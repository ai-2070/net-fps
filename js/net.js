// Co-op over NET (@net-mesh/browser, https://ai2070.net/docs).
//
// One player hosts: their page runs a NET lobby (a store holding the roster,
// names, colours and kill counts, and the listing the server browser shows) and
// the netcode host (the authoritative tick for movement, shots and targets).
// Everyone else finds the lobby with listLobbies and joins it.
//
// Movement uses netcode: each player predicts their own movement with the
// shared rules in sim.js and the host confirms it. Shots are resolved on the
// host with lag compensation (netcode's rewind), so a shot hits what the
// shooter saw when they fired.

import { connect, createLobby, defineStore, joinLobby, listLobbies, peerIdHex, requestCredential } from '@net-mesh/browser';
import { hostNetcode, joinNetcode } from '@net-mesh/browser/netcode';
import { parseInput, spawnState, stepPlayer } from './sim.js';

export const GAME = 'net-shooter';
const STORE_PREFIX = 'net-shooter.lobby.';
const MOVEMENT_PREFIX = 'net-shooter.movement.';
const MAX_NAME = 24;
const COLORS = [0x3d7bd9, 0x3dbf5a, 0xe0a526, 0x9b4dd9];
const MAX_SHOTS_PER_INPUT = 4;

const params = new URLSearchParams(location.search);
// The anchor introduces browsers to each other. By default that is NET's
// public anchor, which admits any game from any site: players of this page
// meet each other there, and never another site's players. `?anchor=https://…`
// points the page at another one, such as the one `npm start -- --local-anchor`
// runs on :8444.
export const PUBLIC_ANCHOR = 'https://anchor.ai2070.net';
export const ANCHOR_URL = params.get('anchor') ?? PUBLIC_ANCHOR;

