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
import { isEpisode, pickEpisodeFiles, runningTotal, videoLabel } from './episode.js';
import { looksLikeSubtitle } from './archive.js';

const PROVIDERS = { opensubtitles, subdl, assrt };
const MIN_CUES = 20;
const ALIGN_TOP = 4;
const CHINESE_COUNTRIES = /^(china|hong kong|taiwan|macao|macau)$/i;

// The title lookup gets a short timeout of its own: a search only waits this
// long for it, then goes on without a title.
const META_TIMEOUT_MS = 5000;

async function movieMeta(imdbId, log, type = 'movie') {
  try {
    const res = await getJson(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeoutMs: META_TIMEOUT_MS });
    const year = Number.parseInt(String(res.meta?.releaseInfo || res.meta?.year || ''), 10) || null;
    const countries = String(res.meta?.country || '').split(',').map((s) => s.trim()).filter(Boolean);
    // Episodes per season (specials, season 0, left out), for sites that
    // number later seasons by running total (e.g. S2E26 for season 2 episode 2).
    const seasonEpisodeCounts = {};
    for (const v of res.meta?.videos || []) {
      if (v.season > 0) seasonEpisodeCounts[v.season] = (seasonEpisodeCounts[v.season] || 0) + 1;
    }
    return { title: res.meta?.name || null, year, countries, seasonEpisodeCounts };
  } catch (e) {
    log(`[meta] Cinemeta lookup failed: ${e.message}`);
    return { title: null, year: null, countries: [], seasonEpisodeCounts: {} };
  }
}

// Which side of the pair is the film's original dialogue. The original side
// must be human-made; the translated side may fall back to AI/MT.
// Cinemeta has no language field, so this goes by the first-listed country.
const originalSide = (meta) => (CHINESE_COUNTRIES.test(meta.countries[0] || '') ? 'zh' : 'en');
const aiAllowed = (side, orig) => side === 'bilingual' || side !== orig;

const labelSide = (labelLang) => (labelLang === 'en' ? 'en' : labelLang === 'ze' || labelLang === 'zh+en' ? 'bilingual' : 'zh');
const contentSide = (lang) => (lang === 'en' ? 'en' : lang === 'bilingual' ? 'bilingual' : 'zh');

// A provider whose server can't be reached twice in a row is skipped for a
// while, so one dead site doesn't add its timeout to every request. One slow
// answer alone doesn't count: that happens to healthy sites too.
const SEARCH_TIMEOUT_MS = 6000;
const DOWN_FOR_MS = 15 * 60 * 1000;
const FAILS_BEFORE_DOWN = 2;
const downUntil = new Map();
const failStreak = new Map();
const isNetworkError = (msg) => /timed out|ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT|socket/i.test(msg);

