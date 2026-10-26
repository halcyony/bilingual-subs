import { createHash } from 'node:crypto';
import { config } from './config.js';
import { getJson } from './http.js';
import * as opensubtitles from './providers/opensubtitles.js';
import * as subdl from './providers/subdl.js';
import * as assrt from './providers/assrt.js';
import { cached } from './cache.js';
import { decode } from './encoding.js';
import { parse, toSrt } from './subtitle.js';
import { classify, scriptOf, machineTranslationMarker, splitLangs } from './detect.js';
import { releaseMatch } from './release.js';
import { align, findAlass } from './align.js';
import { scoreCandidate } from './score.js';
import { mergeBilingual, normaliseBilingual } from './merge.js';

const PROVIDERS = { opensubtitles, subdl, assrt };
const MIN_CUES = 20;
const ALIGN_TOP = 4;
const CHINESE_COUNTRIES = /^(china|hong kong|taiwan|macao|macau)$/i;

async function movieMeta(imdbId, log) {
  try {
    const res = await getJson(`https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`);
    const year = Number.parseInt(String(res.meta?.releaseInfo || res.meta?.year || ''), 10) || null;
    const countries = String(res.meta?.country || '').split(',').map((s) => s.trim()).filter(Boolean);
    return { title: res.meta?.name || null, year, countries };
  } catch (e) {
    log(`[meta] Cinemeta lookup failed: ${e.message}`);
    return { title: null, year: null, countries: [] };
  }
}

// Which side of the pair is the film's original dialogue. The original side
// must be human-made; the translated side may fall back to AI/MT.
// Cinemeta has no language field, so this goes by the first-listed country.
const originalSide = (meta) => (CHINESE_COUNTRIES.test(meta.countries[0] || '') ? 'zh' : 'en');
const aiAllowed = (side, orig) => side === 'bilingual' || side !== orig;

const labelSide = (labelLang) => (labelLang === 'en' ? 'en' : labelLang === 'ze' || labelLang === 'zh+en' ? 'bilingual' : 'zh');
const contentSide = (lang) => (lang === 'en' ? 'en' : lang === 'bilingual' ? 'bilingual' : 'zh');

// A provider whose server can't be reached is skipped for a while, so one dead
// site doesn't add its timeout to every request.
const SEARCH_TIMEOUT_MS = 6000;
const DOWN_FOR_MS = 15 * 60 * 1000;
const downUntil = new Map();
const isNetworkError = (msg) => /timed out|ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT|socket/i.test(msg);

