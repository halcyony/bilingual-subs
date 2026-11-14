import { config } from '../config.js';
import { getJson, getBuffer } from '../http.js';
import { extractArchive, isSubtitleName } from '../archive.js';
import { nameMatchesEpisode } from '../episode.js';

const NAME = 'assrt';

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for']);
const wordsOf = (s) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// assrt matches loosely: a search for "Heat" also returns "ER", "The Practice"
// and "The Heat's On". Keep a hit only if one of its names carries the title:
// every word of a one- or two-word title, most words of a longer one (release
// names shorten long titles and differ between countries).
export function titleInNames(title, names) {
  const all = wordsOf(title);
  const key = all.filter((w) => !STOP_WORDS.has(w));
  const want = key.length ? key : all;
  if (!want.length) return true; // nothing to compare with (non-Latin title)
  const need = want.length <= 2 ? want.length : Math.ceil(want.length * 0.6);
  return names.some((n) => {
    const have = new Set(wordsOf(n));
    return want.filter((w) => have.has(w)).length >= need;
  });
}

// "S08E01", "S01", "Season 2", "第二季": a TV release, not a film.
const TV_MARKER = /\bS\d{1,2}(E\d{1,3})?\b|\bseason\s*\d+|第\s*[\d一二三四五六七八九十]+\s*季/i;

// assrt has no IMDb lookup, so we search by title and drop hits whose
// name carries a different year.
export async function search({ meta, season, episode }, log) {
  if (!config.assrt.token) {
    log(`[${NAME}] skipped: ASSRT_TOKEN not set`);
    return [];
  }
  const { title, year } = await meta;
  if (!title) {
    log(`[${NAME}] skipped: no title for search`);
    return [];
  }
  const episodeQuery = season != null && episode != null;
  const sxe = episodeQuery ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : '';
  const qs = new URLSearchParams({ token: config.assrt.token, q: episodeQuery ? `${title} ${sxe}` : title, cnt: '15', pos: '0' });
  const res = await getJson(`${config.assrt.baseUrl}/sub/search?${qs}`);
  if (res.status !== 0) throw new Error(`status ${res.status}: ${res.errmsg || 'search failed'}`);
  // assrt returns {} instead of [] when nothing matches.
  const subs = Array.isArray(res.sub?.subs) ? res.sub.subs : [];
  const out = [];
  for (const s of subs) {
    // The search reply comes in two shapes: the documented one (id, videoname,
    // lang.langlist) and a newer one (fileid, m_videoname, m_langn, m_source…).
    const id = s.id ?? s.fileid;
    if (!id) continue;
    const names = [...new Set([s.videoname, s.native_name, s.m_videoname, s.video_chinese_name, s.m_title].filter(Boolean))];
    if (!titleInNames(title, names)) continue;
    if (!episodeQuery && names.some((n) => TV_MARKER.test(n))) continue;
    if (episodeQuery) {
      // Season packs (no episode in the name) stay; the file is picked later.
      if (names.some((n) => nameMatchesEpisode(n, season, episode) === false)) continue;
    } else {
      const years = names.join(' ').match(/\b(19|20)\d{2}\b/g) || [];
      if (year && years.length && !years.includes(String(year))) continue;
    }
    const ll = s.lang?.langlist || Object.fromEntries((s.m_langn || []).map((k) => [k, true]));
    const hasZh = ll.langchs || ll.langcht || ll.langdou;
    // m_source says how it was made (原创翻译, 官方译本, 转载, 机翻…); it goes into
    // the text the AI/MT check reads.
    const source = s.m_source || s.m_extras?.producer?.source || '';
    out.push({
      provider: NAME,
      byId: false, // found by name: may be another title, checked in pipeline.js
      id: `${NAME}:${id}`,
      releases: names,
      labelLang: ll.langdou ? 'zh+en' : hasZh ? 'zh' : ll.langeng ? 'en' : (s.lang?.desc || s.m_lang || '?'),
      downloads: Number(s.down_count) || 0,
      flags: { aiTranslated: false, machineTranslated: false },
      text: [...names, s.release_site, s.m_rl_name, s.lang?.desc, source].filter(Boolean).join(' '),
      download: () => download(id),
    });
  }
  return out;
}

async function download(id) {
  const qs = new URLSearchParams({ token: config.assrt.token, id: String(id) });
  const res = await getJson(`${config.assrt.baseUrl}/sub/detail?${qs}`);
  const detail = res.sub?.subs?.[0];
  if (!detail) throw new Error('no detail');
  // Download the whole archive: assrt's per-file "onthefly" links now answer
  // 402/493 (noMoneyException) while the archive link still works. The
  // per-file links stay as a fallback for entries without an archive.
  if (detail.url) {
    try {
      return await extractArchive(detail.filename || `${id}.bin`, await getBuffer(detail.url));
    } catch (e) {
      if (!detail.filelist?.length) throw e;
    }
  }
  const files = (detail.filelist || []).filter((f) => isSubtitleName(f.f));
  if (!files.length) throw new Error('no download url');
  const results = [];
  for (const f of files) results.push({ name: f.f, data: await getBuffer(f.url) });
  return results;
}
