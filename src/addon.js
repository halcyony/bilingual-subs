import { AsyncLocalStorage } from 'node:async_hooks';
import sdk from 'stremio-addon-sdk';
import { config } from './config.js';
import { ensure, status, jobKey } from './jobs.js';

const { addonBuilder } = sdk;

// The subtitle URL handed to Stremio must be absolute and reachable from the
// player, so it's built from the Host header of the incoming request
// (localhost, LAN IP or tunnel — whatever the client used).
export const requestContext = new AsyncLocalStorage();

const pkgVersion = '0.3.0';

export const manifest = {
  id: 'community.bilingual-subs.zh-en',
  version: pkgVersion,
  name: 'Bilingual Subs 中英双语',
  description: 'Chinese + English two-line subtitles. Finds an existing bilingual file, or merges the best Chinese and English subtitles, aligned with alass.',
  resources: ['subtitles'],
  types: ['movie'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

function subtitleUrl(imdbId, filename) {
  const base = requestContext.getStore()?.baseUrl || `http://127.0.0.1:${config.port}`;
  return `${base}/sub/${imdbId}/${filename ? b64url(filename) : '_'}.srt`;
}

const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms));

export function buildAddon(log = console.log) {
  const builder = new addonBuilder(manifest);
  builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    const imdbId = String(id).split(':')[0];
    if (type !== 'movie' || !/^tt\d+$/.test(imdbId)) return { subtitles: [] };
    const filename = extra?.filename || null;
    log(`subtitles request ${imdbId}${filename ? ` (${filename})` : ''}`);

    const s = await status(jobKey(imdbId, filename));
    if (s.state === 'failed') return { subtitles: [], cacheMaxAge: 3600 };

    // Give a fresh search a head start; if it's slower than that, answer with
    // the URL anyway — fetching it waits for the job to finish.
    if (s.state !== 'ready') {
      const job = ensure(imdbId, filename, log);
      const done = await Promise.race([job, timeout(config.answerWaitMs)]);
      if (done && !done.ok) return { subtitles: [], cacheMaxAge: 3600 };
    }
    const entry = { id: `bilingual-${imdbId}`, url: subtitleUrl(imdbId, filename), lang: config.subtitleLang };
    log(`  answered ${imdbId}: lang="${entry.lang}" url=${entry.url}`);
    return {
      subtitles: [entry],
      cacheMaxAge: s.state === 'ready' ? 7 * 24 * 3600 : 600,
    };
  });
  return builder.getInterface();
}
