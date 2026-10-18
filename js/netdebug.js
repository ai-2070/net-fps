// The network debug panel (F4, anywhere): the frame rate, NET and this
// page's node, and in a co-op game each link: the host's to every player, or
// a player's to the host. For each, whether it's direct or relayed through the
// anchor (and why, if the direct attempt ended), its latency (NET's netcode
// clock: the median round trip, and the jitter) and the traffic each way.
// Below, a live map of the game, and NET's own counters.
// It reads what's there twice a second; it owns nothing. NET stays unloaded
// until co-op is opened, so in solo it says so rather than loading it.

const EVERY = 500; // ms between readings
const kb = (bytes, s) => (bytes / 1024 / s).toFixed(1);
const ms = (v) => (v == null ? '…' : `${v} ms`);
const pad = (v, n) => String(v).slice(0, n).padEnd(n);
const lpad = (v, n) => String(v).slice(0, n).padStart(n);
const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Why a link is relayed, from its direct attempt's state (see NET's peerAttempt)
const ATTEMPT = { gathering: 'trying', open: 'trying', iceTimeout: 'ice timeout', udpBlocked: 'udp blocked', failed: 'failed' };

export class NetDebug {
  // `net()`: js/net.js once loaded (or null); `session()`: the co-op game's
  // session (or null, solo or in the menus); `player()`: this player's name
  constructor({ net, session, player }) {
    this.get = { net, session, player };
    this.el = document.createElement('aside');
    this.el.className = 'net-debug hidden';
    this.el.setAttribute('aria-label', 'Network debug');
    this.text = document.createElement('pre');
    this.map = new MeshMap();
    this.below = document.createElement('pre'); // (the counters, under the map)
    this.el.append(this.text, this.map.canvas, this.below);
    document.body.append(this.el);
    this.timer = null;
    this.watched = null; // (the session told our panel's open)
    this.last = null; // (the reading before, for rates)
    this.frames = 0;
    this.slowest = 0; // (the longest gap between two frames since the last reading)
    this.fps = 0;
    this.frameMs = 0;
  }

