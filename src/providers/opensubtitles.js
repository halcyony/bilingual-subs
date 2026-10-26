import { config } from '../config.js';
import { getJson, getBuffer, sleep } from '../http.js';

const NAME = 'opensubtitles';
let session = null; // { token, base }

function headers(extra = {}) {
  const h = { 'Api-Key': config.opensubtitles.apiKey, Accept: 'application/json', ...extra };
  if (session?.token) h.Authorization = `Bearer ${session.token}`;
  return h;
}

// Logging in is optional; it raises the daily download quota.
async function ensureLogin(log) {
  if (session || !config.opensubtitles.username || !config.opensubtitles.password) return;
  try {
    const res = await getJson(`${config.opensubtitles.baseUrl}/login`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ username: config.opensubtitles.username, password: config.opensubtitles.password }),
    });
    session = { token: res.token, base: res.base_url ? `https://${res.base_url}/api/v1` : config.opensubtitles.baseUrl };
  } catch (e) {
    log(`[${NAME}] login failed, continuing anonymously: ${e.message}`);
    session = { token: null, base: config.opensubtitles.baseUrl };
  }
}

// Some shows (often anime) are filed with later seasons numbered by running
// total: season 2 episode 2 of a show with a 24-episode season 1 is "S2E26".
// For season 2+, the running-total number is searched too.
async function runningTotalEpisode(meta, season, episode) {
  if (season == null || season < 2 || !meta) return null;
  const counts = (await meta).seasonEpisodeCounts || {};
  let before = 0;
  for (let s = 1; s < season; s++) {
    if (!counts[s]) return null; // incomplete season list: can't compute it
    before += counts[s];
  }
  return before ? before + episode : null;
}

export async function search({ imdbId, season, episode, meta }, log) {
  if (!config.opensubtitles.apiKey) {
    log(`[${NAME}] skipped: OPENSUBTITLES_API_KEY not set`);
    return [];
  }
  await ensureLogin(log);
  const numericId = String(Number.parseInt(imdbId.replace(/^tt/, ''), 10));
  // OpenSubtitles asks for alphabetically sorted params and lowercase values.
  // Two queries so English results can't crowd Chinese ones out of page 1.
  const episodeQuery = season != null && episode != null;
  const episodeNumbers = [episode];
  if (episodeQuery) {
    const total = await runningTotalEpisode(meta, season, episode);
    if (total && total !== episode) episodeNumbers.push(total);
  }
  const queries = (episodeQuery ? episodeNumbers : [null]).flatMap((ep) =>
    ['en', 'ze,zh-cn,zh-tw'].map((languages) => {
      // Episodes are looked up by the show's id (parent_imdb_id) + numbers.
      const params = episodeQuery
        ? { episode_number: String(ep), languages, order_by: 'download_count', parent_imdb_id: numericId, season_number: String(season), type: 'episode' }
        : { imdb_id: numericId, languages, order_by: 'download_count', type: 'movie' };
      const qs = new URLSearchParams(params);
      return getJson(`${config.opensubtitles.baseUrl}/subtitles?${qs}`, { headers: headers() });
    }),
  );
  const results = await Promise.all(queries);
  const out = [];
  const seen = new Set();
  for (const res of results) {
    for (const item of res.data || []) {
      const a = item.attributes;
      const file = a.files?.[0];
      if (!file || seen.has(a.subtitle_id)) continue;
      seen.add(a.subtitle_id);
      out.push({
        provider: NAME,
        id: `${NAME}:${a.subtitle_id}`,
        releases: [a.release, file.file_name].filter(Boolean),
        labelLang: String(a.language || '').toLowerCase(),
        downloads: a.download_count || 0,
        flags: {
          aiTranslated: Boolean(a.ai_translated),
          machineTranslated: Boolean(a.machine_translated),
        },
        text: [a.release, a.comments].filter(Boolean).join(' '),
        download: () => download(file.file_id, file.file_name),
      });
    }
  }
  return out;
}

// OpenSubtitles rejects bursts of requests (HTTP 429), so downloads run one at
// a time with a short gap, and a 429 is retried after a pause.
let queue = Promise.resolve();
const GAP_MS = 400;

function download(fileId, fileName) {
  const job = queue.then(() => downloadNow(fileId, fileName));
  queue = job.catch(() => {}).then(() => sleep(GAP_MS));
  return job;
}

async function downloadNow(fileId, fileName, attempt = 1) {
  const base = session?.base || config.opensubtitles.baseUrl;
  let res;
  try {
    res = await getJson(`${base}/download`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }),
    });
  } catch (e) {
    if (e.status === 429 && attempt < 3) {
      await sleep(1500 * attempt);
      return downloadNow(fileId, fileName, attempt + 1);
    }
    throw e;
  }
  if (!res.link) throw new Error(`no download link (${res.message || 'quota?'})`);
  return [{ name: `${fileName || fileId}.srt`, data: await getBuffer(res.link) }];
}
