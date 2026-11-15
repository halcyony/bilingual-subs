// Offline checks for the content-analysis pieces (no network, no API keys).
// Run: npm test
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import AdmZip from 'adm-zip';
import SevenZip from '7z-wasm';
import { decode } from '../src/encoding.js';
import { parse, toSrt } from '../src/subtitle.js';
import { classify, scriptOf, machineTranslationMarker } from '../src/detect.js';
import { releaseMatch } from '../src/release.js';
import { align } from '../src/align.js';
import { mergeBilingual } from '../src/merge.js';
import { extractArchive, looksLikeSubtitle } from '../src/archive.js';
import { scoreCandidate } from '../src/score.js';
import { parseVideoId, nameMatchesEpisode, pickEpisodeFiles, runningTotal } from '../src/episode.js';
import { titleInNames } from '../src/providers/assrt.js';
import { resolveAnimeId } from '../src/anime.js';
import { config } from '../src/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const zhS = ['你好，我们走吧。', '这个地方真的很安静。', '他说他会回来的。', '希望是一件好事。', '我们在监狱里过了很多年。'];
const zhT = ['你好，我們走吧。', '這個地方真的很安靜。', '他說他會回來的。', '希望是一件好事。', '我們在監獄裡過了很多年。'];
const en = ['Hello, let us go.', 'This place is really quiet.', 'He said he would come back.', 'Hope is a good thing.', 'We spent many years in prison.'];

// Irregular gaps so alignment has a unique best offset.
const make = (lines, n = 60, offset = 0) => {
  let t = 5000;
  return Array.from({ length: n }, (_, i) => {
    const start = t + offset;
    const dur = 1200 + ((i * 7919) % 2500);
    t += dur + 300 + ((i * 104729) % 4000);
    return { start, end: start + dur, text: lines[i % lines.length] };
  });
};

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

await test('decode GBK', () => {
  const r = decode(iconv.encode(toSrt(make(zhS)), 'gbk'));
  assert.equal(r.encoding, 'gbk');
  assert.ok(r.text.includes('希望是一件好事'));
});

await test('decode Big5', () => {
  const r = decode(iconv.encode(toSrt(make(zhT)), 'big5'));
  assert.equal(r.encoding, 'big5');
  assert.ok(r.text.includes('監獄'));
});

await test('decode UTF-8 with BOM and UTF-16LE', () => {
  const s = toSrt(make(zhS));
  assert.equal(decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)])).encoding, 'utf-8');
  assert.equal(decode(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(s, 'utf16le')])).encoding, 'utf-16le');
});

await test('Simplified vs Traditional by t2s diff ratio', () => {
  assert.equal(scriptOf(zhS.join('').repeat(5)).script, 'simplified');
  const t = scriptOf(zhT.join('').repeat(5));
  assert.equal(t.script, 'traditional');
  assert.ok(t.t2sRatio > 0.1, `ratio ${t.t2sRatio}`);
});

await test('classify zh / en / bilingual', () => {
  assert.equal(classify(make(zhS)).lang, 'zh');
  assert.equal(classify(make(en)).lang, 'en');
  assert.equal(classify(make(zhS.map((z, i) => `${z}\n${en[i]}`))).lang, 'bilingual');
});

await test('bilingual ASS with separate per-language Dialogue lines', () => {
  const ev = make(zhS).flatMap((c, i) => {
    const t = (ms) => `0:${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`;
    return [`Dialogue: 0,${t(c.start)},${t(c.end)},CN,,0,0,0,,{\\fn微软雅黑}${c.text}`, `Dialogue: 0,${t(c.start)},${t(c.end)},EN,,0,0,0,,${en[i % en.length]}`];
  });
  const ass = `[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev.join('\n')}\n`;
  const cues = parse(ass, 'x.ass');
  assert.equal(cues.length, 60);
  assert.equal(cues[0].start, 5000);
  assert.equal(classify(cues).lang, 'bilingual');
});