const cleanName = (v, fallback = 'Player') =>
  String(v ?? '').replace(/[^\p{L}\p{N} _.'#-]/gu, '').trim().slice(0, MAX_NAME) || fallback;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// --- The lobby store: roster, names, colours, kills -------------------------
const parsePlayer = (v) => ({ name: cleanName(v?.name), color: Number(v?.color) >>> 0, kills: Math.max(0, num(v?.kills)) });

// Every hosted game gets its own store id and movement label (a random
// suffix). Between the same two nodes, a second game under the same names
// would reuse streams the first game closed, and a player who stayed in their
// tab could not join the host's next game ("no store … answered the join").
// Joiners read the id from the listing, so both sides always agree.
const STORE_VERSION = 1;
const definitions = new Map();
function lobbyStore(suffix) {
  if (!definitions.has(suffix)) definitions.set(suffix, defineLobbyStore(`${STORE_PREFIX}${suffix}`));
  return definitions.get(suffix);
}

const defineLobbyStore = (id) => defineStore({
  id,
  version: STORE_VERSION,
  state: (v) => {
    const players = {};
    for (const [id, p] of Object.entries(v?.players ?? {})) players[String(id)] = parsePlayer(p);
    return { host: String(v?.host ?? ''), kills: Math.max(0, num(v?.kills)), players };
  },
  empty: () => ({ host: '', kills: 0, players: {} }),
  visibility: 'open', // names, colours and scores are public
  actions: {
    enlist: {
      input: (v) => ({ name: cleanName(v?.name), password: String(v?.password ?? '').slice(0, 64) }),
      output: (v) => ({ color: Number(v?.color) >>> 0 }),
    },
  },
  inputs: {},
});

// --- Connecting ---------------------------------------------------------------
// One NET node for the life of the page: browsing, hosting, joining and
// retrying all use it. Opening a second node in the same tab right after
// closing one leaves it without a session to the host. Each page load is a
// fresh identity (no rememberedIdentity): a reloaded page that came back as
// the same node could not re-handshake with a host still holding its old session.
let nodePromise = null;
let theNode = null; // (the node, once connected: for the F4 panel, see netInfo)
let playing = false; // (in a game, or on the way into one: see hostGame, joinGame)

function getNode(onStatus = () => {}) {
  nodePromise ??= (async () => {
    onStatus('Connecting to NET…');
    let credential;
    try {
      credential = await requestCredential({ anchorUrl: ANCHOR_URL, game: GAME });
    } catch (error) {
      throw new Error(
        error?.kind === 'unreachable'
          ? `Can't reach the NET anchor at ${ANCHOR_URL}.`
          : `The anchor refused a credential (${error?.kind ?? error?.message ?? error}).`
      );
    }
    const node = await connect({ credentialB64: credential.credentialB64, bootstrapUrl: credential.bootstrapUrl });
    // (its session with the anchor gone: see liveNode)
    node.onEvent((event) => {
      if (event.type === 'disconnected') node.__lost = event.reason ?? 'disconnected';
    });
    node.__checked = performance.now();
    countTraffic(node);
    theNode = node;
    return node;
  })();
  nodePromise.catch(() => { nodePromise = null; });
  return nodePromise;
}

// The node, still connected. A page left in the background a while (another
// tab, another program) can lose its session with the anchor: the browser
// slows or freezes it, and the anchor drops it. It then neither sees the games
// nor is seen hosting one, so it's checked before it's used for that (if not
// lately), and when the page comes back to the front: a call to a service
// nobody runs, which the anchor itself refuses (a lookup won't do: the node
// answers those from what it last heard). No answer in time, or the session
// lost: a new node is made, as a reload would. Never while in a game: the
// game's node stays.
const CHECK_EVERY = 20000; // ms a check holds
const CHECK_WAIT = 5000; // ms an answer has
const PROBE_SERVICE = 'net-shooter.alive'; // (nobody serves it: the anchor's refusal is the answer)

async function liveNode(onStatus, force = false) {
  const node = await getNode(onStatus);
  if (playing) return node;
  if (!node.__lost && !force && performance.now() - node.__checked < CHECK_EVERY) return node;
  // (one check at a time, whoever asks)
  node.__checking ??= checkNode(node).finally(() => { node.__checking = null; });
  if ((await node.__checking) || playing) return node;
  if (!node.__replaced) {
    node.__replaced = true;
    console.warn(`NET: the connection was lost (${node.__lost ?? 'no answer'}); connecting again`);
    if (nodePromise && (await nodePromise.catch(() => null)) === node) nodePromise = null;
    if (theNode === node) theNode = null;
    try { node.close(); } catch { /* already gone */ }
  }
  return getNode(onStatus);
}

// Whether the node's session with the anchor is still there (see liveNode)
async function checkNode(node) {
  if (node.__lost) return false;
  const answered = await Promise.race([
    node.call(PROBE_SERVICE, new Uint8Array(0), CHECK_WAIT).then(() => true, (error) => error?.kind === 'rpc-refused'),
    new Promise((resolve) => setTimeout(() => resolve(false), CHECK_WAIT + 500)),
  ]);
  if (answered && !node.__lost) node.__checked = performance.now();
  return answered && !node.__lost;
}

// (back to the front, not in a game: checked at once, so the server browser's next look finds it well)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && nodePromise && !playing) liveNode(undefined, true).catch(() => {});
});

window.addEventListener('pagehide', () => {
  nodePromise?.then((node) => node.close()).catch(() => {});
});

// --- For the network debug panel (F4, js/netdebug.js) --------------------------
// The panel only reads. What it reads is gathered here: traffic with each
// peer, NET's own counters, and (in a game, see the sessions' netStats) each
// link and its round trip.

// Bytes and frames each way with each peer (16-hex id), over every stream
// this node opens or receives on (movement and the lobby store alike), and
// when the peer was last heard from. Counted by wrapping the node's own
// openStream and send, and listening to its stream events.
const traffic = new Map(); // peer → { inB, inN, outB, outN, heard }
function trafficOf(peer) {
  let t = traffic.get(peer);
  if (!t) traffic.set(peer, (t = { inB: 0, inN: 0, outB: 0, outN: 0, heard: 0 }));
  return t;
}
const hexOf = (peer) => String(peer ?? '').toLowerCase().replace(/^0x/, '').padStart(16, '0');