async function searchAll(query, log) {
  const entries = Object.entries(PROVIDERS);
  const settled = await Promise.allSettled(
    entries.map(([name, p]) => {
      if (Date.now() < (downUntil.get(name) || 0)) return Promise.reject(new Error('skipped: unreachable recently, retrying later'));
      return Promise.race([
        p.search(query, log),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`)), SEARCH_TIMEOUT_MS)),
      ]);
    }),
  );
  const results = [];
  settled.forEach((s, i) => {
    const name = entries[i][0];
    if (s.status === 'fulfilled') {
      log(`[${name}] ${s.value.length} results`);
      results.push(...s.value);
    } else {
      const msg = s.reason?.message || String(s.reason);
      if (isNetworkError(msg) && !msg.startsWith('skipped')) downUntil.set(name, Date.now() + DOWN_FOR_MS);
      log(`[${name}] search failed: ${msg}`);
    }
  });
  return results;
}

// Tag AI/MT results, drop the ones not allowed for this film.
function prefilter(results, release, orig, log) {
  const kept = [];
  for (const r of results) {
    const marker = r.flags.aiTranslated
      ? 'ai_translated flag'
      : r.flags.machineTranslated
        ? 'machine_translated flag'
        : machineTranslationMarker(r.text, []);
    r.side = labelSide(r.labelLang);
    if (marker && !aiAllowed(r.side, orig)) {
      log(`  discard ${r.id} (${r.labelLang}): AI/MT on the original-language side — ${marker}`);
      continue;
    }
    r.ai = marker || null;
    r.release = releaseMatch(release, r.releases);
    kept.push(r);
  }
  return kept;
}

// Names/labels that suggest a Chinese+English file. Only used to decide what
// to download first; whether a file is bilingual is decided from its content.
const BILINGUAL_HINT = /中英|双语|雙語|简英|繁英|[简繁簡]体?\s*[&+]\s*英|chs\s*[&+._-]\s*eng|cht\s*[&+._-]\s*eng|bilingual/i;
const downloadPriority = (r) => (r.side === 'bilingual' || BILINGUAL_HINT.test(r.releases.join(' ')) ? 2 : 0) + (r.labelLang === 'zh-cn' ? 1 : 0);

// Pick which results to download: per provider and per label bucket
// (en / zh): likely-bilingual first, then best release match, then popularity.
function selectForDownload(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.provider}/${r.side === 'en' ? 'en' : 'zh'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const picked = [];
  for (const list of groups.values()) {
    list.sort((a, b) => downloadPriority(b) - downloadPriority(a) || b.release.score - a.release.score || b.downloads - a.downloads);
    // English is plentiful elsewhere; spend OpenSubtitles quota mostly on Chinese.
    const isOs = list[0].provider === 'opensubtitles';
    const cap = isOs ? (list[0].side === 'en' ? Math.min(2, config.maxOpenSubtitlesDownloads) : config.maxOpenSubtitlesDownloads) : config.maxDownloadsPerProvider;
    picked.push(...list.slice(0, cap));
  }
  return picked;
}

async function downloadAndAnalyse(r, release, log) {
  let files;
  try {
    const res = await cached(r.id, r.download);
    files = res.files;
    if (res.hit) log(`  cached  ${r.id}`);
  } catch (e) {
    log(`  download failed ${r.id}: ${e.message}`);
    return [];
  }
  const out = [];
  for (const f of files) {
    const { text, encoding } = decode(f.data);
    const cues = parse(text, f.name);
    if (cues.length < MIN_CUES) {
      log(`  skip ${r.id} ${f.name}: only ${cues.length} cues parsed`);
      continue;
    }
    const cls = classify(cues);
    const script = cls.lang === 'zh' || cls.lang === 'bilingual' ? scriptOf(cues.map((c) => c.text).join('\n')) : { script: null, t2sRatio: 0 };
    out.push({
      ...r,
      id: files.length > 1 ? `${r.id}#${f.name}` : r.id,
      fileName: f.name,
      encoding,
      cues,
      lang: cls.lang,
      langStats: cls,
      script: script.script,
      t2sRatio: script.t2sRatio,
      contentMarker: machineTranslationMarker('', cues),
      hash: createHash('sha1').update(cues.map((c) => c.text).join('\n')).digest('hex'),
      release: releaseMatch(release, [...r.releases, f.name]),
    });
  }
  return out;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function pickEnglishReference(english) {
  if (!english.length) return null;
  const med = median(english.map((c) => c.cues.length));
  return [...english].sort(
    (a, b) =>
      Boolean(a.ai) - Boolean(b.ai) ||
      b.release.score - a.release.score ||
      Math.abs(a.cues.length - med) - Math.abs(b.cues.length - med) ||
      b.downloads - a.downloads,
  )[0];
}

function describeTiming(a) {
  if (!a) return 'not aligned';
  const t = a.timing;
  const fps = Math.abs(t.fpsRatio - 1) > 0.001 ? `, fps ×${t.fpsRatio.toFixed(4)}` : '';
  const what = t.kind === 'drift' ? `drift (${t.fixed ? 'corrected' : 'NOT correctable'}, ${pct(t.driftShare)} of cues moved separately)` : t.kind;
  return `${what}, shift median ${(a.medianShiftMs / 1000).toFixed(2)}s${fps} via ${a.method}`;
}

/**
 * Run the whole pipeline. Returns { srt, chosen, mode, candidates } or throws.
 * `log` receives human-readable progress lines.
 */
export async function run({ imdbId, release = null, log = console.log, dump = null }) {
  if (!/^tt\d+$/.test(imdbId)) throw new Error(`not an IMDb id: ${imdbId}`);
  // Only assrt needs the title, so the IMDb-based searches start right away.
  const metaP = movieMeta(imdbId, log);
  const searchP = searchAll({ imdbId, meta: metaP }, log);
  const meta = await metaP;
  const orig = originalSide(meta);
  log(`Movie: ${meta.title || '?'} (${meta.year || '?'})  ${imdbId}  [${meta.countries.join(', ') || 'country ?'}]`);
  log(`Original language side: ${orig === 'zh' ? 'Chinese' : 'English/other'} — AI/MT allowed only for ${orig === 'zh' ? 'English' : 'Chinese'} (as a last resort)`);
  if (release) log(`Release: ${release}`);
  log(`Aligner: ${findAlass() ? `alass (${findAlass()})` : 'built-in offset search (alass not found)'}`);

  log('\n== Search');
  const results = prefilter(await searchP, release, orig, log);

  // Human-made subs first. AI/MT ones are only downloaded for a side that
  // ends up with no human candidate, to save download quota.
  log('\n== Download');
  const human = selectForDownload(results.filter((r) => !r.ai));
  log(`  downloading ${human.length} human-made of ${results.length}`);
  let analysed = (await Promise.all(human.map((s) => downloadAndAnalyse(s, release, log)))).flat();
  const hasHuman = (side) => analysed.some((c) => !c.contentMarker && (side === 'zh' ? c.lang === 'zh' || c.lang === 'bilingual' : c.lang === 'en'));
  const needSides = ['zh', 'en'].filter((side) => !hasHuman(side) && aiAllowed(side, orig));
  const aiPool = results.filter((r) => r.ai && (needSides.includes(r.side) || (r.side === 'bilingual' && needSides.includes('zh'))));
  if (aiPool.length) {
    const aiPicked = selectForDownload(aiPool);
    log(`  no human ${needSides.join('/')} subtitle — falling back to ${aiPicked.length} AI/MT one(s)`);
    analysed = analysed.concat((await Promise.all(aiPicked.map((s) => downloadAndAnalyse(s, release, log)))).flat());
  }

  log('\n== Analyse (content-based)');
  const seen = new Set();
  const candidates = [];
  for (const c of analysed) {
    const tag = `${c.id} [${c.provider}, label=${c.labelLang}]`;
    const desc = `${c.encoding}, ${c.cues.length} cues, lang=${c.lang}${c.script ? `, ${c.script} (t2s ${pct(c.t2sRatio)})` : ''}`;
    if (seen.has(c.hash)) {
      log(`  dup     ${tag}: ${desc}`);
      continue;
    }
    seen.add(c.hash);
    if (c.lang === 'other') {
      const why = c.langStats.garbled
        ? `not real Chinese — only ${pct(c.langStats.commonShare)} common characters (wrong encoding or mislabeled language)`
        : `zh ${pct(c.langStats.zhCues)}, en ${pct(c.langStats.enCues)} of cues`;
      log(`  ignore  ${tag}: ${c.encoding}, ${c.cues.length} cues (${why})`);
      continue;
    }
    if (c.contentMarker) {
      if (!aiAllowed(contentSide(c.lang), orig)) {
        log(`  discard ${tag}: AI/MT marker "${c.contentMarker}" on the original-language side`);
        continue;
      }
      c.ai = c.ai || c.contentMarker;
    }
    log(`  keep    ${tag}: ${desc}${c.ai ? `  [AI/MT: ${c.ai}]` : ''}`);
    candidates.push(c);
  }
  if (dump) await dump(candidates);

  const english = candidates.filter((c) => c.lang === 'en');
  const chinese = candidates.filter((c) => c.lang === 'zh' || c.lang === 'bilingual');
  if (!chinese.length) throw new Error('no usable Chinese or bilingual subtitles found');

  const reference = pickEnglishReference(english);
  let refCues = reference?.cues || null;
  if (reference) {
    log(`\n== English reference: ${reference.id} (${reference.cues.length} cues, release ${reference.release.score.toFixed(2)} ${reference.release.why?.join(' ') || ''})${reference.ai ? ' [AI/MT]' : ''}`);
  } else {
    const bi = chinese.find((c) => c.lang === 'bilingual');
    if (bi) {
      refCues = bi.cues.map((c) => ({ ...c, text: splitLangs(c.text).en })).filter((c) => c.text);
      log(`\n== English reference: none found; using English lines of ${bi.id}`);
    } else {
      log('\n== English reference: none found; timing and completeness not scored');
    }
  }

  log('\n== Score');
  const rescore = (c) => {
    const s = scoreCandidate(c, { refCueCount: refCues?.length });
    c.score = s.total;
    c.breakdown = s.breakdown;
  };
  const alignOne = async (c) => {
    c.aligned = true;
    try {
      c.alignment = await align(refCues, c.cues);
    } catch (e) {
      log(`  align failed ${c.id}: ${e.message}`);
    }
    rescore(c);
  };
  // Alignment is the slow part, so only the most promising few are aligned;
  // if an unaligned one still ends up on top, it gets aligned before it wins.
  chinese.forEach(rescore);
  chinese.sort((a, b) => b.score - a.score);
  if (refCues) {
    await Promise.all(chinese.slice(0, ALIGN_TOP).map(alignOne));
    chinese.sort((a, b) => b.score - a.score);
    while (!chinese[0].aligned) {
      await alignOne(chinese[0]);
      chinese.sort((a, b) => b.score - a.score);
    }
  }
  for (const c of chinese) {
    const b = c.breakdown;
    log(`  ${String(c.score).padStart(5)}  ${c.id}`);
    log(`         bilingual ${b.bilingual} + release ${b.release} + timing ${b.timing} + completeness ${b.completeness} + simplified ${b.simplified}${b.ai ? ` + AI/MT ${b.ai}` : ''}`);
    log(`         ${c.lang}/${c.script}, ${c.cues.length} cues${refCues ? ` vs ref ${refCues.length}` : ''}; release: ${c.release.why?.join(' ') || 'none'}; ${describeTiming(c.alignment)}`);
  }

  const best = chinese[0];
  let out;
  let mode;
  if (best.lang === 'bilingual') {
    mode = 'bilingual';
    let cues = best.cues;
    const t = best.alignment?.timing;
    // Re-time only against a real English file that matches the release at
    // least as well — otherwise the bilingual file may be the one in sync.
    if (t && t.kind !== 'in-sync' && t.fixed && reference && reference.release.score >= best.release.score) {
      cues = best.alignment.cues;
      log(`\n  re-timed bilingual file to the English reference (${t.kind})`);
    } else if (t && t.kind !== 'in-sync') {
      log(`\n  bilingual file timing left as is (${t.kind}${t.fixed ? '' : ', not correctable'}; English reference is not a better release match)`);
    }
    out = normaliseBilingual(cues);
  } else if (refCues) {
    mode = 'merged';
    out = mergeBilingual(best.alignment?.cues || best.cues, refCues);
  } else {
    mode = 'chinese-only';
    out = best.cues;
  }
  log(`\n== Result: ${mode} from ${best.id}${mode === 'merged' && reference ? ` + ${reference.id}` : ''} (${out.length} cues)${best.ai ? ' — contains AI/MT translation' : ''}`);
  return { srt: toSrt(out), mode, chosen: best, reference, candidates };
}
