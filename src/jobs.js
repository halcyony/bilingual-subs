import { mkdir, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { run } from './pipeline.js';
import { videoKey, videoLabel } from './episode.js';

// Finished subtitles are stored on disk per (IMDb id, release filename), so a
// movie is only searched once. Failures are remembered for a while so a movie
// with no Chinese subs doesn't re-query every provider on every play.
const FAIL_TTL_MS = 6 * 60 * 60 * 1000;
// A failure caused by something temporary (a provider down, a download quota
// used up) is retried much sooner than "nothing exists".
const RETRY_TTL_MS = 10 * 60 * 1000;
// A saved subtitle is rebuilt in the background when it is next played after
// this long: better subtitles may have been uploaded since. Sooner if a
// provider failed while it was built.
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_DEGRADED_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_PARALLEL = 2;

const inFlight = new Map(); // key -> Promise<{ok, file?, error?}>
const refreshing = new Map(); // key -> Promise<boolean>
let running = 0;
const waiting = [];

// `video` is { imdbId, season, episode }.
// Bump when saved results should be rebuilt (e.g. a new output format). The
// downloads behind them stay cached, so a rebuild costs no download quota.
// v2: alternative-timing file.
const RESULT_VERSION = 2;

export const jobKey = (video, filename) =>
  createHash('sha1').update(`${videoKey(video)}|${filename || ''}|v${RESULT_VERSION}`).digest('hex').slice(0, 20);

const srtPath = (key) => path.join(config.resultsDir, `${key}.srt`);
// Same subtitle in the other timing group's timing (see pipeline.js), if any.
const altPath = (key) => path.join(config.resultsDir, `${key}.alt.srt`);
// When the result was built and whether anything failed on the way.
const metaPath = (key) => path.join(config.resultsDir, `${key}.meta.json`);
const failPath = (key) => path.join(config.resultsDir, `${key}.fail.json`);

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Write through a temp file so a reader never sees a half-written subtitle.
async function writeAtomic(file, data) {
  await writeFile(`${file}.tmp`, data, 'utf8');
  await rename(`${file}.tmp`, file);
}

async function slot() {
  if (running < MAX_PARALLEL) {
    running++;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
  running++;
}
function release() {
  running--;
  waiting.shift()?.();
}

const labelOf = (video, filename) => `[${videoLabel(video)}${filename ? ` ${filename.slice(0, 40)}` : ''}]`;
const runPipeline = (video, filename, log) => {
  const prefix = labelOf(video, filename);
  return run({ ...video, release: filename || null, log: (l) => log(l.split('\n').map((x) => `${prefix} ${x}`).join('\n')) });
};

async function save(key, result) {
  await mkdir(config.resultsDir, { recursive: true });
  if (result.altSrt) await writeAtomic(altPath(key), result.altSrt);
  else await rm(altPath(key), { force: true });
  await writeAtomic(srtPath(key), result.srt);
  await writeFile(metaPath(key), JSON.stringify({ at: Date.now(), degraded: Boolean(result.degraded) }));
  await rm(failPath(key), { force: true });
  return { ok: true, file: srtPath(key), altFile: result.altSrt ? altPath(key) : null, mode: result.mode };
}

// Current state without starting anything: 'ready' | 'failed' | 'running' | 'none'.
export async function status(key) {
  try {
    await stat(srtPath(key));
    return { state: 'ready', file: srtPath(key), altFile: (await exists(altPath(key))) ? altPath(key) : null };
  } catch {}
  if (inFlight.has(key)) return { state: 'running' };
  try {
    const f = JSON.parse(await readFile(failPath(key), 'utf8'));
    const left = (f.ttlMs ?? FAIL_TTL_MS) - (Date.now() - f.at);
    if (left > 0) return { state: 'failed', error: f.error, retryInMs: left };
  } catch {}
  return { state: 'none' };
}

// Start (or join) the pipeline for this movie/episode + release. Resolves when done.
export function ensure(video, filename, log = console.log) {
  const key = jobKey(video, filename);
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    const s = await status(key);
    if (s.state === 'ready') {
      refreshIfStale(video, filename, log);
      return { ok: true, file: s.file, altFile: s.altFile };
    }
    if (s.state === 'failed') return { ok: false, error: s.error, retryInMs: s.retryInMs };
    await slot();
    try {
      return await save(key, await runPipeline(video, filename, log));
    } catch (e) {
      log(`${labelOf(video, filename)} failed: ${e.message}`);
      // Only a clean "no subtitles exist" is worth remembering for hours.
      const ttlMs = e.code === 'NO_SUBTITLES' && !e.transient ? FAIL_TTL_MS : RETRY_TTL_MS;
      await mkdir(config.resultsDir, { recursive: true });
      await writeFile(failPath(key), JSON.stringify({ at: Date.now(), error: e.message, ttlMs }));
      return { ok: false, error: e.message, retryInMs: ttlMs };
    } finally {
      release();
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

// Rebuild a saved subtitle in the background if it is old enough. The saved
// one keeps being served meanwhile, and stays if the rebuild fails. Returns a
// promise for "was it rebuilt", or null when a rebuild is already under way.
export function refreshIfStale(video, filename, log = console.log) {
  const key = jobKey(video, filename);
  if (refreshing.has(key) || inFlight.has(key)) return null;
  const job = (async () => {
    let builtAt;
    let degraded = false;
    try {
      ({ at: builtAt, degraded = false } = JSON.parse(await readFile(metaPath(key), 'utf8')));
    } catch {
      // Saved before build details were recorded: go by the file's date.
      try {
        builtAt = (await stat(srtPath(key))).mtimeMs;
      } catch {
        return false;
      }
    }
    if (Date.now() - builtAt < (degraded ? REFRESH_DEGRADED_AFTER_MS : REFRESH_AFTER_MS)) return false;
    await slot();
    try {
      await save(key, await runPipeline(video, filename, log));
      log(`${labelOf(video, filename)} saved subtitle rebuilt`);
      return true;
    } catch (e) {
      log(`${labelOf(video, filename)} rebuild failed, keeping the saved subtitle: ${e.message}`);
      // Note the attempt so it isn't repeated on every play.
      const again = e.code !== 'NO_SUBTITLES' || Boolean(e.transient);
      await writeFile(metaPath(key), JSON.stringify({ at: Date.now(), degraded: again })).catch(() => {});
      return false;
    } finally {
      release();
    }
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, job);
  return job;
}
