"use strict";

const cds = require('@sap/cds');
const fragmentProcessor = require('./processing/fragmentProcessor');

module.exports = (srv) => {

  if (srv.name === 'FileProcService') {

    // ══════════════════════════════════════════
    // Startup recovery (runs once when service is served)
    // ══════════════════════════════════════════
    let recoveryDone = false;

    srv.before('*', async () => {
      if (recoveryDone) return;
      recoveryDone = true;
      try {
        console.log('[FileProcService] Running startup recovery...');
        await fragmentProcessor.recoverStaleJobs();
        console.log('[FileProcService] Startup recovery complete');
      } catch (err) {
        console.error('[FileProcService] Recovery error:', err.message);
      }
    });

    // ══════════════════════════════════════════
    // cancelJob: Cancel an active or queued job
    // ══════════════════════════════════════════
    srv.on('cancelJob', async (req) => {
      const { jobId } = req.data;
      const tx = srv.tx(req);

      const jobs = await tx.read('UploadJobs').where({ ID: jobId });
      if (!jobs || jobs.length === 0) {
        req.error(404, `Job not found: ${jobId}`);
        return;
      }

      const job = jobs[0];

      if (job.status === 'DONE' || job.status === 'CANCELLED' || job.status === 'ERROR') {
        return job; // Already finished
      }

      if (job.status === 'PROCESSING') {
        // Set cancel flag + trigger abort
        await tx.update('UploadJobs', jobId).set({ cancelRequested: true });
        fragmentProcessor.cancel(jobId);
        console.log(`[FileProcService] Cancel requested for job ${jobId}`);
      } else {
        // QUEUED or NEW → cancel directly
        await tx.update('UploadJobs', jobId).set({
          status: 'CANCELLED',
          errorMessage: 'Cancelled by user',
          finishedAt: new Date().toISOString(),
        });
        console.log(`[FileProcService] Job ${jobId} cancelled (was ${job.status})`);
      }

      const updated = await tx.read('UploadJobs').where({ ID: jobId });
      return updated[0];
    });

    // ══════════════════════════════════════════
    // deleteJob: Delete a job and its validation errors
    // ══════════════════════════════════════════
    srv.on('deleteJob', async (req) => {
      const { jobId } = req.data;
      const tx = srv.tx(req);

      // Cancel if active
      fragmentProcessor.cancel(jobId);

      await tx.delete('ValidationErrors').where({ job_ID: jobId });
      await tx.delete('UploadJobs').where({ ID: jobId });

      console.log(`[FileProcService] Job ${jobId} deleted`);
      return { deleted: 1 };
    });

    // ══════════════════════════════════════════
    // clearCompletedJobs
    // ══════════════════════════════════════════
    srv.on('clearCompletedJobs', async (req) => {
      const tx = srv.tx(req);

      const completed = await tx.read('UploadJobs').where({ status: 'DONE' });
      if (!completed || completed.length === 0) return { deleted: 0 };

      for (const job of completed) {
        await tx.delete('ValidationErrors').where({ job_ID: job.ID });
      }
      await tx.delete('UploadJobs').where({ status: 'DONE' });

      console.log(`[FileProcService] ${completed.length} completed jobs deleted`);
      return { deleted: completed.length };
    });

    // ══════════════════════════════════════════
    // clearAllJobs
    // ══════════════════════════════════════════
    srv.on('clearAllJobs', async (req) => {
      const tx = srv.tx(req);

      const allJobs = await tx.read('UploadJobs');
      const count = allJobs ? allJobs.length : 0;

      // Cancel any active jobs
      for (const job of allJobs) {
        if (job.status === 'PROCESSING') {
          fragmentProcessor.cancel(job.ID);
        }
      }

      await tx.delete('ValidationErrors');
      await tx.delete('UploadJobs');

      console.log(`[FileProcService] ${count} jobs deleted (all)`);
      return { deleted: count };
    });
  }
};
