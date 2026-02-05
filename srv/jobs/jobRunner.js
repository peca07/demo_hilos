"use strict";

const fs = require('fs');
const readline = require('readline');

/**
 * Configuración de procesamiento - Optimizada para HANA
 * En Cloud Foundry siempre usamos HANA
 */
const CONFIG = {
    // Batch sizes para HANA (alto throughput)
    INITIAL_BATCH_SIZE: 10000,
    MAX_BATCH_SIZE: 50000,
    MIN_BATCH_SIZE: 2000,
    
    // Targets de tiempo por batch (ms)
    TARGET_BATCH_MS_MIN: 200,
    TARGET_BATCH_MS_MAX: 1000,
    
    // Cada cuántos batches actualizar métricas en DB
    METRICS_UPDATE_INTERVAL: 10,
    
    // 0 = sin límite de líneas
    MAX_LINES_POC: 0,
    
    // Intervalo para liberar event loop (ms)
    YIELD_INTERVAL_MS: 5,
    
    // Solo guardar rawLine para errores (ahorra espacio)
    STORE_RAW_LINE_FOR_OK: false,
    
    // Buffer size para lectura de archivo (32MB para HANA)
    HIGH_WATER_MARK: 32 * 1024 * 1024
};

/**
 * Convierte milisegundos a texto legible
 * @param {number} ms - Milisegundos
 * @returns {string} - "2h 15min 30seg" o "45seg" o "1min 23seg"
 */
function formatDuration(ms) {
    if (ms == null || ms < 0) return '-';
    if (ms < 1000) return `${ms}ms`;
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    const s = seconds % 60;
    const m = minutes % 60;
    const h = hours;
    
    if (h > 0) {
        return `${h}h ${m}min ${s}seg`;
    } else if (m > 0) {
        return `${m}min ${s}seg`;
    } else {
        return `${s}seg`;
    }
}

/**
 * Formatea números grandes con separadores de miles
 * @param {number} num 
 * @returns {string}
 */
function formatNumber(num) {
    if (num == null) return '0';
    return num.toLocaleString('es-ES');
}

/**
 * Formatea bytes a formato legible
 * @param {number} bytes 
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes == null || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Pausa asíncrona para liberar el event loop y permitir GC
 */
function yieldToEventLoop(ms = CONFIG.YIELD_INTERVAL_MS) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a file line-by-line and stage records
 * @param {Object} db - Database connection
 * @param {UUID} jobId - UploadJob ID
 * @param {string} workerId - ID del worker que procesa
 */
