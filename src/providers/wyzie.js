import { config } from '../config.js';
import { getJson, getBuffer } from '../http.js';

const NAME = 'wyzie';

// Wyzie Subs (sub.wyzie.io) searches by IMDb id. Of the sources on its free
// plan only "charlie" is used: it serves the OpenSubtitles.org catalogue, and
// its downloads don't count against our OpenSubtitles download quota. The
// others were checked on Shawshank and House: "quebec" matched by name (House
// of the Dragon for House), "oscar" only had Wyzie's own AI translations, and
// "xray" only English. Wyzie's AI translations ("ai-..." ids) are left out.
const SOURCE = 'charlie';
// A title Wyzie hasn't looked up recently takes about 5.3 s (measured on 3
// titles; under 1 s once it has), so it gets longer than the shared 6 s.
export const SEARCH_TIMEOUT_MS = 12000;

// On the free plan every file starts with an advert cue ("You're on the free
// plan. Unlock every source, AI translation & ad-free subs → sub.wyzie.io").
// It is removed: it would also make the file look machine-translated.
export function withoutAdvert(buf) {
  const text = buf.toString('utf8');
  const blocks = text.split(/\r?\n\r?\n/);
  const kept = blocks.filter((b) => !/sub\.wyzie\.(io|ru)|free plan/i.test(b));
  return kept.length === blocks.length ? buf : Buffer.from(kept.join('\n\n'), 'utf8');
}

const LANG = (code) => {
  const c = String(code || '').toLowerCase();
  if (c === 'en') return 'en';
  if (c === 'zt' || /^zh-(tw|hk|hant)$/.test(c)) return 'zh-tw';
  if (c === 'zh' || /^zh-(cn|hans)$/.test(c)) return 'zh-cn';
  return c;
};

export async function search({ imdbId, season, episode }, log) {
  if (!config.wyzie.apiKey) {
    log(`[${NAME}] skipped: WYZIE_API_KEY not set`);
    return [];
  }
  const episodeQuery = season != null && episode != null;
  const queries = ['zh', 'en'].map(async (language) => {
    const qs = new URLSearchParams({
      id: imdbId,
      ...(episodeQuery ? { season: String(season), episode: String(episode) } : {}),
      language,
      source: SOURCE,
      key: config.wyzie.apiKey,
    });
    try {
      return await getJson(`${config.wyzie.baseUrl}/search?${qs}`);
    } catch (e) {
      // "No subtitles found" comes back as HTTP 404: an answer, not a failure.
      if (e.status === 404) return [];
      throw e;
    }
  });
  const out = [];
  const seen = new Set();
  for (const list of await Promise.all(queries)) {
    for (const s of Array.isArray(list) ? list : []) {
      if (s.ai || String(s.id).startsWith('ai-') || seen.has(s.id) || !s.url) continue;
      seen.add(s.id);
      out.push({
        provider: NAME,
        byId: true, // found by IMDb id, so it is for this title
        id: `${NAME}:${s.id}`,
        releases: [s.release, ...(s.releases || []), s.fileName].filter(Boolean),
        labelLang: LANG(s.language),
        downloads: Number(s.downloadCount) || 0,
        flags: { aiTranslated: false, machineTranslated: false },
        text: [s.release, s.fileName].filter(Boolean).join(' '),
        download: async () => [{ name: s.fileName || `${s.id}.${s.format || 'srt'}`, data: withoutAdvert(await getBuffer(s.url)) }],
      });
    }
  }
  return out;
}
