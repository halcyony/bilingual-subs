import { readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Keeps the data folder from growing forever: old downloads, subtitles nobody
// has played for a long time, and the log file.
const DAY_MS = 24 * 60 * 60 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;
const FAIL_NOTE_MAX_AGE_MS = DAY_MS;

const olderThan = async (file, ms) => {
  try {
    return Date.now() - (await stat(file)).mtimeMs > ms;
  } catch {
    return false;
  }
};

// Cached downloads: one folder per download, dated by its index file.
async function pruneCache(maxAgeMs) {
  if (!config.cacheDir) return 0;
  let removed = 0;
  let entries = [];
  try {
    entries = await readdir(config.cacheDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue; // the anime id list lives here too; it refreshes itself
    const dir = path.join(config.cacheDir, e.name);
    if (await olderThan(path.join(dir, 'index.json'), maxAgeMs)) {
      await rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

// Saved subtitles: a play after a week rewrites them (see jobs.js), so an old
// date means nobody has played the title since.
async function pruneResults(maxAgeMs) {
  let removed = 0;
  let names = [];
  try {
    names = await readdir(config.resultsDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const limit = name.endsWith('.fail.json') ? FAIL_NOTE_MAX_AGE_MS : maxAgeMs;
    const file = path.join(config.resultsDir, name);
    if (await olderThan(file, limit)) {
      await rm(file, { force: true });
      removed++;
    }
  }
  return removed;
}

// One previous log is kept as addon.log.1.
async function rotateLog(maxBytes) {
  const file = path.join(config.logsDir, 'addon.log');
  try {
    if ((await stat(file)).size <= maxBytes) return false;
    await rename(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

export async function housekeeping(log = () => {}) {
  const cache = await pruneCache(config.cacheMaxAgeDays * DAY_MS);
  const results = await pruneResults(config.resultsMaxAgeDays * DAY_MS);
  const rotated = await rotateLog(config.logMaxBytes);
  if (cache || results || rotated) log(`housekeeping: removed ${cache} old download(s) and ${results} old result file(s)${rotated ? ', rotated the log' : ''}`);
  return { cache, results, rotated };
}

export function startHousekeeping(log) {
  const tick = () => housekeeping(log).catch((e) => log(`housekeeping failed: ${e.message}`));
  tick();
  setInterval(tick, EVERY_MS).unref();
}
