// Anime catalogs identify titles by Kitsu or MyAnimeList ids
// ("kitsu:48649:1" = Kitsu entry 48649, episode 1). Subtitle sites work with
// IMDb ids, so these are translated with the community mapping list
// Fribb/anime-lists. Kitsu/MAL give every season its own entry; the list
// says which IMDb show and which (TVDB-numbered) season that entry is.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { getBuffer } from './http.js';

const LIST_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const listFile = () => path.join(config.cacheDir || config.resultsDir, 'anime-list-full.json');

let maps = null; // { kitsu: Map, mal: Map }
let loading = null;

function index(list) {
  const kitsu = new Map();
  const mal = new Map();
  for (const e of list) {
    const imdb = [].concat(e.imdb_id || []).find((x) => /^tt\d+$/.test(x));
    if (!imdb) continue;
    const entry = {
      imdbId: imdb,
      movie: e.type === 'MOVIE' || e.type === 'Movie',
      season: e.season?.tvdb ?? null,
      offset: e.episode_offset?.tvdb ?? 0,
    };
    if (e.kitsu_id) kitsu.set(String(e.kitsu_id), entry);
    if (e.mal_id) mal.set(String(e.mal_id), entry);
  }
  return { kitsu, mal };
}

async function load(log) {
  const file = listFile();
  let text = null;
  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs < MAX_AGE_MS) text = await readFile(file, 'utf8');
  } catch {
    // not downloaded yet
  }
  if (!text) {
    try {
      text = (await getBuffer(LIST_URL)).toString('utf8');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      log(`[anime] downloaded the Kitsu/MAL → IMDb mapping list`);
    } catch (e) {
      // Fall back to an old copy rather than failing every anime request.
      try {
        text = await readFile(file, 'utf8');
        log(`[anime] mapping list refresh failed (${e.message}); using the saved copy`);
      } catch {
        throw new Error(`anime mapping list unavailable: ${e.message}`);
      }
    }
  }
  return index(JSON.parse(text));
}

async function getMaps(log) {
  if (maps) return maps;
  loading ??= load(log).then((m) => {
    maps = m;
    // Re-read the list after a week so new shows get mapped.
    setTimeout(() => {
      maps = null;
      loading = null;
    }, MAX_AGE_MS).unref();
    return m;
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

export const isAnimeId = (id) => /^(kitsu|mal):\d+/.test(String(id));

// "kitsu:48649:1" → { imdbId: 'tt26743760', season: 2, episode: 1 }.
// "kitsu:1234" (a film) → { imdbId, season: null, episode: null }. null if unmapped.
export async function resolveAnimeId(id, log = () => {}) {
  const m = String(id).match(/^(kitsu|mal):(\d+)(?::(\d+))?$/);
  if (!m) return null;
  const [, source, sourceId, ep] = m;
  const entry = (await getMaps(log))[source].get(sourceId);
  if (!entry) return null;
  if (ep === undefined) return { imdbId: entry.imdbId, season: null, episode: null };
  return { imdbId: entry.imdbId, season: entry.season ?? 1, episode: Number(ep) + entry.offset };
}
