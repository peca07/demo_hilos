"use strict";

/**
 * Validation Worker Thread
 * Receives text fragments, validates structural integrity of each line.
 * Currently validates: minimum 18 columns per line (semicolon-delimited).
 */

const { parentPort, workerData } = require('worker_threads');

// Convert reference arrays to Sets for O(1) lookup
const refData = {};
if (workerData.referenceData) {
  for (const [tableName, arr] of Object.entries(workerData.referenceData)) {
    refData[tableName] = new Set(arr);
  }
}

const workerId = workerData.workerId || 0;

parentPort.on('message', (msg) => {
  if (msg.type !== 'process_fragment') return;

  const { fragmentNumber, data, startLineNumber } = msg;

  // Convert transferred ArrayBuffer back to string
  const text = Buffer.from(data).toString('utf8');
  const lines = text.split('\n');

  let processedLines = 0;
  let errorCount = 0;

  // Sample first error for diagnostics
  let firstError = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim().length === 0) continue;

    processedLines++;
    const lineNumber = startLineNumber + i;
    const cols = line.split(';');
    const columnCount = cols.length;

    let errorType = null;
    let errorMessage = null;

    // Only validation: column count must be >= 18
    if (columnCount < 18) {
      errorType = 'too_few_columns';
      errorMessage = `Expected >=18 columns, got ${columnCount}`;
    }

    if (errorType) {
      errorCount++;
      // Only capture first error for diagnostics
      if (!firstError) {
        firstError = {
          lineNumber,
          errorType,
          errorMessage,
          columnCount,
          rawLine: line.substring(0, 500), // Cap to 500 chars
        };
      }
    }
  }

  // Report results + worker memory
  const mem = process.memoryUsage();

  parentPort.postMessage({
    type: 'fragment_done',
    workerId,
    fragmentNumber,
    processedLines,
    processedBytes: Buffer.byteLength(text, 'utf8'),
    errorCount,
    firstError, // Only first error for diagnostics
    memory: { rss: mem.rss, heapUsed: mem.heapUsed },
  });
});
