import { Game } from './game.js';
import { Hud } from './hud.js';
import { Sound } from './audio.js';
import { UI } from './ui.js';
import { toast } from './toast.js';

const SETTINGS_KEY = 'net-shooter-settings';
const DEFAULT_SETTINGS = { sensitivity: 1, fov: 80, volume: 60, playerName: `Player ${Math.floor(Math.random() * 900) + 100}` };

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode etc.); settings just won't persist.
  }
}

const canvas = document.getElementById('game');
const hud = new Hud();
const sound = new Sound();
const game = new Game(canvas, hud, sound);
const settings = loadSettings();
game.applySettings(settings);

// 'menu' -> 'starting' (waiting for pointer lock) -> 'playing' <-> 'paused'
let state = 'menu';
let session = null; // co-op over NET (net.js), or null in solo
let connecting = false;

// NET loads only when co-op is opened, so solo never depends on it
let netModule = null;
const loadNet = () => (netModule ??= import('./net.js').catch((error) => {
  netModule = null;
  throw new Error(`Couldn't load NET: ${error.message ?? error}`);
}));

const playerName = () => settings.playerName.trim() || 'Player';

const ui = new UI({
  settings,
  onSolo: startSolo,
  onResume: resume,
  onQuit: quitToMenu,
  onSettingsChange(next) {
    game.applySettings(next);
    saveSettings(next);
  },
  browse: async (onStatus) => (await loadNet()).browseGames(onStatus),
  onHost: (hostSettings) =>
    startCoop((net) => net.hostGame({ game, settings: hostSettings, name: playerName(), onStatus: toast })),
  onJoin: (server, password) =>
    startCoop((net) => net.joinGame({ listing: server.listing, name: playerName(), password, onStatus: toast })),
});
ui.show('main');

function lockPointer() {
  try {
    const request = canvas.requestPointerLock();
    request?.catch?.(() => lockFailed());
  } catch {
    lockFailed();
  }
}

function lockFailed() {
  if (state !== 'starting') return;
  pause();
  toast('Click Resume to capture the mouse.');
}

function startSolo() {
  sound.unlock();
  game.startSolo();
  document.getElementById('pause-mode').textContent = 'Solo';
  hud.show();
  ui.hide();
  state = 'starting';
  lockPointer();
}

async function startCoop(open) {
  if (connecting) return;
  connecting = true;
  sound.unlock();
  try {
    session = await open(await loadNet());
  } catch (error) {
    console.error(error);
    toast(error.message ?? String(error));
    return;
  } finally {
    connecting = false;
  }
  session.onEnd((reason) => {
    toast(reason);
    quitToMenu();
  });
  game.startCoop(session);
  document.getElementById('pause-mode').textContent = 'Co-op';
  toast(session.isHost ? 'Hosting. Others can find your game in the server browser.' : 'Joined the game.');
  hud.show();
  ui.hide();
  state = 'starting';
  lockPointer();
}

function pause() {
  state = 'paused';
  game.setActive(false);
  if (session) document.getElementById('pause-mode').textContent = `Co-op · ${session.label}`;
  ui.show('pause');
}

function resume() {
  sound.unlock();
  state = 'starting';
  ui.hide();
  lockPointer();
}

function quitToMenu() {
  state = 'menu';
  if (document.pointerLockElement) document.exitPointerLock();
  game.toMenu();
  if (session) {
    session.leave().catch((e) => console.warn('leave:', e));
    session = null;
  }
  hud.hide();
  ui.show('main');
}

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    state = 'playing';
    ui.hide();
    game.setActive(true);
  } else if (state === 'playing') {
    // Esc (or alt-tab) released the mouse
    pause();
  }
});
document.addEventListener('pointerlockerror', lockFailed);

// Leaving the page: tell the others
window.addEventListener('pagehide', () => session?.leave());

// Connection details for the devtools console
window.netDebug = () => session?.debug();

// Fallback if the lock request was ignored without an error
canvas.addEventListener('click', () => {
  if (state === 'starting') lockPointer();
});
