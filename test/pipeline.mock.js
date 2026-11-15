// End-to-end pipeline run against a stubbed fetch() that mimics the three
// provider APIs (response shapes as documented). No network or keys needed.
// Run: node test/pipeline.mock.js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import AdmZip from 'adm-zip';
import { toSrt } from '../src/subtitle.js';

process.env.OPENSUBTITLES_API_KEY = 'test';
process.env.SUBDL_API_KEY = 'test';
process.env.ASSRT_TOKEN = 'test';
process.env.CACHE_DIR = ''; // no cache: each scenario must really download
process.env.RESULTS_DIR = mkdtempSync(path.join(tmpdir(), 'bisubs-results-'));
// Translation is off unless a scenario turns it on (keys in a local .env must not leak in).
process.env.DEEPL_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
// Wyzie is off unless a scenario turns it on.
process.env.WYZIE_API_KEY = '';
process.env.WYZIE_BASE_URL = 'https://wyzie.mock';
process.env.SUBSOURCE_API_KEY = '';
process.env.SUBSOURCE_BASE_URL = 'https://subsource.mock/api/v1';

const zhS = ['你好，我们走吧。', '这个地方真的很安静。', '他说他会回来的。', '希望是一件好事。', '我们在监狱里过了很多年。'];
const zhT = ['你好，我們走吧。', '這個地方真的很安靜。', '他說他會回來的。', '希望是一件好事。', '我們在監獄裡過了很多年。'];
const en = ['Hello, let us go.', 'This place is really quiet.', 'He said he would come back.', 'Hope is a good thing.', 'We spent many years in prison.'];
// Dialogue of some other title.
const enOther = ['The ship leaves at dawn tomorrow.', 'Nobody told me about the storm.', 'Keep your hands off the wheel.', 'There is no map for this sea.', 'We sail north until the ice.'];
const make = (lines, n = 300, offset = 0) => {
  let t = 5000;
  return Array.from({ length: n }, (_, i) => {
    const start = t + offset;
    const dur = 1200 + ((i * 7919) % 2500);
    t += dur + 300 + ((i * 104729) % 4000);
    return { start, end: start + dur, text: lines[i % lines.length] };
  });
};
// Cue timing of some other title: nothing lines up with make().
const makeOther = (lines, n = 260) => {
  let t = 12000;
  return Array.from({ length: n }, (_, i) => {
    const start = t;
    const dur = 700 + ((i * 3571) % 3300);
    t += dur + 200 + ((i * 7477) % 9000);
    return { start, end: start + dur, text: lines[i % lines.length] };
  });
};
const zipOf = (entries) => {
  const z = new AdmZip();
  for (const [name, data] of entries) z.addFile(name, data);
  return z.toBuffer();
};

const files = {
  en: Buffer.from(toSrt(make(en))),
  zhMT: Buffer.from(toSrt(make(zhS))),
  seasonZip: zipOf([
    ['House.S01E05.chs.srt', Buffer.from(toSrt(make(zhT)))],
    ['House.S01E06.chs.srt', iconv.encode(toSrt(make(zhS, 300, 1500)), 'gbk')],
    ['House.S01E07.chs.srt', Buffer.from(toSrt(make(zhS, 120)))],
  ]),
  subdlZip: zipOf([
    ['Shawshank.1994.BluRay-SPARKS.chs.srt', iconv.encode(toSrt(make(zhS, 300, 2500)), 'gbk')],
    ['Shawshank.1994.BluRay-SPARKS.cht.srt', iconv.encode(toSrt(make(zhT, 300, 2500)), 'big5')],
  ]),
  subdlOtherZip: zipOf([['Shawshank.1994.chs.srt', Buffer.from(toSrt(makeOther(zhS)))]]),
  subdlEnZip: zipOf([['Shawshank.1994.eng.srt', Buffer.from(toSrt(make(en)))]]),
  bilingual: Buffer.from(toSrt(make(zhS.map((z, i) => `${en[i]}\n${z}`), 300, 40000))),
  // In sync with the film, but its English is another title's dialogue.
  bilingualWrong: Buffer.from(toSrt(make(zhS.map((z, i) => `${enOther[i]}\n${z}`)))),
  // A Chinese + English pair for another title, in that title's timing.
  otherPackZh: Buffer.from(toSrt(makeOther(zhS, 320))),
  otherPackEn: Buffer.from(toSrt(makeOther(enOther, 320))),
};

