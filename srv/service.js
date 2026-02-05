const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');

module.exports = srv => {
    const nuke = require('./js/nuke.js');
    
    // Registrar handlers cuando el servicio FileProcService esté listo
    if (srv.name === 'FileProcService') {
        
        /**
         * createJob: Crea un nuevo job de procesamiento
         * - Valida que el archivo existe
         * - Guarda metadata del archivo
         * - Estado inicial: NEW (no encolado aún)
         */
        srv.on('createJob', async (req) => {
            const { fileName, filePath } = req.data;
            
            // Resolve absolute path
            const absolutePath = path.isAbsolute(filePath) 
                ? filePath 
                : path.resolve(process.cwd(), filePath);
            
            // Validate file exists
            if (!fs.existsSync(absolutePath)) {
                req.error(400, `File not found: ${absolutePath}`);
                return;
            }
            
            // Get file stats
            const stats = fs.statSync(absolutePath);
            const totalBytes = stats.size;
            
            // Create UploadJob con estado NEW
            const tx = srv.tx(req);
            const job = await tx.create('UploadJobs', {
                fileName: fileName,
                filePath: absolutePath,
                status: 'NEW',
                totalBytes: totalBytes,
                processedBytes: 0,
                processedLines: 0,
                errorMessage: null,
                batchSize: 10000,  // Batch inicial para HANA
                lastBatchMs: 0,
                avgBatchMs: 0,
                batchesProcessed: 0,
                attemptCount: 0,
                maxAttempts: 3,
                leaseSeconds: 1800  // 30 minutos
            });
            
            console.log(`[API] Job creado: ${job.ID} - ${fileName}`);
            return job;
        });

        /**
         * startProcessing: Encola el job para que el Worker lo procese
         * - NO procesa el archivo aquí
         * - Solo marca status=READY y requestedAt
         * - El Worker lo tomará cuando esté disponible
         */
        srv.on('startProcessing', async (req) => {
            const { jobId } = req.data;
            
            const tx = srv.tx(req);
            const jobs = await tx.read('UploadJobs').where({ ID: jobId });
            
            if (!jobs || jobs.length === 0) {
                req.error(404, `Job not found: ${jobId}`);
                return;
            }
            
            const job = jobs[0];
            
            // Validar estado actual
            if (job.status === 'PROCESSING') {
                console.log(`[API] Job ${jobId} ya está siendo procesado`);
                return job;
            }
            
            if (job.status === 'DONE') {
                console.log(`[API] Job ${jobId} ya está completado`);
                return job;
            }
            
            if (job.status === 'READY') {
                console.log(`[API] Job ${jobId} ya está en cola`);
                return job;
            }
            
            // Marcar como READY para que el Worker lo tome
            const now = new Date().toISOString();
            await tx.update('UploadJobs', jobId).set({ 
                status: 'READY',
                requestedAt: now,
                errorMessage: null  // Limpiar error previo si es retry
            });
            
            console.log(`[API] Job ${jobId} encolado - Status: READY`);
            
            // Retornar job actualizado
            const updatedJobs = await tx.read('UploadJobs').where({ ID: jobId });
            return updatedJobs[0];
        });
    }
}