function countTraffic(node) {
  const open = node.openStream.bind(node);
  node.openStream = (options) => {
    const stream = open(options);
    if (options?.peer) {
      const peer = hexOf(options.peer);
      const send = stream.send.bind(stream);
      stream.send = (payload) => {
        const t = trafficOf(peer);
        t.outB += payload?.byteLength ?? 0;
        t.outN++;
        return send(payload);
      };
    }
    return stream;
  };
  node.onEvent((event) => {
    if (event.type !== 'stream_data' || !event.payload) return;
    let peer;
    try { peer = peerIdHex(event.peerNode); } catch { return; } // (stream events name the peer in decimal)
    const t = trafficOf(peer);
    t.inB += event.payload.byteLength;
    t.inN++;
    t.heard = performance.now();
  });
}

// One peer's traffic as the panel shows it: totals, and ms since last heard
function trafficFor(peer) {
  const t = traffic.get(peer);
  if (!t) return { inB: 0, inN: 0, outB: 0, outN: 0, heard: null };
  return { inB: t.inB, inN: t.inN, outB: t.outB, outN: t.outN, heard: t.heard ? Math.round(performance.now() - t.heard) : null };
}

// NET on this page: the anchor, this node, and its counters that aren't zero
// (nested ones flattened as `group.name`)
const flat = (counters, prefix = '') => Object.entries(counters ?? {}).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
const nonzero = (counters) => Object.fromEntries(flat(counters).filter(([, v]) => v !== '0' && v !== 0));
export function netInfo() {
  let counters = {};
  let rtc = {};
  try { counters = nonzero(theNode?.counters()); } catch { /* not there yet */ }
  try { rtc = nonzero(theNode?.rtcStats().counters); } catch { /* not there yet */ }
  return {
    anchor: ANCHOR_URL,
    node: theNode?.nodeIdHex() ?? null,
    connecting: Boolean(nodePromise) && !theNode,
    lost: theNode?.__lost ?? null,
    playing,
    counters,
    rtc,
  };
}

// The direct-link attempt NET has with `peer`, as the panel shows it
// ({ state, direct }, or null before any attempt)
function attemptOf(node, peer) {
  return node.peerAttempt(peer).then((a) => ({ state: a.state, direct: a.direct }), () => null);
}

// How often a player tells the host its round trip (see joinGame): always,
// so the host's panel has it when opened; more often while a panel is open
const REPORT_EVERY = 1000;
const REPORT_EVERY_WATCHED = 500;
// How long a player's "my panel is open" holds (see the host's `links` entity)
const WATCH_HOLDS_MS = 3000;
// How often an open panel reads the links (peerAttempt)
const LINKS_EVERY = 500;

// --- Direct links -----------------------------------------------------------------
// Players start over a session relayed through the anchor, and NET tries for
// a direct (WebRTC) link underneath that takes over when it comes. Since NET
// 0.39, connectPeer never cancels an attempt under way nor re-offers on a
// direct pair, so it's safe to call "to be sure"; but it only returns once the
// attempt has settled, which, where no direct link can be had, is the whole
// ICE deadline (seconds).

// How long a joiner waits for a direct link before going on over the relayed
// one (the direct one, should it come, takes over underneath)
const DIRECT_WAIT_MS = 1500;

// The link NET has with `peer`: 'direct', 'trying' (an attempt under way:
// gathering, or its channel open but not yet direct), 'ended' (the last
// attempt ended without a direct link) or 'none' (no attempt yet)
function linkWith(node, peer) {
  return node.peerAttempt(peer).then(
    (a) => (a.direct ? 'direct' : a.state === 'gathering' || a.state === 'open' ? 'trying' : 'ended'),
    () => 'none',
  );
}

