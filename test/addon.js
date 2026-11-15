// Checks for the add-on's answer to a player: which entries it lists, for which
// ids, and how long the player may keep the answer. Saved results are put in a
// temp folder by hand, so nothing touches the network. Run: node test/addon.js
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DATA = mkdtempSync(path.join(tmpdir(), 'bisubs-addon-'));
process.env.DATA_DIR = DATA;
process.env.CACHE_DIR = path.join(DATA, 'cache');
process.env.RESULTS_DIR = path.join(DATA, 'results');
process.env.LOGS_DIR = path.join(DATA, 'logs');
process.env.SUBTITLE_LANG = 'chi-test';
process.env.ANSWER_WAIT_MS = '200';
mkdirSync(process.env.RESULTS_DIR, { recursive: true });

const { buildAddon, requestContext, manifest, SUB_FILE_NAME, ALT_FILE_NAME } = await import('../src/addon.js');
const { jobKey } = await import('../src/jobs.js');
const { parseVideoId } = await import('../src/episode.js');

const addon = buildAddon(() => {});
const ask = (type, id, extra = {}, baseUrl = 'https://subs.example.test/tok') =>
  requestContext.run({ baseUrl }, () => addon.get('subtitles', type, id, extra));

const save = (id, filename, { alt = false, fail = null } = {}) => {
  const key = jobKey(parseVideoId(id), filename);
  const dir = process.env.RESULTS_DIR;
  if (fail) writeFileSync(path.join(dir, `${key}.fail.json`), JSON.stringify({ at: Date.now(), error: 'x', ttlMs: fail }));
  else writeFileSync(path.join(dir, `${key}.srt`), '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  if (alt) writeFileSync(path.join(dir, `${key}.alt.srt`), '1\n00:00:02,000 --> 00:00:03,000\nHi\n');
  // built just now: no background rebuild
  if (!fail) writeFileSync(path.join(dir, `${key}.meta.json`), JSON.stringify({ at: Date.now(), degraded: false }));
};

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

await test('the manifest asks for subtitles of movies, series and anime ids', () => {
  assert.deepEqual(manifest.resources, ['subtitles']);
  assert.deepEqual(manifest.types, ['movie', 'series', 'anime']);
  assert.deepEqual(manifest.idPrefixes, ['tt', 'kitsu:', 'mal:']);
});

await test('a saved movie subtitle is listed once, with a link ending in the readable file name', async () => {
  save('tt0111161', null);
  const res = await ask('movie', 'tt0111161');
  assert.equal(res.subtitles.length, 1);
  const [s] = res.subtitles;
  assert.equal(s.lang, 'chi-test');
  assert.equal(s.url, `https://subs.example.test/tok/sub/tt0111161/_/${SUB_FILE_NAME}`);
  assert.equal(res.cacheMaxAge, 7 * 24 * 3600, 'a finished search is final');
});

await test('an episode link writes the id with underscores and carries the file name', async () => {
  save('tt0412142:1:6', 'House.S01E06.720p.mkv');
  const res = await ask('series', 'tt0412142:1:6', { filename: 'House.S01E06.720p.mkv' });
  const name = Buffer.from('House.S01E06.720p.mkv').toString('base64url');
  assert.equal(res.subtitles[0].url, `https://subs.example.test/tok/sub/tt0412142_1_6/${name}/${SUB_FILE_NAME}`);
});

await test('a second timing is listed as a second entry', async () => {
  save('tt0903747:1:1', null, { alt: true });
  const res = await ask('series', 'tt0903747:1:1');
  assert.equal(res.subtitles.length, 2);
  assert.equal(res.subtitles[0].id, 'bilingual-tt0903747:1:1');
  assert.equal(res.subtitles[1].id, 'bilingual-alt-tt0903747:1:1');
  assert.ok(res.subtitles[1].url.endsWith(`/${ALT_FILE_NAME}`));
  assert.equal(res.subtitles[1].lang, res.subtitles[0].lang);
});

await test('the link follows the address the player used', async () => {
  save('tt0111161', null);
  const res = await ask('movie', 'tt0111161', {}, 'http://192.168.1.5:7000/tok');
  assert.ok(res.subtitles[0].url.startsWith('http://192.168.1.5:7000/tok/sub/'));
});

await test('a remembered failure gives an empty answer the player may keep for 1 to 60 minutes', async () => {
  save('tt0000001', null, { fail: 6 * 3600 * 1000 });
  let res = await ask('movie', 'tt0000001');
  assert.deepEqual(res.subtitles, []);
  assert.equal(res.cacheMaxAge, 3600, 'capped at an hour');
  save('tt0000002', null, { fail: 5 * 60 * 1000 });
  res = await ask('movie', 'tt0000002');
  assert.deepEqual(res.subtitles, []);
  assert.ok(res.cacheMaxAge >= 60 && res.cacheMaxAge <= 5 * 60, `cacheMaxAge ${res.cacheMaxAge}`);
});

await test('the wrong kind of id for the type, and unreadable ids, get nothing', async () => {
  assert.deepEqual((await ask('movie', 'tt0412142:1:6')).subtitles, [], 'an episode asked as a movie');
  assert.deepEqual((await ask('series', 'tt0111161')).subtitles, [], 'a movie asked as a series');
  assert.deepEqual((await ask('movie', 'tt-nope')).subtitles, []);
  assert.deepEqual((await ask('series', 'tt0412142:x:y')).subtitles, []);
});

console.log(`\n${passed} passed`);
process.exit(0);
