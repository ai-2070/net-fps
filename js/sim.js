// The arena layout and player movement, with no three.js in it, so the same
// rules run everywhere: in solo, on a co-op host (authoritative), and on each
// co-op client (prediction). If the host and a client ever disagreed about
// movement, every host snapshot would pull the client back.

export const PLAYER = { radius: 0.35, height: 1.75, eye: 1.6, walk: 5.5, sprint: 8.5, jump: 7.2, gravity: 22 };
export const ARENA = 25; // half-size of the square arena
export const WALL_HEIGHT = 4;
export const STEP_DT = 1 / 60; // co-op inputs are sampled at a fixed rate

// [x, z, width, height, depth]
export const CRATES = [
  [-8, -6, 2, 2, 2], [-6.4, -6.6, 1.2, 1.2, 1.2], [8, 5, 2, 2, 2], [9.8, 5.4, 1, 1, 1],
  [12, -10, 3, 3, 3], [-12, -14, 2, 2, 2],
];
export const CONCRETE = [
  [0, -11, 6, 1.1, 0.5], [0, 8, 4, 1, 1], [-12, 10, 1, 3, 6], [-18, 0, 1, 1.4, 8], [18, 2, 1, 1.4, 6],
  [16, 16, 1.5, 5, 1.5], [-16, 16, 1.5, 5, 1.5], [16, -16, 1.5, 5, 1.5], [-16, -16, 1.5, 5, 1.5],
];
const WALL_SPAN = ARENA * 2 + 2;
export const WALLS = [
  [0, -ARENA - 0.5, WALL_SPAN, WALL_HEIGHT, 1],
  [0, ARENA + 0.5, WALL_SPAN, WALL_HEIGHT, 1],
  [-ARENA - 0.5, 0, 1, WALL_HEIGHT, WALL_SPAN],
  [ARENA + 0.5, 0, 1, WALL_HEIGHT, WALL_SPAN],
];

// Axis-aligned boxes the player collides with (the same boxes the map draws)
export const COLLIDERS = [...WALLS, ...CRATES, ...CONCRETE].map(([x, z, w, h, d]) => ({
  min: { x: x - w / 2, y: 0, z: z - d / 2 },
  max: { x: x + w / 2, y: h, z: z + d / 2 },
}));

export function spawnState(x = 0, z = 2) {
  return { x, y: 0, z, vx: 0, vy: 0, vz: 0, g: 1, yaw: 0, pitch: 0 };
}

// Advance a player one step.
//   state: { x, y, z, vx, vy, vz, g (on ground, 0/1), yaw, pitch }
//   input: { f, s (-1..1), yaw, pitch, sprint, aim, jump (booleans), dt }
export function stepPlayer(state, input) {
  const dt = input.dt;
  const speed = input.aim ? PLAYER.walk * 0.55 : input.sprint ? PLAYER.sprint : PLAYER.walk;

  // At yaw 0 the camera looks down -Z: forward = (-sin, 0, -cos), right = (cos, 0, -sin)
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  let wx = -sin * input.f + cos * input.s;
  let wz = -cos * input.f - sin * input.s;
  const len = Math.hypot(wx, wz);
  if (len > 0) {
    wx = (wx / len) * speed;
    wz = (wz / len) * speed;
  }

  const s = { ...state, yaw: input.yaw, pitch: input.pitch };
  const blend = 1 - Math.exp(-(s.g ? 14 : 2.5) * dt);
  s.vx += (wx - s.vx) * blend;
  s.vz += (wz - s.vz) * blend;

  if (input.jump && s.g) {
    s.vy = PLAYER.jump;
    s.g = 0;
  }
  s.vy -= PLAYER.gravity * dt;

  moveAxis(s, 'x', s.vx * dt);
  moveAxis(s, 'z', s.vz * dt);
  moveAxis(s, 'y', s.vy * dt);
  return s;
}

// Resolve movement one axis at a time against the static boxes.
function moveAxis(s, axis, delta) {
  const r = PLAYER.radius;
  const h = PLAYER.height;
  const eps = 1e-4;
  s[axis] += delta;

  if (axis === 'y') {
    s.g = 0;
    if (s.y <= 0) {
      s.y = 0;
      if (s.vy < 0) s.vy = 0;
      s.g = 1;
    }
  }

  for (const b of COLLIDERS) {
    if (s.x + r <= b.min.x || s.x - r >= b.max.x) continue;
    if (s.z + r <= b.min.z || s.z - r >= b.max.z) continue;
    if (s.y + h <= b.min.y || s.y >= b.max.y) continue;

    if (axis === 'x') s.x = delta > 0 ? b.min.x - r - eps : b.max.x + r + eps;
    else if (axis === 'z') s.z = delta > 0 ? b.min.z - r - eps : b.max.z + r + eps;
    else if (delta <= 0) {
      s.y = b.max.y;
      s.vy = 0;
      s.g = 1;
    } else {
      s.y = b.min.y - h - eps;
      s.vy = 0;
    }
  }
}

// Untrusted input from the network → a clean input. Bounds dt so nobody
// moves faster by claiming big time steps.
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export function parseInput(v) {
  return {
    f: clamp(Math.round(num(v?.f)), -1, 1),
    s: clamp(Math.round(num(v?.s)), -1, 1),
    yaw: num(v?.yaw),
    pitch: clamp(num(v?.pitch), -Math.PI / 2, Math.PI / 2),
    sprint: Boolean(v?.sprint),
    aim: Boolean(v?.aim),
    jump: Boolean(v?.jump),
    dt: clamp(num(v?.dt, STEP_DT), 0, 0.05),
  };
}
