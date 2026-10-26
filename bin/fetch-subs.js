#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run } from '../src/pipeline.js';
import { toSrt } from '../src/subtitle.js';
import { parseVideoId } from '../src/episode.js';

const USAGE = `Usage: node bin/fetch-subs.js <id> [releaseFilename] [options]

  id                movie IMDb id, e.g. tt0111161, or an episode as
                    <show id>:<season>:<episode>, e.g. tt0412142:1:6
  releaseFilename   optional video file name, used for release matching

Options:
  -o, --out <file>  output SRT (default: out/<imdbId>.zh-en.srt)
  --dump <dir>      also save every decoded candidate as UTF-8 SRT
  -h, --help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    dump: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !positionals[0]) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const [id, release = null] = positionals;
const video = parseVideoId(id);
if (!video) {
  console.error(`Error: not an IMDb id or <id>:<season>:<episode>: ${id}`);
  process.exit(1);
}
const outFile = values.out || path.join('out', `${id.replace(/:/g, '_')}.zh-en.srt`);

const dump = values.dump
  ? async (candidates) => {
      await mkdir(values.dump, { recursive: true });
      for (const c of candidates) {
        const safe = c.id.replace(/[^\w.-]+/g, '_').slice(0, 120);
        await writeFile(path.join(values.dump, `${safe}.${c.lang}.srt`), toSrt(c.cues));
      }
    }
  : null;

try {
  const result = await run({ ...video, release, dump });
  await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  await writeFile(outFile, result.srt, 'utf8');
  console.log(`Wrote ${outFile}`);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