await test('episode ids and file-name episode matching', () => {
  assert.deepEqual(parseVideoId('tt0412142:1:6'), { imdbId: 'tt0412142', season: 1, episode: 6 });
  assert.deepEqual(parseVideoId('tt0111161'), { imdbId: 'tt0111161', season: null, episode: null });
  assert.equal(parseVideoId('nope'), null);
  const cases = [
    ['House.S01E06.720p.chs.srt', true], ['House.S01E07.chs.srt', false], ['house.1x06.srt', true],
    ['House.S01E01-22.DVDRip.eng', true], ['House.S02E06.srt', false], ['豪斯医生.第一季.第六集.ass', true],
    ['第06集.srt', true], ['House.EP06.srt', true], ['House Season 1 Complete', null], ['House.S01.E06.srt', true],
  ];
  for (const [name, want] of cases) assert.equal(nameMatchesEpisode(name, 1, 6), want, name);
});

await test('vector drawing lines left in converted SRTs are dropped', () => {
  const srt = [
    '1', '00:00:01,000 --> 00:00:27,000', 'm 20 0 l 209 0 b 218 0 229 11 229 20 l 229 209 b 229 218 218 228 209 228', '',
    '2', '00:00:01,000 --> 00:00:27,000', 'm 71 60 b 71 0 161 0 161 60 b 161 120 71 120 71 60', '■', '',
    '3', '00:00:30,000 --> 00:00:32,000', '你好，我们走吧。', 'Hello, let us go.', '',
    '4', '00:00:33,000 --> 00:00:35,000', 'Room 101 is on the left', '',
  ].join('\n');
  const cues = parse(srt, 'x.srt');
  assert.equal(cues.length, 2, JSON.stringify(cues));
  assert.equal(cues[0].text, '你好，我们走吧。\nHello, let us go.');
  assert.equal(cues[1].text, 'Room 101 is on the left');
});

await test('mislabeled Arabic decoded as GBK is not treated as Chinese', () => {
  const ar = ['لو لم أكن أهتم', 'أكثر مما يمكن للكلمات أن تقول', 'هل كنت سأشعر بهذه الطريقة؟', 'إذا لم يكن هذا حباً', 'لا أعتقد أن مدير المتجر يحبني كثيراً'];
  const { text } = decode(iconv.encode(toSrt(make(ar)), 'win1256'));
  const cls = classify(parse(text, 'x.srt'));
  assert.notEqual(cls.lang, 'zh');
  assert.ok(cls.garbled, JSON.stringify(cls));
});

await test('AI / machine translation markers', () => {
  assert.ok(machineTranslationMarker('', [{ text: '本字幕由AI翻译' }]));
  assert.ok(machineTranslationMarker('Machine translated from English', []));
  assert.equal(machineTranslationMarker('Shawshank.1994.1080p.BluRay-SPARKS', make(en)), null);
});

await test('release matching', () => {
  const v = 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS.mkv';
  const same = releaseMatch(v, ['The.Shawshank.Redemption.1994.720p.BluRay.x264-SPARKS']);
  const web = releaseMatch(v, ['The Shawshank Redemption (1994) [NF][WEBDL-1080p]-OzONE']);
  assert.ok(same.score > 0.7, JSON.stringify(same));
  assert.ok(web.score < 0.3, JSON.stringify(web));
});

await test('alignment recovers a 3.2s offset', async () => {
  const ref = make(en, 200);
  const shifted = make(zhS, 200, 3200);
  const r = await align(ref, shifted);
  assert.ok(Math.abs(r.medianShiftMs + 3200) <= 150, `median ${r.medianShiftMs}`);
});

await test('merge puts Chinese on line 1, English on line 2', () => {
  const merged = mergeBilingual(make(zhS, 10), make(en, 10));
  assert.equal(merged.length, 10);
  assert.equal(merged[0].text, `${zhS[0]}\n${en[0]}`);
});

await test('zip extraction', async () => {
  const zip = new AdmZip();
  zip.addFile('a.chs.srt', Buffer.from(toSrt(make(zhS))));
  zip.addFile('readme.txt', Buffer.from('x'));
  const files = await extractArchive('x.zip', zip.toBuffer());
  assert.deepEqual(files.map((f) => f.name), ['a.chs.srt']);
});

