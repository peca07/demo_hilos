namespace fileproc;
using { managed, cuid } from '@sap/cds/common';

/**
 * Job de procesamiento de archivos
 * Lifecycle: NEW → QUEUED → PROCESSING → DONE/ERROR/CANCELLED
 */
entity UploadJob : cuid, managed {
  // Archivo
  fileName          : String(255);
  sharePointItemId  : String(500);
  totalBytes        : Integer64;

  // Estado
  status            : String(20) default 'NEW';
  errorMessage      : LargeString;

  // Progreso
  totalLines        : Integer64 default 0;
  processedLines    : Integer64 default 0;
  processedBytes    : Integer64 default 0;
  errorLines        : Integer64 default 0;

  // Fragmentación (Worker Threads internos)
  numFragments      : Integer default 0;
  fragmentsDone     : Integer default 0;
  numWorkerThreads  : Integer default 2;

  // Tiempos
  startedAt         : Timestamp;
  finishedAt        : Timestamp;
  heartbeatAt       : Timestamp;
  cancelRequested   : Boolean default false;

  totalDurationMs   : Integer64;
  totalDurationText : String(50);

  // Throughput
  linesPerSecond    : Integer;
  bytesPerSecond    : Integer64;

  // Resultado
  validationPassed  : Boolean default false;
  maxErrorsReached  : Boolean default false;

  // Backward compat (UI search)
  claimedBy         : String(100);

  // Errores de validación
  errors            : Composition of many ValidationError on errors.job = $self;
}

/**
 * Solo almacena errores de validación (no todas las líneas)
 */
entity ValidationError : cuid {
  job               : Association to UploadJob;
  lineNumber        : Integer64;
  errorType         : String(50);
  errorMessage      : String(500);
  fieldName         : String(100);
  fieldValue        : String(500);
  rawLine           : LargeString;
}
