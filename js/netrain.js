// The NET cards' packet rain (as on NET's own page, ai2070.net): columns of
// what passes over a mesh (packets, timings, node ids, calls) falling, each
// a bright lime head and a trail fading behind it. Drawn on each
// canvas.net-rain while it's on screen; still, one frame, for those who'd
// rather less motion.
const TOKENS = [
  'SYN', 'ACK', 'R2+B', 'hb.syn', 'hb.ack', 'fwd()', 'route()', 'cap.exec', 'cap.write', 'engram', 'pingpong',
  '0.93ns', '36ns', '113ns', '4.2ms', 'p50', 'p99', '0x4E45', 'node.0x4e', 'node.0xff', 'mesh.join', 'relay',
  'direct', 'ICE', 'DTLS', 'peer.07', 'peer.12', '01010100', '01001110', 'ERR', 'OK', 'evt', 'sig', 'ttl=7',
];
const LIME = [196, 255, 61];
const DIM = [107, 138, 30];
const FONT = 11; // px
const LINE = 14; // px between tokens down a column
const COLUMN = 64; // px between columns

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

function start(canvas) {
  const ctx = canvas.getContext('2d');
  let columns = [];
  let w = 0;
  let h = 0;
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    w = Math.max(1, r.width);
    h = Math.max(1, r.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.max(1, Math.ceil(w / COLUMN));
    columns = Array.from({ length: n }, (_, i) => column(i * COLUMN + Math.random() * 18, true));
  };
  // (a stream down a column: where its head is, how fast, how long its trail, its tokens)
  const column = (x, anywhere) => ({
    x,
    y: anywhere ? Math.random() * (h + 200) - 100 : -Math.random() * 160,
    speed: 18 + Math.random() * 46, // px a second
    length: 4 + Math.floor(Math.random() * 9),
    tokens: Array.from({ length: 14 }, () => pick(TOKENS)),
    swap: Math.random(),
  });
  const draw = (dt) => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = `400 ${FONT}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    for (const c of columns) {
      c.y += c.speed * dt;
      // (now and then a token changes, as the mesh's traffic does)
      c.swap -= dt;
      if (c.swap <= 0) {
        c.tokens[Math.floor(Math.random() * c.tokens.length)] = pick(TOKENS);
        c.swap = 0.3 + Math.random();
      }
      for (let k = 0; k < c.length; k++) {
        const y = c.y - k * LINE;
        if (y < -LINE || y > h) continue;
        const fade = 1 - k / c.length;
        const [r, g, b] = k === 0 ? LIME : DIM;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(k === 0 ? 0.95 : 0.7 * fade * fade).toFixed(3)})`;
        // (a column still above the top counts from below zero: wrapped round, not undefined)
        const n = c.tokens.length;
        ctx.fillText(c.tokens[(((Math.floor(c.y / LINE) + k) % n) + n) % n], c.x, y);
      }
      if (c.y - c.length * LINE > h) Object.assign(c, column(c.x, false));
    }
  };
  resize();
  new ResizeObserver(resize).observe(canvas);
  if (still) {
    draw(0);
    return;
  }
  let last = performance.now();
  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!canvas.offsetParent) return; // (not on screen: its screen's closed)
    draw(dt);
  };
  requestAnimationFrame(frame);
}

export function startNetRain() {
  for (const canvas of document.querySelectorAll('canvas.net-rain')) start(canvas);
}
