import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_ALASS = path.join(ROOT, 'tools', 'alass', process.platform === 'win32' ? 'alass-cli.exe' : 'alass-cli');

// Where cache/, results/ and logs/ live (a mounted volume in Docker).
const DATA_DIR = process.env.DATA_DIR || ROOT;

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  userAgent: process.env.USER_AGENT || 'stremio-bilingual-subs v0.3.0',
  opensubtitles: {
    apiKey: process.env.OPENSUBTITLES_API_KEY || '',
    username: process.env.OPENSUBTITLES_USERNAME || '',
    password: process.env.OPENSUBTITLES_PASSWORD || '',
    baseUrl: 'https://api.opensubtitles.com/api/v1',
  },
  subdl: {
    apiKey: process.env.SUBDL_API_KEY || '',
    baseUrl: 'https://api.subdl.com/api/v1',
    downloadBase: 'https://dl.subdl.com',
  },
  assrt: {
    token: process.env.ASSRT_TOKEN || '',
    baseUrl: 'https://api.assrt.net/v1',
  },
  // How many results per provider *per language bucket* to actually download.
  // Downloads are quota-limited on OpenSubtitles, so keep this small.
  maxDownloadsPerProvider: int(process.env.MAX_DOWNLOADS_PER_PROVIDER, 4),
  // OpenSubtitles counts every download against a daily quota (5 anonymous,
  // 100 for an "under dev" consumer), so it gets its own cap.
  maxOpenSubtitlesDownloads: int(process.env.MAX_OPENSUBTITLES_DOWNLOADS, 4),
  alassPath: process.env.ALASS_PATH || BUNDLED_ALASS,
  // Set CACHE_DIR= (empty) to disable the download cache.
  cacheDir: process.env.CACHE_DIR ?? path.join(DATA_DIR, 'cache'),
  // Finished subtitles served by the add-on.
  resultsDir: process.env.RESULTS_DIR || path.join(DATA_DIR, 'results'),
  logsDir: process.env.LOGS_DIR || path.join(DATA_DIR, 'logs'),
  port: int(process.env.PORT, 7000),
  // 0.0.0.0 = reachable from other devices on your network; 127.0.0.1 = this PC only.
  host: process.env.HOST || '0.0.0.0',
  // Public address behind a reverse proxy (e.g. https://subs.example.com).
  // Without it, subtitle links are built from the request's Host header.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // Optional secret path segment: when set, the add-on only answers under
  // /<token>/..., so a guessed domain alone can't use your API quotas.
  addonToken: (process.env.ADDON_TOKEN || '').replace(/^\/+|\/+$/g, ''),
  // Language code Stremio files the subtitle under. 'chi' shows as "Chinese";
  // a non-ISO value (e.g. "中英双语") is shown as-is.
  subtitleLang: process.env.SUBTITLE_LANG || 'chi',
  // How long the add-on waits for a fresh search before answering Stremio.
  answerWaitMs: int(process.env.ANSWER_WAIT_MS, 20000),
  httpTimeoutMs: int(process.env.HTTP_TIMEOUT_MS, 20000),
};
