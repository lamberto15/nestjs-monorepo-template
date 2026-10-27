// The built assets compressed once, when the Caddy image is built
// (caddy/Dockerfile, after `vite build`): a .br and a .gz beside each file
// that compresses, which Caddy's `file_server { precompressed br gzip }`
// sends to a browser that takes them (caddy/Caddyfile, `handle /assets/*`).
//   node scripts/precompress.mjs dist/assets
// Caddy serves such files but does not make them (its file_server docs,
// "precompressed"), and a Vite plugin would compress on every build (the
// tests', the bundle budget's) what only the image ships: node:zlib, on the
// build's output. caddy/caddyfile.test.mjs runs it and serves what it wrote.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

// What compresses: text, and WebAssembly. Fonts (woff2) and pictures are
// compressed already.
const compressible = /\.(?:js|mjs|css|wasm|svg|json|html|txt|xml|map)$/;
// Brotli's best (quality 11) took 105 s for DuckDB's 39 MB WebAssembly
// alone; quality 9 took 5 s for a file 14% larger. Below this size, the best.
const largest = 16 * 1024 * 1024;

const encodings = {
  br: (source) =>
    promisify(brotliCompress)(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: source.length > largest ? 9 : 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    }),
  gz: (source) => promisify(gzip)(source, { level: 9 }),
};

/** Writes `path.br` and `path.gz` beside `path`, each only when it is smaller; how many. */
async function precompress(path) {
  const source = await readFile(path);
  const written = await Promise.all(
    Object.entries(encodings).map(async ([extension, compress]) => {
      const compressed = await compress(source);
      if (compressed.length >= source.length) return 0;
      await writeFile(`${path}.${extension}`, compressed);
      return 1;
    }),
  );
  return written.reduce((a, b) => a + b, 0);
}

const dir = process.argv[2];
if (!dir || !(await stat(dir).catch(() => undefined))?.isDirectory()) {
  console.error('usage: node scripts/precompress.mjs <directory>');
  process.exit(1);
}
// All at once: zlib compresses on libuv's threads, four at a time.
const paths = (await readdir(dir, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && compressible.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name));
const counts = await Promise.all(paths.map(precompress));
console.log(
  `precompress: ${counts.reduce((a, b) => a + b, 0)} files written in ${dir}`,
);
