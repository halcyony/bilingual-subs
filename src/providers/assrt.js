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
  const subs = res.sub?.subs || [];
  const out = [];
  for (const s of subs) {
    const names = [s.videoname, s.native_name].filter(Boolean);
    if (episodeQuery) {
      // Season packs (no episode in the name) stay; the file is picked later.
      if (names.some((n) => nameMatchesEpisode(n, season, episode) === false)) continue;
    } else {
      const years = names.join(' ').match(/\b(19|20)\d{2}\b/g) || [];
      if (year && years.length && !years.includes(String(year))) continue;
    }
    const ll = s.lang?.langlist || {};
    const hasZh = ll.langchs || ll.langcht || ll.langdou;
    out.push({
      provider: NAME,
      id: `${NAME}:${s.id}`,
      releases: names,
      labelLang: ll.langdou ? 'zh+en' : hasZh ? 'zh' : ll.langeng ? 'en' : (s.lang?.desc || '?'),
      downloads: s.down_count || 0,
      flags: { aiTranslated: false, machineTranslated: false },
      text: [...names, s.release_site, s.lang?.desc].filter(Boolean).join(' '),
      download: () => download(s.id),
    });
  }
  return out;
}

async function download(id) {
  const qs = new URLSearchParams({ token: config.assrt.token, id: String(id) });
  const res = await getJson(`${config.assrt.baseUrl}/sub/detail?${qs}`);
  const detail = res.sub?.subs?.[0];
  if (!detail) throw new Error('no detail');
  // Prefer individual files inside the archive (assrt exposes them directly).
  const files = (detail.filelist || []).filter((f) => isSubtitleName(f.f));
  if (files.length) {
    const results = [];
    for (const f of files) results.push({ name: f.f, data: await getBuffer(f.url) });
    return results;
  }
  if (!detail.url) throw new Error('no download url');
  return extractArchive(detail.filename || `${id}.bin`, await getBuffer(detail.url));
}
