"use strict";

/**
 * Validation Worker Thread
 * Receives text fragments, validates each line, returns only errors.
 * All reference data lookups are O(1) via Sets.
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
    let fieldName = null;
    let fieldValue = null;

    if (columnCount < 12) {
      errorType = 'too_few_columns';
      errorMessage = `Expected >=12 columns, got ${columnCount}`;
    } else {
      const currency = (cols[3] || '').trim();
      const province = (cols[10] || '').trim();
      const product = (cols[11] || '').trim();

      // Required fields
      if (!currency) {
        errorType = 'missing_field';
        errorMessage = 'Currency is empty';
        fieldName = 'currency';
      } else if (!province) {
        errorType = 'missing_field';
        errorMessage = 'Province is empty';
        fieldName = 'province';
      } else if (!product) {
        errorType = 'missing_field';
        errorMessage = 'Product is empty';
        fieldName = 'product';
      }

      // Reference data validation (only if no basic error)
      if (!errorType && refData.currencies && !refData.currencies.has(currency)) {
        errorType = 'invalid_currency';
        errorMessage = `Currency '${currency}' not found`;
        fieldName = 'currency';
        fieldValue = currency;
      }
      if (!errorType && refData.provinces && !refData.provinces.has(province)) {
        errorType = 'invalid_province';
        errorMessage = `Province '${province}' not found`;
        fieldName = 'province';
        fieldValue = province;
      }
      if (!errorType && refData.products && !refData.products.has(product)) {
        errorType = 'invalid_product';
        errorMessage = `Product '${product}' not found`;
        fieldName = 'product';
        fieldValue = product;
      }
    }

    if (errorType) {
      errorCount++;
      // Only capture first error for diagnostics
      if (!firstError) {
        firstError = {
          lineNumber,
          errorType,
          errorMessage,
          fieldName,
          fieldValue: fieldValue || null,
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
