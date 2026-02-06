using teco from '../db/tablas';
using fileproc from '../db/schema';

// Servicio para generar asientos
@requires: 'NukeService'
service NukeGenerarAsientosService {   

}

// Servicio para procesamiento de archivos
@requires: 'FileProcessor'
service FileProcService {
  entity UploadJobs as projection on fileproc.UploadJob;
  entity StgRecords as projection on fileproc.StgRecord;
  
  action createJob(fileName: String, filePath: String) returns UploadJobs;
  action startProcessing(jobId: UUID) returns UploadJobs;
  
  // Acciones de limpieza
  action deleteJob(jobId: UUID) returns { deleted: Integer };
  action clearCompletedJobs() returns { deleted: Integer };
  action clearAllJobs() returns { deleted: Integer };
}

// ===========================================
// SharePoint Files Service - Microsoft Graph
// ===========================================
@requires: 'FileProcessor'
@path: 'sharepoint'
service SharePointService {
  
  // Tipo para los archivos de SharePoint
  type SharePointFile {
    itemId     : String;
    name       : String;
    size       : Integer64;
    mimeType   : String;
    webUrl     : String;
    createdAt  : Timestamp;
    modifiedAt : Timestamp;
  }

  // Listar archivos del folder configurado
  function listFiles() returns array of SharePointFile;
  
  // Listar archivos de un folder específico
  function listFilesInFolder(folderId: String) returns array of SharePointFile;
  
  // Descargar archivo (retorna stream binario)
  action downloadFile(itemId: String) returns LargeBinary;
  
  // Obtener URL de descarga directa (para UI - válido por ~1 hora)
  function getDownloadUrl(itemId: String) returns { url: String; expiresAt: Timestamp };
  
  // Crear job desde archivo de SharePoint
  action createJobFromSharePoint(itemId: String, fileName: String) returns String;
}
