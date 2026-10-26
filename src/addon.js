import { AsyncLocalStorage } from 'node:async_hooks';
import sdk from 'stremio-addon-sdk';
import { config } from './config.js';
import { ensure, status, jobKey } from './jobs.js';
import { parseVideoId, isEpisode, videoKey, videoLabel } from './episode.js';
import { isAnimeId, resolveAnimeId } from './anime.js';

const { addonBuilder } = sdk;

// The subtitle URL handed to Stremio must be absolute and reachable from the
// player, so it's built from the Host header of the incoming request
// (localhost, LAN IP or tunnel — whatever the client used).
export const requestContext = new AsyncLocalStorage();

const pkgVersion = '0.6.0';

export const manifest = {
  id: 'community.bilingual-subs.zh-en',
  version: pkgVersion,
  name: 'Bilingual Subs 中英双语',
  description: 'Chinese + English two-line subtitles. Finds an existing bilingual file, or merges the best Chinese and English subtitles, aligned with alass.',
  resources: ['subtitles'],
  // 'anime' for anime catalogs that use their own type name.
  types: ['movie', 'series', 'anime'],
  // Kitsu / MyAnimeList ids come from anime catalogs; see src/anime.js.
  idPrefixes: ['tt', 'kitsu:', 'mal:'],
  catalogs: [],
};

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

// In the link, an episode id "tt0412142:1:6" is written "tt0412142_1_6".
// The link ends in a readable file name because players label the track with
// it: Nuvio's automatic subtitle picker re-runs after every seek and switches
// to a built-in track unless it recognises the active one as your preferred
// language ("Chinese" in the label; mpv also tags ".zh.srt" as Chinese).
export const SUB_FILE_NAME = 'Chinese-English.zh.srt';
export const ALT_FILE_NAME = 'Chinese-English.alt.zh.srt';

function subtitleUrl(video, filename, name = SUB_FILE_NAME) {
  const base = requestContext.getStore()?.baseUrl || `http://127.0.0.1:${config.port}`;
  return `${base}/sub/${videoKey(video).replace(/:/g, '_')}/${filename ? b64url(filename) : '_'}/${name}`;
}

const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms));

export function buildAddon(log = console.log) {
  const builder = new addonBuilder(manifest);
  builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    let video;
    try {
      video = isAnimeId(id) ? await resolveAnimeId(id, log) : parseVideoId(id);
    } catch (e) {
      log(`subtitles request ${id}: ${e.message}`);
      return { subtitles: [] };
    }
    if (!video) {
      if (isAnimeId(id)) log(`subtitles request ${id}: no IMDb id known for it, skipped`);
      return { subtitles: [] };
    }
    if (type === 'movie' && isEpisode(video)) return { subtitles: [] };
    if (type === 'series' && !isEpisode(video)) return { subtitles: [] };
    const filename = extra?.filename || null;
    const via = isAnimeId(id) ? ` (from ${id})` : '';
    log(`subtitles request ${videoLabel(video)}${via}${filename ? ` (${filename})` : ''}`);

    const s = await status(jobKey(video, filename));
    if (s.state === 'failed') return { subtitles: [], cacheMaxAge: 3600 };

    // Give a fresh search a short head start, then answer with the entry
    // anyway: Nuvio drops late answers. Until the search finishes, the file
    // link serves a "being prepared" placeholder (see bin/server.js).
    let ready = s.state === 'ready';
    let hasAlt = Boolean(s.altFile);
    if (!ready) {
      const job = ensure(video, filename, log);
      const done = await Promise.race([job, timeout(config.answerWaitMs)]);
      if (done && !done.ok) return { subtitles: [], cacheMaxAge: 3600 };
      ready = Boolean(done?.ok);
      hasAlt = Boolean(done?.altFile);
    }
    const entries = [{ id: `bilingual-${videoKey(video)}`, url: subtitleUrl(video, filename), lang: config.subtitleLang }];
    // Second entry: the same subtitle in the other timing group's timing. Nuvio
    // labels both the same, so it's simply the second one listed.
    if (hasAlt) entries.push({ id: `bilingual-alt-${videoKey(video)}`, url: subtitleUrl(video, filename, ALT_FILE_NAME), lang: config.subtitleLang });
    log(`  answered ${videoLabel(video)}${ready ? '' : ' (search still running)'}${hasAlt ? ' + alternative timing' : ''}: lang="${config.subtitleLang}" url=${entries[0].url}`);
    return {
      subtitles: entries,
      // A finished search is final; while it runs, ask again soon so the
      // alternative-timing entry can appear once it's known.
      cacheMaxAge: ready ? 7 * 24 * 3600 : 60,
    };
  });
  return builder.getInterface();
}
