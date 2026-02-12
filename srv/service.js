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
    // clearCompletedJobs: borra jobs en estado final (DONE, ERROR, CANCELLED)
    // Primero borra ValidationErrors (hijos) y luego UploadJobs para no violar FK.
    // Optimizado: borrado en batch usando IN para minimizar queries a BD.
    // ══════════════════════════════════════════
    const TERMINAL_STATUSES = ['DONE', 'ERROR', 'CANCELLED'];

    srv.on('clearCompletedJobs', async (req) => {
      const tx = srv.tx(req);

      const all = await tx.read('UploadJobs');
      const completed = (all || []).filter((j) => TERMINAL_STATUSES.includes(j.status));
      if (completed.length === 0) return { deleted: 0 };

      const jobIds = completed.map((j) => j.ID);

      // Borrado en batch: primero ValidationErrors, luego UploadJobs
      const { DELETE } = cds.ql;
      await tx.run(DELETE.from('ValidationErrors').where`job_ID in ${jobIds}`);
      await tx.run(DELETE.from('UploadJobs').where`ID in ${jobIds}`);

      console.log(`[FileProcService] ${completed.length} completed jobs deleted (DONE/ERROR/CANCELLED)`);
      return { deleted: completed.length };
    });

    // ══════════════════════════════════════════
    // clearAllJobs: borra todos los jobs y sus ValidationErrors de la BD.
    // Cancela los que estén PROCESSING/QUEUED antes de borrar.
    // ══════════════════════════════════════════
    srv.on('clearAllJobs', async (req) => {
      const tx = srv.tx(req);

      const allJobs = await tx.read('UploadJobs');
      const count = allJobs ? allJobs.length : 0;

      // Cancelar jobs activos antes de borrar
      for (const job of allJobs || []) {
        if (job.status === 'PROCESSING' || job.status === 'QUEUED') {
          fragmentProcessor.cancel(job.ID);
        }
      }

      // Borrado en batch: primero hijos, luego padres (evita violación de FK)
      const { DELETE } = cds.ql;
      await tx.run(DELETE.from('ValidationErrors'));
      await tx.run(DELETE.from('UploadJobs'));

      console.log(`[FileProcService] ${count} jobs deleted (all)`);
      return { deleted: count };
    });
  }
};
