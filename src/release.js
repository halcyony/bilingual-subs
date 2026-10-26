// Compare a video release filename with a subtitle's release name(s).
// Source and release group matter most for timing; resolution barely does.

const SOURCES = [
  ['remux', /\bremux\b/],
  ['bluray', /\b(blu-?ray|bdrip|brrip|bd25|bd50|bdremux)\b/],
  ['webdl', /\b(web-?dl|webdl)\b/],
  ['webrip', /\bweb-?rip\b/],
  ['web', /\bweb\b/],
  ['hdtv', /\bhdtv\b/],
  ['dvd', /\b(dvd-?rip|dvd|dvdscr|dvd5|dvd9)\b/],
  ['hdrip', /\bhd-?rip\b/],
];
const EDITIONS = /\b(extended|remastered|directors?[ .]?cut|unrated|imax|theatrical|criterion)\b/g;
const NOISE = new Set(['x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'aac', 'dts', 'ac3', 'eac3', 'atmos', 'truehd', 'mkv', 'mp4', 'avi', 'srt', 'ass', 'hdr', 'sdr', 'dv', '10bit', '8bit']);

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|m4v|srt|ass|ssa|vtt|zip|rar)$/g, '')
    .replace(/[\[\](){}_]/g, ' ')
    .replace(/\.(?=\S)/g, ' ');
}

export function features(name) {
  const s = norm(name);
  const source = SOURCES.find(([, re]) => re.test(s))?.[0] || null;
  const resolution = s.match(/\b(2160p|1080p|720p|576p|480p|4k)\b/)?.[1] || null;
  const group = String(name || '').replace(/\.(mkv|mp4|avi|srt|ass)$/i, '').match(/-([A-Za-z0-9]+)(?:\s*\[.*\])?$/)?.[1]?.toLowerCase() || null;
  const editions = [...s.matchAll(EDITIONS)].map((m) => m[1].replace(/[ .]/g, ''));
  const tokens = new Set(s.split(/[\s.\-+]+/).filter((t) => t.length > 1 && !NOISE.has(t) && !/^(19|20)\d{2}$/.test(t)));
  return { source, resolution, group, editions, tokens };
}

const sameFamily = (a, b) => a === b || (['webdl', 'webrip', 'web'].includes(a) && ['webdl', 'webrip', 'web'].includes(b)) || (['remux', 'bluray'].includes(a) && ['remux', 'bluray'].includes(b));

// Returns { score: 0..1, why: string[] }.
export function releaseMatch(videoName, subNames) {
  if (!videoName) return { score: 0, why: ['no release given'] };
  const v = features(videoName);
  let best = { score: 0, why: [] };
  for (const name of subNames || []) {
    const s = features(name);
    let score = 0;
    const why = [];
    if (v.group && s.group && v.group === s.group) {
      score += 0.45;
      why.push(`group=${v.group}`);
    }
    if (v.source && s.source) {
      if (v.source === s.source) {
        score += 0.3;
        why.push(`source=${v.source}`);
      } else if (sameFamily(v.source, s.source)) {
        score += 0.15;
        why.push(`source~${s.source}`);
      }
    }
    if (v.resolution && v.resolution === s.resolution) {
      score += 0.05;
      why.push(v.resolution);
    }
    const ed = v.editions.filter((e) => s.editions.includes(e));
    if (ed.length) {
      score += 0.1;
      why.push(`edition=${ed.join('+')}`);
    } else if (v.editions.length !== s.editions.length) {
      score -= 0.1;
      why.push('edition mismatch');
    }
    // Small bonus for other shared tokens (streaming service tags, etc.).
    const shared = [...v.tokens].filter((t) => s.tokens.has(t)).length;
    score += 0.1 * (shared / Math.max(1, v.tokens.size));
    score = Math.max(0, Math.min(1, score));
    if (score > best.score) best = { score, why, name };
  }
  return best;
}
