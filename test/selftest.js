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
import { extractArchive } from '../src/archive.js';
import { scoreCandidate } from '../src/score.js';

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

console.log(`\n${passed} passed`);
