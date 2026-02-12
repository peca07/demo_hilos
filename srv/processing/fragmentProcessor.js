"use strict";

/**
 * Fragment Processor - Core stream orchestrator
 *
 * Streams files from SharePoint, splits into byte-bounded fragments,
 * distributes to worker_threads with backpressure.
 *
 * Phase 1: in-process semaphore (MAX_CONCURRENT_JOBS = 1)
 * Phase 2: DB-backed claim/lease for multi-instance
 */

const { Worker } = require('worker_threads');
const path = require('path');
const { logMemory, checkMemoryThreshold } = require('./memoryLogger');

// ============================================
// Configuration
// ============================================
const CONFIG = {
  MAX_CONCURRENT_JOBS: 2, // Allow 2 concurrent jobs for multi-user testing
  NUM_WORKERS: 2,
  FRAGMENT_MAX_BYTES: 32 * 1024 * 1024, // 32MB
  HEARTBEAT_INTERVAL_MS: 15000,
  HEARTBEAT_TIMEOUT_MS: 60000,
  MAX_ERRORS_PER_JOB: 10000, // No longer used (we don't store errors)
  FAIL_FAST_THRESHOLD: 50000,
  MEMORY_THRESHOLD_PERCENT: 75,
  CONTAINER_MEMORY_MB: 2048,
  METRICS_LOG_INTERVAL_MS: 10000,
};