await test('7z extraction', async () => {
  const sz = await SevenZip({ print: () => {}, printErr: () => {} });
  sz.FS.writeFile('/a.cht.srt', Buffer.from(toSrt(make(zhT))));
  sz.callMain(['a', '/t.7z', '/a.cht.srt']);
  const files = await extractArchive('t.7z', Buffer.from(sz.FS.readFile('/t.7z')));
  assert.deepEqual(files.map((f) => f.name), ['a.cht.srt']);
});

const timingCases = {
  'in-sync': (t) => t,
  offset: (t) => t + 2500,
  fps: (t) => t * (25 / 23.976),
  drift: (t) => (t > 1200000 ? t + 6000 : t + 500),
};
for (const useAlass of [true, false]) {
  await test(`timing verdicts (${useAlass ? 'alass' : 'built-in aligner'})`, async () => {
    const ref = make(en, 600);
    for (const [name, f] of Object.entries(timingCases)) {
      const cues = make(zhS, 600).map((c) => ({ ...c, start: f(c.start), end: f(c.start) + (c.end - c.start) }));
      const { timing } = await align(ref, cues, { useAlass });
      const want = name === 'fps' ? 'offset' : name;
      assert.equal(timing.kind, want, `${name}: ${JSON.stringify(timing)}`);
      // Only alass can re-time a drifting file section by section.
      assert.equal(timing.fixed, name !== 'drift' || useAlass, `${name} fixed`);
    }
  });
}

const cand = (o) => ({ cues: make(en), release: { score: 0 }, alignment: null, ...o });
const timing = (kind, fixed = true, medianShiftMs = 0) => ({ medianShiftMs, timing: { kind, fixed } });

await test('score ordering: bilingual beats a perfect Chinese-only file', () => {
  const bi = scoreCandidate(cand({ lang: 'bilingual', script: 'traditional', alignment: timing('offset', true, 9000) }), { refCueCount: 120 });
  const zh = scoreCandidate(cand({ lang: 'zh', script: 'simplified', release: { score: 1 }, alignment: timing('in-sync') }), { refCueCount: 60 });
  assert.ok(bi.total > zh.total, `${bi.total} vs ${zh.total}`);
});

await test('score ordering: uncorrectable drift loses the bilingual bonus', () => {
  const bi = scoreCandidate(cand({ lang: 'bilingual', script: 'simplified', alignment: timing('drift', false) }), { refCueCount: 60 });
  const zh = scoreCandidate(cand({ lang: 'zh', script: 'traditional', alignment: timing('in-sync') }), { refCueCount: 60 });
  assert.ok(zh.total > bi.total, `${zh.total} vs ${bi.total}`);
});

await test('score ordering: any human file beats an AI one', () => {
  const ai = scoreCandidate(cand({ lang: 'bilingual', script: 'simplified', release: { score: 1 }, alignment: timing('in-sync'), ai: 'flag' }), { refCueCount: 60 });
  const zh = scoreCandidate(cand({ lang: 'zh', script: 'traditional', alignment: timing('drift', false) }), { refCueCount: 600 });
  assert.ok(zh.total > ai.total, `${zh.total} vs ${ai.total}`);
});

await test('English in Windows-1252 keeps its apostrophes and accents', () => {
  const lines = ['Don’t stop now.', 'Café at nine…', 'It’s fine, really.', 'We’ll see about that.', 'She said “hello” to him.'];
  const r = decode(iconv.encode(toSrt(make(lines)), 'win1252'));
  assert.equal(r.encoding, 'windows-1252');
  assert.ok(r.text.includes('Don’t stop now.'), r.text.slice(0, 120));
  assert.ok(r.text.includes('Café at nine…'));
  assert.equal(classify(parse(r.text, 'x.srt')).lang, 'en');
});

