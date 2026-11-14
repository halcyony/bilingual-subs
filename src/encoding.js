import iconv from 'iconv-lite';

// High-frequency characters in both scripts. Text decoded with the wrong
// legacy codec still produces valid-looking CJK, but rarely these characters.
export const COMMON = new Set(
  '的一是不了人我在有他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实吗呢吧啊嗯' +
    '這個們來為國說時會對發後裡過還進樣麼現當動開從實嗎點們沒誰話讓見關' +
    '，。？！、：；「」『』…',
);

function score(text) {
  let hits = 0;
  let bad = 0;
  for (const ch of text) {
    if (COMMON.has(ch)) hits++;
    else if (ch === '�') bad++;
  }
  return hits - bad * 10;
}

function looksUtf16(buf) {
  const n = Math.min(buf.length, 2000) & ~1;
  if (n < 20) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) evenZero++;
    if (buf[i + 1] === 0) oddZero++;
  }
  if (oddZero > n / 8 && evenZero < n / 50) return 'utf16le';
  if (evenZero > n / 8 && oddZero < n / 50) return 'utf16be';
  return null;
}

// A file that is UTF-8 apart from a few damaged bytes: at least ten valid
// multi-byte characters for every invalid sequence. A legacy-encoded file
// read as UTF-8 is the other way round (mostly invalid sequences).
function mostlyValidUtf8(loose) {
  let bad = 0;
  let multi = 0;
  for (const ch of loose) {
    if (ch === '�') bad++;
    else if (ch.codePointAt(0) >= 0x80) multi++;
  }
  return multi >= bad * 10;
}

// Western-European text (old English SRTs: curly quotes, accents) has few
// non-ASCII bytes and they stand alone. Chinese in GBK/Big5 has many, and GBK
// bytes come in pairs. Reading the former as GBK swallows the next letter
// ("Don't" becomes "Don" plus a stray character).
const WIN1252_MAX_HIGH_SHARE = 0.05;

function looksWindows1252(buf) {
  let high = 0;
  let alone = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] < 0x80) continue;
    high++;
    if (!(buf[i - 1] >= 0x80) && !(buf[i + 1] >= 0x80)) alone++;
  }
  return high > 0 && high / buf.length < WIN1252_MAX_HIGH_SHARE && alone / high > 0.5;
}

// Returns { text, encoding }. Text is normalised to UTF-8 without BOM, \n line endings.
export function decode(buf) {
  let encoding;
  let text;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    encoding = 'utf-8';
    text = buf.subarray(3).toString('utf8');
  } else if (buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = 'utf-16le';
    text = iconv.decode(buf.subarray(2), 'utf16le');
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    encoding = 'utf-16be';
    text = iconv.decode(buf.subarray(2), 'utf16be');
  } else if (looksUtf16(buf)) {
    encoding = looksUtf16(buf) === 'utf16le' ? 'utf-16le' : 'utf-16be';
    text = iconv.decode(buf, encoding.replace('-', ''));
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      encoding = 'utf-8';
    } catch {
      const loose = buf.toString('utf8');
      if (mostlyValidUtf8(loose)) {
        // UTF-8 with a few damaged bytes: keep it, the bad spots become U+FFFD.
        encoding = 'utf-8';
        text = loose;
      } else if (looksWindows1252(buf)) {
        encoding = 'windows-1252';
        text = iconv.decode(buf, 'win1252');
      } else {
        // gb18030 is a superset of GBK/GB2312, so it decodes either.
        const gbk = iconv.decode(buf, 'gb18030');
        const big5 = iconv.decode(buf, 'big5');
        if (score(big5) > score(gbk)) {
          encoding = 'big5';
          text = big5;
        } else {
          encoding = 'gbk';
          text = gbk;
        }
      }
    }
  }
  return { text: text.replace(/^﻿/, '').replace(/\r\n?/g, '\n'), encoding };
}