// Switches the scenarios flip, and counters they read.
let assrtMode = 'ok'; // 'ok' | 'none' | 'wrongNames' | 'wrongContent' | 'down'
let withSubdl = true;
let subdlMode = 'ok'; // 'ok' | 'otherTiming' | 'searchFails' | 'quota'
let subdlEnglish = false;
let osEnglish = true;
let country = 'United States';
let osChinese = true;
let deeplMode = 'ok'; // 'ok' | 'usedUp' | 'quota456' | 'down'
let claudeMode = 'ok'; // 'ok' | 'down' | 'busy' (429 while another request is running)
let claudeInFlight = 0;
let ssTraditional = false;
let deeplGate = null;
const calls = { assrtDetail: 0, subdlEnglish: 0, subdlDownload: 0, deeplTranslate: 0, claude: 0, claudeModels: [], claudeMaxInFlight: 0, wyzieSearch: [], wyzieDownload: [], subsource: [] };
const toZh = (line) => zhS[en.indexOf(line)] ?? `译${line}`;

const json = (o, init = {}) => new Response(JSON.stringify(o), { ...init, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.host === 'v3-cinemeta.strem.io') return json({ meta: { name: 'The Shawshank Redemption', releaseInfo: '1994', country } });
  if (u.host === 'api.opensubtitles.com' && u.pathname.endsWith('/subtitles')) {
    const isEn = u.searchParams.get('languages') === 'en';
    if (isEn && !osEnglish) return json({ data: [] });
    if (!isEn && !osChinese) return json({ data: [] });
    const attrs = isEn
      ? { subtitle_id: '1', language: 'en', download_count: 900, release: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS', files: [{ file_id: 11, file_name: 'shawshank.en' }] }
      : { subtitle_id: '2', language: 'zh-cn', download_count: 5000, machine_translated: true, release: 'Shawshank BluRay-SPARKS', files: [{ file_id: 22, file_name: 'shawshank.zh' }] };
    return json({ data: [{ attributes: attrs }] });
  }
  if (u.host === 'api.opensubtitles.com' && u.pathname.endsWith('/download')) {
    const id = JSON.parse(opts.body).file_id;
    return json({ link: `https://dl.example/os/${id}` });
  }
  if (u.host === 'dl.example') {
    if (u.pathname.endsWith('/11')) return new Response(files.en);
    if (u.pathname.endsWith('/22')) return new Response(files.zhMT);
    if (u.pathname.endsWith('/97')) return new Response(files.bilingualWrong);
    if (u.pathname.endsWith('/96zh')) return new Response(files.otherPackZh);
    if (u.pathname.endsWith('/96en')) return new Response(files.otherPackEn);
    return new Response(files.bilingual);
  }
  if (u.host === 'api.subdl.com' && subdlMode === 'searchFails') return new Response('bad gateway', { status: 502 });
  if (u.host === 'api.subdl.com' && u.searchParams.get('type') === 'tv') {
    // A whole-season pack, plus a single-episode result for another episode.
    if (u.searchParams.get('languages') === 'EN') return json({ status: true, subtitles: [] });
    return json({ status: true, subtitles: [
      { release_name: 'House.S01.Complete.BluRay', name: 'house.s01.zip', language: 'ZH', season: 1, episode: null, full_season: true, url: '/subtitle/80-80.zip' },
      { release_name: 'House.S01E09.chs', name: 'house.s01e09.zip', language: 'ZH', season: 1, episode: 9, episode_from: 9, episode_end: 9, full_season: false, url: '/subtitle/81-81.zip' },
    ] });
  }
  if (u.host === 'dl.subdl.com' && u.pathname.includes('80-80')) return new Response(files.seasonZip);
  if (u.host === 'api.subdl.com') {
    if (subdlEnglish && u.searchParams.get('languages') === 'EN') {
      return json({ status: true, subtitles: [{ sd_id: 9, release_name: 'The.Shawshank.Redemption.1994.BluRay', name: 'SUBDL.shawshank.en.zip', lang: 'english', language: 'EN', url: '/subtitle/9.zip' }] });
    }
    return json({ status: true, subtitles: !withSubdl ? [] : [{ sd_id: 7, release_name: 'The.Shawshank.Redemption.1994.BluRay-SPARKS', name: 'SUBDL.shawshank.zip', lang: 'chinese', language: 'ZH', url: '/subtitle/7.zip' }] });
  }
  if (u.host === 'dl.subdl.com') {
    calls.subdlDownload++;
    if (subdlMode === 'errorPage') return new Response('<html><body>Something went wrong</body></html>');
    if (subdlMode === 'quota') {
      return json({ error: 'api_download_limit_exceeded', message: 'Free daily download limit reached (50/day).', limit: 50, retryAfterSeconds: 7200 }, { status: 429 });
    }
    if (u.pathname.includes('/9.zip')) {
      calls.subdlEnglish++;
      return new Response(files.subdlEnZip);
    }
    return new Response(subdlMode === 'otherTiming' ? files.subdlOtherZip : files.subdlZip);
  }
  if (u.host === 'api.assrt.net' && assrtMode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  if (u.host === 'api.assrt.net' && u.pathname.endsWith('/search')) {
    const hit = {
      ok: { id: 99, videoname: 'The.Shawshank.Redemption.1994.WEB-DL', native_name: '肖申克的救赎', lang: { langlist: { langdou: true } } },
      wrongNames: { id: 98, videoname: 'ER.S01.1080p.WEBRip.DDP2.0.x264', native_name: '不知道', lang: { langlist: { langdou: true } } },
      wrongContent: { id: 97, videoname: 'The.Shawshank.Redemption.1994.BluRay', native_name: '不知道', lang: { langlist: { langdou: true } } },
      wrongPack: { id: 96, videoname: 'Beyond.The.Shawshank.Redemption.1994.WEB-DL', native_name: '不知道', lang: { langlist: { langchs: true, langeng: true } } },
    }[assrtMode];
    return json({ status: 0, sub: { subs: hit ? [hit] : [] } });
  }
  if (u.host === 'api.assrt.net' && u.pathname.endsWith('/detail')) {
    calls.assrtDetail++;
    const id = u.searchParams.get('id');
    if (id === '96') {
      return json({ status: 0, sub: { subs: [{ filelist: [
        { f: 'Beyond.chs.srt', url: 'https://dl.example/assrt/96zh' },
        { f: 'Beyond.eng.srt', url: 'https://dl.example/assrt/96en' },
      ] }] } });
    }
    return json({ status: 0, sub: { subs: [{ filelist: [{ f: 'shawshank.chs&eng.srt', url: `https://dl.example/assrt/${id}` }] }] } });
  }
  if (u.host === 'api-free.deepl.com') {
    assert.equal(opts.headers.Authorization, 'DeepL-Auth-Key deepl-test:fx');
    if (deeplMode === 'down') return new Response('unavailable', { status: 503 });
    if (u.pathname === '/v2/usage') return json({ character_count: deeplMode === 'usedUp' ? 499990 : 1000, character_limit: 500000 });
    calls.deeplTranslate++;
    if (deeplGate) await deeplGate; // a scenario can hold the answer back
    if (deeplMode === 'quota456') return json({ message: 'Quota exceeded' }, { status: 456 });
    const body = JSON.parse(opts.body);
    assert.equal(body.target_lang, 'ZH-HANS');
    assert.ok(body.text.length <= 50, 'DeepL takes at most 50 texts per request');
    return json({ translations: body.text.map((t) => ({ detected_source_language: 'EN', text: toZh(t) })) });
  }
  if (u.host === 'api.anthropic.com' && u.pathname === '/v1/messages') {
    calls.claude++;
    if (claudeMode === 'down') return json({ type: 'error', error: { type: 'invalid_request_error', message: 'credit balance too low' } }, { status: 400 });
    claudeInFlight++;
    calls.claudeMaxInFlight = Math.max(calls.claudeMaxInFlight, claudeInFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (claudeMode === 'busy' && claudeInFlight > 1) return json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '0' } });
    const body = JSON.parse(opts.body);
    calls.claudeModels.push(body.model);
    assert.equal(body.output_config.format.type, 'json_schema');
    const prompt = body.messages[0].content;
    const items = JSON.parse(prompt.slice(prompt.indexOf('Translate:\n') + 'Translate:\n'.length));
    const text = JSON.stringify({ lines: items.map((it) => ({ i: it.i, zh: toZh(it.en) })) });
    return json({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
    } finally {
      claudeInFlight--;
    }
  }
  if (u.host === 'wyzie.mock' && u.pathname === '/search') {
    calls.wyzieSearch.push(`${u.searchParams.get('language')}/${u.searchParams.get('source')}`);
    if (u.searchParams.get('language') !== 'zh') return json({ code: 404, message: 'No subtitles found' }, { status: 404 });
    return json([
      { id: 'ai-zh', url: 'https://wyzie.mock/ai', language: 'zh', ai: true, source: 'charlie' },
      { id: '1958483388', url: 'https://wyzie.mock/c/1/id/1958483388?format=srt', language: 'zh', release: 'Shawshank.1994.BluRay.720p', fileName: 'Shawshank.chs.srt', downloadCount: 6139, source: 'charlie', format: 'srt' },
    ]);
  }
  if (u.host === 'wyzie.mock') {
    calls.wyzieDownload.push(u.pathname);
    const advert = "1\n00:00:00,000 --> 00:00:06,000\nYou're on the free plan. Unlock every source, AI translation & ad-free subs → sub.wyzie.io\n\n";
    return new Response(advert + toSrt(make(zhS, 300, 1200)));
  }
  if (u.host === 'subsource.mock') {
    calls.subsource.push(`${opts.headers?.['X-API-Key']} ${u.pathname}${u.searchParams.get('language') ? ` ${u.searchParams.get('language')}` : ''}`);
    if (u.pathname.endsWith('/movies/search')) return json({ success: true, data: [{ movieId: 5, imdbId: u.searchParams.get('imdb'), season: null, type: 'movie' }, { movieId: 6, imdbId: 'tt9999999', season: null }] });
    if (u.pathname.endsWith('/subtitles') && u.searchParams.get('language') === 'chinese_bg_code') {
      return json({ success: true, data: [{ subtitleId: 77, movieId: 5, language: 'chinese_bg_code', releaseInfo: ['Shawshank.1994.BluRay.chs'], downloads: 5, productionType: 'translated' }] });
    }
    if (u.pathname.endsWith('/subtitles')) return json({ success: true, data: [] });
    if (u.pathname.endsWith('/subtitles/77/download')) {
      const lines = ssTraditional ? zhT : zhS;
      return new Response(zipOf([['Shawshank.1994.BluRay.chs.srt', Buffer.from(toSrt(make(lines, 300, 1800)))]]));
    }
  }
  throw new Error(`unexpected fetch ${url}`);
};

const { run } = await import('../src/pipeline.js');
const release = 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS.mkv';
const quiet = () => {};
let out;

console.log('### Scenario 1: a bilingual file exists (40 s late)');
let r = await run({ imdbId: 'tt0111161', release });
assert.equal(r.mode, 'bilingual');
assert.equal(r.chosen.provider, 'assrt');
assert.equal(r.chosen.alignment.timing.kind, 'offset');
assert.ok(r.srt.includes('你好，我们走吧。\nHello, let us go.'), 'bilingual normalised to zh-first');
assert.ok(r.srt.startsWith('1\n00:00:05,000 --> '), `bilingual re-timed: ${r.srt.slice(0, 40)}`);

console.log('\n### Scenario 2: no bilingual file → merge');
assrtMode = 'none';
r = await run({ imdbId: 'tt0111161', release });
assert.equal(r.mode, 'merged');
assert.match(r.chosen.id, /chs\.srt$/);
assert.ok(Math.abs(r.chosen.alignment.medianShiftMs + 2500) <= 150);
assert.ok(r.srt.startsWith('1\n00:00:05,000 --> '), r.srt.slice(0, 80));
assert.ok(r.srt.includes('你好，我们走吧。\nHello, let us go.'));
assert.ok(!r.candidates.some((c) => c.id === 'opensubtitles:2'), 'MT sub not downloaded while human Chinese exists');

console.log('\n### Scenario 3: English film, no human Chinese → AI Chinese fallback');
withSubdl = false;
r = await run({ imdbId: 'tt0111161', release });
assert.equal(r.mode, 'merged');
assert.equal(r.chosen.id, 'opensubtitles:2');
assert.ok(r.chosen.ai);

console.log('\n### Scenario 4: Chinese film → AI Chinese is never used');
country = 'Hong Kong, China';
await assert.rejects(run({ imdbId: 'tt0111161', release }), /no usable Chinese/);

console.log('\n### Scenario 5: TV episode, Chinese only in a whole-season pack');
country = 'United States';
withSubdl = true;
r = await run({ imdbId: 'tt0412142', season: 1, episode: 6 });
assert.equal(r.mode, 'merged');
assert.match(r.chosen.id, /House\.S01E06\.chs\.srt$/, r.chosen.id);
assert.ok(!r.candidates.some((c) => /S01E0[57]/.test(c.id)), 'other episodes from the pack are not used');
assert.ok(Math.abs(r.chosen.alignment.medianShiftMs + 1500) <= 150);
assert.ok(r.srt.includes('你好，我们走吧。\nHello, let us go.'));

console.log('\n### Scenario 6: assrt hits named for another title are not downloaded');
assrtMode = 'wrongNames';
calls.assrtDetail = 0;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(calls.assrtDetail, 0);
assert.equal(r.chosen.provider, 'subdl');

console.log('\n### Scenario 7: a bilingual file with another title\'s dialogue is rejected');
assrtMode = 'wrongContent';
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.ok(r.candidates.some((c) => c.id === 'assrt:97' && c.lang === 'bilingual'), 'the file was downloaded and looked bilingual');
assert.equal(r.mode, 'merged', 'it must not win on its bilingual bonus');
assert.equal(r.chosen.provider, 'subdl');

console.log('\n### Scenario 7b: English found by name for another title never becomes the timing reference');
// No release name (as from Nuvio), and the other title's English has the most
// cues: without the check it would be picked as the reference.
assrtMode = 'wrongPack';
r = await run({ imdbId: 'tt0111161', log: quiet });
assert.ok(r.candidates.some((c) => c.id === 'assrt:96#Beyond.eng.srt' && c.lang === 'en'), 'the other title\'s English was downloaded');
assert.equal(r.reference.provider, 'opensubtitles');
assert.equal(r.chosen.provider, 'subdl');
assert.ok(r.srt.includes('你好，我们走吧。\nHello, let us go.'));

console.log('\n### Scenario 8: the only Chinese file cannot be matched to the English timing → nothing is served');
assrtMode = 'none';
subdlMode = 'otherTiming';
await assert.rejects(run({ imdbId: 'tt0111161', release, log: quiet }), (e) => e.code === 'NO_SUBTITLES' && e.transient === false);
subdlMode = 'ok';

console.log('\n### Scenario 9: "nothing exists" is remembered for hours, a temporary failure for minutes');
const { ensure, status, jobKey, refreshIfStale } = await import('../src/jobs.js');
country = 'Hong Kong, China';
withSubdl = false;
let res = await ensure({ imdbId: 'tt0000009', season: null, episode: null }, null, quiet);
assert.equal(res.ok, false);
assert.ok(res.retryInMs > 5 * 3600 * 1000, `clean failure: ${res.retryInMs}`);
subdlMode = 'searchFails';
const flaky = { imdbId: 'tt0000010', season: null, episode: null };
res = await ensure(flaky, null, quiet);
assert.equal(res.ok, false);
assert.ok(res.retryInMs <= 10 * 60 * 1000, `temporary failure: ${res.retryInMs}`);
const st = await status(jobKey(flaky, null));
assert.equal(st.state, 'failed');
assert.ok(st.retryInMs <= 10 * 60 * 1000);
subdlMode = 'ok';

console.log('\n### Scenario 10: SubDL English is fetched only when OpenSubtitles has none');
country = 'United States';
withSubdl = true;
subdlEnglish = true;
calls.subdlEnglish = 0;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(calls.subdlEnglish, 0, 'OpenSubtitles had English');
assert.equal(r.reference.provider, 'opensubtitles');
osEnglish = false;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(calls.subdlEnglish, 1, 'no English on OpenSubtitles');
assert.equal(r.reference.provider, 'subdl');
osEnglish = true;
subdlEnglish = false;

console.log('\n### Scenario 11: an old saved subtitle is rebuilt in the background');
const saved = { imdbId: 'tt0000011', season: null, episode: null };
res = await ensure(saved, null, quiet);
assert.equal(res.ok, true);
assert.equal(await refreshIfStale(saved, null, quiet), false, 'a fresh result is left alone');
const metaFile = path.join(process.env.RESULTS_DIR, `${jobKey(saved, null)}.meta.json`);
writeFileSync(metaFile, JSON.stringify({ at: Date.now() - 8 * 24 * 3600 * 1000, degraded: false }));
assert.equal(await refreshIfStale(saved, null, quiet), true, 'an 8-day-old result is rebuilt');
assert.ok(Date.now() - JSON.parse(readFileSync(metaFile, 'utf8')).at < 60000);
assert.ok(readFileSync(res.file, 'utf8').includes('你好，我们走吧。'));

console.log('\n### Scenario 11b: an error page sent instead of a subtitle counts as a failed download');
subdlMode = 'errorPage';
out = [];
r = await run({ imdbId: 'tt0111161', release, log: (l) => out.push(l) });
assert.match(out.join('\n'), /download failed subdl:7: the download is not a subtitle file/);
assert.equal(r.degraded, true);
assert.equal(r.chosen.id, 'opensubtitles:2', 'falls back to what is left');
subdlMode = 'ok';

console.log('\n### Scenario 12: a provider is skipped only after two failures in a row');
assrtMode = 'down';
const logsOf = async () => {
  const lines = [];
  await run({ imdbId: 'tt0111161', release, log: (l) => lines.push(l) });
  return lines.join('\n');
};
out = await logsOf();
assert.match(out, /\[assrt\] search failed: api\.assrt\.net: ECONNREFUSED/);
out = await logsOf();
assert.match(out, /\[assrt\] search failed: api\.assrt\.net: ECONNREFUSED/, 'one failure must not disable it');
out = await logsOf();
assert.match(out, /\[assrt\] search failed: skipped: unreachable recently/);

console.log('\n### Scenario 13: SubDL\'s daily limit stops further download attempts');
subdlMode = 'quota';
calls.subdlDownload = 0;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(r.degraded, true, 'a result built without SubDL is marked for an early rebuild');
const firstRun = calls.subdlDownload;
assert.ok(firstRun >= 1);
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(calls.subdlDownload, firstRun, 'no further requests once the limit was reported');

console.log('\n### Scenario 14: no Chinese subtitle anywhere and no translation key → nothing is served');
const { config } = await import('../src/config.js');
osChinese = false;
withSubdl = false;
assrtMode = 'none';
await assert.rejects(run({ imdbId: 'tt0111161', release, log: quiet }), { code: 'NO_SUBTITLES' });

console.log('\n### Scenario 15: no Chinese subtitle anywhere → DeepL translates the English');
config.translate.deeplKey = 'deepl-test:fx';
config.translate.anthropicKey = 'claude-test';
let announced = 0;
r = await run({ imdbId: 'tt0111161', release, log: quiet, onTranslate: () => announced++ });
assert.equal(announced, 1, 'the caller is told when a translation starts');
assert.equal(r.mode, 'translated');
assert.match(r.chosen.ai, /DeepL/);
assert.equal(r.chosen.provider, 'opensubtitles', 'translated from the English found by IMDb id');
assert.ok(r.srt.includes('这个地方真的很安静。\nThis place is really quiet.'), 'Chinese line above the English line');
assert.match(r.srt, /^1\n00:00:00,000 --> 00:00:02,500\n【机器翻译】\n/, 'says once that it is machine-translated');
assert.equal(r.degraded, true, 'rebuilt early, so a human Chinese subtitle replaces it when one appears');
assert.equal(calls.claude, 0, 'Claude is not used while DeepL works');

console.log('\n### Scenario 15b: a job says it is translating while it translates, and not after');
{
  const { ensure: ensureJob, jobKey: keyOf, isTranslating } = await import('../src/jobs.js');
  const video = { imdbId: 'tt0000015', season: null, episode: null };
  assert.equal(isTranslating(keyOf(video, null)), false);
  let release_ = () => {};
  deeplGate = new Promise((res) => (release_ = res));
  const job = ensureJob(video, null, quiet);
  const before = calls.deeplTranslate;
  while (calls.deeplTranslate === before) await new Promise((res) => setImmediate(res)); // DeepL is being asked
  assert.equal(isTranslating(keyOf(video, null)), true, 'translating is reported while the job runs');
  release_();
  deeplGate = null;
  assert.equal((await job).ok, true);
  assert.equal(isTranslating(keyOf(video, null)), false, 'cleared when the job is done');
}

console.log('\n### Scenario 16: DeepL allowance used up → Claude Haiku translates instead');
deeplMode = 'usedUp';
calls.deeplTranslate = 0;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(r.mode, 'translated');
assert.match(r.chosen.ai, /claude-haiku-5-5/);
assert.equal(calls.deeplTranslate, 0, 'no DeepL translation started that could not finish');
assert.ok(calls.claude >= 3, '300 lines go in several requests');
assert.ok(calls.claudeModels.every((m) => m === 'claude-haiku-5-5'));
assert.ok(r.srt.includes('希望是一件好事。\nHope is a good thing.'));

console.log('\n### Scenario 17: DeepL answers "quota exceeded" mid-way → Claude Haiku takes over');
deeplMode = 'quota456';
calls.claude = 0;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.match(r.chosen.ai, /claude-haiku-5-5/);
assert.ok(calls.claude >= 1);

console.log('\n### Scenario 17b: translation chunks run in parallel, at most eight at once');
deeplMode = 'usedUp';
calls.claudeMaxInFlight = 0;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(r.mode, 'translated');
assert.ok(calls.claudeMaxInFlight >= 2 && calls.claudeMaxInFlight <= 8, `in flight: ${calls.claudeMaxInFlight}`);
assert.ok(r.srt.includes('希望是一件好事。\nHope is a good thing.'));

console.log('\n### Scenario 17c: told to slow down (429), the refused chunks are redone one at a time');
claudeMode = 'busy';
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(r.mode, 'translated');
assert.ok(r.srt.includes('希望是一件好事。\nHope is a good thing.'), 'every line still translated');
claudeMode = 'ok';

console.log('\n### Scenario 18: both translators fail → retried soon, not remembered for hours');
deeplMode = 'down';
claudeMode = 'down';
await assert.rejects(run({ imdbId: 'tt0111161', release, log: quiet }), (e) => e.code === 'NO_SUBTITLES' && e.transient === true);
claudeMode = 'ok';
deeplMode = 'ok';

console.log('\n### Scenario 19: a Chinese-original title with no Chinese anywhere is machine-translated too');
country = 'China';
calls.deeplTranslate = 0;
calls.claude = 0;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(r.mode, 'translated');
assert.ok(r.degraded, 'rebuilt later so a human Chinese file can replace it');
assert.ok(calls.deeplTranslate + calls.claude > 0);
country = 'United States';

console.log('\n### Scenario 20: an existing Chinese subtitle (even an AI one from a site) wins over translating');
osChinese = true;
withSubdl = true;
subdlMode = 'ok';
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.notEqual(r.mode, 'translated');

console.log('\n### Scenario 21: Wyzie finds the only Chinese file; its AI translations are skipped');
osChinese = false;
withSubdl = false;
assrtMode = 'none';
config.wyzie.apiKey = 'wyzie-test';
calls.claude = 0;
calls.deeplTranslate = 0;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(r.mode, 'merged');
assert.equal(r.chosen.id, 'wyzie:1958483388');
assert.ok(!r.chosen.ai && !r.chosen.contentMarker, 'the free-plan advert does not make it look machine-translated');
assert.ok(!r.srt.includes('wyzie'), 'the advert is not in the result');
assert.equal(calls.claude + calls.deeplTranslate, 0, 'a human file wins over translating');
assert.deepEqual(calls.wyzieSearch.sort(), ['en/charlie', 'zh/charlie']);
assert.deepEqual(calls.wyzieDownload, ['/c/1/id/1958483388'], 'the AI entry is never downloaded');
config.wyzie.apiKey = '';

console.log('\n### Scenario 22: SubSource finds the only Chinese file (by IMDb id, then per language)');
config.subsource.apiKey = 'ss-test';
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(r.mode, 'merged');
assert.equal(r.chosen.id, 'subsource:77');
assert.deepEqual(calls.subsource.sort(), [
  'ss-test /api/v1/movies/search',
  'ss-test /api/v1/subtitles big_5_code',
  'ss-test /api/v1/subtitles chinese_bg_code',
  'ss-test /api/v1/subtitles english',
  'ss-test /api/v1/subtitles/77/download',
]);
assert.ok(r.srt.includes('你好，我们走吧。\nHello, let us go.'));

console.log('\n### Scenario 23: the only Chinese file is Traditional → shown in Simplified, unless turned off');
ssTraditional = true;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.equal(r.chosen.script, 'traditional');
assert.ok(r.srt.includes('他说他会回来的。\nHe said he would come back.'), 'converted');
assert.ok(!r.srt.includes('們'));
config.toSimplified = false;
r = await run({ imdbId: 'tt0111161', release, log: quiet });
assert.ok(r.srt.includes('他說他會回來的。'), 'kept as it is');
config.toSimplified = true;
ssTraditional = false;
config.subsource.apiKey = '';
osChinese = true;
withSubdl = true;
assrtMode = 'ok';

console.log('\npipeline mock: all assertions passed');
