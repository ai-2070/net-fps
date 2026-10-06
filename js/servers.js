import { toast } from './toast.js';

// Co-op games come from NET (https://ai2070.net/docs): each hosted game is a
// NET lobby, listed with listLobbies (see net.js browseGames).
//
// The fields follow what NET provides:
// - region: a logical label the host declares in the lobby's listing. It's a category
//   players filter by, not a measurement, so the browser never treats it as a speed hint.
// - route: NET doesn't expose a ping/RTT figure for a listing. What it reports is the path
//   to a peer once connected: direct (peer-to-peer) or relayed through the anchor. Until
//   you join, the route is unknown.
export const REGIONS = ['EU West', 'EU East', 'NA East', 'NA West', 'South America', 'Asia', 'Oceania'];
const ROUTES = {
  direct: { label: 'Direct', hint: 'Peer-to-peer connection to the host' },
  relayed: { label: 'Relayed', hint: 'Traffic goes through a relay node' },
  unknown: { label: '—', hint: 'Known once you join: direct (peer-to-peer) or relayed' },
};
const LOCK_ICON = '<svg class="lock" viewBox="0 0 16 16" aria-label="Password protected"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2z"/></svg>';

export class ServerBrowser {
  // browse(onStatus) → Promise<server[]>; onJoin(server, password)
  constructor(root, { browse, onJoin }) {
    this.root = root;
    this.browse = browse;
    this.onJoin = onJoin;
    this.panel = root.querySelector('.panel');
    this.tbody = root.querySelector('tbody');
    this.headers = [...root.querySelectorAll('th[data-sort]')];
    const el = (name) => root.querySelector(`[data-browser="${name}"]`);
    this.search = el('search');
    this.region = el('region');
    this.hideFull = el('hide-full');
    this.hideEmpty = el('hide-empty');
    this.refreshBtn = el('refresh');
    this.joinBtn = el('join');
    this.password = el('password');
    this.status = el('status');

    this.servers = [];
    this.selectedId = null;
    this.sort = { key: 'players', dir: -1 };
    this.loading = false;

    for (const th of this.headers) {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        this.sort = this.sort.key === key
          ? { key, dir: -this.sort.dir }
          : { key, dir: key === 'players' ? -1 : 1 };
        this.render();
      });
    }
    for (const region of REGIONS) this.region.add(new Option(region, region));
    this.search.addEventListener('input', () => this.render());
    this.region.addEventListener('change', () => this.render());
    this.hideFull.addEventListener('change', () => this.render());
    this.hideEmpty.addEventListener('change', () => this.render());
    this.refreshBtn.addEventListener('click', () => this.refresh());
    this.joinBtn.addEventListener('click', () => this.join());
    this.password.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.join();
    });

    this.tbody.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-id]');
      if (row) this.select(row.dataset.id);
    });
    this.tbody.addEventListener('dblclick', (e) => {
      const row = e.target.closest('tr[data-id]');
      if (row) this.join();
    });
    this.tbody.addEventListener('keydown', (e) => {
      const row = e.target.closest('tr[data-id]');
      if (!row) return;
      if (e.key === 'Enter') this.join();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
        if (next?.dataset.id) {
          this.select(next.dataset.id);
          next.focus();
        }
      }
    });
  }

  async refresh() {
    if (this.loading) return;
    this.loading = true;
    this.panel.classList.add('loading');
    this.refreshBtn.disabled = true;
    this.joinBtn.disabled = true;
    const setStatus = (text) => {
      this.status.textContent = text;
      this.showMessage(text);
    };
    setStatus('Searching for games…');

    let error = null;
    try {
      this.servers = await this.browse(setStatus);
    } catch (e) {
      console.warn('browse failed:', e);
      error = e;
      this.servers = [];
    }
    if (!this.servers.some((s) => s.id === this.selectedId)) this.selectedId = null;
    this.loading = false;
    this.panel.classList.remove('loading');
    this.refreshBtn.disabled = false;
    this.render();
    if (error) {
      this.showMessage(error.message ?? String(error));
      this.status.textContent = 'Not connected to NET';
    }
  }

  visibleServers() {
    const query = this.search.value.trim().toLowerCase();
    const { key, dir } = this.sort;
    return this.servers
      .filter((s) => !query || s.name.toLowerCase().includes(query))
      .filter((s) => !this.region.value || s.region === this.region.value)
      .filter((s) => !(this.hideFull.checked && s.players >= s.max))
      .filter((s) => !(this.hideEmpty.checked && s.players === 0))
      .sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
        return cmp * dir || a.name.localeCompare(b.name);
      });
  }

  render() {
    if (this.loading) return;
    for (const th of this.headers) {
      if (th.dataset.sort === this.sort.key) th.setAttribute('aria-sort', this.sort.dir > 0 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    }

    const list = this.visibleServers();
    if (!list.some((s) => s.id === this.selectedId)) this.selectedId = null;

    if (list.length === 0) {
      this.showMessage(this.servers.length ? 'No games match your filters.' : 'No games found. Try refreshing, or host your own.');
    } else {
      this.tbody.replaceChildren(...list.map((s) => this.row(s)));
    }

    const players = this.servers.reduce((sum, s) => sum + s.players, 0);
    this.status.textContent = `${list.length} of ${this.servers.length} games · ${players} players online`;
    this.updateJoin();
  }

  row(s) {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;
    tr.tabIndex = 0;
    const full = s.players >= s.max;
    tr.classList.toggle('full', full);
    tr.classList.toggle('selected', s.id === this.selectedId);

    const name = document.createElement('td');
    const nameWrap = document.createElement('span');
    nameWrap.className = 'server-name';
    nameWrap.textContent = s.name;
    if (s.locked) nameWrap.insertAdjacentHTML('afterbegin', LOCK_ICON);
    name.append(nameWrap);

    const region = document.createElement('td');
    const regionTag = document.createElement('span');
    regionTag.className = 'region-tag';
    regionTag.textContent = s.region;
    region.append(regionTag);

    const map = document.createElement('td');
    map.textContent = s.map;

    const players = document.createElement('td');
    players.className = 'num';
    players.textContent = `${s.players} / ${s.max}`;
    const pips = document.createElement('span');
    pips.className = 'pips';
    for (let i = 0; i < s.max; i++) {
      const pip = document.createElement('i');
      if (i < s.players) pip.className = 'on';
      pips.append(pip);
    }
    players.append(pips);

    const route = document.createElement('td');
    const badge = document.createElement('span');
    const info = ROUTES[s.route] ?? ROUTES.unknown;
    badge.className = `route ${s.route}`;
    badge.textContent = info.label;
    badge.title = info.hint;
    route.append(badge);

    tr.append(name, region, map, players, route);
    return tr;
  }

  showMessage(text) {
    const tr = document.createElement('tr');
    tr.className = 'message';
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = text;
    tr.append(td);
    this.tbody.replaceChildren(tr);
  }

  select(id) {
    this.selectedId = id;
    for (const tr of this.tbody.querySelectorAll('tr[data-id]')) {
      tr.classList.toggle('selected', tr.dataset.id === id);
    }
    this.updateJoin();
  }

  // The password box shows only for a locked game
  updateJoin() {
    const server = this.servers.find((s) => s.id === this.selectedId);
    this.joinBtn.disabled = !server;
    const locked = Boolean(server?.locked);
    if (locked !== !this.password.classList.contains('hidden')) {
      this.password.classList.toggle('hidden', !locked);
      this.password.value = '';
    }
  }

  join() {
    const server = this.servers.find((s) => s.id === this.selectedId);
    if (!server) return;
    if (server.players >= server.max) {
      toast(`"${server.name}" is full.`);
      return;
    }
    if (server.locked && !this.password.value) {
      toast(`"${server.name}" needs a password.`);
      this.password.focus();
      return;
    }
    this.onJoin(server, this.password.value);
  }
}
