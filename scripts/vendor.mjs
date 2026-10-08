import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
await build({ stdin: { contents: "export { createMorph } from 'morphicons/dom';", resolveDir: process.cwd() }, bundle: true, format: 'esm', minify: true, outfile: 'public/vendor/morphicons.js', banner: { js: '/* Morphicons · MIT · https://github.com/guillermolg00/morphicons */' } });
await copyFile('node_modules/morphicons/LICENSE', 'public/vendor/morphicons.LICENSE.txt');