  get open() {
    return this.timer !== null;
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    this.el.classList.remove('hidden');
    this.map.start();
    this.last = null;
    this.timer = setInterval(() => this.render(), EVERY);
    let before = performance.now();
    const count = (now) => {
      if (!this.open) return;
      this.frames++;
      this.slowest = Math.max(this.slowest, now - before);
      before = now;
      requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
    this.render();
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    this.map.stop();
    this.watch(null);
    this.el.classList.add('hidden');
  }

  // Tell the session our panel's open (it reads the links more often then,
  // and a player asks the host to share its links for the map): only the
  // current one, only while open
  watch(session) {
    if (this.watched === session) return;
    this.watched?.watch?.(false);
    this.watched = session;
    session?.watch?.(true);
  }

  render() {
    const now = performance.now();
    const net = this.get.net();
    const session = this.get.session();
    this.watch(session);
    const dt = this.last ? (now - this.last.at) / 1000 : 0;
    if (dt) {
      this.fps = Math.round(this.frames / dt);
      this.frameMs = this.frames ? (dt * 1000) / this.frames : 0;
    }
    const measured = Boolean(dt);
    const slowest = this.slowest;
    this.frames = 0;
    this.slowest = 0;

    const info = net?.netInfo?.() ?? null;
    const stats = session?.netStats?.() ?? null;
    const lines = [];
    const head = (text) => lines.push(`<b>${esc(text)}</b>`);
    const row = (k, v) => lines.push(`<i>${pad(k, 10)}</i>${esc(v)}`);

    head('NET DEBUG');
    row('fps', measured ? `${this.fps} · a frame every ${this.frameMs.toFixed(1)} ms, the slowest ${slowest.toFixed(1)}` : '…');
    if (!info) {
      row('net', 'not loaded (opens with co-op)');
    } else {
      row('anchor', info.anchor.replace(/^https?:\/\//, ''));
      row('node', info.node ? `${info.node} (${info.lost ? `session lost: ${info.lost}` : 'connected'})` : info.connecting ? 'connecting…' : 'not connected');
    }

    // ---- The game ----
    const was = this.last?.peers ?? new Map();
    const peers = new Map();
    if (stats) {
      const hosting = stats.role === 'host';
      lines.push('');
      head(`GAME · ${hosting ? 'HOSTING' : 'JOINED'} · ${stats.game}`);
      row('me', `${this.get.player()} · ${stats.id.slice(0, 8)}${hosting ? ' · hosts the game' : ''}`);
      if (hosting) {
        const dropped = Object.entries(stats.dropped ?? {}).filter(([, n]) => n);
        row('netcode', `tick ${stats.tick} at 30 Hz · dropped ${dropped.length ? dropped.map(([why, n]) => `${why} ${n}`).join(', ') : 'none'}`);
        if (stats.sendError) row('send error', stats.sendError);
      } else {
        const n = stats.netcode;
        row('netcode', `${n.snapshots} snapshots (${n.lateSnapshots} late, ${n.partialSnapshots} partial) · ${n.corrections} corrections · ${n.pendingInputs} inputs waiting`);
        if (n.lastError) row('error', n.lastError);
      }
      if (hosting) {
        const direct = stats.peers.filter((p) => p.direct).length;
        row('players', `${stats.peers.length + 1} in the game · ${direct} direct, ${stats.peers.length - direct} relayed`);
      }
      lines.push('');
      lines.push(`<i>${pad(hosting ? 'player' : 'host', 15)}${pad('link', 22)}${lpad('latency', 8)}${lpad('jitter', 7)}${lpad('heard', 8)}${lpad('up kB/s', 9)}${lpad('down', 7)}</i>`);
      let up = 0;
      let down = 0;
      for (const p of stats.peers) {
        const before = was.get(p.id);
        const u = before && dt ? (p.outB - before.outB) / dt : null;
        const d = before && dt ? (p.inB - before.inB) / dt : null;
        up += u ?? 0;
        down += d ?? 0;
        peers.set(p.id, p);
        const who = `${p.name ?? p.id.slice(0, 6)}${p.id === stats.host ? '*' : ''}`;
        const link = p.direct ? 'direct' : !p.stream ? 'no link' : p.attempt && p.attempt !== 'open' && p.attempt !== 'gathering' ? `relayed (${ATTEMPT[p.attempt] ?? p.attempt})` : 'relayed';
        lines.push(`${pad(who, 15)}<span class="${p.direct ? 'ok' : 'warn'}">${pad(link, 22)}</span>${lpad(ms(p.rtt), 8)}${lpad(p.jitter == null ? '' : `${p.jitter}`, 7)}${lpad(p.heard == null ? '—' : `${p.heard}`, 8)}${lpad(u == null ? '…' : kb(u, 1), 9)}${lpad(d == null ? '…' : kb(d, 1), 7)}`);
      }
      if (!stats.peers.length) lines.push('(nobody else yet)');
      else if (stats.peers.length > 1) lines.push(`<i>${pad('total', 60)}</i>${lpad(kb(up, 1), 9)}${lpad(kb(down, 1), 7)}`);
      lines.push(`<i>* hosts the game · latency: median round trip${hosting ? ', as each player measures it' : ''} · heard: ms since its last frame</i>`);
      lines.push('<i>relayed: through the anchor, slower (the direct attempt in brackets, if it ended)</i>');
      lines.push('<i>players link to the host only: it runs the game (see js/net.js)</i>');
      const totals = stats.peers.reduce((t, p) => ({ inB: t.inB + p.inB, outB: t.outB + p.outB, inN: t.inN + p.inN, outN: t.outN + p.outN }), { inB: 0, outB: 0, inN: 0, outN: 0 });
      row('all told', `up ${(totals.outB / 1048576).toFixed(2)} MB in ${totals.outN} frames · down ${(totals.inB / 1048576).toFixed(2)} MB in ${totals.inN}`);
    } else if (info) {
      lines.push('');
      row('game', 'not in one');
    }

    // ---- The node's counters (under the map) ----
    const below = [];
    for (const [title, counters] of [['NODE', info?.counters], ['RTC', info?.rtc]]) {
      const entries = Object.entries(counters ?? {});
      if (!entries.length) continue;
      if (below.length) below.push('');
      below.push(`<b>${esc(`${title} · counters not zero`)}</b>`);
      for (const [k, v] of entries) below.push(`${pad(k, 34)}${lpad(v, 12)}`);
    }
    this.below.innerHTML = (below.length ? '\n' : '') + below.join('\n');

    this.text.innerHTML = lines.join('\n');
    this.map.update(stats && session?.meshView ? session.meshView() : null);
    this.last = { at: now, peers };
  }
}

// ---------- The game's links, drawn ----------
// Each page a node, placed so the distance between two is their round trip
// (springs pulling each pair to a length by its latency; pairs not measured
// yet just kept apart). Lines: dim for a direct link, dashed amber for one
// relayed through the anchor; ours bright, a packet running along each.
// Latency only: where players are isn't known (it would take their IP
// addresses), so near means quick, not close by. A player's map shows the
// host's links to the others once the host shares them (see js/net.js).

const LIME = '196, 255, 61';
const AMBER = '224, 180, 74';
const MAP_H = 250;

class MeshMap {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'net-map hidden';
    this.ctx = this.canvas.getContext('2d');
    this.view = null;
    this.pos = new Map(); // tag → { x, y, vx, vy } (in the map's own units: the canvas's CSS pixels)
    this.raf = null;
    this.t0 = performance.now();
  }

  start() {
    if (this.raf !== null) return;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.step();
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  // The game as the session has it (see meshView in js/net.js), or null: not in one
  update(view) {
    this.view = view;
    this.canvas.classList.toggle('hidden', !view);
    if (!view) return;
    const w = this.width();
    view.nodes.forEach((n, i) => {
      if (this.pos.has(n.tag)) return;
      const a = (i / Math.max(1, view.nodes.length)) * Math.PI * 2;
      this.pos.set(n.tag, { x: w / 2 + Math.cos(a) * 60, y: MAP_H / 2 + Math.sin(a) * 50, vx: 0, vy: 0 });
    });
    for (const tag of this.pos.keys()) if (!view.nodes.some((n) => n.tag === tag)) this.pos.delete(tag);
  }

  width() {
    return Math.max(260, this.canvas.clientWidth || 360);
  }

  // One step of the springs
  step() {
    const v = this.view;
    if (!v) return;
    const w = this.width();
    const h = MAP_H;
    const top = 30; // (under the map's heading)
    const nodes = v.nodes.map((n) => this.pos.get(n.tag)).filter(Boolean);
    const longest = Math.max(30, ...v.edges.map((e) => e.ms ?? 0));
    const span = Math.min(w, h - top) * 0.72;
    const length = (ms) => 56 + (ms / longest) * (span - 56);
    const pull = (a, b, rest, k) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (k * (d - rest)) / d;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    };
    for (const e of v.edges) {
      const a = this.pos.get(e.a);
      const b = this.pos.get(e.b);
      if (a && b && e.ms !== null) pull(a, b, length(e.ms), 0.02);
    }
    // (everyone kept apart: a pair not measured yet at least the shortest length)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < 64) pull(a, b, 64, 0.03);
      }
    }
    let cx = 0;
    let cy = 0;
    for (const p of nodes) {
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x += p.vx;
      p.y += p.vy;
      cx += p.x / nodes.length;
      cy += p.y / nodes.length;
    }
    // (centred, and inside)
    for (const p of nodes) {
      p.x = Math.min(w - 40, Math.max(40, p.x + (w / 2 - cx) * 0.1));
      p.y = Math.min(h - 26, Math.max(top + 18, p.y + ((h + top) / 2 - cy) * 0.1));
    }
  }