// ============================================
// Duration formatter
// ============================================
function formatDuration(ms) {
  if (ms == null || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const s = seconds % 60;
  const m = minutes % 60;
  if (hours > 0) return `${hours}h ${m}min ${s}seg`;
  if (minutes > 0) return `${m}min ${s}seg`;
  return `${s}seg`;
}

// ============================================
// Worker Pool - manages worker threads + backpressure
// ============================================
class WorkerPool {
  constructor(numWorkers, referenceData, onFragmentDone) {
    this._workers = [];
    this._waitQueue = []; // resolve functions waiting for a free worker
    this._onFragmentDone = onFragmentDone;

    for (let i = 0; i < numWorkers; i++) {
      const instance = new Worker(
        path.join(__dirname, 'validationWorker.js'),
        { workerData: { workerId: i, referenceData } }
      );

      const w = { instance, busy: false, id: i };
      this._workers.push(w);

      instance.on('message', (msg) => {
        if (msg.type === 'fragment_done') {
          this._onFragmentDone(msg);
          w.busy = false;
          this._notifyWaiters();
        }
      });

      instance.on('error', (err) => {
        console.error(`[WorkerPool] Worker ${i} error:`, err.message);
        w.busy = false;
        this._notifyWaiters();
      });
    }
  }

  _notifyWaiters() {
    if (this._waitQueue.length > 0) {
      const resolve = this._waitQueue.shift();
      resolve();
    }
  }

  /** Wait for a free worker (implements backpressure) */
  async getWorker() {
    let free = this._workers.find((w) => !w.busy);
    while (!free) {
      await new Promise((resolve) => this._waitQueue.push(resolve));
      free = this._workers.find((w) => !w.busy);
    }
    return free;
  }

  /** Wait until ALL workers finish their current fragment */
  async waitAllDone() {
    while (this._workers.some((w) => w.busy)) {
      await new Promise((resolve) => this._waitQueue.push(resolve));
    }
  }

  busyCount() {
    return this._workers.filter((w) => w.busy).length;
  }

  async terminateAll() {
    for (const w of this._workers) {
      try {
        await w.instance.terminate();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

// ============================================
// Fragment Processor (singleton)
// ============================================
class FragmentProcessor {
  constructor() {
    this._activeJobs = new Map(); // jobId -> { abortController, pool, intervals }
    this._currentJobCount = 0;
  }

  get isProcessing() {
    return this._currentJobCount > 0;
  }

  /**
   * Enqueue a job for processing.
   * @returns {boolean} true if started immediately, false if stays QUEUED
   */
  async enqueue(jobId, downloadUrl) {
    if (this._currentJobCount < CONFIG.MAX_CONCURRENT_JOBS) {
      this._currentJobCount++;
      setImmediate(() => {
        this._processJob(jobId, downloadUrl)
          .catch((err) =>
            console.error(`[FragmentProcessor] Fatal error in job ${jobId}:`, err)
          )
          .finally(() => {
            this._currentJobCount--;
            this._activeJobs.delete(jobId);
            this._autoDequeue().catch(console.error);
          });
      });
      return true;
    }
    return false;
  }

  /** Cancel an active job */
  cancel(jobId) {
    const active = this._activeJobs.get(jobId);
    if (active) {
      console.log(`[FragmentProcessor] Cancelling job ${jobId}`);
      active.cancelled = true;
      active.abortController.abort();
    }
  }

  // ──────────────────────────────────────────
  // Core processing pipeline
  // ──────────────────────────────────────────
  async _processJob(jobId, downloadUrl) {
    const cds = require('@sap/cds');
    const db = await cds.connect.to('db');
    const axios = require('axios');

    const abortController = new AbortController();
    const jobState = {
      abortController,
      cancelled: false,
      pool: null,
      heartbeatInterval: null,
      metricsInterval: null,
    };
    this._activeJobs.set(jobId, jobState);

    // Counters
    let processedLines = 0;
    let processedBytes = 0;
    let errorLines = 0;
    let fragmentNumber = 0;
    let fragmentsDone = 0;
    let firstError = null; // Only store first error for diagnostics
    const startTime = Date.now();

    try {
      // 1. Update status → PROCESSING
      await db.update('fileproc.UploadJob', jobId).set({
        status: 'PROCESSING',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        claimedBy: `instance-${process.env.CF_INSTANCE_INDEX || '0'}`,
      });

      // 2. Load reference data from HANA
      console.log(`[FragmentProcessor] Loading reference data...`);
      const referenceData = await this._loadReferenceData(db);
      logMemory('after-ref-data');

      // 3. Create worker pool
      const pool = new WorkerPool(CONFIG.NUM_WORKERS, referenceData, (msg) => {
        // Called each time a worker finishes a fragment
        processedLines += msg.processedLines;
        processedBytes += msg.processedBytes;
        errorLines += msg.errorCount;
        fragmentsDone++;

        // Capture only the first error for diagnostics
        if (!firstError && msg.firstError) {
          firstError = msg.firstError;
          console.error(`[FragmentProcessor] FIRST ERROR detected:`, {
            line: firstError.lineNumber,
            type: firstError.errorType,
            message: firstError.errorMessage,
            field: firstError.fieldName,
            value: firstError.fieldValue,
            rawLine: firstError.rawLine
          });
        }
      });
      jobState.pool = pool;

      // 4. Heartbeat (updates DB every 15s)
      jobState.heartbeatInterval = setInterval(async () => {
        try {
          const job = await db.read('fileproc.UploadJob', jobId);
          if (job && job.cancelRequested) {
            this.cancel(jobId);
          }
          await db.update('fileproc.UploadJob', jobId).set({
            heartbeatAt: new Date().toISOString(),
            processedLines,
            processedBytes,
            errorLines,
            numFragments: fragmentNumber,
            fragmentsDone,
          });
        } catch (e) {
          console.warn('[FragmentProcessor] Heartbeat error:', e.message);
        }
      }, CONFIG.HEARTBEAT_INTERVAL_MS);

      // 5. Metrics logging
      jobState.metricsInterval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        const lps = elapsed > 0 ? Math.round(processedLines / elapsed) : 0;
        const mbps = elapsed > 0 ? (processedBytes / 1024 / 1024 / elapsed).toFixed(1) : 0;
        console.log(
          `[FragmentProcessor] ${processedLines.toLocaleString()} lines | ${(processedBytes / 1024 / 1024).toFixed(1)}MB | ${lps} l/s | ${mbps} MB/s | Workers: ${pool.busyCount()}/${CONFIG.NUM_WORKERS} | Errors: ${errorLines}`
        );
        logMemory('processing');
      }, CONFIG.METRICS_LOG_INTERVAL_MS);

      // 6. Open stream to SharePoint
      console.log(`[FragmentProcessor] Opening stream...`);
      logMemory('before-stream');

      const response = await axios({
        method: 'GET',
        url: downloadUrl,
        responseType: 'stream',
        signal: abortController.signal,
        timeout: 0, // no idle timeout for large files
      });

      const stream = response.data;
      stream.setEncoding('utf8');

      // 7. Fragment and distribute with backpressure
      let fragmentBuffer = '';
      let fragmentBytes = 0;
      let fragmentStartLine = 1;
      let firstChunkLogged = false;

      for await (const chunk of stream) {
        // Log first 5 lines for diagnostics
        if (!firstChunkLogged) {
          const preview = chunk.substring(0, 2000);
          const previewLines = preview.split('\n').slice(0, 5);
          console.log(`[FragmentProcessor] First lines preview (delimiter check):`);
          previewLines.forEach((line, idx) => {
            console.log(`  Line ${idx + 1}: ${line.substring(0, 200)}`);
            if (idx === 0) {
              const semicolonCount = (line.match(/;/g) || []).length;
              const pipeCount = (line.match(/\|/g) || []).length;
              const tabCount = (line.match(/\t/g) || []).length;
              console.log(`    Delimiters: ; = ${semicolonCount}, | = ${pipeCount}, tab = ${tabCount}`);
            }
          });
          firstChunkLogged = true;
        }
        // Check cancel
        if (jobState.cancelled) throw new Error('Job cancelled');

        fragmentBuffer += chunk;
        fragmentBytes += Buffer.byteLength(chunk, 'utf8');

        // Send fragments while buffer exceeds maxBytes
        while (fragmentBytes >= CONFIG.FRAGMENT_MAX_BYTES) {
          const lastNewline = fragmentBuffer.lastIndexOf('\n');
          if (lastNewline === -1) break; // need more data for a complete line

          const fragmentText = fragmentBuffer.substring(0, lastNewline);
          fragmentBuffer = fragmentBuffer.substring(lastNewline + 1);
          fragmentBytes = Buffer.byteLength(fragmentBuffer, 'utf8');

          // Count lines via indexOf (fast)
          let lineCount = 1;
          let idx = -1;
          while ((idx = fragmentText.indexOf('\n', idx + 1)) !== -1) lineCount++;

          fragmentNumber++;
          const startLine = fragmentStartLine;
          fragmentStartLine += lineCount;

          // Fail-fast check
          if (errorLines >= CONFIG.FAIL_FAST_THRESHOLD) {
            throw new Error(
              `Too many errors (${errorLines}), threshold: ${CONFIG.FAIL_FAST_THRESHOLD}`
            );
          }

          // Memory check
          checkMemoryThreshold(CONFIG.MEMORY_THRESHOLD_PERCENT, CONFIG.CONTAINER_MEMORY_MB);

          // BACKPRESSURE: wait for free worker
          const worker = await pool.getWorker();
          worker.busy = true;

          // Transfer buffer (zero-copy)
          const buf = Buffer.from(fragmentText);
          worker.instance.postMessage(
            {
              type: 'process_fragment',
              fragmentNumber,
              data: buf.buffer,
              startLineNumber: startLine,
            },
            [buf.buffer]
          );
        }
      }

      // 8. Flush last fragment
      if (fragmentBuffer.trim().length > 0) {
        fragmentNumber++;

        let lineCount = 1;
        let idx = -1;
        while ((idx = fragmentBuffer.indexOf('\n', idx + 1)) !== -1) lineCount++;

        const worker = await pool.getWorker();
        worker.busy = true;

        const buf = Buffer.from(fragmentBuffer);
        worker.instance.postMessage(
          {
            type: 'process_fragment',
            fragmentNumber,
            data: buf.buffer,
            startLineNumber: fragmentStartLine,
          },
          [buf.buffer]
        );
        fragmentBuffer = '';
      }

      // 9. Wait for all workers to finish
      await pool.waitAllDone();

      // 10. Log summary (no DB storage of individual errors)
      if (errorLines > 0) {
        console.log(`[FragmentProcessor] Job completed with ${errorLines.toLocaleString()} errors (not stored in DB)`);
        if (firstError) {
          console.log(`[FragmentProcessor] First error was at line ${firstError.lineNumber}: ${firstError.errorMessage}`);
        }
      }

      // 11. Final update → DONE
      const endTime = Date.now();
      const durationMs = endTime - startTime;
      const lps = durationMs > 0 ? Math.round(processedLines / (durationMs / 1000)) : 0;
      const bps = durationMs > 0 ? Math.round(processedBytes / (durationMs / 1000)) : 0;

      await db.update('fileproc.UploadJob', jobId).set({
        status: 'DONE',
        totalLines: processedLines,
        processedLines,
        processedBytes,
        errorLines,
        numFragments: fragmentNumber,
        fragmentsDone,
        finishedAt: new Date(endTime).toISOString(),
        totalDurationMs: durationMs,
        totalDurationText: formatDuration(durationMs),
        linesPerSecond: lps,
        bytesPerSecond: bps,
        validationPassed: errorLines === 0,
      });

      console.log(
        `[FragmentProcessor] Job ${jobId} DONE: ${processedLines.toLocaleString()} lines, ${errorLines} errors, ${formatDuration(durationMs)}`
      );
      logMemory('job-done');
    } catch (error) {
      // ── Error / Cancel handling ──
      const endTime = Date.now();
      const durationMs = endTime - startTime;
      const isCancelled =
        jobState.cancelled ||
        error.message === 'Job cancelled' ||
        error.name === 'AbortError' ||
        error.code === 'ERR_CANCELED';

      const finalStatus = isCancelled ? 'CANCELLED' : 'ERROR';
      const errorMsg = isCancelled ? 'Job cancelled by user' : error.message;

      console.log(`[FragmentProcessor] Job ${jobId} ${finalStatus}: ${errorMsg}`);

      try {
        await db.update('fileproc.UploadJob', jobId).set({
          status: finalStatus,
          errorMessage: errorMsg,
          processedLines,
          processedBytes,
          errorLines,
          finishedAt: new Date(endTime).toISOString(),
          totalDurationMs: durationMs,
          totalDurationText: formatDuration(durationMs),
        });
      } catch (e) {
        console.error('[FragmentProcessor] Error updating job status:', e.message);
      }
    } finally {
      // ── Cleanup ──
      const state = this._activeJobs.get(jobId);
      if (state) {
        clearInterval(state.heartbeatInterval);
        clearInterval(state.metricsInterval);
        if (state.pool) await state.pool.terminateAll();
      }
      this._activeJobs.delete(jobId);
      logMemory('after-cleanup');
    }
  }

  // ──────────────────────────────────────────
  // Reference data loading (TODO: real HANA queries)
  // ──────────────────────────────────────────
  async _loadReferenceData(_db) {
    // TODO: Replace with actual HANA queries when tables are available
    //
    // Example:
    //   const currencies = await db.read('ref.Currencies').columns('code');
    //   const provinces  = await db.read('ref.Provinces').columns('code');
    //   const products   = await db.read('ref.Products').columns('code');
    //   return {
    //     currencies: currencies.map(c => c.code),  // → array of strings
    //     provinces:  provinces.map(p => p.code),
    //     products:   products.map(p => p.code),     // ~600K entries
    //   };
    //
    // Workers convert these arrays to Sets for O(1) lookup.

    console.log('[FragmentProcessor] Reference data: using placeholder (no tables configured yet)');
    return {};
  }

  // ──────────────────────────────────────────
  // Auto-dequeue: start next QUEUED job
  // ──────────────────────────────────────────
  async _autoDequeue() {
    if (this._currentJobCount >= CONFIG.MAX_CONCURRENT_JOBS) return;

    try {
      const cds = require('@sap/cds');
      const db = await cds.connect.to('db');

      const nextJobs = await db
        .read('fileproc.UploadJob')
        .where({ status: 'QUEUED' })
        .orderBy('createdAt asc')
        .limit(1);

      if (nextJobs.length === 0) return;

      const job = nextJobs[0];
      console.log(`[FragmentProcessor] Auto-dequeuing job ${job.ID}`);

      // Get fresh download URL from SharePoint
      const sp = await cds.connect.to('SharePointService');
      const result = await sp.send('getDownloadUrl', { itemId: job.sharePointItemId });

      if (result && result.url) {
        await this.enqueue(job.ID, result.url);
      } else {
        console.error(`[FragmentProcessor] No download URL for job ${job.ID}`);
        await db.update('fileproc.UploadJob', job.ID).set({
          status: 'ERROR',
          errorMessage: 'Could not get download URL from SharePoint',
          finishedAt: new Date().toISOString(),
        });
        // Try next queued job
        await this._autoDequeue();
      }
    } catch (error) {
      console.error('[FragmentProcessor] Auto-dequeue error:', error.message);
    }
  }

  // ──────────────────────────────────────────
  // Startup recovery: detect stale PROCESSING jobs
  // ──────────────────────────────────────────
  async recoverStaleJobs() {
    try {
      const cds = require('@sap/cds');
      const db = await cds.connect.to('db');

      const staleThreshold = new Date(
        Date.now() - CONFIG.HEARTBEAT_TIMEOUT_MS
      ).toISOString();

      const staleJobs = await db
        .read('fileproc.UploadJob')
        .where(
          `status = 'PROCESSING' AND (heartbeatAt IS NULL OR heartbeatAt < '${staleThreshold}')`
        );

      for (const job of staleJobs) {
        console.log(
          `[FragmentProcessor] Recovering stale job ${job.ID} (heartbeat: ${job.heartbeatAt})`
        );
        await db.update('fileproc.UploadJob', job.ID).set({
          status: 'ERROR',
          errorMessage: 'Recovered after instance restart (stale heartbeat)',
          finishedAt: new Date().toISOString(),
        });
      }

      if (staleJobs.length > 0) {
        console.log(`[FragmentProcessor] Recovered ${staleJobs.length} stale jobs`);
      }

      // Auto-dequeue any waiting jobs
      await this._autoDequeue();
    } catch (error) {
      console.error('[FragmentProcessor] Recovery error:', error.message);
    }
  }
}

module.exports = new FragmentProcessor();
