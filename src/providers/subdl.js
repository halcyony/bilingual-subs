import { config } from '../config.js';
import { getJson, getBuffer } from '../http.js';
import { extractArchive } from '../archive.js';

const NAME = 'subdl';

// For an episode, SubDL also returns season packs and episode ranges; keep the
// ones that cover this episode (the right file is picked after download).
function coversEpisode(s, season, episode) {
  if (s.season != null && Number(s.season) !== season) return false;
  if (s.full_season) return true;
  const from = Number(s.episode_from ?? s.episode);
  const to = Number(s.episode_end) || from;
  if (!Number.isFinite(from)) return true;
  return episode >= from && episode <= to;
}

export async function search({ imdbId, season, episode }, log) {
  if (!config.subdl.apiKey) {
    log(`[${NAME}] skipped: SUBDL_API_KEY not set`);
    return [];
  }
  const episodeQuery = season != null && episode != null;
  // ZH = Chinese, ZH_BG = Chinese (Big5 / Traditional). Labels are only used
  // for querying; the actual script is detected from content later.
  // Separate queries so English results can't fill the page and hide Chinese ones.
  const queries = ['EN', 'ZH,ZH_BG'].map(async (languages) => {
    const qs = new URLSearchParams({
      api_key: config.subdl.apiKey,
      imdb_id: imdbId,
      type: episodeQuery ? 'tv' : 'movie',
      ...(episodeQuery ? { season_number: String(season), episode_number: String(episode) } : {}),
      languages,
      subs_per_page: '30',
      releases: '1',
      comment: '1',
    });
    const res = await getJson(`${config.subdl.baseUrl}/subtitles?${qs}`);
    if (res.status === false) throw new Error(res.error || res.message || 'search failed');
    return res.subtitles || [];
  });
  let subs = (await Promise.all(queries)).flat();
  if (episodeQuery) subs = subs.filter((s) => coversEpisode(s, season, episode));
  return subs.map((s, i) => {
    const lang = String(s.language || s.lang || '').toLowerCase();
    // Download URLs come back with our api_key appended; keep it out of ids/logs.
    const urlPath = String(s.url || '').split('?')[0];
    return {
      provider: NAME,
      id: `${NAME}:${urlPath.replace(/^\/subtitle\//, '').replace(/\.zip$/, '') || s.sd_id || i}`,
      releases: [s.release_name, s.name, ...(s.releases || [])].filter(Boolean),
      labelLang: lang.startsWith('en') ? 'en' : lang,
      downloads: 0, // SubDL's API does not expose download counts
      flags: { aiTranslated: false, machineTranslated: false },
      text: [s.release_name, s.name, s.comment, s.author].filter(Boolean).join(' '),
      download: async () => extractArchive(`${s.name || 'subdl'}.zip`, await getBuffer(`${config.subdl.downloadBase}${s.url}`)),
    };
  });
}
