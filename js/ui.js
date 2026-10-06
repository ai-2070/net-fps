import { ServerBrowser, REGIONS } from './servers.js';

const FORMAT = {
  sensitivity: (v) => `${v.toFixed(1)}×`,
  fov: (v) => `${v}°`,
  volume: (v) => `${v}%`,
};

// Screen stack for the menus: push() opens a sub-screen, back() returns to the previous one.
export class UI {
  constructor({ settings, onSolo, onResume, onQuit, onSettingsChange, onHost, onJoin, browse }) {
    this.root = document.getElementById('menus');
    this.screens = new Map([...this.root.querySelectorAll('.screen')].map((el) => [el.dataset.screen, el]));
    this.stack = [];
    this.browser = new ServerBrowser(this.screens.get('servers'), { browse, onJoin });

    const actions = {
      play: () => this.push('mode'),
      settings: () => this.push('settings'),
      controls: () => this.push('controls'),
      coop: () => {
        this.push('servers');
        this.browser.refresh();
      },
      host: () => this.push('host'),
      back: () => this.back(),
      solo: onSolo,
      resume: onResume,
      quit: onQuit,
    };

    this.root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (el && !el.disabled) actions[el.dataset.action]?.();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.stack.length > 1) this.back();
    });

    const hostRegion = this.root.querySelector('[data-region-options]');
    for (const region of REGIONS) hostRegion.add(new Option(region, region));

    this.root.querySelector('[data-host-form]').addEventListener('submit', (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      onHost({
        name: form.get('name').trim() || 'My co-op game',
        maxPlayers: Number(form.get('maxPlayers')) || 4,
        map: form.get('map'),
        region: form.get('region'),
        password: form.get('password'),
        friendlyFire: form.get('friendlyFire') === 'on',
      });
    });

    const nameInput = this.screens.get('settings').querySelector('input[name="playerName"]');
    nameInput.value = settings.playerName;
    nameInput.addEventListener('input', () => {
      settings.playerName = nameInput.value;
      onSettingsChange(settings);
    });

    for (const input of this.screens.get('settings').querySelectorAll('input[type="range"]')) {
      const output = input.parentElement.querySelector('output');
      const key = input.name;
      input.value = settings[key];
      output.textContent = FORMAT[key](settings[key]);
      input.addEventListener('input', () => {
        settings[key] = Number(input.value);
        output.textContent = FORMAT[key](settings[key]);
        onSettingsChange(settings);
      });
    }
  }

  get current() {
    return this.stack[this.stack.length - 1] ?? null;
  }

  show(name) {
    this.stack = [name];
    this.render();
  }

  push(name) {
    this.stack.push(name);
    this.render();
  }

  back() {
    if (this.stack.length < 2) return;
    this.stack.pop();
    this.render();
  }

  hide() {
    this.stack = [];
    this.render();
  }

  render() {
    const current = this.current;
    for (const [name, el] of this.screens) el.classList.toggle('active', name === current);
    this.root.classList.toggle('visible', current !== null);
    if (current) this.screens.get(current).querySelector('.menu-list button, .mode-card, .btn')?.focus({ preventScroll: true });
  }
}
