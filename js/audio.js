// Tiny synthesized sound effects, so the game ships without audio assets.
export class Sound {
  constructor() {
    this.ctx = null;
    this.volume = 0.6;
  }

  // Browsers only allow audio after a user gesture, so call this from a click handler.
  unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);

      const length = this.ctx.sampleRate * 0.5;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(volume) {
    this.volume = volume;
    if (this.master) this.master.gain.value = volume;
  }

  noiseBurst(t, duration, type, frequency, peak) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + duration);
  }

  tone(t, type, from, to, duration, peak) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + duration);
  }

  // `level` scales the loudness, e.g. quieter for other players' shots
  shot(level = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.18, 'lowpass', 3200, 0.7 * level);
    this.tone(t, 'triangle', 180, 45, 0.12, 0.6 * level);
  }

  hit(head) {
    if (!this.ctx) return;
    const f = head ? 1500 : 1000;
    this.tone(this.ctx.currentTime, 'square', f, f, 0.05, 0.07);
  }

  kill() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 'square', 880, 880, 0.07, 0.07);
    this.tone(t + 0.07, 'square', 1320, 1320, 0.1, 0.07);
  }

  dry() {
    if (!this.ctx) return;
    this.noiseBurst(this.ctx.currentTime, 0.03, 'highpass', 4000, 0.3);
  }

  reload() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t + 0.15, 0.05, 'bandpass', 1800, 0.35);
    this.noiseBurst(t + 0.75, 0.06, 'bandpass', 1200, 0.45);
    this.noiseBurst(t + 1.25, 0.05, 'bandpass', 2600, 0.4);
  }
}