await test('mostly-English GBK file with a few Chinese lines is still read as GBK', () => {
  const lines = [...en, ...en, ...en, '字幕组制作，谢谢观看'];
  const r = decode(iconv.encode(toSrt(make(lines, 64)), 'gbk'));
  assert.equal(r.encoding, 'gbk');
  assert.ok(r.text.includes('字幕组制作'));
});

await test('UTF-8 with one damaged byte is still read as UTF-8', () => {
  const good = Buffer.from(toSrt(make(zhS)));
  const r = decode(Buffer.concat([good.subarray(0, 500), Buffer.from([0xff]), good.subarray(500)]));
  assert.equal(r.encoding, 'utf-8');
  const cues = parse(r.text, 'x.srt');
  assert.equal(cues.length, 60);
  assert.equal(classify(cues).lang, 'zh');
});

await test('SRT without blank lines between cues', () => {
  const src = make(en, 30);
  const tight = toSrt(src).replace(/\n\n/g, '\n');
  const cues = parse(tight, 'x.srt');
  assert.equal(cues.length, 30);
  assert.deepEqual(cues.map((c) => c.text), src.map((c) => c.text), 'cue numbers must not leak into the text');
  // a cue whose own text is a number keeps it when blank lines are present
  assert.equal(parse('1\n00:00:01,000 --> 00:00:02,000\n1994\n\n2\n00:00:03,000 --> 00:00:04,000\nHello there\n', 'x.srt')[0].text, '1994');
});

await test('anime pack file names and running-total episode numbers', () => {
  assert.equal(nameMatchesEpisode('[Group] Show - 02 [1080p].srt', 1, 2), true);
  assert.equal(nameMatchesEpisode('[Group] Show - 03v2 (1080p) [ABCD1234].ass', 1, 2), false);
  assert.equal(nameMatchesEpisode('Movie - 1080p.srt', 1, 2), null);
  assert.equal(runningTotal({ 1: 24, 2: 24 }, 2, 2), 26);
  assert.equal(runningTotal({ 1: 24 }, 1, 2), null);
  assert.equal(runningTotal({ 2: 24 }, 2, 2), null);
  const pack = ['[G] Show - 02 [1080p].ass', '[G] Show - 26 [1080p].ass', '[G] Show - 27 [1080p].ass'].map((name) => ({ name }));
  assert.deepEqual(pickEpisodeFiles(pack, 2, 2, 26).map((f) => f.name), ['[G] Show - 26 [1080p].ass']);
  assert.deepEqual(pickEpisodeFiles(pack, 1, 2, null).map((f) => f.name), ['[G] Show - 02 [1080p].ass']);
  const seasoned = ['Show.S02E02.srt', 'Show.S02E03.srt'].map((name) => ({ name }));
  assert.deepEqual(pickEpisodeFiles(seasoned, 2, 2, 26).map((f) => f.name), ['Show.S02E02.srt']);
  assert.deepEqual(pickEpisodeFiles([{ name: 'whatever.srt' }], 2, 2, 26).map((f) => f.name), ['whatever.srt']);
});

await test('error pages are not mistaken for subtitles', () => {
  assert.equal(looksLikeSubtitle(Buffer.from('<html><body>Daily limit reached</body></html>')), false);
  assert.equal(looksLikeSubtitle(Buffer.from('{"error":"api_download_limit_exceeded"}')), false);
  assert.equal(looksLikeSubtitle(Buffer.from(toSrt(make(en)))), true);
  assert.equal(looksLikeSubtitle(iconv.encode(toSrt(make(zhS)), 'utf16le')), true);
  assert.equal(looksLikeSubtitle(Buffer.from('[Script Info]\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi\n')), true);
});

await test('assrt hits must carry the title', () => {
  assert.equal(titleInNames('Heat', ['Heat.1995.REMASTERED.BDRip.X264.iNT-TLF']), true);
  assert.equal(titleInNames('Heat', ['The Heat’s On']), false);
  assert.equal(titleInNames('Heat', ['ER.S01.1080p.WEBRip.DDP2.0.x264']), false);
  assert.equal(titleInNames('The Dark Knight', ['The.Dark.Knight.2008.1080p.BluRay']), true);
  assert.equal(titleInNames('The Dark Knight', ['Dark.Shadows.2012']), false);
  assert.equal(titleInNames('Harry Potter and the Sorcerer’s Stone', ['Harry.Potter.and.the.Philosophers.Stone.2001']), true);
  assert.equal(titleInNames('The Shawshank Redemption', ['不知道', 'The.Shawshank.Redemption.1994.2160p']), true);
});

