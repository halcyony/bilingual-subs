// Weights are spaced so each criterion outranks everything after it in
// practice: bilingual > release match > timing vs English > completeness > Simplified.
// AI/machine-translated files sit below every human-made one.
export const WEIGHTS = {
  bilingual: 1000,
  release: 400,
  timing: 200,
  completeness: 100,
  simplified: 50,
  ai: -3000,
};

// Offset at which a constant delay stops earning extra points. Constant delays
// are corrected automatically, so this only breaks ties between fixable files.
const OFFSET_ZERO_MS = 10000;

function timingPoints(a) {
  if (!a) return 0;
  const t = a.timing;
  if (t.kind === 'in-sync') return WEIGHTS.timing;
  if (t.kind === 'offset') return Math.round(WEIGHTS.timing * (0.5 + 0.5 * Math.max(0, 1 - Math.abs(a.medianShiftMs) / OFFSET_ZERO_MS)));
  return t.fixed ? Math.round(WEIGHTS.timing * 0.25) : 0;
}

export function scoreCandidate(c, { refCueCount }) {
  const b = {};
  // A bilingual file whose drift couldn't be corrected is unusable as-is, so
  // it loses its bonus and competes as a plain Chinese file.
  const unfixableDrift = c.alignment?.timing.kind === 'drift' && !c.alignment.timing.fixed;
  b.bilingual = c.lang === 'bilingual' && !unfixableDrift ? WEIGHTS.bilingual : 0;
  b.release = Math.round(WEIGHTS.release * (c.release?.score || 0));
  b.timing = timingPoints(c.alignment);
  if (refCueCount) {
    const r = c.cues.length / refCueCount;
    b.completeness = Math.round(WEIGHTS.completeness * Math.min(r, 1 / r));
  } else {
    b.completeness = 0;
  }
  b.simplified = c.script === 'simplified' ? WEIGHTS.simplified : 0;
  b.ai = c.ai ? WEIGHTS.ai : 0;
  const total = Object.values(b).reduce((s, x) => s + x, 0);
  return { total, breakdown: b };
}
