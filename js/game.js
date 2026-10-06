import * as THREE from 'three';
import { ARENA, CONCRETE, CRATES, PLAYER, STEP_DT, WALLS, stepPlayer } from './sim.js';

const WEAPON = { mag: 30, fireInterval: 0.1, reloadTime: 1.5, damage: 25, headshot: 2 };
const TARGET = { hp: 100, respawn: 3 };
const MAX_PITCH = Math.PI / 2 - 0.01;
const MAX_DECALS = 80;
const WEAPON_LAYER = 1; // drawn in a second pass so the gun never clips into walls
const PLAYER_SPAWN = new THREE.Vector3(0, 0, 2);
const HIP = new THREE.Vector3(0.2, -0.19, -0.44);
const ADS = new THREE.Vector3(0, -0.066, -0.5);
const WEAPON_SCALE = 0.75;

// [x, z, patrol distance along x]
const TARGET_SPOTS = [
  [0, -18, 3], [-9, -19, 1.5], [10, -19, 2], [6, -14, 1], [20, -8, 1.5], [-21, 6, 1.2], [14, 18, 1], [-5, 19, 2],
];

const _v = new THREE.Vector3();
const _end = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

const easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;

function canvasTexture(size, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

export class Game {
  constructor(canvas, hud, sound) {
    this.hud = hud;
    this.sound = sound;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xa9bccd);
    this.scene.fog = new THREE.Fog(0xa9bccd, 35, 95);

    this.camera = new THREE.PerspectiveCamera(80, 1, 0.03, 300);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();

    this.world = []; // static meshes bullets can hit
    this.targets = [];
    this.targetMeshes = [];
    this.effects = [];
    this.decals = [];
    this.particleGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    this.decalGeo = new THREE.CircleGeometry(0.05, 10);
    this.decalMat = new THREE.MeshBasicMaterial({
      color: 0x151515, transparent: true, opacity: 0.85, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4,
    });

    this.mode = 'attract'; // 'attract' = menu backdrop, 'play' = in a match
    this.active = false; // input + simulation running (false while paused)
    this.time = 0;
    this.sensitivity = 0.0022;
    this.baseFov = 80;

    this.keys = new Set();
    this.mouseDown = false;
    this.aiming = false;
    this.sprinting = false;
    this.showingAim = false;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.wish = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;

    this.ammo = WEAPON.mag;
    this.fireCooldown = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.kick = 0;
    this.aimT = 0;
    this.sprintT = 0;
    this.bobT = 0;
    this.bobAmount = 0;
    this.flashT = 0;
    this.kills = 0;

    // Co-op (see startCoop): the NET session, other players, queued shots
    this.net = null;
    this.remote = new Map();
    this.stepAcc = 0;
    this.pendingShots = [];
    this.myKills = 0;

    this.buildLights();
    this.buildMap();
    this.buildTargets();
    this.buildWeapon();
    this.bindInput();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- Public API ----------

  startSolo() {
    this.mode = 'play';
    this.pos.copy(PLAYER_SPAWN);
    this.vel.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;
    this.ammo = WEAPON.mag;
    this.reloading = false;
    this.fireCooldown = 0;
    this.kick = this.aimT = this.sprintT = this.bobAmount = 0;
    this.kills = 0;

    for (const t of this.targets) {
      t.group.position.copy(t.home);
      this.revive(t);
    }
    this.clearEffects();
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.syncCamera();

    this.hud.setMode('Solo');
    this.hud.setAmmo(this.ammo, WEAPON.mag);
    this.hud.setReloading(false);
    this.hud.setKills(0);
    this.hud.setAiming(false);
    this.showingAim = false;
  }

  // Co-op over NET. `session` comes from net.js (hostGame / joinGame): it
  // takes this player's inputs and hands back every player's state.
  startCoop(session) {
    this.startSolo();
    this.net = session;
    this.stepAcc = 0;
    this.pendingShots.length = 0;
    this.myKills = session.roster()[session.myId]?.kills ?? 0;
    const spawn = session.entities()[session.myId];
    if (spawn) this.applyState(spawn);
    this.syncCamera();
    this.hud.setMode('Co-op');
    this.hud.setKills(session.teamKills());
  }

  toMenu() {
    this.setActive(false);
    if (this.net) {
      this.net = null;
      for (const avatar of this.remote.values()) this.removeAvatar(avatar);
      this.remote.clear();
      for (const t of this.targets) {
        t.group.position.copy(t.home);
        this.revive(t);
      }
    }
    this.mode = 'attract';
    this.flash.visible = false;
    this.flashLight.intensity = 0;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  setActive(active) {
    this.active = active;
    if (!active) this.releaseInput();
  }

  applySettings({ sensitivity, fov, volume }) {
    this.sensitivity = 0.0022 * sensitivity;
    this.baseFov = fov;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.sound.setVolume(volume / 100);
  }

  // ---------- Scene ----------

  buildLights() {
    const hemi = new THREE.HemisphereLight(0xe3edf7, 0x4d4639, 1.4);
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    sun.position.set(20, 35, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 90 });
    sun.shadow.bias = -0.0005;
    hemi.layers.enable(WEAPON_LAYER);
    sun.layers.enable(WEAPON_LAYER);
    this.scene.add(hemi, sun);
  }

  buildMap() {
    const floorTex = canvasTexture(256, (g, s) => {
      g.fillStyle = '#6f757c';
      g.fillRect(0, 0, s, s);
      g.fillStyle = '#676d74';
      g.fillRect(0, 0, s / 2, s / 2);
      g.fillRect(s / 2, s / 2, s / 2, s / 2);
      g.strokeStyle = 'rgba(0,0,0,0.22)';
      g.lineWidth = 3;
      g.strokeRect(0, 0, s, s);
    });
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(ARENA, ARENA);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA * 2, ARENA * 2),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.world.push(floor);

    const crateTex = canvasTexture(128, (g, s) => {
      g.fillStyle = '#a57c45';
      g.fillRect(0, 0, s, s);
      g.strokeStyle = '#6e4f28';
      g.lineWidth = 12;
      g.strokeRect(6, 6, s - 12, s - 12);
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(10, 10);
      g.lineTo(s - 10, s - 10);
      g.stroke();
    });
    const crateMat = new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.85 });
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x8e959d, roughness: 0.9 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x5d6570, roughness: 0.95 });

    for (const [x, z, w, h, d] of WALLS) this.addBox(x, z, w, h, d, wallMat);

    for (const [x, z, w, h, d] of CRATES) this.addBox(x, z, w, h, d, crateMat);
    for (const [x, z, w, h, d] of CONCRETE) this.addBox(x, z, w, h, d, concreteMat);
  }

  addBox(x, z, w, h, d, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.updateMatrixWorld();
    this.scene.add(mesh);
    this.world.push(mesh);
  }

  buildTargets() {
    const bodyGeo = new THREE.CapsuleGeometry(0.34, 0.75, 4, 14);
    const headGeo = new THREE.SphereGeometry(0.22, 16, 12);
    const visorGeo = new THREE.BoxGeometry(0.3, 0.08, 0.06);
    const baseGeo = new THREE.CylinderGeometry(0.45, 0.5, 0.08, 20);
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.35, metalness: 0.5 });

    for (const [x, z, amp] of TARGET_SPOTS) {
      const material = new THREE.MeshStandardMaterial({
        color: 0xd9483b, roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0,
      });
      const group = new THREE.Group();
      const base = new THREE.Mesh(baseGeo, darkMat);
      base.position.y = 0.04;
      const body = new THREE.Mesh(bodyGeo, material);
      body.position.y = 0.84;
      const head = new THREE.Mesh(headGeo, material);
      head.position.y = 1.76;
      const visor = new THREE.Mesh(visorGeo, darkMat);
      visor.position.set(0, 1.78, 0.19);
      for (const m of [base, body, head, visor]) m.castShadow = true;
      group.add(base, body, head, visor);

      const target = {
        group, material,
        home: new THREE.Vector3(x, 0, z),
        amp,
        speed: 0.6 + Math.random() * 0.6,
        phase: Math.random() * Math.PI * 2,
        hp: TARGET.hp, alive: true, respawnT: 0, pop: 1, flash: 0,
      };
      body.userData.target = target;
      head.userData.target = target;
      head.userData.head = true;

      group.position.copy(target.home);
      this.scene.add(group);
      this.targets.push(target);
      this.targetMeshes.push(body, head);
    }
  }

  buildWeapon() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.45, metalness: 0.6 });
    const olive = new THREE.MeshStandardMaterial({ color: 0x4c5530, roughness: 0.8 });
    const part = (geo, mat, x, y, z, rx = 0) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.x = rx;
      return mesh;
    };

    const weapon = new THREE.Group();
    const barrel = part(new THREE.CylinderGeometry(0.017, 0.017, 0.32, 10), dark, 0, 0.02, -0.36, Math.PI / 2);
    weapon.add(
      part(new THREE.BoxGeometry(0.08, 0.11, 0.42), dark, 0, 0, 0),
      part(new THREE.BoxGeometry(0.085, 0.085, 0.22), olive, 0, 0.008, -0.26),
      barrel,
      part(new THREE.BoxGeometry(0.055, 0.17, 0.08), dark, 0, -0.12, -0.05, 0.2),
      part(new THREE.BoxGeometry(0.05, 0.12, 0.06), olive, 0, -0.1, 0.12, -0.3),
      part(new THREE.BoxGeometry(0.06, 0.1, 0.2), olive, 0, -0.01, 0.3),
      part(new THREE.BoxGeometry(0.016, 0.04, 0.016), dark, 0, 0.075, -0.34),
      part(new THREE.BoxGeometry(0.04, 0.03, 0.03), dark, 0, 0.07, 0.12),
    );

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.02, -0.54);
    weapon.add(this.muzzle);

    const flashTex = canvasTexture(64, (g, s) => {
      const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      grad.addColorStop(0, 'rgba(255,250,220,1)');
      grad.addColorStop(0.25, 'rgba(255,200,90,0.9)');
      grad.addColorStop(0.6, 'rgba(255,120,30,0.35)');
      grad.addColorStop(1, 'rgba(255,80,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    });
    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshBasicMaterial({
        map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }),
    );
    this.flash.position.copy(this.muzzle.position);
    this.flash.visible = false;
    weapon.add(this.flash);

    weapon.position.copy(HIP);
    weapon.scale.setScalar(WEAPON_SCALE);
    weapon.traverse((o) => o.layers.set(WEAPON_LAYER));

    this.flashLight = new THREE.PointLight(0xffb060, 0, 8, 2);
    this.flashLight.position.copy(this.muzzle.position);
    this.flashLight.layers.enableAll();
    weapon.add(this.flashLight);

    this.weapon = weapon;
    this.camera.add(weapon);
  }

  // ---------- Input ----------

  bindInput() {
    document.addEventListener('keydown', (e) => {
      if (!this.active) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.reload();
      if (e.code === 'Space') e.preventDefault();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    document.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) this.aiming = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.aiming = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      // Some browsers occasionally report huge spikes under pointer lock
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      const sens = this.sensitivity * (this.aiming ? 0.7 : 1);
      this.yaw -= e.movementX * sens;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * sens, -MAX_PITCH, MAX_PITCH);
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this.releaseInput());
  }

  releaseInput() {
    this.keys.clear();
    this.mouseDown = false;
    this.aiming = false;
  }

  // ---------- Loop ----------

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.mode === 'attract') {
      this.time += dt;
      const a = this.time * 0.05;
      this.camera.position.set(Math.sin(a) * 21, 7.5, Math.cos(a) * 21);
      this.camera.lookAt(0, 1, 0);
      this.updateTargets(dt);
      this.updateEffects(dt);
    } else if (this.net) {
      // Co-op keeps running while paused: the others are still playing
      this.time += dt;
      this.updateCoop(dt);
      this.updateEffects(dt);
    } else if (this.active) {
      this.time += dt;
      this.updatePlayer(dt);
      this.updateWeapon(dt);
      this.updateTargets(dt);
      this.updateEffects(dt);
    }

    this.render();
  }

  render() {
    const r = this.renderer;
    this.camera.layers.set(0);
    r.render(this.scene, this.camera);

    if (this.mode === 'play') {
      r.autoClear = false;
      r.shadowMap.autoUpdate = false;
      r.clearDepth();
      // A Color background forces a clear on every render, so drop it for the overlay pass
      const background = this.scene.background;
      this.scene.background = null;
      this.camera.layers.set(WEAPON_LAYER);
      r.render(this.scene, this.camera);
      this.scene.background = background;
      r.shadowMap.autoUpdate = true;
      r.autoClear = true;
    }
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- Player ----------

  // This frame's movement input, from the keys and the current view
  sampleInput(dt) {
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    this.sprinting = (k.has('ShiftLeft') || k.has('ShiftRight')) && fwd > 0 && !this.aiming && !this.mouseDown;
    return {
      f: fwd, s: side, yaw: this.yaw, pitch: this.pitch,
      sprint: this.sprinting, aim: this.aiming, jump: k.has('Space'), dt,
    };
  }

  updatePlayer(dt) {
    // The movement rules live in sim.js so co-op hosts and clients share them
    this.applyState(stepPlayer(this.playerState(), this.sampleInput(dt)));
    this.updateFov(dt);
    this.syncCamera();
  }

  playerState() {
    const p = this.pos;
    const v = this.vel;
    return { x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, g: this.onGround ? 1 : 0, yaw: this.yaw, pitch: this.pitch };
  }

  applyState(s) {
    this.pos.set(s.x, s.y, s.z);
    this.vel.set(s.vx, s.vy, s.vz);
    this.onGround = Boolean(s.g);
  }

  updateFov(dt) {
    const aimFov = this.aiming ? this.baseFov * 0.72 : this.baseFov;
    if (Math.abs(this.camera.fov - aimFov) > 0.01) {
      this.camera.fov += (aimFov - this.camera.fov) * (1 - Math.exp(-dt * 14));
      this.camera.updateProjectionMatrix();
    }
  }

  syncCamera() {
    this.camera.position.set(this.pos.x, this.pos.y + PLAYER.eye, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  // ---------- Weapon ----------

  updateWeapon(dt) {
    this.fireCooldown -= dt;

    if (this.reloading) {
      this.reloadT += dt;
      if (this.reloadT >= WEAPON.reloadTime) {
        this.reloading = false;
        this.ammo = WEAPON.mag;
        this.hud.setAmmo(this.ammo, WEAPON.mag);
        this.hud.setReloading(false);
      }
    }

    if (this.mouseDown && this.fireCooldown <= 0 && !this.reloading) {
      if (this.ammo > 0) {
        this.shoot();
      } else {
        this.sound.dry();
        this.fireCooldown = 0.3;
        this.reload();
      }
    }

    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      }
    }

    // Weapon pose: hip/ADS blend, walk bob, recoil kick, sprint and reload poses
    const ease = (rate) => 1 - Math.exp(-dt * rate);
    this.aimT += ((this.aiming && !this.reloading ? 1 : 0) - this.aimT) * ease(16);
    this.sprintT += ((this.sprinting ? 1 : 0) - this.sprintT) * ease(10);
    this.kick *= Math.exp(-dt * 16);

    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.bobAmount += ((this.onGround ? Math.min(speed / PLAYER.walk, 1.5) : 0) - this.bobAmount) * ease(10);
    this.bobT += dt * (4 + speed * 1.3);
    const bob = this.bobAmount * (1 - this.aimT * 0.85);
    const dip = this.reloading ? Math.sin(Math.min(this.reloadT / WEAPON.reloadTime, 1) * Math.PI) : 0;

    const w = this.weapon;
    w.position.lerpVectors(HIP, ADS, this.aimT);
    w.position.x += Math.sin(this.bobT) * 0.014 * bob;
    w.position.y += -Math.abs(Math.cos(this.bobT)) * 0.012 * bob - dip * 0.12 - this.sprintT * 0.05;
    w.position.z += this.kick * (0.05 - this.aimT * 0.02);
    w.rotation.set(this.kick * 0.08 - dip * 0.5 - this.sprintT * 0.3, this.sprintT * 0.55, dip * 0.45);

    const showingAim = this.aimT > 0.6;
    if (showingAim !== this.showingAim) {
      this.showingAim = showingAim;
      this.hud.setAiming(showingAim);
    }
  }

  shoot() {
    this.ammo--;
    this.fireCooldown = WEAPON.fireInterval;
    this.kick = 1;
    this.hud.setAmmo(this.ammo, WEAPON.mag);
    this.sound.shot();

    this.flashT = 0.05;
    this.flash.visible = true;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.flashLight.intensity = 12;

    const moving = Math.hypot(this.vel.x, this.vel.z) > 1;
    const spread = (this.aiming ? 0.002 : 0.012) + (moving ? 0.015 : 0) + (this.onGround ? 0 : 0.03);
    this.ndc.set((Math.random() * 2 - 1) * spread, (Math.random() * 2 - 1) * spread);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const candidates = this.world.concat(this.targetMeshes.filter((m) => m.userData.target.alive));
    const hit = this.raycaster.intersectObjects(candidates, false)[0];
    const end = hit ? hit.point : this.raycaster.ray.at(150, _end);
    this.muzzle.getWorldPosition(_muzzle);
    this.tracer(_muzzle, end);

    // Recoil nudges the view after the shot is resolved
    this.pitch = Math.min(this.pitch + (this.aiming ? 0.005 : 0.009), MAX_PITCH);
    this.yaw += (Math.random() - 0.5) * 0.006;

    // Co-op: the host decides what this shot hits (with lag compensation);
    // what happens here is only this player's instant feedback
    if (this.net) {
      const { origin, direction } = this.raycaster.ray;
      this.pendingShots.push({ o: origin.toArray(), d: direction.toArray() });
    }

    if (this.ammo === 0) this.reload();
    if (!hit) return;

    const target = hit.object.userData.target;
    if (target && this.net) {
      this.hud.hitmarker(false);
      this.sound.hit(Boolean(hit.object.userData.head));
      this.burst(hit.point, 0xffffff, 4, 2);
    } else if (target) {
      this.damage(target, Boolean(hit.object.userData.head), hit.point);
    } else {
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      this.addDecal(hit.point, normal);
      this.burst(hit.point, 0xffcf7a, 6, 3, normal);
    }
  }

  reload() {
    if (this.reloading || this.ammo === WEAPON.mag) return;
    this.reloading = true;
    this.reloadT = 0;
    this.hud.setReloading(true);
    this.sound.reload();
  }

  // ---------- Targets ----------

  updateTargets(dt) {
    const cam = this.camera.position;
    for (const t of this.targets) {
      if (!t.alive) {
        t.respawnT -= dt;
        if (t.respawnT <= 0) this.revive(t);
        continue;
      }
      const g = t.group;
      g.position.x = t.home.x + Math.sin(this.time * t.speed + t.phase) * t.amp;
      g.rotation.y = Math.atan2(cam.x - g.position.x, cam.z - g.position.z);
      this.animateTarget(t, dt);
    }
  }

  animateTarget(t, dt) {
    if (t.pop < 1) {
      t.pop = Math.min(1, t.pop + dt * 3);
      t.group.scale.setScalar(Math.max(0.001, easeOutBack(t.pop)));
    }
    if (t.flash > 0) {
      t.flash = Math.max(0, t.flash - dt * 8);
      t.material.emissiveIntensity = t.flash;
    }
  }

  // `feedback` is false on a co-op host resolving someone's shot: the shooter
  // gets their own hitmarker and sound, and kills are counted by the session.
  damage(target, head, point, feedback = true) {
    target.hp -= WEAPON.damage * (head ? WEAPON.headshot : 1);
    target.flash = 0.6;
    target.material.emissiveIntensity = target.flash;

    if (target.hp > 0) {
      if (feedback) {
        this.hud.hitmarker(false);
        this.sound.hit(head);
      }
      this.burst(point, 0xffffff, 4, 2);
      return 'hit';
    }

    target.alive = false;
    target.respawnT = TARGET.respawn;
    target.group.visible = false;
    if (feedback) {
      this.kills++;
      this.hud.setKills(this.kills);
      this.hud.hitmarker(true);
      this.sound.kill();
    }
    this.burst(_v.copy(target.group.position).setY(1.1), 0xd9483b, 22, 5);
    return 'kill';
  }

  revive(t) {
    t.alive = true;
    t.hp = TARGET.hp;
    t.pop = 0;
    t.flash = 0;
    t.material.emissiveIntensity = 0;
    t.group.visible = true;
    t.group.scale.setScalar(0.001);
  }

  // ---------- Co-op ----------

  updateCoop(dt) {
    const net = this.net;

    // Inputs go out at a fixed rate so the host and this page's prediction
    // step the same way. While paused the player stands still, but inputs keep
    // flowing so the host doesn't drop them.
    this.stepAcc = Math.min(this.stepAcc + dt, 0.25);
    while (this.stepAcc >= STEP_DT) {
      this.stepAcc -= STEP_DT;
      const input = this.active
        ? this.sampleInput(STEP_DT)
        : { f: 0, s: 0, yaw: this.yaw, pitch: this.pitch, sprint: false, aim: false, jump: false, dt: STEP_DT };
      if (this.pendingShots.length) input.shots = this.pendingShots.splice(0, 4);
      net.input(input);
    }

    const view = net.entities();
    const me = view[net.myId];
    if (me) this.applyState(me); // predicted here, confirmed by the host

    if (net.isHost) this.updateTargets(dt);
    else this.applyTargets(view, dt);
    this.updateRemotePlayers(view, net.roster(), dt);
    this.updateCoopKills(net);

    this.updateWeapon(dt);
    this.updateFov(dt);
    this.syncCamera();
  }

  // Host: the targets as every player should see them
  targetStates() {
    const out = {};
    this.targets.forEach((t, i) => {
      out[`t${i}`] = { x: t.group.position.x, z: t.group.position.z, a: t.alive ? 1 : 0, hp: t.hp };
    });
    return out;
  }

  // Client: targets follow the host's snapshots
  applyTargets(view, dt) {
    const cam = this.camera.position;
    this.targets.forEach((t, i) => {
      const e = view[`t${i}`];
      if (!e) return;
      const g = t.group;
      g.position.x = e.x;
      g.position.z = e.z;
      g.rotation.y = Math.atan2(cam.x - g.position.x, cam.z - g.position.z);
      if (e.a && !t.alive) {
        this.revive(t);
      } else if (!e.a && t.alive) {
        t.alive = false;
        g.visible = false;
        this.burst(_v.copy(g.position).setY(1.1), 0xd9483b, 22, 5);
      } else if (e.a && e.hp < t.hp) {
        t.flash = 0.6;
      }
      t.hp = e.hp;
      if (t.alive) this.animateTarget(t, dt);
    });
  }

  // Host: resolve one player's shot. `rewound` holds the entities as that
  // player saw them when they fired (netcode lag compensation); null for the
  // host's own shots, which see the present.
  resolveShot(shot, shooter, rewound) {
    const origin = new THREE.Vector3().fromArray(shot.o);
    const dir = new THREE.Vector3().fromArray(shot.d);
    if (dir.lengthSq() < 1e-6) return { end: origin, kill: false };
    dir.normalize();
    // A shot must start at the shooter's eye, not wherever the client claims
    if (shooter) {
      const eye = _v.set(shooter.x, shooter.y + PLAYER.eye, shooter.z);
      if (origin.distanceTo(eye) > 1.5) origin.copy(eye);
    }

    const moved = [];
    if (rewound) {
      this.targets.forEach((t, i) => {
        const r = rewound[`t${i}`];
        if (!r) return;
        moved.push([t, t.group.position.x, t.group.position.z]);
        t.group.position.x = r.x;
        t.group.position.z = r.z;
        t.group.updateMatrixWorld(true);
      });
    }

    this.raycaster.set(origin, dir);
    const candidates = this.world.concat(this.targetMeshes.filter((m) => m.userData.target.alive));
    const hit = this.raycaster.intersectObjects(candidates, false)[0];

    for (const [t, x, z] of moved) {
      t.group.position.x = x;
      t.group.position.z = z;
      t.group.updateMatrixWorld(true);
    }

    const end = hit ? hit.point.clone() : origin.clone().addScaledVector(dir, 150);
    let kill = false;
    const target = hit?.object.userData.target;
    if (target) kill = this.damage(target, Boolean(hit.object.userData.head), hit.point, false) === 'kill';
    return { end, kill };
  }

  updateCoopKills(net) {
    const mine = net.roster()[net.myId]?.kills ?? this.myKills;
    if (mine > this.myKills) {
      this.hud.hitmarker(true);
      this.sound.kill();
    }
    this.myKills = mine;
    this.hud.setKills(net.teamKills());
  }

  // Other players: a body, a head, a gun that follows their aim, and a name
  updateRemotePlayers(view, roster, dt) {
    const net = this.net;
    for (const [id, avatar] of this.remote) {
      if (!view[id]) {
        this.removeAvatar(avatar);
        this.remote.delete(id);
      }
    }
    for (const [id, e] of Object.entries(view)) {
      if (id === net.myId || id.startsWith('t') || id.includes(':')) continue; // targets, shots
      const info = roster[id];
      let avatar = this.remote.get(id);
      if (!avatar) {
        avatar = this.createAvatar(info?.color ?? 0x3d7bd9);
        avatar.group.position.set(e.x, e.y, e.z);
        avatar.sh = view[`shot:${id}`]?.sh ?? 0;
        this.remote.set(id, avatar);
      }
      this.setAvatarName(avatar, info?.name ?? '…');

      // The host sees others at its 30 Hz tick; glide between updates
      const k = 1 - Math.exp(-20 * dt);
      avatar.group.position.lerp(_v.set(e.x, e.y, e.z), k);
      avatar.group.rotation.y = e.yaw ?? 0;
      avatar.aim.rotation.x = e.pitch ?? 0;

      const shot = view[`shot:${id}`];
      if (shot && shot.sh > avatar.sh) {
        avatar.sh = shot.sh;
        avatar.group.updateMatrixWorld(true);
        avatar.muzzle.getWorldPosition(_muzzle);
        this.tracer(_muzzle, _end.set(shot.hx, shot.hy, shot.hz));
        this.sound.shot(0.35);
      }
    }
  }

  createAvatar(color) {
    const group = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.45, metalness: 0.5 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.8, 4, 12), suit);
    body.position.y = 0.85;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), suit);
    head.position.y = 1.6;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.06), dark);
    visor.position.set(0, 1.62, -0.18);

    // Pitches with the player's aim, around eye height
    const aim = new THREE.Group();
    aim.position.y = 1.4;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.55), dark);
    gun.position.set(0.22, -0.05, -0.3);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0.22, -0.03, -0.6);
    aim.add(gun, muzzle);

    group.add(body, head, visor, aim);
    group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.scene.add(group);
    return { group, aim, muzzle, suit, dark, label: null, name: '', sh: 0 };
  }

  setAvatarName(avatar, name) {
    if (avatar.name === name) return;
    avatar.name = name;
    if (avatar.label) {
      avatar.group.remove(avatar.label);
      avatar.label.material.map.dispose();
      avatar.label.material.dispose();
    }
    const texture = canvasTexture(256, (g, s) => {
      g.font = 'bold 40px Rajdhani, system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 7;
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.strokeText(name, s / 2, s / 2);
      g.fillStyle = '#fff';
      g.fillText(name, s / 2, s / 2);
    });
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false }));
    label.scale.set(1.2, 1.2, 1);
    label.position.y = 2.15;
    avatar.label = label;
    avatar.group.add(label);
  }

  removeAvatar(avatar) {
    this.scene.remove(avatar.group);
    avatar.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    avatar.suit.dispose();
    avatar.dark.dispose();
    if (avatar.label) {
      avatar.label.material.map.dispose();
      avatar.label.material.dispose();
    }
  }

  // ---------- Effects ----------

  addEffect(life, update, dispose) {
    this.effects.push({ age: 0, life, update, dispose });
  }

  updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.age += dt;
      const k = Math.min(e.age / e.life, 1);
      e.update(k, dt);
      if (k >= 1) {
        e.dispose();
        this.effects.splice(i, 1);
      }
    }
  }

  clearEffects() {
    for (const e of this.effects) e.dispose();
    this.effects.length = 0;
    for (const d of this.decals) this.scene.remove(d);
    this.decals.length = 0;
  }

  tracer(from, to) {
    const geometry = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const material = new THREE.LineBasicMaterial({ color: 0xfff1b8, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
    this.addEffect(
      0.07,
      (k) => { material.opacity = 0.85 * (1 - k); },
      () => { this.scene.remove(line); geometry.dispose(); material.dispose(); },
    );
  }

  burst(point, color, count, speed, normal = null) {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true });
    const parts = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.particleGeo, material);
      m.position.copy(point);
      m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
        .normalize()
        .multiplyScalar(speed * (0.3 + Math.random() * 0.7));
      if (normal) v.addScaledVector(normal, speed * 0.6);
      else v.y += speed * 0.4;
      m.userData.v = v;
      this.scene.add(m);
      parts.push(m);
    }
    this.addEffect(
      0.6,
      (k, dt) => {
        material.opacity = 1 - k;
        for (const m of parts) {
          const v = m.userData.v;
          v.y -= 14 * dt;
          m.position.addScaledVector(v, dt);
          if (m.position.y < 0.02) {
            m.position.y = 0.02;
            v.set(v.x * 0.5, -v.y * 0.3, v.z * 0.5);
          }
        }
      },
      () => {
        for (const m of parts) this.scene.remove(m);
        material.dispose();
      },
    );
  }

  addDecal(point, normal) {
    const d = new THREE.Mesh(this.decalGeo, this.decalMat);
    d.position.copy(point).addScaledVector(normal, 0.005);
    d.lookAt(_v.copy(d.position).add(normal));
    d.rotateZ(Math.random() * Math.PI);
    d.scale.setScalar(0.7 + Math.random() * 0.6);
    this.scene.add(d);
    this.decals.push(d);
    if (this.decals.length > MAX_DECALS) this.scene.remove(this.decals.shift());
  }
}
