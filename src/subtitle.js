// Minimal SRT / VTT / ASS parsing into a common cue list:
//   [{ start, end, text }]  (milliseconds, text lines joined with \n)

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function toMs(h, m, s, frac) {
  return ((+h * 60 + +m) * 60 + +s) * 1000 + Math.round(+frac.padEnd(3, '0').slice(0, 3));
}

function stripTags(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function parseSrtLike(text) {
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx === -1) continue;
    const [a, b] = lines[idx].split('-->');
    const ma = a.match(TIME) || a.match(/(\d{1,2}):(\d{2})[,.](\d{1,3})/);
    const mb = b?.match(TIME) || b?.match(/(\d{1,2}):(\d{2})[,.](\d{1,3})/);
    if (!ma || !mb) continue;
    const start = ma.length === 5 ? toMs(ma[1], ma[2], ma[3], ma[4]) : toMs(0, ma[1], ma[2], ma[3]);
    const end = mb.length === 5 ? toMs(mb[1], mb[2], mb[3], mb[4]) : toMs(0, mb[1], mb[2], mb[3]);
    const body = stripTags(lines.slice(idx + 1).join('\n'));
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}

function parseAss(text) {
  const cues = [];
  let format = null;
  let inEvents = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      format = line.replace(/^format\s*:/i, '').split(',').map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line) || !format) continue;
    const parts = line.replace(/^dialogue\s*:/i, '').split(',');
    const fields = parts.slice(0, format.length - 1).map((s) => s.trim());
    fields.push(parts.slice(format.length - 1).join(','));
    const get = (k) => fields[format.indexOf(k)];
    const ts = (s) => {
      const m = s?.match(/(\d+):(\d{2}):(\d{2})[.](\d{1,3})/);
      return m ? toMs(m[1], m[2], m[3], m[4].padEnd(2, '0').padEnd(3, '0')) : null;
    };
    // ASS centiseconds: "0:00:01.50" → 1500ms. padEnd(3) above turns "50" into "500".
    const start = ts(get('start'));
    const end = ts(get('end'));
    const style = (get('style') || '').toLowerCase();
    if (start == null || end == null) continue;
    // Skip obvious non-dialogue layers (signs, karaoke, staff credits drawn with \p).
    const rawText = get('text') || '';
    if (/\\p[1-9]/.test(rawText)) continue;
    const body = stripTags(rawText.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '));
    if (body) cues.push({ start, end, text: body, style });
  }
  // Bilingual ASS often puts each language in its own Dialogue line with the
  // same timing; fold those into one cue so detection sees both languages.
  cues.sort((x, y) => x.start - y.start || x.end - y.end);
  const merged = [];
  for (const c of cues) {
    const prev = merged[merged.length - 1];
    if (prev && prev.start === c.start && prev.end === c.end) prev.text += `\n${c.text}`;
    else merged.push({ start: c.start, end: c.end, text: c.text });
  }
  return merged;
}

export function parse(text, name = '') {
  const isAss = /\.(ass|ssa)$/i.test(name) || /^\s*\[script info\]/im.test(text.slice(0, 500));
  const cues = isAss ? parseAss(text) : parseSrtLike(text);
  return cues.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
}

function fmt(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
}
