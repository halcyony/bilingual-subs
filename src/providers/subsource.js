import { config } from '../config.js';
import { getJson, getBuffer } from '../http.js';
import { extractArchive } from '../archive.js';
import { nameMatchesEpisode } from '../episode.js';

const NAME = 'subsource';

// SubSource (api.subsource.net, key in the X-API-Key header). A title is
// looked up by IMDb id, then its subtitles are listed per language. Series
// are listed per season with no episode filter, so files named for another
// episode are dropped here and season packs are opened after download.
// Chinese is labelled "chinese_bg_code" (GB) or "big_5_code" (Big5); the
// labels don't say which script the file is in, that is read from content.
// Measured on 7 titles: Chinese for Inception (10), The Wandering Earth (4),
// House season 1 (1, episode 1 only), Attack on Titan (1), none for
// Shawshank, Breaking Bad or Friends.
const LANGUAGES = { chinese_bg_code: 'zh', big_5_code: 'zh-tw', english: 'en' };

const headers = () => ({ 'X-API-Key': config.subsource.apiKey, Accept: 'application/json' });

export async function search({ imdbId, season, episode }, log) {
  if (!config.subsource.apiKey) {
    log(`[${NAME}] skipped: SUBSOURCE_API_KEY not set`);
    return [];
  }
  const episodeQuery = season != null && episode != null;
  const qs = new URLSearchParams({ searchType: 'imdb', imdb: imdbId });
  const found = await getJson(`${config.subsource.baseUrl}/movies/search?${qs}`, { headers: headers() });
  const titles = (found.data || []).filter((t) => t.imdbId === imdbId);
  const title = episodeQuery ? titles.find((t) => Number(t.season) === season) : titles.find((t) => t.season == null) || titles[0];
  if (!title) return [];
  const lists = await Promise.all(
    Object.keys(LANGUAGES).map((language) => {
      const q = new URLSearchParams({ movieId: String(title.movieId), language, limit: '100' });
      return getJson(`${config.subsource.baseUrl}/subtitles?${q}`, { headers: headers() });
    }),
  );
  const out = [];
  for (const s of lists.flatMap((l) => l.data || [])) {
    const names = (s.releaseInfo || []).filter(Boolean);
    if (episodeQuery && names.length && names.every((n) => nameMatchesEpisode(n, season, episode) === false)) continue;
    const made = String(s.productionType || '');
    out.push({
      provider: NAME,
      byId: true, // the title was found by IMDb id
      id: `${NAME}:${s.subtitleId}`,
      releases: names,
      labelLang: LANGUAGES[s.language] || s.language,
      downloads: Number(s.downloads) || 0,
      flags: {
        aiTranslated: /\bai\b/i.test(made),
        machineTranslated: /machine/i.test(made),
        hearingImpaired: Boolean(s.hearingImpaired),
        foreignPartsOnly: Boolean(s.foreignParts),
      },
      text: [...names, s.commentary].filter(Boolean).join(' '),
      download: async () =>
        extractArchive(`${NAME}-${s.subtitleId}.zip`, await getBuffer(`${config.subsource.baseUrl}/subtitles/${s.subtitleId}/download`, { headers: headers() })),
    });
  }
  return out;
}