await test('cues shifted to before 0:00 are dropped, not written as zero-length cues', () => {
  const srt = toSrt([
    { start: -3000, end: -1000, text: 'gone' },
    { start: -500, end: 800, text: 'partly before the start' },
    { start: 1000, end: 2000, text: 'normal' },
  ]);
  assert.ok(!srt.includes('gone'));
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:00,800\npartly before the start\n'), srt);
  assert.equal(parse(srt, 'x.srt').length, 2);
});

await test('Chinese file names inside a zip are read as GBK', async () => {
  // Build a zip with an ASCII placeholder name, then put the GBK bytes in its place
  // (same length), the way Chinese zip tools store names without the UTF-8 flag.
  const z = new AdmZip();
  z.addFile('XXXXXX.srt', Buffer.from(toSrt(make(zhS))));
  const buf = z.toBuffer();
  const from = Buffer.from('XXXXXX.srt');
  const to = iconv.encode('第06集.srt', 'gbk');
  assert.equal(to.length, from.length);
  for (let i = buf.indexOf(from); i !== -1; i = buf.indexOf(from, i + 1)) to.copy(buf, i);
  const files = await extractArchive('pack.zip', buf);
  assert.deepEqual(files.map((f) => f.name), ['第06集.srt']);
  assert.equal(nameMatchesEpisode(files[0].name, 1, 6), true, 'the episode number is found in the repaired name');
  // A UTF-8 name is left alone.
  const z2 = new AdmZip();
  z2.addFile('第06集.srt', Buffer.from(toSrt(make(zhS))));
  assert.deepEqual((await extractArchive('pack.zip', z2.toBuffer())).map((f) => f.name), ['第06集.srt']);
});

await test('anime films have no season, and a guessed season is logged', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bisubs-anime-'));
  writeFileSync(
    path.join(dir, 'anime-list-full.json'),
    JSON.stringify([
      { kitsu_id: 1, type: 'MOVIE', imdb_id: 'tt0000001' },
      { kitsu_id: 2, type: 'TV', imdb_id: 'tt0000002', season: { tvdb: 2 }, episode_offset: { tvdb: 10 } },
      { kitsu_id: 3, type: 'TV', imdb_id: 'tt0000003' },
    ]),
  );
  config.cacheDir = dir;
  const lines = [];
  const log = (l) => lines.push(l);
  assert.deepEqual(await resolveAnimeId('kitsu:1', log), { imdbId: 'tt0000001', season: null, episode: null });
  assert.deepEqual(await resolveAnimeId('kitsu:1:1', log), { imdbId: 'tt0000001', season: null, episode: null }, 'a film sent with an episode number');
  assert.deepEqual(await resolveAnimeId('kitsu:2:3', log), { imdbId: 'tt0000002', season: 2, episode: 13 });
  assert.equal(lines.length, 0, 'no guess, nothing logged');
  assert.deepEqual(await resolveAnimeId('kitsu:3:4', log), { imdbId: 'tt0000003', season: 1, episode: 4 });
  assert.match(lines.join('\n'), /kitsu:3:4: the list gives no season, assuming season 1/);
  assert.equal(await resolveAnimeId('kitsu:999:1', log), null);
});

await test('the version comes from package.json only', async () => {
  const { readFileSync } = await import('node:fs');
  const { VERSION } = await import('../src/config.js');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal(config.userAgent, `stremio-bilingual-subs v${pkg.version}`);
  assert.ok(!readFileSync(new URL('../src/addon.js', import.meta.url), 'utf8').match(/pkgVersion = '\d/), 'no hard-coded version in addon.js');
});

console.log(`\n${passed} passed`);
