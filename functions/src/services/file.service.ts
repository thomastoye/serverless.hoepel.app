import {
  childListToXlsx,
  childrenWithCommentsListToXlsx,
  createAllFiscalCertsXlsx,
  createChildAttendanceXlsx,
  createCrewAttendanceXlsx,
  crewListToXlsx,
  LocalFileCreationResult,
} from './data-to-xlsx';
import {
  DayDate,
  FileType,
  IDetailedChildAttendance,
  IShift,
  Shift,
} from '@hoepel.app/types';
import * as admin from 'firebase-admin';
import { ChildService } from './child.service';
import { CrewService } from './crew.service';
import { ShiftService } from './shift.service';

interface FirestoreFileDocument {
  expires: Date;
  created: Date;
  createdBy: string;
  createdByUid: string;
  description: string;
  format: 'XLSX' | 'PDF' | 'DOCX';
  refPath: string;
  tenant: string;
  type: FileType;
}


export class FileService {
  constructor(
    private childService: ChildService,
    private crewService: CrewService,
    private shiftService: ShiftService,
    private db: admin.firestore.Firestore, // TODO refactor so this service does not use db directly
    private storage: any, // Bucket
  ) {}

  async exportAllChildren(tenant: string, createdBy: string, uid: string): Promise<FirestoreFileDocument> {
    const localFile = childListToXlsx(await this.childService.getAll(tenant), tenant);

    return await this.saveFile(localFile, tenant, createdBy, uid, 'all-children');
  }

  async exportAllCrew(tenant: string, createdBy: string, uid: string): Promise<FirestoreFileDocument> {
    const localFile = crewListToXlsx(await this.crewService.getAll(tenant), tenant);

    return await this.saveFile(localFile, tenant, createdBy, uid, 'all-crew');
  }

  async exportChildrenWithComment(tenant: string, createdBy: string, uid: string): Promise<FirestoreFileDocument> {
    const children = (await this.childService.getAll(tenant)).filter(child => child.remarks);
    const localFile = childrenWithCommentsListToXlsx(children, tenant);

    return await this.saveFile(localFile, tenant, createdBy, uid, 'children-with-comment');
  }

  async exportCrewAttendances(tenant: string, createdBy: string, uid: string, year: number): Promise<FirestoreFileDocument> {
    const allCrewForAtt = (await this.crewService.getAll(tenant)).filter(crew => crew.active);

    const shiftsForCrewAtt = await this.getShiftsInYear(year, tenant);
    const crewAttendances = await this.getCrewAttendancesOnShifts(shiftsForCrewAtt, tenant);

    const localFile = createCrewAttendanceXlsx(allCrewForAtt, shiftsForCrewAtt, crewAttendances, year, tenant);

    return await this.saveFile(localFile, tenant, createdBy, uid, 'crew-attendances');
  }

  async exportChildAttendances(tenant: string, createdBy: string, uid: string, year: number): Promise<FirestoreFileDocument> {
    const allChildrenForChildAtt = await this.childService.getAll(tenant);

    const shiftsForChildAtt = await this.getShiftsInYear(year, tenant);
    const childAttendancesForChildAtt = await this.getChildAttendancesOnShifts(shiftsForChildAtt, tenant);

    const localFile = createChildAttendanceXlsx(allChildrenForChildAtt, shiftsForChildAtt, childAttendancesForChildAtt, year, tenant);

    return await this.saveFile(localFile, tenant, createdBy, uid, 'child-attendances');
  }

  async exportFiscalCertificatesList(tenant: string, createdBy: string, uid: string, year: number): Promise<FirestoreFileDocument> {
    const allChildrenForFiscalCerts = await this.childService.getAll(tenant);

    const shiftsForFiscalCerts = await this.getShiftsInYear(year, tenant);
    const childAttendancesForFiscalCerts = await this.getChildAttendancesOnShifts(shiftsForFiscalCerts, tenant);

    const localFile = createAllFiscalCertsXlsx(allChildrenForFiscalCerts, shiftsForFiscalCerts, childAttendancesForFiscalCerts, year, tenant);

    return await this.saveFile(localFile, tenant, createdBy, uid, 'crew-attendances');
  }

  async removeFile(tenant: string, uid: string, fileName: string) {
    const docs = await this.db.collection('reports').where('refPath', '==', fileName).where('tenant', '==', tenant).get();

    if (docs.empty) {
      throw new Error(`Could not find document for tenant ${tenant} with fileName ${fileName}`)
    }

    await this.storage.file(fileName).delete();
    await this.db.collection('reports').doc(docs.docs[0].id).delete();
  }

  private async saveFile(localFile: LocalFileCreationResult, tenant: string, createdBy: string, uid: string, type: FileType): Promise<FirestoreFileDocument> {
    const bucketFileName = await this.uploadFile(tenant, localFile);

    const doc: FirestoreFileDocument = {
      expires: this.getFileExpirationDate(),
      created: new Date(),
      createdBy,
      createdByUid: uid,
      description: localFile.description,
      format: localFile.format,
      refPath: bucketFileName,
      tenant,
      type,
    };

    await this.saveToFirestore(doc);

    return doc;
  }

  private getFileExpirationDate(): Date {
    // Document expires in a year from now
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    return expires;
  }

  /**
   * Upload a file to the storage bucket
   *
   * @return The name of the file in the file storage bucket
   */
  private async uploadFile(tenant: string, localFile: LocalFileCreationResult): Promise<string> {
    // Upload to storage
    const name = `${new Date().getTime()} ${tenant} ${localFile.downloadFileName}`;

    await this.storage.file(name).save(
      localFile.file, {
        metadata: {
          metadata: { tenant: tenant, expires: this.getFileExpirationDate().getTime().toString() },

          // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Disposition
          // https://stackoverflow.com/questions/1741353/how-to-set-response-filename-without-forcing-saveas-dialog
          contentDisposition: `inline; filename="${localFile.downloadFileName}"`,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      }
    );

    return name;
  }

  private async saveToFirestore(doc: FirestoreFileDocument): Promise<void> {
    await this.db.collection('reports').add(doc);
  }


  /// Data access helpers

  private async getShiftsInYear(year: number, tenant): Promise<ReadonlyArray<Shift>> {
    const shifts = await this.shiftService.getAll(tenant);

    return shifts.filter(shift => DayDate.fromDayId(shift.dayId).year === year);
  }

  private async getCrewAttendancesOnShifts(shifts: ReadonlyArray<IShift>, tenant: string): Promise<ReadonlyArray<{ shiftId: string, attendances: ReadonlyArray<any> }>> {
    const all = await Promise.all(
      shifts.map(shift => this.db.collection('crew-attendances-by-shift').doc(shift.id).get())
    ); // TODO Should use get many

    return all.filter(snapshot => snapshot.exists && snapshot.data().attendances && snapshot.data().tenant === tenant).map(snapshot => {
      return {
        shiftId: snapshot.id,
        attendances: snapshot.data().attendances,
      };
    });
  };

  private async getChildAttendancesOnShifts(shifts: ReadonlyArray<IShift>, tenant: string): Promise<ReadonlyArray<{ shiftId: string, attendances: ReadonlyArray<IDetailedChildAttendance> }>> {
    const all = await Promise.all(
      shifts.map(shift => this.db.collection('child-attendances-by-shift').doc(shift.id).get())
    );

    return all.filter(snapshot => snapshot.exists && snapshot.data().attendances && snapshot.data().tenant === tenant).map(snapshot => {
      return {
        shiftId: snapshot.id,
        attendances: snapshot.data().attendances,
      };
    });
  };
}
