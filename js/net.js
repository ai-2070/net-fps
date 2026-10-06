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

import { connect, createLobby, defineStore, joinLobby, listLobbies, requestCredential } from '@net-mesh/browser';
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

  onStatus('Opening the lobby…');
  const lobby = await createLobby({
    node,
    game: GAME,
    name: cleanName(settings.name, 'Co-op game'),
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
    return out;
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
  });

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
  const routeTimer = setInterval(async () => {
    const attempt = await node.peerAttempt(hostId).catch(() => null);
    route = attempt?.direct ? 'Direct' : 'Relayed';
  }, 1000);

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
    input: (i) => net.input(i),
    onEnd: (fn) => { endListener = fn; },
    debug: async () => ({ host: hostId, route, stats: net.stats(), view: Object.keys(net.view()), me: net.view()[myId] }),
    leave: async () => {
      clearInterval(routeTimer);
      stopStatus();
      net.close();
      await replica.close().catch(() => {});
      playing = false;
    },
  };
}
