namespace fileproc;
using { managed, cuid } from '@sap/cds/common';

/**
 * Job de procesamiento de archivos
 * Lifecycle: NEW → READY → PROCESSING → DONE/ERROR/CANCELED
 */
entity UploadJob : cuid, managed {
  // Información del archivo
  fileName          : String(255);
  filePath          : String(1000);      // Path local (POC) o storageRef futuro
  totalBytes        : Integer64;
  
  // Estado del job
  status            : String(20) default 'NEW';  // NEW, READY, PROCESSING, DONE, ERROR, CANCELED
  errorMessage      : LargeString;
  
  // Progreso de procesamiento
  processedBytes    : Integer64 default 0;
  processedLines    : Integer64 default 0;
  
  // Worker claiming (para concurrencia)
  claimedAt         : Timestamp;          // Cuándo el worker tomó el job
  claimedBy         : String(100);        // ID del worker (ej: "worker-0")
  heartbeatAt       : Timestamp;          // Última señal de vida del worker
  attemptCount      : Integer default 0;  // Intentos de procesamiento
  maxAttempts       : Integer default 3;  // Máximo de reintentos
  leaseSeconds      : Integer default 1800; // 30 min lease por defecto
  requestedAt       : Timestamp;          // Cuándo se llamó startProcessing
  
  // Tiempos reales de procesamiento
  startedAt         : Timestamp;          // Inicio real del procesamiento
  finishedAt        : Timestamp;          // Fin del procesamiento
  totalDurationMs   : Integer64;          // Duración total en ms
  totalDurationText : String(50);         // "3min 25seg" - legible
  
  // Métricas de batch
  batchSize         : Integer default 10000;
  lastBatchMs       : Integer;
  avgBatchMs        : Integer;
  avgBatchText      : String(50);         // "1.2seg" - legible
  batchesProcessed  : Integer default 0;
  
  // Throughput
  linesPerSecond    : Integer;            // Rendimiento: líneas/seg
  bytesPerSecond    : Integer64;          // Rendimiento: bytes/seg
}

/**
 * Registros de staging parseados del archivo
 */
entity StgRecord : cuid, managed {
  job            : Association to UploadJob;
  lineNumber     : Integer64;
  currency       : String(10);
  province       : String(50);
  product        : String(100);
  columnCount    : Integer;
  parseStatus    : String(10);  // OK, ERROR
  errorReason    : String(100);
  rawLine        : LargeString; // Solo se guarda para errores
}
