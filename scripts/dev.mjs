#!/usr/bin/env node
// Local setup: the game built and rebuilt on every change (scripts/build.mjs),
// served over HTTPS. Its co-op uses NET's public anchor (anchor.ai2070.net)
// unless you run your own:
//
//   npm start                              # play on this machine
//   npm start -- --host 192.168.1.20       # also reachable on your LAN at that address
//   npm start -- --local-anchor            # also run a NET anchor here, on :8444
//
// The anchor introduces players' browsers to each other; game traffic goes
// directly between them. First run creates .anchor/ with a TLS certificate
// from mkcert (a secure context needs HTTPS), and with --local-anchor the mesh
// PSK and the credential issuer key. A local anchor needs a `net-mesh` with the
// anchor feature: the release's net-mesh-anchor archive, at NET_MESH_BIN or
// .anchor/bin/net-mesh(.exe). See README.md.
//
// Switches: ANCHOR_STATS=1 prints per-game counters; ANCHOR_VERBOSE=1|2|3 sets
// the anchor's log level.

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { extname, join, normalize, sep } from 'node:path';
import { out, root, watch } from './build.mjs';

const work = join(root, '.anchor');
const exe = process.platform === 'win32' ? '.exe' : '';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const host = arg('--host', 'localhost');
const pagePort = Number(arg('--port', 8081));
const anchorPort = Number(arg('--anchor-port', 8444)); // with --local-anchor; the printed URL passes it as ?anchor=
const GAME = 'net-shooter';
const localAnchor = args.includes('--local-anchor');

const bin = process.env.NET_MESH_BIN ?? join(work, 'bin', `net-mesh${exe}`);
if (localAnchor && !existsSync(bin)) {
  console.error(`No net-mesh binary at ${bin}.\nDownload the release's net-mesh-anchor archive (see README.md) or set NET_MESH_BIN.`);
  process.exit(1);
}

// --- One-time secrets and certificate ---------------------------------------
mkdirSync(work, { recursive: true });
const pskFile = join(work, 'psk.hex');
const issuerFile = join(work, 'issuer.toml');
if (localAnchor) {
  if (!existsSync(pskFile)) writeFileSync(pskFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  if (!existsSync(issuerFile)) execFileSync(bin, ['identity', 'generate', '--out', issuerFile], { stdio: 'inherit' });
}

const certFile = join(work, 'cert.pem');
const keyFile = join(work, 'key.pem');
const certNamesFile = join(work, 'cert-names.txt');
const names = ['localhost', '127.0.0.1', '::1', ...(host === 'localhost' ? [] : [host])];
if (!existsSync(certFile) || (existsSync(certNamesFile) && readFileSync(certNamesFile, 'utf8') !== names.join(' '))) {
  try {
    execFileSync('mkcert', ['-cert-file', certFile, '-key-file', keyFile, ...names], { stdio: 'inherit' });
  } catch {
    console.error('mkcert failed. Install it and run `mkcert -install` once so browsers trust local certificates.');
    process.exit(1);
  }
  writeFileSync(certNamesFile, names.join(' '));
}

// --- Page server (HTTPS: WebCrypto and WebRTC want a secure context) --------
const pageOrigin = `https://${host}:${pagePort}`;
const origins = new Set([pageOrigin, `https://localhost:${pagePort}`, `https://127.0.0.1:${pagePort}`]);

// The game, built into dist/ and rebuilt on every change (see build.mjs)
await watch();

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};
// Only the built game is served: the page, its code, NET's wasm and the styles
const servable = (rel) =>
  rel === 'index.html' ||
  /^(js|css)[\\/][\w.-]+\.(js|css|map|wasm)$/.test(rel);

const pages = createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'https://x').pathname);
  const rel = normalize(path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1));
  // (the page straight from the source, so an edit to it shows on a reload)
  const file = rel === 'index.html' ? join(root, rel) : join(out, rel);
  if (!file.startsWith(root + sep) || !servable(rel) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
});
pages.listen(pagePort, host === 'localhost' ? '127.0.0.1' : '0.0.0.0');

const printUrls = (query = '') => {
  console.log(`\n  Net Shooter:  ${pageOrigin}/${query}\n`);
  console.log('Co-op: Play → Co-op → Host game; others join from the server browser.\n');
};

if (!localAnchor) {
  console.log("Co-op uses NET's public anchor, https://anchor.ai2070.net (--local-anchor runs one here).");
  printUrls();
  const stopPages = () => {
    pages.close();
    process.exit(0);
  };
  process.on('SIGINT', stopPages);
  process.on('SIGTERM', stopPages);
} else {
// --- The local anchor ---------------------------------------------------------
const meshIp = host === 'localhost' ? '127.0.0.1' : host;
const anchorArgs = [
  'anchor', 'serve',
  '--bind', `${meshIp}:0`,
  '--psk-file', pskFile,
  '--listen', `${host === 'localhost' ? '127.0.0.1' : '0.0.0.0'}:${anchorPort}`,
  '--url', `https://${host}:${anchorPort}`,
  '--rtc-bind', `${meshIp}:0`,
  '--tls-cert', certFile,
  '--tls-key', keyFile,
  '--issuer-identity', issuerFile,
  '--insecure-permissions',
  '--game', GAME,
  ...[...origins].flatMap((o) => ['--allow-origin', o]),
  '--output', 'ndjson',
  ...(process.env.ANCHOR_STATS ? ['--game-stats-secs', '5'] : []),
  ...(process.env.ANCHOR_VERBOSE ? [`-${'v'.repeat(Number(process.env.ANCHOR_VERBOSE) || 1)}`] : []),
];
const anchor = spawn(bin, anchorArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
anchor.stdout.setEncoding('utf8').on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    try {
      const report = JSON.parse(line);
      if (report.game_stats) console.log(`[anchor stats] ${JSON.stringify(report.game_stats)}`);
      else if (report.credential_endpoint) {
        console.log(`Anchor ready at https://${host}:${anchorPort} (game "${GAME}")`);
        printUrls(`?anchor=https://${host}:${anchorPort}`);
      }
    } catch {
      console.log(`[anchor] ${line}`);
    }
  }
});

let stopping = false;
anchor.on('exit', (code) => {
  if (stopping) return;
  console.error(`anchor exited (${code})`);
  pages.close();
  process.exit(code ?? 1);
});

const stop = () => {
  stopping = true;
  anchor.kill();
  pages.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
}
