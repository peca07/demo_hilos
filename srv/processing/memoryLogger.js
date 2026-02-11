"use strict";

/**
 * Memory Logging Utility
 * Monitors RAM usage to prevent CF OOM kills
 */

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function logMemory(label) {
  const mem = process.memoryUsage();
  console.log(
    `[Memory:${label}] RSS: ${formatMB(mem.rss)} | Heap: ${formatMB(mem.heapUsed)}/${formatMB(mem.heapTotal)} | External: ${formatMB(mem.external)} | ArrayBuffers: ${formatMB(mem.arrayBuffers)}`
  );
  return mem;
}

function checkMemoryThreshold(thresholdPercent, containerMB) {
  const mem = process.memoryUsage();
  const rssMB = mem.rss / 1024 / 1024;
  const thresholdMB = containerMB * (thresholdPercent / 100);
  if (rssMB > thresholdMB) {
    console.warn(
      `[Memory] WARNING: RSS ${formatMB(mem.rss)} exceeds ${thresholdPercent}% of ${containerMB}MB (threshold: ${thresholdMB.toFixed(0)}MB)`
    );
    return false;
  }
  return true;
}

function getMemoryStats() {
  const mem = process.memoryUsage();
  return {
    rss: formatMB(mem.rss),
    heapUsed: formatMB(mem.heapUsed),
    heapTotal: formatMB(mem.heapTotal),
    external: formatMB(mem.external),
    arrayBuffers: formatMB(mem.arrayBuffers),
    rssMB: mem.rss / 1024 / 1024,
  };
}

module.exports = { logMemory, checkMemoryThreshold, getMemoryStats, formatMB };