async function processFile(db, jobId, workerId = 'unknown') {
    let job = null;
    let batch = [];
    let lineNumber = 0;
    let processedBytes = 0;
    let batchSize = CONFIG.INITIAL_BATCH_SIZE;
    let batchesProcessed = 0;
    let totalBatchMs = 0;
    let stream = null;
    let rl = null;
    let okCount = 0;
    let errorCount = 0;
    
    // Tiempo de inicio
    const startTime = Date.now();
    const startTimeISO = new Date(startTime).toISOString();

    try {
        // Fetch job to get file path
        const jobs = await db.read('fileproc.UploadJob').where({ ID: jobId });
        if (!jobs || jobs.length === 0) {
            throw new Error(`Job not found: ${jobId}`);
        }
        
        job = jobs[0];
        const filePath = job.filePath;
        batchSize = job.batchSize || CONFIG.INITIAL_BATCH_SIZE;
        
        // Log inicio con formato bonito
        console.log(`\n[${workerId}] ${'═'.repeat(50)}`);
        console.log(`[${workerId}] 📄 Job: ${jobId}`);
        console.log(`[${workerId}] 📁 Archivo: ${job.fileName}`);
        console.log(`[${workerId}] 📊 Tamaño: ${formatBytes(job.totalBytes)}`);
        console.log(`[${workerId}] ⚙️  Batch inicial: ${formatNumber(batchSize)}`);
        console.log(`[${workerId}] ${'─'.repeat(50)}`);
        
        // Marcar inicio del procesamiento
        await db.update('fileproc.UploadJob', jobId).set({
            startedAt: startTimeISO
        });
        
        // Validar que el archivo existe
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        
        // Create read stream with optimized highWaterMark
        stream = fs.createReadStream(filePath, {
            encoding: 'utf8',
            highWaterMark: CONFIG.HIGH_WATER_MARK
        });
        
        // Create readline interface
        rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });
        
        // Process line by line
        for await (const line of rl) {
            lineNumber++;
            processedBytes += Buffer.byteLength(line, 'utf8') + 1;
            
            // Límite de líneas para POC
            if (CONFIG.MAX_LINES_POC > 0 && lineNumber > CONFIG.MAX_LINES_POC) {
                console.log(`[${workerId}] ⚠️ POC limit: ${CONFIG.MAX_LINES_POC} líneas`);
                break;
            }
            
            // Parse line (semicolon separated)
            const cols = line.split(';');
            const columnCount = cols.length;
            
            let parseStatus = 'OK';
            let errorReason = null;
            let currency = '';
            let province = '';
            let product = '';
            
            // Validate column count
            if (columnCount < 12) {
                parseStatus = 'ERROR';
                errorReason = 'too_few_columns';
            } else {
                // Extract fields (columns 4, 11, 12 => 0-based: 3, 10, 11)
                currency = (cols[3] || '').trim();
                province = (cols[10] || '').trim();
                product = (cols[11] || '').trim();
                
                // Validate required fields
                if (!currency || !province || !product) {
                    parseStatus = 'ERROR';
                    errorReason = 'missing_required_field';
                }
            }
            
            // Create staging record
            const stgRecord = {
                job: { ID: jobId },
                lineNumber: lineNumber,
                currency: currency,
                province: province,
                product: product,
                columnCount: columnCount,
                parseStatus: parseStatus,
                errorReason: errorReason,
                rawLine: (parseStatus === 'ERROR' || CONFIG.STORE_RAW_LINE_FOR_OK) ? line : null
            };
            
            batch.push(stgRecord);
            
            if (parseStatus === 'OK') {
                okCount++;
            } else {
                errorCount++;
            }
            
            // Flush batch when size reached
            if (batch.length >= batchSize) {
                const flushResult = await flushBatch(
                    db, jobId, batch, batchSize, batchesProcessed, 
                    totalBatchMs, lineNumber, processedBytes, 
                    job.totalBytes, startTime, workerId
                );
                batchSize = flushResult.newBatchSize;
                batchesProcessed = flushResult.batchesProcessed;
                totalBatchMs = flushResult.totalBatchMs;
                
                // Liberar memoria
                batch.length = 0;
                batch = [];
                
                // Liberar event loop
                await yieldToEventLoop();
                
                // Forzar GC si disponible
                if (global.gc) {
                    global.gc();
                }
            }
        }
        
        // Flush remaining records
        if (batch.length > 0) {
            const flushResult = await flushBatch(
                db, jobId, batch, batchSize, batchesProcessed,
                totalBatchMs, lineNumber, processedBytes,
                job.totalBytes, startTime, workerId
            );
            batchesProcessed = flushResult.batchesProcessed;
            batch.length = 0;
            batch = [];
        }
        
        // Calcular métricas finales
        const endTime = Date.now();
        const totalDurationMs = endTime - startTime;
        const linesPerSecond = totalDurationMs > 0 ? Math.round(lineNumber / (totalDurationMs / 1000)) : 0;
        const bytesPerSecond = totalDurationMs > 0 ? Math.round(job.totalBytes / (totalDurationMs / 1000)) : 0;
        
        // Mark job as DONE with final metrics
        await db.update('fileproc.UploadJob', jobId).set({
            status: 'DONE',
            processedBytes: job.totalBytes,
            processedLines: lineNumber,
            finishedAt: new Date(endTime).toISOString(),
            totalDurationMs: totalDurationMs,
            totalDurationText: formatDuration(totalDurationMs),
            linesPerSecond: linesPerSecond,
            bytesPerSecond: bytesPerSecond,
            avgBatchText: formatDuration(batchesProcessed > 0 ? Math.round(totalBatchMs / batchesProcessed) : 0)
        });
        
        // Log resumen final
        console.log(`\n[${workerId}] ${'─'.repeat(50)}`);
        console.log(`[${workerId}] ✅ JOB COMPLETADO: ${jobId}`);
        console.log(`[${workerId}] ${'─'.repeat(50)}`);
        console.log(`[${workerId}] ⏱️  Duración total: ${formatDuration(totalDurationMs)}`);
        console.log(`[${workerId}] 📝 Líneas procesadas: ${formatNumber(lineNumber)}`);
        console.log(`[${workerId}] ✓  OK: ${formatNumber(okCount)} | ✗ Errores: ${formatNumber(errorCount)}`);
        console.log(`[${workerId}] 📦 Batches: ${formatNumber(batchesProcessed)} | Avg: ${formatDuration(batchesProcessed > 0 ? Math.round(totalBatchMs / batchesProcessed) : 0)}`);
        console.log(`[${workerId}] 🚀 Throughput: ${formatNumber(linesPerSecond)} líneas/seg | ${formatBytes(bytesPerSecond)}/seg`);
        console.log(`[${workerId}] ${'═'.repeat(50)}\n`);
        
    } catch (error) {
        console.error(`\n[${workerId}] ❌ ERROR en job ${jobId}:`, error.message);
        
        // Calcular duración hasta el error
        const errorTime = Date.now();
        const durationUntilError = errorTime - startTime;
        
        // Update job with error status
        try {
            await db.update('fileproc.UploadJob', jobId).set({
                status: 'ERROR',
                errorMessage: error.message || String(error),
                processedLines: lineNumber,
                finishedAt: new Date(errorTime).toISOString(),
                totalDurationMs: durationUntilError,
                totalDurationText: formatDuration(durationUntilError)
            });
        } catch (updateError) {
            console.error(`[${workerId}] Error actualizando status:`, updateError.message);
        }
        
    } finally {
        // Cleanup
        if (rl) {
            rl.close();
        }
        if (stream) {
            stream.destroy();
        }
        batch = null;
        job = null;
    }
}

