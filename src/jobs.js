import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { run } from './pipeline.js';
import { videoKey, videoLabel } from './episode.js';

// Finished subtitles are stored on disk per (IMDb id, release filename), so a
// movie is only searched once. Failures are remembered for a while so a movie
// with no Chinese subs doesn't re-query every provider on every play.
const FAIL_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PARALLEL = 2;

const inFlight = new Map(); // key -> Promise<{ok, file?, error?}>
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

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
const failPath = (key) => path.join(config.resultsDir, `${key}.fail.json`);

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

// Current state without starting anything: 'ready' | 'failed' | 'running' | 'none'.
export async function status(key) {
  try {
    await stat(srtPath(key));
    return { state: 'ready', file: srtPath(key), altFile: (await exists(altPath(key))) ? altPath(key) : null };
  } catch {}
  if (inFlight.has(key)) return { state: 'running' };
  try {
    const f = JSON.parse(await readFile(failPath(key), 'utf8'));
    if (Date.now() - f.at < FAIL_TTL_MS) return { state: 'failed', error: f.error };
  } catch {}
  return { state: 'none' };
}

// Start (or join) the pipeline for this movie/episode + release. Resolves when done.
export function ensure(video, filename, log = console.log) {
  const key = jobKey(video, filename);
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    const s = await status(key);
    if (s.state === 'ready') return { ok: true, file: s.file, altFile: s.altFile };
    if (s.state === 'failed') return { ok: false, error: s.error };
    await slot();
    const prefix = `[${videoLabel(video)}${filename ? ` ${filename.slice(0, 40)}` : ''}]`;
    try {
      const result = await run({ ...video, release: filename || null, log: (l) => log(l.split('\n').map((x) => `${prefix} ${x}`).join('\n')) });
      await mkdir(config.resultsDir, { recursive: true });
      if (result.altSrt) await writeFile(altPath(key), result.altSrt, 'utf8');
      await writeFile(srtPath(key), result.srt, 'utf8');
      return { ok: true, file: srtPath(key), altFile: result.altSrt ? altPath(key) : null, mode: result.mode };
    } catch (e) {
      log(`${prefix} failed: ${e.message}`);
      await mkdir(config.resultsDir, { recursive: true });
      await writeFile(failPath(key), JSON.stringify({ at: Date.now(), error: e.message }));
      return { ok: false, error: e.message };
    } finally {
      release();
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}
