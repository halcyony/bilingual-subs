import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { getJson } from './http.js';
import { cached } from './cache.js';

// Machine translation of an English subtitle into Simplified Chinese, for
// titles with no Chinese subtitle anywhere. DeepL is tried first; when its
// allowance is used up, or it fails, Claude Haiku takes over.
// Each translation is cached by the English file's content, so a title is
// only translated once.

const oneLine = (t) => String(t).split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
// Sound tags like "[door slams]" or "(laughs)" are left out of what is sent.
const speech = (t) => oneLine(t).replace(/[[(][^\])]*[\])]/g, ' ').replace(/\s+/g, ' ').trim();

export const translationConfigured = () => Boolean(config.translate.deeplKey || config.translate.anthropicKey);

class QuotaError extends Error {}

// ---- DeepL ----------------------------------------------------------------

const deeplBase = () => (config.translate.deeplKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
const deeplHeaders = () => ({ Authorization: `DeepL-Auth-Key ${config.translate.deeplKey}`, 'Content-Type': 'application/json' });
const DEEPL_BATCH = 50; // DeepL takes at most 50 texts per request

async function deepl(lines) {
  // Check the allowance first, so a translation isn't left half done.
  const need = lines.reduce((n, l) => n + l.length, 0);
  const usage = await getJson(`${deeplBase()}/v2/usage`, { headers: deeplHeaders() });
  const left = (usage.character_limit ?? Infinity) - (usage.character_count ?? 0);
  if (left < need) throw new QuotaError(`DeepL allowance left: ${left} characters, need ${need}`);
  const out = [];
  for (let i = 0; i < lines.length; i += DEEPL_BATCH) {
    const batch = lines.slice(i, i + DEEPL_BATCH);
    let res;
    try {
      res = await getJson(`${deeplBase()}/v2/translate`, {
        method: 'POST',
        headers: deeplHeaders(),
        body: JSON.stringify({ text: batch.map((l) => l || ' '), source_lang: 'EN', target_lang: 'ZH-HANS' }),
      });
    } catch (e) {
      if (e.status === 456) throw new QuotaError('DeepL allowance used up');
      throw e;
    }
    const got = (res.translations || []).map((t) => t.text);
    if (got.length !== batch.length) throw new Error(`DeepL returned ${got.length} lines for ${batch.length}`);
    out.push(...got.map((t, k) => (batch[k] ? t : '')));
  }
  return out;
}

// ---- Claude ---------------------------------------------------------------

const CHUNK = 120; // lines per request
const CONTEXT = 6; // earlier lines shown for context, not translated again
const SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, zh: { type: 'string' } },
        required: ['i', 'zh'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

let client = null;
const anthropic = () =>
  (client ??= new Anthropic({
    apiKey: config.translate.anthropicKey,
    maxRetries: 2,
    // Through the global fetch, so the tests' stub sees these calls too.
    fetch: (...args) => globalThis.fetch(...args),
  }));

const system = (title) =>
  [
    `You translate English film and TV subtitles into Simplified Chinese${title ? ` for "${title}"` : ''}.`,
    'Write natural, spoken Mandarin as a professional subtitler would: short, idiomatic, matching each speaker\'s tone.',
    'Translate every numbered line on its own, one Chinese line per English line, keeping the same numbers. Never merge, split or skip lines.',
    'Keep names as commonly rendered in Chinese, or as is if there is no usual Chinese form. Use Chinese punctuation.',
    'Lines marked as context are only there for meaning; do not return them.',
  ].join('\n');

async function claudeChunk(lines, from, title) {
  const before = lines.slice(Math.max(0, from - CONTEXT), from).map((l) => `(context) ${l}`);
  const items = lines.slice(from, from + CHUNK).map((l, k) => ({ i: from + k, en: l }));
  const res = await anthropic().messages.create({
    model: config.translate.claudeModel,
    max_tokens: 8000,
    system: system(title),
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `${before.length ? `${before.join('\n')}\n\n` : ''}Translate:\n${JSON.stringify(items)}` }],
  });
  if (res.stop_reason !== 'end_turn') throw new Error(`Claude stopped early (${res.stop_reason})`);
  const text = res.content.find((b) => b.type === 'text')?.text;
  const got = new Map(JSON.parse(text).lines.map((l) => [l.i, l.zh]));
  return items.map((it) => (it.en ? got.get(it.i) ?? null : ''));
}

// Chunks translated at once. A 120-line chunk comes back as about 3,300 tokens
// and each request reserves MAX_TOKENS against the output-token rate limit
// (80K a minute on a new account), so 8 x 8,000 stays under it.
const PARALLEL = 8;

async function claude(lines, title) {
  const starts = [];
  for (let from = 0; from < lines.length; from += CHUNK) starts.push(from);
  const parts = new Array(starts.length);
  const rateLimited = [];
  // Several chunks at a time: they only share the source lines, not each other's output.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, starts.length) }, async () => {
      while (next < starts.length) {
        const k = next++;
        try {
          parts[k] = await claudeChunk(lines, starts[k], title);
        } catch (e) {
          if (e.status !== 429) throw e;
          rateLimited.push(k);
        }
      }
    }),
  );
  // Told to slow down: the chunks that were refused go one at a time.
  for (const k of rateLimited.sort((a, b) => a - b)) parts[k] = await claudeChunk(lines, starts[k], title);
  const out = parts.flat();
  const missing = out.filter((l) => l === null).length;
  if (missing > lines.length * 0.05) throw new Error(`Claude left ${missing} of ${lines.length} lines untranslated`);
  return out.map((l) => l ?? '');
}

// ---- Both -----------------------------------------------------------------

async function translateLines(lines, title, log) {
  if (config.translate.deeplKey) {
    try {
      return { engine: 'DeepL', lines: await deepl(lines) };
    } catch (e) {
      if (!config.translate.anthropicKey) throw e;
      log(`  DeepL ${e instanceof QuotaError ? 'allowance' : 'failed'}: ${e.message}; using ${config.translate.claudeModel}`);
    }
  }
  return { engine: config.translate.claudeModel, lines: await claude(lines, title) };
}

/**
 * Translate an English subtitle's cues. Returns { engine, lines } with one
 * Chinese line per cue ('' where there was nothing to translate).
 */
export async function translateCues(reference, { title = null, log = console.log } = {}) {
  const lines = reference.cues.map((c) => speech(c.text));
  const { files, hit } = await cached(`translate:zh-hans:${reference.hash}`, async () => {
    const t = await translateLines(lines, title, log);
    return [{ name: 'zh.json', data: Buffer.from(JSON.stringify(t)) }];
  });
  const t = JSON.parse(files[0].data.toString('utf8'));
  if (hit) log(`  cached translation (${t.engine})`);
  return t;
}