// The node, as joinLobby sees it: its connectPeer goes on after
// DIRECT_WAIT_MS (the relayed session is up by then), leaving the direct
// attempt to carry on
function quickJoin(node) {
  return Object.create(node, {
    connectPeer: {
      value: (peer) => Promise.race([
        node.connectPeer(peer),
        new Promise((resolve) => setTimeout(() => resolve({ type: 'pending', peer }), DIRECT_WAIT_MS)),
      ]),
    },
  });
}

// --- Server browser -----------------------------------------------------------
// The open lobbies, in the shape the server browser lists.
export async function browseGames(onStatus) {
  const node = await liveNode(onStatus);
  onStatus?.('Searching for games…');
  // Announcements take a moment to reach a node that just connected, so an
  // empty list is only believed after a few seconds of looking
  const deadline = Date.now() + 4000;
  let lobbies = await listLobbies({ node, game: GAME });
  while (lobbies.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    lobbies = await listLobbies({ node, game: GAME });
  }
  return lobbies.map((l) => ({
    id: l.code,
    name: l.name,
    region: String(l.info.region ?? '—'),
    map: String(l.info.map ?? 'Warehouse'),
    players: l.players,
    max: l.capacity,
    route: 'unknown', // NET only knows the path once you're connected
    locked: Boolean(l.info.locked),
    listing: l,
  }));
}

// --- Shared bits ----------------------------------------------------------------
function spawnFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return spawnState(((h % 7) - 3) * 1.2, 2 + ((h >> 3) % 3));
}

// Clean up a player's shots from the wire: origin and direction, at most a few per input
function parseShots(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_SHOTS_PER_INPUT).map((s) => ({
    o: [num(s?.o?.[0]), num(s?.o?.[1]), num(s?.o?.[2])],
    d: [num(s?.d?.[0]), num(s?.d?.[1]), num(s?.d?.[2])],
  }));
}

// Remote players and targets are drawn between two host snapshots: lerp the
// numbers, turn the short way round, and take counters and flags from the newer one.
const LERP_KEYS = ['x', 'y', 'z', 'pitch'];
function interpolate(a, b, t) {
  const out = { ...b };
  for (const k of LERP_KEYS) if (k in a && k in b) out[k] = a[k] + (b[k] - a[k]) * t;
  if ('yaw' in a && 'yaw' in b) {
    const d = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
    out.yaw = a.yaw + d * t;
  }
  return out;
}

// --- Hosting --------------------------------------------------------------------
// Returns a session for the game (see Game.startCoop).
export async function hostGame({ game, settings, name, onStatus }) {
  const node = await liveNode(onStatus);
  playing = true;
  try {
    return await openGame({ node, game, settings, name, onStatus });
  } catch (error) {
    playing = false;
    throw error;
  }
}

