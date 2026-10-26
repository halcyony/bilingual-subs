#!/usr/bin/env node
import os from 'node:os';
import { readFile, appendFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import sdk from 'stremio-addon-sdk';
import { config } from '../src/config.js';
import { buildAddon, requestContext, manifest } from '../src/addon.js';
import { ensure } from '../src/jobs.js';
import { parseVideoId, videoLabel } from '../src/episode.js';
import { findAlass } from '../src/align.js';

const { getRouter } = sdk;
const token = config.addonToken;
const prefix = token ? `/${token}` : '';
const hideToken = (s) => (token ? s.split(token).join('***') : s);

// Everything printed is also appended to logs/addon.log.
const logFile = path.join(config.logsDir, 'addon.log');
mkdirSync(config.logsDir, { recursive: true });
const log = (...a) => {
  const line = `${new Date().toLocaleString('sv-SE')} ${hideToken(a.join(' '))}`; // local time, YYYY-MM-DD HH:MM:SS
  console.log(line);
  appendFile(logFile, `${line}\n`).catch(() => {});
};

const app = express();

// For container health checks; says nothing about the add-on.
app.get('/health', (req, res) => res.type('text/plain').send('ok'));

// One line per request: what was asked, by which app, and how it went.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ua = (req.get('user-agent') || '-').slice(0, 80);
    log(`HTTP ${req.method} ${decodeURIComponent(req.originalUrl).slice(0, 160)} -> ${res.statusCode} in ${Date.now() - started} ms  [${ua}]`);
  });
  next();
});

const routes = express.Router();

// Remember how the client reached us, so subtitle URLs point back the same way.
routes.use((req, res, next) => {
  const proto = req.get('x-forwarded-proto')?.split(',')[0] || req.protocol;
  const origin = config.publicUrl || `${proto}://${req.get('x-forwarded-host') || req.get('host')}`;
  requestContext.run({ baseUrl: `${origin}${prefix}` }, next);
});

// A one-cue SRT covering the whole film, shown instead of the real file when
// it isn't available yet. Players (Nuvio's PC app especially) freeze while a
// subtitle link is slow, so this link never waits long.
const placeholder = (zh, en) => `1\n00:00:00,000 --> 99:59:59,000\n${zh}\n${en}\n`;
const PREPARING = placeholder('中英字幕准备中…请稍后重新选择', 'Bilingual subtitles are being prepared. Select them again in a few seconds.');
const NOT_FOUND = placeholder('未找到中文字幕', 'No Chinese subtitles were found for this title.');

const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms));

// The finished SRT, or a placeholder if the search hasn't finished within a
// few seconds. Reselecting later fetches this same link and gets the real file.
routes.get('/sub/:videoId/:file.srt', async (req, res) => {
  // Movies: tt0111161. Episodes: tt0412142_1_6 (":" written as "_" in links).
  const video = parseVideoId(req.params.videoId.replace(/_/g, ':'));
  if (!video) return res.status(400).end();
  const { file } = req.params;
  const imdbId = videoLabel(video);
  const filename = file === '_' ? null : Buffer.from(file, 'base64url').toString('utf8');
  const result = await Promise.race([ensure(video, filename, log), timeout(config.subWaitMs)]);
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/x-subrip; charset=utf-8');
  if (result?.ok) return res.send(await readFile(result.file));
  res.set('Cache-Control', 'no-store');
  if (!result) log(`  placeholder for ${imdbId}: search still running`);
  res.send(result ? NOT_FOUND : PREPARING);
});

routes.get('/', (req, res) => res.redirect(`${prefix}/manifest.json`));
routes.use(getRouter(buildAddon(log)));

app.use(prefix || '/', routes);
app.use((req, res) => res.status(404).end());

app.listen(config.port, config.host, () => {
  const lan = config.host === '127.0.0.1' ? [] : Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  log(`${manifest.name} v${manifest.version} running`);
  log(`  aligner: ${findAlass() || 'built-in (alass not found)'}`);
  if (config.publicUrl) log(`  public:        ${config.publicUrl}${token ? '/<ADDON_TOKEN>' : ''}/manifest.json`);
  log(`  this machine:  http://127.0.0.1:${config.port}${token ? '/<ADDON_TOKEN>' : ''}/manifest.json`);
  for (const ip of lan) log(`  local network: http://${ip}:${config.port}${token ? '/<ADDON_TOKEN>' : ''}/manifest.json`);
});
