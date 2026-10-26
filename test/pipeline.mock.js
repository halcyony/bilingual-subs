// End-to-end pipeline run against a stubbed fetch() that mimics the three
// provider APIs (response shapes as documented). No network or keys needed.
// Run: node test/pipeline.mock.js
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import AdmZip from 'adm-zip';
import { toSrt } from '../src/subtitle.js';

process.env.OPENSUBTITLES_API_KEY = 'test';
process.env.SUBDL_API_KEY = 'test';
process.env.ASSRT_TOKEN = 'test';
process.env.CACHE_DIR = ''; // no cache: each scenario must really download

const zhS = ['你好，我们走吧。', '这个地方真的很安静。', '他说他会回来的。', '希望是一件好事。', '我们在监狱里过了很多年。'];
const zhT = ['你好，我們走吧。', '這個地方真的很安靜。', '他說他會回來的。', '希望是一件好事。', '我們在監獄裡過了很多年。'];
const en = ['Hello, let us go.', 'This place is really quiet.', 'He said he would come back.', 'Hope is a good thing.', 'We spent many years in prison.'];
const make = (lines, n = 300, offset = 0) => {
  let t = 5000;
  return Array.from({ length: n }, (_, i) => {
    const start = t + offset;
    const dur = 1200 + ((i * 7919) % 2500);
    t += dur + 300 + ((i * 104729) % 4000);
    return { start, end: start + dur, text: lines[i % lines.length] };
  });
};

const files = {
  en: Buffer.from(toSrt(make(en))),
  zhMT: Buffer.from(toSrt(make(zhS))),
  subdlZip: (() => {
    const z = new AdmZip();
    z.addFile('Shawshank.1994.BluRay-SPARKS.chs.srt', iconv.encode(toSrt(make(zhS, 300, 2500)), 'gbk'));
    z.addFile('Shawshank.1994.BluRay-SPARKS.cht.srt', iconv.encode(toSrt(make(zhT, 300, 2500)), 'big5'));
    return z.toBuffer();
  })(),
  bilingual: Buffer.from(toSrt(make(zhS.map((z, i) => `${en[i]}\n${z}`), 300, 40000))),
};

let withAssrt = true;
let withSubdl = true;
let country = 'United States';
const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.host === 'v3-cinemeta.strem.io') return json({ meta: { name: 'The Shawshank Redemption', releaseInfo: '1994', country } });
  if (u.host === 'api.opensubtitles.com' && u.pathname.endsWith('/subtitles')) {
    const isEn = u.searchParams.get('languages') === 'en';
    const attrs = isEn
      ? { subtitle_id: '1', language: 'en', download_count: 900, release: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS', files: [{ file_id: 11, file_name: 'shawshank.en' }] }
      : { subtitle_id: '2', language: 'zh-cn', download_count: 5000, machine_translated: true, release: 'Shawshank BluRay-SPARKS', files: [{ file_id: 22, file_name: 'shawshank.zh' }] };
    return json({ data: [{ attributes: attrs }] });
  }
  if (u.host === 'api.opensubtitles.com' && u.pathname.endsWith('/download')) {
    const id = JSON.parse(opts.body).file_id;
    return json({ link: `https://dl.example/os/${id}` });
  }
  if (u.host === 'dl.example') return new Response(u.pathname.endsWith('/11') ? files.en : u.pathname.endsWith('/22') ? files.zhMT : files.bilingual);
  if (u.host === 'api.subdl.com') return json({ status: true, subtitles: !withSubdl ? [] : [{ sd_id: 7, release_name: 'The.Shawshank.Redemption.1994.BluRay-SPARKS', name: 'SUBDL.shawshank.zip', lang: 'chinese', language: 'ZH', url: '/subtitle/7.zip' }] });
  if (u.host === 'dl.subdl.com') return new Response(files.subdlZip);
  if (u.host === 'api.assrt.net' && u.pathname.endsWith('/search')) {
    return json({ status: 0, sub: { subs: withAssrt ? [{ id: 99, videoname: 'The.Shawshank.Redemption.1994.WEB-DL', native_name: '肖申克的救赎', lang: { langlist: { langdou: true } } }] : [] } });
  }
  if (u.host === 'api.assrt.net' && u.pathname.endsWith('/detail')) return json({ status: 0, sub: { subs: [{ filelist: [{ f: 'shawshank.chs&eng.srt', url: 'https://dl.example/assrt/99' }] }] } });
  throw new Error(`unexpected fetch ${url}`);
};

const { run } = await import('../src/pipeline.js');
const release = 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS.mkv';

console.log('### Scenario 1: a bilingual file exists (40 s late)');
let r = await run({ imdbId: 'tt0111161', release });
assert.equal(r.mode, 'bilingual');
assert.equal(r.chosen.provider, 'assrt');
assert.equal(r.chosen.alignment.timing.kind, 'offset');
assert.ok(r.srt.includes('你好，我们走吧。\nHello, let us go.'), 'bilingual normalised to zh-first');
assert.ok(r.srt.startsWith('1\n00:00:05,000 --> '), `bilingual re-timed: ${r.srt.slice(0, 40)}`);

console.log('\n### Scenario 2: no bilingual file → merge');
withAssrt = false;
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

console.log('\npipeline mock: all assertions passed');
