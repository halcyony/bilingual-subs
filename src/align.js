import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { parse, toSrt } from './subtitle.js';

let alassBin; // undefined = not probed yet, null = not available

export function findAlass() {
  if (alassBin !== undefined) return alassBin;
  alassBin = null;
  for (const bin of [config.alassPath, 'alass', 'alass-cli']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) {
      alassBin = bin;
      break;
    }
  }
  return alassBin;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`alass exited ${code}: ${err.slice(-300)}`))));
  });
}

async function alignAlass(bin, refCues, cues) {
  const dir = await mkdtemp(path.join(tmpdir(), 'subalign-'));
  try {
    const ref = path.join(dir, 'ref.srt');
    const inp = path.join(dir, 'in.srt');
    const out = path.join(dir, 'out.srt');
    await writeFile(ref, toSrt(refCues));
    await writeFile(inp, toSrt(cues));
    await run(bin, [ref, inp, out]);
    return parse(await readFile(out, 'utf8'), 'out.srt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Fallback when alass isn't available: find the single offset (and common
// framerate ratio) that maximises overlap with the reference. No split
// handling, so it can't fix mid-file drift the way alass does.
const BIN = 100; // ms
const SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24];

// Best single (scale, shift) of `cues` against the reference, by how much
// subtitle-on time overlaps.
function bestShift(refCues, cues, { scales = [1], maxShiftMs = 120000, step = 2 } = {}) {
  const len = Math.ceil(Math.max(...refCues.map((c) => c.end), ...cues.map((c) => c.end)) * 1.1 / BIN) + 4000;
  const prefix = new Int32Array(len + 1);
  const occ = new Uint8Array(len);
  for (const c of refCues) for (let i = Math.max(0, Math.floor(c.start / BIN)); i < Math.ceil(c.end / BIN) && i < len; i++) occ[i] = 1;
  for (let i = 0; i < len; i++) prefix[i + 1] = prefix[i] + occ[i];
  const overlap = (scale, shiftBins) => {
    let sum = 0;
    for (const c of cues) {
      const a = Math.max(0, Math.min(len, Math.floor((c.start * scale) / BIN) + shiftBins));
      const b = Math.max(0, Math.min(len, Math.ceil((c.end * scale) / BIN) + shiftBins));
      sum += prefix[b] - prefix[a];
    }
    return sum;
  };
  let best = { scale: 1, shift: 0, score: -1 };
  const maxShift = Math.round(maxShiftMs / BIN);
  for (const scale of scales) {
    for (let s = -maxShift; s <= maxShift; s += step) {
      const v = overlap(scale, s);
      if (v > best.score) best = { scale, shift: s, score: v };
    }
  }
  for (let s = best.shift - step; s <= best.shift + step; s++) {
    const v = overlap(best.scale, s);
    if (v > best.score) best = { ...best, shift: s, score: v };
  }
  return { scale: best.scale, shiftMs: best.shift * BIN, overlap: best.score };
}

function alignFallback(refCues, cues) {
  const { scale, shiftMs } = bestShift(refCues, cues, { scales: SCALES });
  return cues.map((c) => ({ ...c, start: c.start * scale + shiftMs, end: c.end * scale + shiftMs }));
}

// How a file's timing relates to the reference:
//   'in-sync' — nothing to do
//   'offset'  — one constant delay (and/or a framerate ratio); fully fixable
//   'drift'   — different parts need different corrections (usually another cut).
//               `fixed` says whether the aligned result actually lines up.
const SYNC_MS = 300;
const DRIFT_MS = 1000;

function linearResiduals(times, shifts) {
  const n = times.length;
  const mt = times.reduce((s, x) => s + x, 0) / n;
  const ms = shifts.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (times[i] - mt) * (shifts[i] - ms);
    den += (times[i] - mt) ** 2;
  }
  const slope = den ? num / den : 0;
  return { slope, residuals: shifts.map((s, i) => s - (ms + slope * (times[i] - mt))) };
}

// Re-check the aligned result in chunks: each chunk's own best shift should be ~0.
function residualChunks(refCues, aligned, chunks = 6) {
  const size = Math.ceil(aligned.length / chunks);
  const out = [];
  for (let i = 0; i < aligned.length; i += size) {
    const part = aligned.slice(i, i + size);
    if (part.length < 15) continue;
    out.push(bestShift(refCues, part, { maxShiftMs: 15000, step: 1 }).shiftMs);
  }
  return out;
}

function analyseTiming(refCues, cues, aligned) {
  const times = cues.map((c) => c.start);
  const shifts = aligned.map((c, i) => c.start - cues[i].start);
  const { slope, residuals } = linearResiduals(times, shifts);
  const nonLinearShare = residuals.filter((r) => Math.abs(r) > DRIFT_MS).length / (residuals.length || 1);
  const chunkShifts = residualChunks(refCues, aligned);
  const badChunks = chunkShifts.filter((s) => Math.abs(s) > DRIFT_MS).length;
  const unfixed = badChunks >= 2 || chunkShifts.some((s) => Math.abs(s) > 3 * DRIFT_MS);
  const sorted = [...shifts].sort((a, b) => a - b);
  const spread = (sorted[Math.floor(sorted.length * 0.9)] ?? 0) - (sorted[Math.floor(sorted.length * 0.1)] ?? 0);
  let kind;
  if (unfixed || nonLinearShare > 0.1) kind = 'drift';
  else if (Math.abs(sorted[Math.floor(sorted.length / 2)] ?? 0) > SYNC_MS || spread > SYNC_MS) kind = 'offset';
  else kind = 'in-sync';
  return {
    kind,
    fixed: !unfixed,
    driftShare: nonLinearShare,
    fpsRatio: 1 + slope,
    chunkShiftsMs: chunkShifts,
  };
}

// Align `cues` to `refCues`. Returns the aligned cues, how far they moved
// (medianShiftMs signed, meanAbsShiftMs) and a `timing` verdict (see above).
export async function align(refCues, cues, { useAlass = true } = {}) {
  const bin = useAlass ? findAlass() : null;
  let aligned;
  let method;
  if (bin) {
    aligned = await alignAlass(bin, refCues, cues);
    method = 'alass';
    if (aligned.length !== cues.length) {
      // alass shouldn't drop cues; if it did, our shift stats would be wrong.
      aligned = alignFallback(refCues, cues);
      method = 'fallback(alass cue mismatch)';
    }
  } else {
    aligned = alignFallback(refCues, cues);
    method = 'fallback';
  }
  const shifts = aligned.map((c, i) => c.start - cues[i].start).sort((a, b) => a - b);
  const medianShiftMs = shifts.length ? shifts[Math.floor(shifts.length / 2)] : 0;
  const meanAbsShiftMs = shifts.reduce((s, x) => s + Math.abs(x), 0) / (shifts.length || 1);
  return { cues: aligned, method, medianShiftMs, meanAbsShiftMs, timing: analyseTiming(refCues, cues, aligned) };
}
