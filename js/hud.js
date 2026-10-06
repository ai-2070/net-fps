const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.root = $('hud');
    this.mode = $('hud-mode');
    this.ammo = $('hud-ammo');
    this.mag = $('hud-mag');
    this.reload = $('hud-reload');
    this.kills = $('hud-kills');
    this.crosshair = $('crosshair');
    this.hit = $('hitmarker');
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  setMode(text) { this.mode.textContent = text; }
  setKills(n) { this.kills.textContent = n; }
  setReloading(on) { this.reload.classList.toggle('hidden', !on); }
  setAiming(on) { this.crosshair.classList.toggle('hidden', on); }

  setAmmo(ammo, mag) {
    this.ammo.textContent = ammo;
    this.mag.textContent = mag;
    this.ammo.classList.toggle('low', ammo <= mag * 0.2);
  }

  hitmarker(kill) {
    this.hit.classList.remove('show', 'kill');
    void this.hit.offsetWidth; // restart the CSS animation
    this.hit.classList.add('show');
    if (kill) this.hit.classList.add('kill');
  }
}
