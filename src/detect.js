import * as OpenCC from 'opencc-js';
import { COMMON } from './encoding.js';

const t2s = OpenCC.Converter({ from: 't', to: 'cn' });

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;
const LATIN_WORD = /[A-Za-z]{2,}/g;

// Above this share of CJK characters changed by t2s, the text is Traditional.
// Simplified text scores ~0–1% (a few chars OpenCC normalises); Traditional
// usually 15–35%.
const TRADITIONAL_RATIO = 0.05;
// Share of cues that must carry both scripts for a file to count as bilingual.
const BILINGUAL_RATIO = 0.4;
// Real Chinese text is ~50% made of the most common characters; text that is
// really another language decoded as GBK/Big5 (e.g. mislabeled Arabic) is ~1%.
const MIN_COMMON_SHARE = 0.15;

function commonShare(cues) {
  let cjk = 0;
  let common = 0;
  for (const c of cues) {
    for (const ch of c.text.match(CJK) || []) {
      cjk++;
      if (COMMON.has(ch)) common++;
    }
  }
  return cjk ? common / cjk : 0;
}

export function scriptOf(text) {
  const cjk = text.match(CJK) || [];
  if (cjk.length < 20) return { script: null, t2sRatio: 0, cjkChars: cjk.length };
  const sample = cjk.join('');
  const converted = t2s(sample);
  let changed = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] !== converted[i]) changed++;
  const t2sRatio = changed / sample.length;
  return {
    script: t2sRatio > TRADITIONAL_RATIO ? 'traditional' : 'simplified',
    t2sRatio,
    cjkChars: cjk.length,
  };
}

function cueLangs(text) {
  const cjk = (text.match(CJK) || []).length;
  const latin = (text.match(LATIN_WORD) || []).length;
  return { zh: cjk >= 2, en: latin >= 2 };
}

// Classify a cue list by content: 'bilingual' | 'zh' | 'en' | 'other'.
export function classify(cues) {
  let zh = 0;
  let en = 0;
  let both = 0;
  for (const c of cues) {
    const l = cueLangs(c.text);
    if (l.zh) zh++;
    if (l.en) en++;
    if (l.zh && l.en) both++;
  }
  const n = cues.length || 1;
  const stats = { zhCues: zh / n, enCues: en / n, bothCues: both / n, commonShare: commonShare(cues) };
  const realChinese = stats.commonShare >= MIN_COMMON_SHARE;
  let lang = 'other';
  if (realChinese && stats.bothCues >= BILINGUAL_RATIO) lang = 'bilingual';
  else if (realChinese && stats.zhCues >= 0.3) lang = 'zh';
  else if (stats.enCues >= 0.5 && stats.zhCues < 0.3) lang = 'en';
  return { lang, garbled: !realChinese && stats.zhCues >= 0.3, ...stats };
}

const MT_PATTERNS = [
  /\bAI[\s-]*(translat|generat|subtit)/i,
  /\bmachine[\s-]*translat/i,
  /\b(google|deepl|bing|chatgpt|gpt-?\d|whisper)\b[\s\S]{0,20}(translat|翻译|翻譯)/i,
  /\bauto[\s-]*(translat|generat)/i,
  /机翻|機翻|机器翻译|機器翻譯|AI\s*翻译|AI\s*翻譯|人工智能翻译|自动翻译|自動翻譯|谷歌翻译|谷歌翻譯/,
];

// Look for MT/AI markers in provider metadata and in the first/last cues
// (where credits usually live).
export function machineTranslationMarker(metaText, cues) {
  const edge = [...cues.slice(0, 8), ...cues.slice(-8)].map((c) => c.text).join('\n');
  for (const src of [metaText || '', edge]) {
    for (const re of MT_PATTERNS) {
      const m = src.match(re);
      if (m) return m[0];
    }
  }
  return null;
}

// Pull Chinese and English parts out of a cue's text (for bilingual files).
export function splitLangs(text) {
  const zh = [];
  const en = [];
  for (const line of text.split('\n')) {
    const l = cueLangs(line);
    if (l.zh) zh.push(line);
    else if (/[A-Za-z]/.test(line)) en.push(line);
    else zh.push(line);
  }
  return { zh: zh.join(' '), en: en.join(' ') };
}
