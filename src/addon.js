import { AsyncLocalStorage } from 'node:async_hooks';
import sdk from 'stremio-addon-sdk';
import { config } from './config.js';
import { ensure, status, jobKey } from './jobs.js';
import { parseVideoId, isEpisode, videoKey, videoLabel } from './episode.js';

const { addonBuilder } = sdk;

// The subtitle URL handed to Stremio must be absolute and reachable from the
// player, so it's built from the Host header of the incoming request
// (localhost, LAN IP or tunnel — whatever the client used).
export const requestContext = new AsyncLocalStorage();

const pkgVersion = '0.4.0';

export const manifest = {
  id: 'community.bilingual-subs.zh-en',
  version: pkgVersion,
  name: 'Bilingual Subs 中英双语',
  description: 'Chinese + English two-line subtitles. Finds an existing bilingual file, or merges the best Chinese and English subtitles, aligned with alass.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

// In the link, an episode id "tt0412142:1:6" is written "tt0412142_1_6".
function subtitleUrl(video, filename) {
  const base = requestContext.getStore()?.baseUrl || `http://127.0.0.1:${config.port}`;
  return `${base}/sub/${videoKey(video).replace(/:/g, '_')}/${filename ? b64url(filename) : '_'}.srt`;
}

const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms));

export function buildAddon(log = console.log) {
  const builder = new addonBuilder(manifest);
  builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    const video = parseVideoId(id);
    if (!video) return { subtitles: [] };
    if (type === 'movie' ? isEpisode(video) : type !== 'series' || !isEpisode(video)) return { subtitles: [] };
    const filename = extra?.filename || null;
    log(`subtitles request ${videoLabel(video)}${filename ? ` (${filename})` : ''}`);

    const s = await status(jobKey(video, filename));
    if (s.state === 'failed') return { subtitles: [], cacheMaxAge: 3600 };

    // Give a fresh search a short head start, then answer with the entry
    // anyway: Nuvio drops late answers. Until the search finishes, the file
    // link serves a "being prepared" placeholder (see bin/server.js).
    let ready = s.state === 'ready';
    if (!ready) {
      const job = ensure(video, filename, log);
      const done = await Promise.race([job, timeout(config.answerWaitMs)]);
      if (done && !done.ok) return { subtitles: [], cacheMaxAge: 3600 };
      ready = Boolean(done?.ok);
    }
    const entry = { id: `bilingual-${videoKey(video)}`, url: subtitleUrl(video, filename), lang: config.subtitleLang };
    log(`  answered ${videoLabel(video)}${ready ? '' : ' (search still running)'}: lang="${entry.lang}" url=${entry.url}`);
    return {
      subtitles: [entry],
      cacheMaxAge: ready ? 7 * 24 * 3600 : 60,
    };
  });
  return builder.getInterface();
}
