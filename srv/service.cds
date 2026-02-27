using teco from '../db/tablas';
using fileproc from '../db/schema';

// Servicio para generar asientos (futuro)
// @requires: 'NukeService'
service NukeGenerarAsientosService {

}

// Servicio para procesamiento de archivos
// @requires: 'FileProcessor'
service FileProcService {
  entity UploadJobs       as projection on fileproc.UploadJob;
  entity ValidationErrors as projection on fileproc.ValidationError;

  // Cancelar job en progreso
  action cancelJob(jobId: UUID) returns UploadJobs;

  // Limpieza
  action deleteJob(jobId: UUID) returns { deleted: Integer };
  action clearCompletedJobs() returns { deleted: Integer };
  action clearAllJobs() returns { deleted: Integer };
}

// SharePoint Files Service
// @requires: 'FileProcessor'
@path: 'sharepoint'
@impl: './sharepoint-service.js'
service SharePointService {

  type SharePointItem {
    itemId     : String;
    name       : String;
    isFolder   : Boolean;
    size       : Integer64;
    mimeType   : String;
    webUrl     : String;
    createdAt  : Timestamp;
    modifiedAt : Timestamp;
  }

  action listFiles(folderPath : String)  returns array of SharePointItem;
  action getDownloadUrl(itemId : String) returns { url: String; expiresAt: Timestamp };

  // Crear job desde SharePoint (UI llama esta action)
  action createJobFromSharePoint(itemId: String, fileName: String) returns String;
}
