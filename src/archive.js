import AdmZip from 'adm-zip';
import { createExtractorFromData } from 'node-unrar-js';
import SevenZip from '7z-wasm';

const SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;
export const isSubtitleName = (name) => SUB_EXT.test(name || '');

const isZip = (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
const isRar = (b) => b.length > 7 && b.subarray(0, 4).toString('latin1') === 'Rar!';
const is7z = (b) => b.length > 6 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc;

// Returns [{ name, data }] of subtitle files. Plain subtitle buffers pass through.
export async function extractArchive(name, buf) {
  if (isZip(buf)) {
    const zip = new AdmZip(buf);
    return zip
      .getEntries()
      .filter((e) => !e.isDirectory && isSubtitleName(e.entryName))
      .map((e) => ({ name: e.entryName, data: e.getData() }));
  }
  if (isRar(buf)) {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const extractor = await createExtractorFromData({ data: ab });
    const { files } = extractor.extract({ files: (h) => !h.flags.directory && isSubtitleName(h.name) });
    return [...files].map((f) => ({ name: f.fileHeader.name, data: Buffer.from(f.extraction) }));
  }
  if (is7z(buf)) return extract7z(buf);
  return [{ name, data: buf }];
}

// 7-Zip compiled to WASM: runs inside Node, nothing installed on the system.
// A fresh instance per archive, since the emscripten FS is global state.
async function extract7z(buf) {
  const sz = await SevenZip({ print: () => {}, printErr: () => {} });
  sz.FS.mkdir('/work');
  sz.FS.writeFile('/work/in.7z', new Uint8Array(buf));
  sz.callMain(['x', '/work/in.7z', '-o/work/out', '-y']);
  const out = [];
  const walk = (dir, rel) => {
    let names;
    try {
      names = sz.FS.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === '.' || n === '..') continue;
      const p = `${dir}/${n}`;
      const r = rel ? `${rel}/${n}` : n;
      if (sz.FS.isDir(sz.FS.stat(p).mode)) walk(p, r);
      else if (isSubtitleName(n)) out.push({ name: r, data: Buffer.from(sz.FS.readFile(p)) });
    }
  };
  walk('/work/out', '');
  return out;
}