// `trouble` collects everything that went wrong on the way (failed searches,
// failed downloads). It decides how long a "nothing found" is remembered and
// whether a result should be rebuilt soon.
async function searchAll(query, log, trouble) {
  const entries = Object.entries(PROVIDERS);
  // The clock starts once the title lookup has answered, so a slow Cinemeta
  // doesn't count against the providers waiting for it.
  const deadline = Promise.resolve(query.meta).then(
    () =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`)), SEARCH_TIMEOUT_MS).unref();
      }),
  );
  deadline.catch(() => {});
  const settled = await Promise.allSettled(
    entries.map(([name, p]) => {
      if (Date.now() < (downUntil.get(name) || 0)) return Promise.reject(new Error('skipped: unreachable recently, retrying later'));
      return Promise.race([p.search(query, log), deadline]);
    }),
  );
  const results = [];
  settled.forEach((s, i) => {
    const name = entries[i][0];
    if (s.status === 'fulfilled') {
      failStreak.delete(name);
      log(`[${name}] ${s.value.length} results`);
      results.push(...s.value);
    } else {
      const msg = s.reason?.message || String(s.reason);
      trouble.push(`${name} search: ${msg}`);
      if (isNetworkError(msg) && !msg.startsWith('skipped')) {
        const streak = (failStreak.get(name) || 0) + 1;
        failStreak.set(name, streak);
        if (streak >= FAILS_BEFORE_DOWN) {
          downUntil.set(name, Date.now() + DOWN_FOR_MS);
          failStreak.delete(name);
        }
      }
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
// `deferred` are fallbacks, fetched only if the first round leaves a gap.
function selectForDownload(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.provider}/${r.side === 'en' ? 'en' : 'zh'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const osHasEnglish = results.some((r) => r.provider === 'opensubtitles' && r.side === 'en');
  const picked = [];
  const deferred = [];
  for (const list of groups.values()) {
    list.sort((a, b) => downloadPriority(b) - downloadPriority(a) || b.release.score - a.release.score || b.downloads - a.downloads);
    const { provider } = list[0];
    const english = list[0].side === 'en';
    let cap = config.maxDownloadsPerProvider;
    // English is plentiful elsewhere; spend OpenSubtitles quota mostly on Chinese.
    if (provider === 'opensubtitles') cap = english ? Math.min(2, config.maxOpenSubtitlesDownloads) : config.maxOpenSubtitlesDownloads;
    if (provider === 'subdl') cap = english ? Math.min(2, config.maxSubdlDownloads) : config.maxSubdlDownloads;
    const chosen = list.slice(0, cap);
    // SubDL's daily quota is small, so its English is only a fallback for
    // titles where OpenSubtitles has none.
    if (provider === 'subdl' && english && osHasEnglish) deferred.push(...chosen);
    else picked.push(...chosen);
  }
  return { picked, deferred };
}

// `ctx`: { release, video, absolute (running-total episode number), trouble, log }.
async function downloadAndAnalyse(r, ctx) {
  const { release, video, log } = ctx;
  let files;
  try {
    const res = await cached(r.id, async () => {
      const got = await r.download();
      // An error page or "limit reached" notice must not be cached as a subtitle.
      if (got.length && !got.some((f) => looksLikeSubtitle(f.data))) throw new Error('the download is not a subtitle file');
      return got;
    });
    files = res.files;
    if (res.hit) log(`  cached  ${r.id}`);
  } catch (e) {
    ctx.trouble.push(`${r.id} download: ${e.message}`);
    log(`  download failed ${r.id}: ${e.message}`);
    return [];
  }
  const all = files.length;
  // Season packs contain every episode; keep the files named for this one.
  if (isEpisode(video)) files = pickEpisodeFiles(files, video.season, video.episode, ctx.absolute);
  if (files.length !== all) log(`  ${r.id}: ${files.length} of ${all} files are this episode`);
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
      id: all > 1 ? `${r.id}#${f.name}` : r.id,
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

const normLine = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MIN_LINES_TO_JUDGE = 20;
const MIN_ENGLISH_MATCH = 0.1;

// Share of some English lines (4+ words) that also occur in the English
// subtitles known to be for this title. Searches by name bring in files for
// other titles; measured on real files, the right title scores 0.38 to 0.91
// and a wrong one 0.00. null = too few lines to judge.
function sharedLines(texts, englishLines) {
  const lines = texts.map(normLine).filter((l) => l.split(' ').length >= 4);
  if (lines.length < MIN_LINES_TO_JUDGE) return null;
  return lines.filter((l) => englishLines.has(l)).length / lines.length;
}

function noSubtitles(trouble) {
  const e = new Error('no usable Chinese or bilingual subtitles found');
  e.code = 'NO_SUBTITLES';
  // "Nothing exists" is only certain when every search and download worked.
  e.transient = trouble.length > 0;
  return e;
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
export async function run({ imdbId, season = null, episode = null, release = null, log = console.log, dump = null }) {
  if (!/^tt\d+$/.test(imdbId)) throw new Error(`not an IMDb id: ${imdbId}`);
  const video = { imdbId, season, episode };
  const trouble = [];
  // Only assrt needs the title, so the IMDb-based searches start right away.
  const metaP = movieMeta(imdbId, log, isEpisode(video) ? 'series' : 'movie');
  const searchP = searchAll({ imdbId, season, episode, meta: metaP }, log, trouble);
  const meta = await metaP;
  const orig = originalSide(meta);
  log(`${isEpisode(video) ? 'Episode' : 'Movie'}: ${meta.title || '?'} (${meta.year || '?'})  ${videoLabel(video)}  [${meta.countries.join(', ') || 'country ?'}]`);
  log(`Original language side: ${orig === 'zh' ? 'Chinese' : 'English/other'} — AI/MT allowed only for ${orig === 'zh' ? 'English' : 'Chinese'} (as a last resort)`);
  if (release) log(`Release: ${release}`);
  log(`Aligner: ${findAlass() ? `alass (${findAlass()})` : 'built-in offset search (alass not found)'}`);

  log('\n== Search');
  const results = prefilter(await searchP, release, orig, log);

  // Human-made subs first. AI/MT ones are only downloaded for a side that
  // ends up with no human candidate, to save download quota.
  log('\n== Download');
  const ctx = { release, video, log, trouble, absolute: runningTotal(meta.seasonEpisodeCounts, season, episode) };
  const fetchAll = async (list) => (await Promise.all(list.map((s) => downloadAndAnalyse(s, ctx)))).flat();
  const { picked: human, deferred } = selectForDownload(results.filter((r) => !r.ai));
  log(`  downloading ${human.length} human-made of ${results.length}`);
  let analysed = await fetchAll(human);
  if (deferred.length && !analysed.some((c) => c.lang === 'en')) {
    log(`  no English subtitle from the first round, trying ${deferred.length} more from SubDL`);
    analysed = analysed.concat(await fetchAll(deferred));
  }
  const hasHuman = (side) => analysed.some((c) => !c.contentMarker && (side === 'zh' ? c.lang === 'zh' || c.lang === 'bilingual' : c.lang === 'en'));
  const needSides = ['zh', 'en'].filter((side) => !hasHuman(side) && aiAllowed(side, orig));
  const aiPool = results.filter((r) => r.ai && (needSides.includes(r.side) || (r.side === 'bilingual' && needSides.includes('zh'))));
  if (aiPool.length) {
    const ai = selectForDownload(aiPool);
    const aiPicked = [...ai.picked, ...ai.deferred];
    log(`  no human ${needSides.join('/')} subtitle — falling back to ${aiPicked.length} AI/MT one(s)`);
    analysed = analysed.concat(await fetchAll(aiPicked));
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

  let english = candidates.filter((c) => c.lang === 'en');
  let chinese = candidates.filter((c) => c.lang === 'zh' || c.lang === 'bilingual');
  // English found by IMDb id is certain to be this title's. It is the anchor:
  // anything found by name (which brings in other titles) must share dialogue
  // with it, and only anchored English may become the timing reference.
  const anchor = english.filter((c) => c.byId);
  if (anchor.length) {
    const englishLines = new Set(anchor.flatMap((c) => c.cues.map((q) => normLine(q.text))));
    const sameTitle = (c, texts) => {
      const match = sharedLines(texts, englishLines);
      if (match === null || match >= MIN_ENGLISH_MATCH) return true;
      log(`  reject  ${c.id}: its English lines don't match this title's English subtitles (${pct(match)} in common)`);
      return false;
    };
    english = english.filter((c) => c.byId || sameTitle(c, c.cues.map((q) => q.text)));
    chinese = chinese.filter((c) => c.lang !== 'bilingual' || sameTitle(c, c.cues.map((q) => splitLangs(q.text).en)));
  } else if (english.length) {
    // Nothing to check it against, so it can't be trusted as a reference.
    log(`  English was only found by name search (${english.length} file(s)): not used as the timing reference`);
    english = [];
  }
  if (!chinese.length) throw noSubtitles(trouble);

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
    // Timing that still doesn't fit a real English subtitle after alignment
    // means another cut or another title: out of sync either way. Measured
    // on real files, the right title never ends up here and a wrong one
    // does nine times in ten.
    const t = c.alignment?.timing;
    if (reference && t?.kind === 'drift' && !t.fixed) {
      c.rejected = true;
      log(`  reject  ${c.id}: timing can't be matched to the English subtitle (another cut or title)`);
    }
    rescore(c);
  };
  const settle = () => {
    chinese = chinese.filter((c) => !c.rejected);
    chinese.sort((a, b) => b.score - a.score);
  };
  // Alignment is the slow part, so only the most promising few are aligned;
  // if an unaligned one still ends up on top, it gets aligned before it wins.
  chinese.forEach(rescore);
  chinese.sort((a, b) => b.score - a.score);
  if (refCues) {
    await Promise.all(chinese.slice(0, ALIGN_TOP).map(alignOne));
    settle();
    while (chinese.length && !chinese[0].aligned) {
      await alignOne(chinese[0]);
      settle();
    }
  }
  if (!chinese.length) throw noSubtitles(trouble);
  for (const c of chinese) {
    const b = c.breakdown;
    log(`  ${String(c.score).padStart(5)}  ${c.id}`);
    log(`         bilingual ${b.bilingual} + release ${b.release} + timing ${b.timing} + completeness ${b.completeness} + simplified ${b.simplified}${b.ai ? ` + AI/MT ${b.ai}` : ''}`);
    log(`         ${c.lang}/${c.script}, ${c.cues.length} cues${refCues ? ` vs ref ${refCues.length}` : ''}; release: ${c.release.why?.join(' ') || 'none'}; ${describeTiming(c.alignment)}`);
  }

  const best = chinese[0];
  let out;
  let mode;
  // Where the output sits relative to the English reference's timing: 0 unless
  // a bilingual file is kept in its own (shifted) timing below.
  let outOffsetMs = 0;
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
      outOffsetMs = -best.alignment.medianShiftMs;
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

  const alt = alternateTiming(chinese, outOffsetMs);
  if (alt) log(`== Alternative timing: ${(alt.shiftMs / 1000).toFixed(2)}s (${alt.support} other subtitle file${alt.support > 1 ? 's' : ''} use it)`);
  return {
    srt: toSrt(out),
    altSrt: alt ? toSrt(out.map((c) => ({ ...c, start: c.start + alt.shiftMs, end: c.end + alt.shiftMs }))) : null,
    altShiftMs: alt?.shiftMs ?? null,
    mode,
    chosen: best,
    reference,
    candidates,
    // Something failed on the way (a search or a download), so a better
    // result may be possible later.
    degraded: trouble.length > 0,
    trouble,
  };
}

// Subtitle files for the same title often come in two timing groups (web vs
// Blu-ray releases are commonly ~1 s apart), and the add-on can't tell which
// one the viewer's video matches. When other files agree on a constant shift
// from the output, offer the output shifted to their timing as a second entry.
const ALT_MIN_MS = 400;
const ALT_MAX_MS = 15000;
function alternateTiming(candidates, outOffsetMs) {
  const votes = new Map();
  for (const c of candidates) {
    const a = c.alignment;
    if (!a || a.timing.kind !== 'offset' || Math.abs(a.timing.fpsRatio - 1) > 0.001) continue;
    const nativeMs = Math.round(-a.medianShiftMs / 100) * 100; // this file's own timing vs the reference
    const shift = nativeMs - outOffsetMs;
    if (Math.abs(shift) < ALT_MIN_MS || Math.abs(shift) > ALT_MAX_MS) continue;
    votes.set(shift, (votes.get(shift) || 0) + 1);
  }
  let best = null;
  for (const [shiftMs, support] of votes) if (!best || support > best.support) best = { shiftMs, support };
  return best;
}
