import { splitLangs } from './detect.js';

const oneLine = (t) => t.split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const HAN = /[㐀-䶿一-鿿豈-﫿]/;

// Only the Chinese lines of a cue from a Chinese file. Such files sometimes
// carry English lines too (songs, signs, untranslated lines), which would
// repeat the English line under them.
export const chineseLines = (text) => oneLine(text.split('\n').filter((l) => HAN.test(l)).join('\n'));

// English text without hearing-impaired extras: sound descriptions in
// brackets or parentheses ("[door slams]", "(laughs)") and speaker labels
// ("SKYLER: Hey."). A line left empty is dropped; a lone remaining dialogue
// line loses its "- ".
export function cleanEnglish(text) {
  const lines = text
    .split('\n')
    .map((l) =>
      l
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .replace(/^(\s*-?\s*)[A-Z][A-Z0-9 .'-]{0,30}[A-Z]:\s*/, '$1')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((l) => l && !/^-\s*$/.test(l));
  if (lines.length === 1) lines[0] = lines[0].replace(/^-\s*/, '');
  return lines.join(' ');
}

// The longest English text two or more joined English cues may have (two
// subtitle lines of about 42 characters).
const MAX_JOINED_CHARS = 84;
// A Chinese cue that would sit on its own needs at least this much screen
// time free of other cues; otherwise it joins the cue it overlaps most.
const MIN_FREE_MS = 500;

// Merge Chinese cues (already aligned to the English reference) into the
// English timeline. Output text is "Chinese\nEnglish".
//  - Each Chinese cue goes to the English cue it overlaps most.
//  - An English cue left without Chinese, but mostly covered by a Chinese cue
//    that went to the cue next to it, is joined with that neighbour, so the
//    Chinese line shows under both English lines.
//  - Chinese cues that match no English cue are kept on their own, cut to the
//    time no other cue uses so players don't stack them.
export function mergeBilingual(zhCues, enCues) {
  const slots = enCues
    .map((c) => ({ start: c.start, end: c.end, zh: [], en: cleanEnglish(c.text) }))
    .filter((s) => s.en);
  const zhs = zhCues.map((z) => ({ start: z.start, end: z.end, text: chineseLines(z.text) })).filter((z) => z.text);
  const orphans = [];
  let j = 0;
  for (const z of zhs) {
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
      slots[best].zh.push(z);
    } else {
      orphans.push(z);
    }
  }

  // joinNext[k]: English cues k and k + 1 become one output cue.
  const joinNext = new Array(slots.length).fill(false);
  for (let k = 0; k < slots.length; k++) {
    if (slots[k].zh.length) continue;
    let best = null;
    for (const n of [k - 1, k + 1]) {
      for (const z of slots[n]?.zh || []) {
        const ov = overlap(z, slots[k]);
        if (ov >= 0.5 * (slots[k].end - slots[k].start) && (!best || ov > best.ov)) best = { n, ov };
      }
    }
    if (best) joinNext[Math.min(k, best.n)] = true;
  }
  const groups = [];
  for (let k = 0; k < slots.length; k++) {
    const g = groups.at(-1);
    const joined = g && joinNext[k - 1] && g.en.length + 1 + slots[k].en.length <= MAX_JOINED_CHARS;
    if (joined) {
      g.end = Math.max(g.end, slots[k].end);
      g.en += ` ${slots[k].en}`;
      g.parts.push(slots[k].en);
      g.zh.push(...slots[k].zh);
    } else {
      groups.push({ start: slots[k].start, end: slots[k].end, en: slots[k].en, parts: [slots[k].en], zh: [...slots[k].zh] });
    }
  }
  // Joined cues are often two speakers. When the Chinese lines all mark
  // speakers with dashes, mark the English parts the same way.
  for (const g of groups) {
    if (g.parts.length > 1 && g.zh.length && g.zh.every((z) => /^\s*-/.test(z.text))) {
      g.en = g.parts.map((p) => (p.startsWith('-') ? p : `- ${p}`)).join(' ');
    }
  }

  // Orphans: keep the longest stretch of their time no merged cue uses; with
  // too little left, join the merged cue they overlap most instead.
  const lone = [];
  for (const z of orphans) {
    const busy = groups.filter((g) => overlap(g, z) > 0).sort((a, b) => a.start - b.start);
    let free = { start: z.start, end: z.start };
    let at = z.start;
    for (const g of [...busy, { start: z.end, end: z.end }]) {
      const gap = { start: at, end: Math.min(g.start, z.end) };
      if (gap.end - gap.start > free.end - free.start) free = gap;
      at = Math.max(at, g.end);
    }
    if (!busy.length) lone.push({ start: z.start, end: z.end, zh: [z], en: '' });
    else if (free.end - free.start >= MIN_FREE_MS) lone.push({ ...free, zh: [z], en: '' });
    else busy.reduce((a, b) => (overlap(b, z) > overlap(a, z) ? b : a)).zh.push(z);
  }

  return [...groups, ...lone]
    .map((g) => {
      const zh = [...g.zh].sort((a, b) => a.start - b.start).map((z) => z.text).join(' ');
      return { start: g.start, end: g.end, text: [zh, g.en].filter(Boolean).join('\n') };
    })
    .sort((a, b) => a.start - b.start);
}

// Normalise an existing bilingual file so every cue is "Chinese\nEnglish".
export function normaliseBilingual(cues) {
  return cues.map((c) => {
    const { zh, en } = splitLangs(c.text);
    return { start: c.start, end: c.end, text: [zh, en].filter(Boolean).join('\n') };
  });
}
