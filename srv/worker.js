"use strict";

/**
 * Worker Process - Procesa jobs de la cola de forma asíncrona
 * 
 * Este script corre como proceso separado del API.
 * - Hace polling de jobs con status=READY
 * - Claim atómico para evitar que múltiples workers procesen el mismo job
 * - Procesa el archivo y actualiza métricas
 * - Soporta múltiples instancias en paralelo (horizontal scaling)
 * 
 * Uso:
 *   node srv/worker.js
 *   
 * Variables de entorno:
 *   CF_INSTANCE_INDEX - Índice de la instancia en CF (0, 1, 2...)
 *   WORKER_POLL_INTERVAL_MS - Intervalo de polling (default: 2000)
 *   WORKER_LEASE_SECONDS - Tiempo máximo de lease (default: 1800)
 */

const cds = require('@sap/cds');
const crypto = require('crypto');

// Configuración del worker
const CONFIG = {
    POLL_INTERVAL_MS: parseInt(process.env.WORKER_POLL_INTERVAL_MS) || 2000,
    LEASE_SECONDS: parseInt(process.env.WORKER_LEASE_SECONDS) || 1800,
    HEARTBEAT_INTERVAL_MS: 30000,  // Heartbeat cada 30 segundos
};

// Identificador único del worker
const WORKER_ID = `worker-${process.env.CF_INSTANCE_INDEX || '0'}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Intenta reclamar un job de forma atómica
 * Solo un worker puede reclamar cada job gracias al WHERE condition
 * 
 * @param {Object} db - Conexión a base de datos
 * @returns {Object|null} - Job reclamado o null si no hay jobs disponibles
 */
async function claimJob(db) {
    const now = new Date();
    const nowISO = now.toISOString();
    
    // Calcular tiempo límite para jobs stale (lease expirado)
    const leaseExpiredTime = new Date(now.getTime() - CONFIG.LEASE_SECONDS * 1000);
    const leaseExpiredISO = leaseExpiredTime.toISOString();
    
    try {
        // Buscar jobs disponibles:
        // 1. Status READY (encolados y no tomados)
        // 2. Status PROCESSING pero con lease expirado (worker murió)
        const availableJobs = await db.read('fileproc.UploadJob')
            .where(`(status = 'READY') OR (status = 'PROCESSING' AND claimedAt < '${leaseExpiredISO}')`)
            .orderBy('requestedAt asc')
            .limit(10);  // Tomar algunos candidatos
        
        if (!availableJobs || availableJobs.length === 0) {
            return null;
        }
        
        // Intentar reclamar el primer job disponible
        for (const candidate of availableJobs) {
            // Incrementar attemptCount si es un retry
            const newAttemptCount = candidate.status === 'PROCESSING' 
                ? candidate.attemptCount + 1 
                : candidate.attemptCount + 1;
            
            // Verificar si excedió máximo de intentos
            if (newAttemptCount > (candidate.maxAttempts || 3)) {
                console.log(`[${WORKER_ID}] Job ${candidate.ID} excedió máximo de intentos (${newAttemptCount}/${candidate.maxAttempts})`);
                await db.update('fileproc.UploadJob', candidate.ID).set({
                    status: 'ERROR',
                    errorMessage: `Exceeded max attempts: ${newAttemptCount}`,
                    finishedAt: nowISO
                });
                continue;
            }
            
            // Claim atómico: solo actualiza si el estado no cambió
            // Esto previene race conditions entre workers
            const result = await db.update('fileproc.UploadJob', candidate.ID)
                .set({
                    status: 'PROCESSING',
                    claimedAt: nowISO,
                    claimedBy: WORKER_ID,
                    heartbeatAt: nowISO,
                    attemptCount: newAttemptCount
                })
                .where(`ID = '${candidate.ID}' AND (status = 'READY' OR (status = 'PROCESSING' AND claimedAt < '${leaseExpiredISO}'))`);
            
            // Si la actualización afectó filas, tenemos el job
            // En CAP/CDS, result puede ser el número de filas o el objeto
            if (result !== 0 && result !== null) {
                // Leer el job reclamado
                const claimedJobs = await db.read('fileproc.UploadJob').where({ ID: candidate.ID });
                if (claimedJobs && claimedJobs.length > 0 && claimedJobs[0].claimedBy === WORKER_ID) {
                    console.log(`[${WORKER_ID}] ✓ Job reclamado: ${candidate.ID} (intento ${newAttemptCount})`);
                    return claimedJobs[0];
                }
            }
            
            // Otro worker lo tomó, intentar siguiente
            console.log(`[${WORKER_ID}] Job ${candidate.ID} tomado por otro worker`);
        }
        
        return null;
        
    } catch (error) {
        console.error(`[${WORKER_ID}] Error en claimJob:`, error.message);
        return null;
    }
}

/**
 * Actualiza el heartbeat del job para indicar que el worker sigue vivo
 */
async function updateHeartbeat(db, jobId) {
    try {
        await db.update('fileproc.UploadJob', jobId).set({
            heartbeatAt: new Date().toISOString()
        });
    } catch (error) {
        console.error(`[${WORKER_ID}] Error actualizando heartbeat:`, error.message);
    }
}

/**
 * Loop principal del worker
 */
async function workerLoop() {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[${WORKER_ID}] Worker iniciado`);
    console.log(`[${WORKER_ID}] Poll interval: ${CONFIG.POLL_INTERVAL_MS}ms`);
    console.log(`[${WORKER_ID}] Lease timeout: ${CONFIG.LEASE_SECONDS}s`);
    console.log(`${'═'.repeat(60)}\n`);
    
    // Conectar a la base de datos
    const db = await cds.connect.to('db');
    
    // Cargar el procesador de archivos
    const { processFile } = require('./jobs/jobRunner');
    
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 10;
    
    // Loop infinito
    while (true) {
        try {
            // Intentar reclamar un job
            const job = await claimJob(db);
            
            if (job) {
                consecutiveErrors = 0;  // Reset error counter
                
                console.log(`\n${'─'.repeat(60)}`);
                console.log(`[${WORKER_ID}] Procesando job: ${job.ID}`);
                console.log(`[${WORKER_ID}] Archivo: ${job.fileName}`);
                console.log(`[${WORKER_ID}] Tamaño: ${(job.totalBytes / 1024 / 1024).toFixed(2)} MB`);
                console.log(`${'─'.repeat(60)}`);
                
                // Iniciar heartbeat en background
                const heartbeatInterval = setInterval(() => {
                    updateHeartbeat(db, job.ID);
                }, CONFIG.HEARTBEAT_INTERVAL_MS);
                
                try {
                    // Procesar el archivo
                    await processFile(db, job.ID, WORKER_ID);
                    
                } finally {
                    // Limpiar heartbeat
                    clearInterval(heartbeatInterval);
                }
                
            } else {
                // No hay jobs disponibles, esperar
                await sleep(CONFIG.POLL_INTERVAL_MS);
            }
            
        } catch (error) {
            consecutiveErrors++;
            console.error(`[${WORKER_ID}] Error en loop (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error.message);
            
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.error(`[${WORKER_ID}] Demasiados errores consecutivos, saliendo...`);
                process.exit(1);
            }
            
            // Esperar un poco más largo después de un error
            await sleep(CONFIG.POLL_INTERVAL_MS * 2);
        }
    }
}

// Manejo de señales para shutdown graceful
process.on('SIGTERM', () => {
    console.log(`[${WORKER_ID}] Recibido SIGTERM, cerrando...`);
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log(`[${WORKER_ID}] Recibido SIGINT, cerrando...`);
    process.exit(0);
});

// Iniciar el worker
console.log(`[Worker] Iniciando CDS...`);
cds.on('served', () => {
    // CDS está listo, iniciar el loop
    workerLoop().catch(err => {
        console.error('[Worker] Error fatal:', err);
        process.exit(1);
    });
});

// Bootstrap CDS sin servidor HTTP
cds.serve('all').catch(err => {
    console.error('[Worker] Error iniciando CDS:', err);
    process.exit(1);
});