  draw() {
    const v = this.view;
    if (!v) return;
    const w = this.width();
    const h = MAP_H;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.height = `${h}px`;
    }
    const c = this.ctx;
    const t = performance.now() - this.t0;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#0d100d';
    c.fillRect(0, 0, w, h);
    // (the grid)
    c.strokeStyle = 'rgba(45, 53, 44, 0.45)';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = 0.5; x < w; x += 24) { c.moveTo(x, 26); c.lineTo(x, h); }
    for (let y = 26.5; y < h; y += 24) { c.moveTo(0, y); c.lineTo(w, y); }
    c.stroke();
    c.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
    c.textBaseline = 'middle';
    c.fillStyle = `rgb(${LIME})`;
    c.fillText('▸', 8, 13);
    c.fillStyle = '#6b7568';
    c.fillText('MESH.LATENCY', 20, 13);
    const legend = 'DIRECT ─  RELAYED ┄';
    c.fillText(legend, w - 8 - c.measureText(legend).width, 13);
    c.strokeStyle = 'rgba(45, 53, 44, 0.9)';
    c.beginPath(); c.moveTo(0, 26.5); c.lineTo(w, 26.5); c.stroke();

    // Lines, theirs under ours
    const edges = [...v.edges].sort((a, b) => Number(a.mine) - Number(b.mine));
    for (const e of edges) {
      const a = this.pos.get(e.a);
      const b = this.pos.get(e.b);
      if (!a || !b) continue;
      const colour = e.direct ? LIME : AMBER;
      c.strokeStyle = `rgba(${colour}, ${e.mine ? 0.9 : 0.35})`;
      c.lineWidth = e.mine ? 1.6 : 1;
      c.setLineDash(e.direct ? (e.mine ? [6, 5] : []) : [3, 4]);
      c.lineDashOffset = e.mine ? -t / 40 : 0;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      c.setLineDash([]);
      // (the latency, halfway)
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const label = e.ms === null ? '…' : `${e.ms} ms`;
      c.font = '10px "JetBrains Mono", ui-monospace, monospace';
      const lw = c.measureText(label).width + 6;
      c.fillStyle = 'rgba(13, 16, 13, 0.85)';
      c.fillRect(mx - lw / 2, my - 7, lw, 14);
      c.fillStyle = e.mine ? `rgb(${colour})` : `rgba(${colour}, 0.6)`;
      c.fillText(label, mx - lw / 2 + 3, my);
      // (ours: a packet running along it, there and back in its round trip, slowed to be seen)
      if (e.mine) {
        const me = this.pos.get(e.a === v.nodes[0].tag ? e.a : e.b);
        const them = me === a ? b : a;
        const period = 900 + (e.ms ?? 50) * 12;
        const f = (t % period) / period;
        const k = f < 0.5 ? f * 2 : 2 - f * 2;
        c.fillStyle = `rgb(${colour})`;
        c.beginPath(); c.arc(me.x + (them.x - me.x) * k, me.y + (them.y - me.y) * k, 3, 0, Math.PI * 2); c.fill();
      }
    }
    // Nodes
    for (const n of v.nodes) {
      const p = this.pos.get(n.tag);
      if (!p) continue;
      const r = n.me ? 8 : 6.5;
      c.strokeStyle = `rgba(${LIME}, ${n.leads ? 0.55 : 0.22})`;
      c.lineWidth = 1;
      c.beginPath(); c.arc(p.x, p.y, r + 7, 0, Math.PI * 2); c.stroke();
      c.fillStyle = n.me ? `rgb(${LIME})` : `rgba(${LIME}, 0.7)`;
      c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill();
      c.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
      const name = `${n.name.slice(0, 16)}${n.leads ? ' *' : ''}`;
      const id = `node.0x${n.tag.slice(0, 4)}${n.me ? ' (you)' : ''}`;
      const right = p.x + r + 10 + Math.max(c.measureText(name).width, c.measureText(id).width) < w;
      const x = right ? p.x + r + 10 : p.x - r - 10;
      c.textAlign = right ? 'left' : 'right';
      c.fillStyle = n.me ? `rgb(${LIME})` : `rgba(${LIME}, 0.75)`;
      c.fillText(name, x, p.y - 6);
      c.font = '10px "JetBrains Mono", ui-monospace, monospace';
      c.fillStyle = '#6b7568';
      c.fillText(id, x, p.y + 7);
      c.textAlign = 'left';
    }
    if (v.nodes.length < 2) {
      c.fillStyle = '#6b7568';
      c.fillText('alone in the game', 12, h - 14);
    }
  }
}
