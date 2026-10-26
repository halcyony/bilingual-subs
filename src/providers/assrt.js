import { config } from '../config.js';
import { getJson, getBuffer } from '../http.js';
import { extractArchive, isSubtitleName } from '../archive.js';
import { nameMatchesEpisode } from '../episode.js';

const NAME = 'assrt';

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
