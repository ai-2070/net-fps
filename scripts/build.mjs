#!/usr/bin/env node
// The game, built into dist/ (npm run build): what a static host serves.
//
// - js/main.js bundled with three.js and NET (@net-mesh/browser) from
//   node_modules. NET (js/net.js) stays its own chunk, loaded only when co-op
//   is opened, so solo never loads it.
// - NET's WebAssembly leaf (net_leaf.js and net_leaf_bg.wasm), copied next to
//   the chunks: NET imports it at run time from beside its own code, which no
//   bundler can follow.
// - the page and the styles.
//
// scripts/dev.mjs (npm start) imports this to rebuild on every change.
import { context, build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const out = join(root, 'dist');
const leaf = join(root, 'node_modules', '@net-mesh', 'browser', 'dist');

function copyStatic() {
  mkdirSync(join(out, 'js'), { recursive: true });
  copyFileSync(join(root, 'index.html'), join(out, 'index.html'));
  for (const file of ['net_leaf.js', 'net_leaf_bg.wasm']) copyFileSync(join(leaf, file), join(out, 'js', file));
}

const options = (dev) => ({
  absWorkingDir: root,
  entryPoints: ['js/main.js', 'css/style.css'],
  outbase: '.',
  outdir: out,
  entryNames: '[dir]/[name]',
  chunkNames: 'js/[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  // (the fonts come from Google Fonts, as the page links them)
  external: ['https://*'],
  logLevel: 'info',
  plugins: [{ name: 'static', setup: (b) => b.onEnd(copyStatic) }],
});

// Rebuilds on every change to the code or the styles (the page itself is
// copied on each rebuild; dev.mjs serves it straight from the source)
export async function watch() {
  rmSync(out, { recursive: true, force: true });
  const ctx = await context(options(true));
  await ctx.watch();
  return ctx;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  rmSync(out, { recursive: true, force: true });
  await build(options(false));
}
