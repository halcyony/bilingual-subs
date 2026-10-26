import { splitLangs } from './detect.js';

const oneLine = (t) => t.split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

// Merge Chinese cues (already aligned to the English reference) into the
// English timeline: each Chinese cue goes to the English cue it overlaps most.
// Output text is "Chinese\nEnglish". Unmatched cues are kept on their own.
export function mergeBilingual(zhCues, enCues) {
  const slots = enCues.map((c) => ({ start: c.start, end: c.end, zh: [], en: oneLine(c.text) }));
  const orphans = [];
  let j = 0;
  for (const z of zhCues) {
    while (j < slots.length && slots[j].end <= z.start) j++;
    let best = -1;
    let bestOv = 0;
    for (let k = Math.max(0, j - 1); k < slots.length && slots[k].start < z.end; k++) {
      const ov = overlap(z, slots[k]);
      if (ov > bestOv) {
        bestOv = ov;
        best = k;
      }
    }
    // Require a meaningful overlap, otherwise the lines belong to different moments.
    if (best >= 0 && bestOv >= 0.3 * Math.min(z.end - z.start, slots[best].end - slots[best].start)) {
      slots[best].zh.push(oneLine(z.text));
    } else {
      orphans.push({ start: z.start, end: z.end, text: oneLine(z.text) });
    }
  }
  const merged = slots.map((s) => ({
    start: s.start,
    end: s.end,
    text: s.zh.length ? `${s.zh.join(' ')}\n${s.en}` : s.en,
  }));
  return [...merged, ...orphans].sort((a, b) => a.start - b.start);
}

// Normalise an existing bilingual file so every cue is "Chinese\nEnglish".
export function normaliseBilingual(cues) {
  return cues.map((c) => {
    const { zh, en } = splitLangs(c.text);
    return { start: c.start, end: c.end, text: [zh, en].filter(Boolean).join('\n') };
  });
}
