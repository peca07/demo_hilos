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