async function openGame({ node, game, settings, name, onStatus }) {
  const myId = node.nodeIdHex();
  const password = settings.password ?? '';
  const suffix = Math.random().toString(36).slice(2, 10);
  const gameName = cleanName(settings.name, 'Co-op game');

  onStatus('Opening the lobby…');
  const lobby = await createLobby({
    node,
    game: GAME,
    name: gameName,
    capacity: settings.maxPlayers,
    info: {
      region: settings.region,
      map: settings.map,
      locked: password.length > 0,
      friendlyFire: Boolean(settings.friendlyFire),
    },
    definition: lobbyStore(suffix),
    initialState: { host: myId, kills: 0, players: {} },
    actions: {
      // Joining the roster: checked here, on the host, so the password never
      // leaves this page
      enlist: (input, context) => {
        const state = context.getState();
        if (context.peer !== state.host && input.password !== password) throw new Error('wrong password');
        const used = new Set(Object.values(state.players).map((p) => p.color));
        const players = { ...state.players };
        players[context.peer] ??= { name: input.name, color: COLORS.find((c) => !used.has(c)) ?? COLORS[0], kills: 0 };
        players[context.peer] = { ...players[context.peer], name: input.name };
        context.setState({ players });
        return { color: players[context.peer].color };
      },
    },
    onEvent: (event, context) => {
      if (event.type !== 'leave') return;
      const players = { ...context.getState().players };
      delete players[event.peer];
      context.setState({ players });
    },
  });
  const store = lobby.host;
  await lobby.self.ready();
  await lobby.self.act('enlist', { name, password });

  // Authoritative state: every player's movement lives here; targets live in the game
  const world = { [myId]: spawnFor(myId) };
  // For the F4 panel: each player's round trip to us as they measure it, and
  // whether their panel is open (see joinGame's reports); each link's attempt
  const reports = new Map(); // peer → { rtt, jitter, direct, watching (until when) }
  const attempts = new Map(); // peer → { state, direct }
  let linksTimer = null;
  const note = (peer, report) => {
    if (!Array.isArray(report)) return;
    const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
    reports.set(peer, { rtt: n(report[0]), jitter: n(report[1]), direct: report[2] === 1, watching: report[3] === 1 ? performance.now() + WATCH_HOLDS_MS : 0 });
  };
  const shotsFired = {}; // id → { sh, hx, hy, hz }: last shot, for others' tracers

  const credit = (peer) => {
    const state = store.getState();
    const player = state.players[peer];
    if (!player) return;
    store.setState({
      ...state,
      kills: state.kills + 1,
      players: { ...state.players, [peer]: { ...player, kills: player.kills + 1 } },
    });
  };

  const fire = (peer, shots, rewound) => {
    for (const shot of shots) {
      const result = game.resolveShot(shot, world[peer], rewound);
      const prev = shotsFired[peer] ?? { sh: 0 };
      shotsFired[peer] = { sh: prev.sh + 1, hx: result.end.x, hy: result.end.y, hz: result.end.z };
      if (result.kill) credit(peer);
    }
  };

  // A player's last shot rides as its own entity (`shot:<id>`), so the
  // player's movement state holds only what prediction reproduces
  const addPlayer = (out, id) => {
    out[id] = world[id];
    if (shotsFired[id]) out[`shot:${id}`] = shotsFired[id];
  };
  const isEnlisted = (peer) => Boolean(store.getState().players[peer]);

  // Only players whose inputs are still arriving are drawn, so a closed tab's
  // character disappears as soon as netcode drops it
  let netHost = null;
  const snapshot = () => {
    const live = new Set(netHost?.players() ?? []);
    live.add(myId);
    const out = game.targetStates();
    for (const id of Object.keys(world)) if (live.has(id)) addPlayer(out, id);
    // (a player's F4 panel open: every link to us and its round trip, so
    // their map can draw the whole game, not only their own link)
    if (someoneWatching()) out['net:links'] = { l: linkTable(live) };
    return out;
  };
  const someoneWatching = () => {
    const now = performance.now();
    for (const r of reports.values()) if (r.watching > now) return true;
    return false;
  };
  const linkDirect = (peer) => attempts.get(peer)?.direct ?? (direct.has(peer) || reports.get(peer)?.direct === true);
  // peer → [round trip in ms (-1: not measured yet), 1 direct / 0 relayed]
  const linkTable = (live) => {
    const l = {};
    for (const id of live) {
      if (id === myId) continue;
      l[id] = [reports.get(id)?.rtt ?? -1, linkDirect(id) ? 1 : 0];
    }
    return l;
  };

  netHost = hostNetcode({
    transport: node,
    label: `${MOVEMENT_PREFIX}${suffix}`,
    tickRate: 30,
    playerTimeoutMs: 2000,
    authorize: (peer) => peer !== myId && isEnlisted(peer),
    step: ({ inputs }) => {
      for (const [peer, list] of inputs) {
        for (const { data, seen } of list) {
          if (data?.net) note(peer, data.net);
          world[peer] = stepPlayer(world[peer] ?? spawnFor(peer), parseInput(data));
          const shots = parseShots(data?.shots);
          // Lag compensation: resolve against the targets as this player saw them
          if (shots.length) fire(peer, shots, netHost.rewind(seen).entities);
        }
      }
    },
    snapshot,
  });

  // Direct connections: a joiner offers the host a direct WebRTC link while
  // joining, and the link also needs this side to answer (acceptPeer).
  // Without it every join waits out the ICE deadline and stays relayed through
  // the anchor. Answered whenever the pair isn't direct and no attempt is under
  // way, however often it was before: with no offer waiting, acceptPeer gives
  // up after a few seconds and changes nothing.
  const direct = new Set();
  const answering = new Set();
  const seekTag = `net-lobby:${GAME}:seek:${myId}`;
  const answer = (peer) => {
    if (answering.has(peer)) return;
    answering.add(peer);
    linkWith(node, peer)
      .then((link) => {
        if (link === 'direct') direct.add(peer);
        else direct.delete(peer);
        if (link === 'direct' || link === 'trying') return null;
        return node.acceptPeer(peer).then((outcome) => { if (outcome?.type === 'direct') direct.add(peer); });
      })
      .catch(() => {})
      .finally(() => answering.delete(peer));
  };
  const seekTimer = setInterval(async () => {
    for (const { peerIdHex: peer } of await node.query(seekTag).catch(() => [])) answer(peer);
  }, 500);

  const stopPlayers = lobby.subscribePlayers((players) => {
    const present = new Set(players);
    for (const id of Object.keys(world)) {
      if (!present.has(id)) {
        delete world[id];
        delete shotsFired[id];
      }
    }
    for (const id of direct) if (!present.has(id)) direct.delete(id);
    for (const id of reports.keys()) if (!present.has(id)) reports.delete(id);
    for (const id of attempts.keys()) if (!present.has(id)) attempts.delete(id);
  });

  // The players in the game but us: connected to the netcode, or on the roster
  const others = () => {
    const ids = new Set([...(netHost.players() ?? []), ...Object.keys(store.getState().players)]);
    ids.delete(myId);
    return [...ids];
  };

  return {
    myId,
    isHost: true,
    label: 'Hosting',
    roster: () => store.getState().players,
    teamKills: () => store.getState().kills,
    entities: () => {
      const out = {};
      const live = new Set([...(netHost.players() ?? []), myId]);
      for (const id of Object.keys(world)) if (live.has(id)) addPlayer(out, id);
      return out;
    },
    // The host's own player is authoritative: apply its input directly
    input: (i) => {
      world[myId] = stepPlayer(world[myId], parseInput(i));
      const shots = parseShots(i.shots);
      if (shots.length) fire(myId, shots, null);
    },
    onEnd: () => {},
    // For the F4 panel (js/netdebug.js). `watch(true)`: the panel's open, so
    // each link's attempt is read every LINKS_EVERY ms
    watch(on) {
      clearInterval(linksTimer);
      linksTimer = null;
      if (!on) return;
      const read = () => {
        for (const id of others()) attemptOf(node, id).then((a) => { if (a) attempts.set(id, a); });
      };
      read();
      linksTimer = setInterval(read, LINKS_EVERY);
    },
    netStats: () => {
      const roster = store.getState().players;
      const connected = new Set(netHost.players() ?? []);
      return {
        role: 'host',
        id: myId,
        host: myId,
        name: roster[myId]?.name ?? name,
        game: gameName,
        tick: netHost.currentTick,
        dropped: netHost.dropped,
        sendError: netHost.lastSendError,
        sharing: someoneWatching(),
        peers: others().map((id) => ({
          id,
          name: roster[id]?.name ?? null,
          direct: linkDirect(id),
          attempt: attempts.get(id)?.state ?? null,
          stream: connected.has(id),
          rtt: reports.get(id)?.rtt ?? null,
          jitter: reports.get(id)?.jitter ?? null,
          ...trafficFor(id),
        })),
      };
    },
    // The game as the panel's map draws it: us in the middle, a link to each player
    meshView: () => {
      const roster = store.getState().players;
      const ids = others();
      const nodes = [{ tag: myId, name: roster[myId]?.name ?? name, me: true, leads: true }];
      for (const id of ids) nodes.push({ tag: id, name: roster[id]?.name ?? id.slice(0, 6), me: false, leads: false });
      const edges = ids.map((id) => ({ a: myId, b: id, ms: reports.get(id)?.rtt ?? null, direct: linkDirect(id), mine: true }));
      return { nodes, edges };
    },
    debug: () => ({
      id: myId,
      code: lobby.code,
      lobby: lobby.players(),
      net: netHost.players(),
      direct: [...direct],
      shots: Object.fromEntries(Object.entries(shotsFired).map(([id, s]) => [id, s.sh])),
      kills: store.getState().kills,
      targetsHp: Object.values(game.targetStates()).map((t) => (t.a ? t.hp : 0)),
      dropped: netHost.dropped,
    }),
    leave: async () => {
      clearInterval(seekTimer);
      clearInterval(linksTimer);
      stopPlayers();
      netHost.close();
      await lobby.close().catch(() => {});
      playing = false;
    },
  };
}

