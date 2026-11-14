import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';

// Raw downloaded subtitle files, kept so re-running the same movie doesn't
// spend provider download quota again.
const dirFor = (id) => path.join(config.cacheDir, createHash('sha1').update(id).digest('hex').slice(0, 16));

// Downloads in progress, so two jobs that want the same file (two episodes of
// a season asking for the same pack) share one download.
const pending = new Map();

async function load(id, fetchFiles) {
  const dir = dirFor(id);
  try {
    const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
    const files = await Promise.all(index.files.map(async (name, i) => ({ name, data: await readFile(path.join(dir, `${i}.bin`)) })));
    return { files, hit: true };
  } catch {
    // not cached yet
  }
  const files = await fetchFiles();
  await mkdir(dir, { recursive: true });
  await Promise.all(files.map((f, i) => writeFile(path.join(dir, `${i}.bin`), f.data)));
  // The index is what marks an entry as complete, so it goes last and in one step.
  const index = path.join(dir, 'index.json');
  await writeFile(`${index}.tmp`, JSON.stringify({ id, files: files.map((f) => f.name) }));
  await rename(`${index}.tmp`, index);
  return { files, hit: false };
}

export async function cached(id, fetchFiles) {
  if (!config.cacheDir) return { files: await fetchFiles(), hit: false };
  if (!pending.has(id)) pending.set(id, load(id, fetchFiles).finally(() => pending.delete(id)));
  return pending.get(id);
}