/**
 * Flush a batch of staging records to database
 */
async function flushBatch(db, jobId, batch, currentBatchSize, currentBatchesProcessed, currentTotalBatchMs, processedLines, processedBytes, totalBytes, jobStartTime, workerId) {
    const startTime = Date.now();
    
    // Insert batch
    await db.create('fileproc.StgRecord', batch);
    
    const dtMs = Date.now() - startTime;
    
    // Auto-tune batch size basado en el tiempo de inserción
    let newBatchSize = currentBatchSize;
    if (dtMs < CONFIG.TARGET_BATCH_MS_MIN) {
        newBatchSize = Math.min(Math.floor(currentBatchSize * 1.5), CONFIG.MAX_BATCH_SIZE);
    } else if (dtMs > CONFIG.TARGET_BATCH_MS_MAX) {
        newBatchSize = Math.max(Math.floor(currentBatchSize * 0.7), CONFIG.MIN_BATCH_SIZE);
    }
    
    const newBatchesProcessed = currentBatchesProcessed + 1;
    const newTotalBatchMs = currentTotalBatchMs + dtMs;
    const avgBatchMs = Math.floor(newTotalBatchMs / newBatchesProcessed);
    
    // Calcular tiempo transcurrido
    const elapsedMs = Date.now() - jobStartTime;
    
    // Actualizar métricas en DB cada N batches
    if (newBatchesProcessed % CONFIG.METRICS_UPDATE_INTERVAL === 0 || newBatchesProcessed === 1) {
        const linesPerSecond = elapsedMs > 0 ? Math.round(processedLines / (elapsedMs / 1000)) : 0;
        
        await db.update('fileproc.UploadJob', jobId).set({
            lastBatchMs: dtMs,
            avgBatchMs: avgBatchMs,
            avgBatchText: formatDuration(avgBatchMs),
            batchesProcessed: newBatchesProcessed,
            batchSize: newBatchSize,
            processedLines: processedLines,
            processedBytes: processedBytes,
            linesPerSecond: linesPerSecond
        });
        
        // Log de progreso con tiempo legible
        const progress = totalBytes > 0 ? ((processedBytes / totalBytes) * 100).toFixed(1) : 0;
        console.log(`[${workerId}] 📊 ${progress}% | ${formatNumber(processedLines)} líneas | ${formatBytes(processedBytes)} | Batch: ${formatNumber(newBatchSize)} | ${formatDuration(elapsedMs)} transcurridos`);
    }
    
    return {
        newBatchSize,
        batchesProcessed: newBatchesProcessed,
        totalBatchMs: newTotalBatchMs
    };
}

module.exports = {
    processFile,
    formatDuration,
    formatNumber,
    formatBytes,
    CONFIG
};