// --- Joining --------------------------------------------------------------------
export async function joinGame({ listing, name, password, onStatus }) {
  const node = await liveNode(onStatus);
  const myId = node.nodeIdHex();
  playing = true;

  onStatus('Joining…');
  let replica;
  let suffix;
  try {
    // The listing names the host's store as `<id>@<version>`
    const [storeId, version] = String(listing.store).split('@');
    if (!storeId.startsWith(STORE_PREFIX) || Number(version) !== STORE_VERSION) {
      throw Object.assign(new Error('That game runs a different version of Net Shooter.'), { code: 'version-mismatch' });
    }
    suffix = storeId.slice(STORE_PREFIX.length);
    const enlist = async (via) => {
      replica = await joinLobby({ node: via, definition: lobbyStore(suffix), game: GAME, lobby: listing });
      await replica.ready();
      await replica.act('enlist', { name, password });
    };
    try {
      // Joining doesn't wait for a direct link: the game starts on the
      // relayed session, and the direct one, should it come, replaces it
      // underneath (see quickJoin)
      await enlist(quickJoin(node));
    } catch (error) {
      if (error?.code === 'action-rejected' || error?.code === 'forbidden') throw error;
      // (the relayed session not up in time after all: the full wait)
      console.warn('quick join failed, joining the slow way:', error?.code ?? error?.message ?? error);
      await replica?.close().catch(() => {});
      replica = undefined;
      await enlist(node);
    }
  } catch (error) {
    console.warn('join failed:', error?.code ?? error?.kind, error?.message ?? error);
    playing = false;
    await replica?.close().catch(() => {});
    const reason = {
      'action-rejected': 'Wrong password.',
      forbidden: 'That game is full.',
      'not-found': 'The host could not be reached. It may have closed the game.',
      'owner-lost': 'The host closed the game.',
      'version-mismatch': error?.message,
    }[error?.code];
    throw new Error(reason ?? `Couldn't join: ${error?.code ?? error?.message ?? error}`);
  }

  const hostId = replica.getState().host;
  // Joining the lobby already set up a session with the host. Netcode would
  // call connectPeer before opening its stream, which on a relayed pair re-runs
  // a direct attempt and holds movement back until ICE gives up. Hand it the
  // node without connectPeer so movement starts on the session we have.
  const transport = {
    nodeIdHex: () => node.nodeIdHex(),
    onEvent: (handler) => node.onEvent(handler),
    openStream: (options) => node.openStream(options),
  };
  const net = joinNetcode({
    transport,
    host: hostId,
    label: `${MOVEMENT_PREFIX}${suffix}`,
    local: { id: myId, predict: (e, i) => stepPlayer(e ?? spawnFor(myId), parseInput(i)) },
    interpolate,
    interpolationDelayMs: 100,
  });

  let route = 'Connecting';
  let attempt = null; // (the direct attempt with the host, as last read: for the F4 panel)
  const readRoute = async () => {
    attempt = await attemptOf(node, hostId);
    route = attempt?.direct ? 'Direct' : 'Relayed';
  };
  const routeTimer = setInterval(readRoute, 1000);

  // For the F4 panel (js/netdebug.js): our round trip to the host rides along
  // with an input now and then, so the host's panel can show it, and so the
  // host knows when our panel is open (it then shares its links with us: the
  // `net:links` entity, see openGame)
  let watching = false;
  let linksTimer = null;
  let reportedAt = 0;
  const report = () => {
    const now = performance.now();
    if (now - reportedAt < (watching ? REPORT_EVERY_WATCHED : REPORT_EVERY)) return null;
    const clock = net.stats().clock;
    if (!clock && !watching) return null;
    reportedAt = now;
    return [clock ? Math.round(clock.rttMs) : -1, clock ? Math.round(clock.jitterMs) : -1, attempt?.direct ? 1 : 0, watching ? 1 : 0];
  };
  const hostName = () => replica.getState().players[hostId]?.name ?? null;

  let endListener = () => {};
  const stopStatus = replica.subscribeStatus((status) => {
    if (status.error?.code === 'owner-lost' || status.phase === 'closed') endListener('The host closed the game.');
    else if (status.phase === 'failed') endListener('Lost the connection to the host.');
  });

  return {
    myId,
    isHost: false,
    get label() {
      const clock = net.stats().clock;
      return clock ? `${route} · ${Math.round(clock.rttMs)} ms` : route;
    },
    roster: () => replica.getState().players,
    teamKills: () => replica.getState().kills,
    entities: () => net.view(),
    input: (i) => {
      const r = report();
      net.input(r ? { ...i, net: r } : i);
    },
    onEnd: (fn) => { endListener = fn; },
    watch(on) {
      watching = on;
      reportedAt = 0; // (told at once)
      clearInterval(linksTimer);
      linksTimer = on ? setInterval(readRoute, LINKS_EVERY) : null;
    },
    netStats: () => {
      const stats = net.stats();
      const clock = stats.clock;
      return {
        role: 'player',
        id: myId,
        host: hostId,
        name: replica.getState().players[myId]?.name ?? name,
        game: cleanName(listing.name, 'Co-op game'),
        netcode: stats,
        sharing: Boolean(net.view()['net:links']),
        peers: [{
          id: hostId,
          name: hostName(),
          direct: Boolean(attempt?.direct),
          attempt: attempt?.state ?? null,
          stream: stats.snapshots > 0,
          rtt: clock ? Math.round(clock.rttMs) : null,
          jitter: clock ? Math.round(clock.jitterMs) : null,
          ...trafficFor(hostId),
        }],
      };
    },
    // The game as the panel's map draws it: our link to the host, and the
    // host's to each other player, once the host shares them (`net:links`)
    meshView: () => {
      const roster = replica.getState().players;
      const links = net.view()['net:links']?.l ?? {};
      const clock = net.stats().clock;
      const nodes = [
        { tag: myId, name: roster[myId]?.name ?? name, me: true, leads: false },
        { tag: hostId, name: hostName() ?? hostId.slice(0, 6), me: false, leads: true },
      ];
      const edges = [{ a: myId, b: hostId, ms: clock ? Math.round(clock.rttMs) : null, direct: Boolean(attempt?.direct), mine: true }];
      for (const [id, link] of Object.entries(links)) {
        if (id === myId || id === hostId || !Array.isArray(link)) continue;
        const [ms, isDirect] = link;
        nodes.push({ tag: id, name: roster[id]?.name ?? id.slice(0, 6), me: false, leads: false });
        edges.push({ a: hostId, b: id, ms: Number.isFinite(ms) && ms >= 0 ? ms : null, direct: isDirect === 1, mine: false });
      }
      return { nodes, edges };
    },
    debug: async () => ({ host: hostId, route, stats: net.stats(), view: Object.keys(net.view()), me: net.view()[myId] }),
    leave: async () => {
      clearInterval(routeTimer);
      clearInterval(linksTimer);
      stopStatus();
      net.close();
      await replica.close().catch(() => {});
      playing = false;
    },
  };
}
