// Three.js presentation layer. Consumes immutable snapshots + interpolation
// alpha; never mutates rules state. Layers: environment / gameplay / effects /
// UI anchors. Bloom is selective (HDR rails only) and tier-gated; the no-post
// baseline stays fully readable.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TABLE_W, TABLE_H, MALLET_R, PUCK_R, GOAL_W, MAX_PUCK_SPEED, PHASE } from './rules.js';
import { themeById } from './content.js';

// World mapping: table (x,y) -> world (x - W/2, 0, y - H/2). Player 0 at -z.
export function toWorld(x, y) { return [x - TABLE_W / 2, y - TABLE_H / 2]; }
export function fromWorld(wx, wz) { return [wx + TABLE_W / 2, wz + TABLE_H / 2]; }

export const QUALITY_TIERS = {
  low:    { dpr: 1,    shadows: false, particles: 300,  bloom: false, renderScale: 0.85, envDetail: 0 },
  medium: { dpr: 1.5,  shadows: true,  particles: 1000, bloom: false, renderScale: 1,    envDetail: 1 },
  high:   { dpr: 2,    shadows: true,  particles: 2000, bloom: true,  renderScale: 1,    envDetail: 2 },
};

// Authored camera framing constants (no magic offsets inline).
export const CAMERA = {
  fov: 46,
  height: 165,
  back: 118,          // distance behind player 0's goal
  lookAhead: 18,      // look target pulled toward table centre
  transitionTime: 0.9,
};

const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_FX = 2, LAYER_UI = 3;

export class Renderer {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.debugView = 'none';
    this._shake = 0;
    this._camFrom = null;
    this._camT = 1;
    this._lastState = null;
    this._disposables = [];
    this._tierName = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 1, 800);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_FX);
    this.camera.layers.enable(LAYER_UI);

    this._buildLights();
    this._buildParticles();
    this.composer = null;
    this.setQuality(settings.quality === 'auto' ? autoTier() : settings.quality);
    this.resize();
  }

  // ------------------------------------------------------------------ setup

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x8899cc, 0x0a0c18, 0.55);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.key.position.set(-60, 140, -40);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    const s = 130;
    Object.assign(this.key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 400 });
    this.scene.add(this.key);
    this.fill = new THREE.PointLight(0x4466ff, 0.4, 500);
    this.fill.position.set(40, 60, 60);
    this.scene.add(this.fill);
  }

  _buildParticles() {
    // Pooled particle system: fixed buffers, zero per-frame allocation.
    const MAX = 2000;
    this.pMax = MAX;
    this.pCount = 0;
    this.pPos = new Float32Array(MAX * 3);
    this.pVel = new Float32Array(MAX * 3);
    this.pLife = new Float32Array(MAX);
    this.pMaxLife = new Float32Array(MAX);
    this.pCol = new Float32Array(MAX * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const mat = new THREE.PointsMaterial({
      size: 1.6, vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_FX);
    this.points.raycast = () => {}; // cosmetic: never intercepts raycasts
    this.scene.add(this.points);
    this._disposables.push(geo, mat);
  }

  /** Build/rebuild all theme-dependent meshes. */
  buildArena(themeId, obstacles = []) {
    this.theme = themeById(themeId);
    const t = this.theme;
    if (this.arena) {
      this.scene.remove(this.arena);
      this.arena.traverse(o => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); });
    }
    const g = new THREE.Group();
    this.arena = g;
    this.scene.add(g);
    this.scene.background = new THREE.Color(t.bg);
    this.scene.fog = new THREE.Fog(t.bg, 260, 520);

    const std = (color, opts = {}) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.35, ...opts });
      this._disposables.push(m);
      return m;
    };
    const glow = (color, intensity = 2.2) => {
      const m = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.1 });
      this._disposables.push(m);
      return m;
    };

    // Environment floor + pillars (tier-scaled detail).
    const floorGeo = new THREE.PlaneGeometry(900, 900);
    const floor = new THREE.Mesh(floorGeo, std(t.floor, { roughness: 0.9, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -6;
    floor.receiveShadow = true;
    floor.layers.set(LAYER_ENV);
    g.add(floor);
    this._disposables.push(floorGeo);

    const pillarCount = [0, 8, 16][QUALITY_TIERS[this._tierName]?.envDetail ?? 1];
    if (pillarCount) {
      const pilGeo = new THREE.CylinderGeometry(2.2, 2.8, 60, 8);
      const pilMat = std(t.table, { roughness: 0.7 });
      const capMat = glow(t.rail, 1.4);
      for (let i = 0; i < pillarCount; i++) {
        const a = (i / pillarCount) * Math.PI * 2;
        const r = 200;
        const p = new THREE.Mesh(pilGeo, pilMat);
        p.position.set(Math.cos(a) * r, 24, Math.sin(a) * r);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 2, 8), capMat);
        cap.position.y = 31;
        p.add(cap);
        p.layers.set(LAYER_ENV);
        g.add(p);
      }
      this._disposables.push(pilGeo);
    }

    // Table body.
    const tableGeo = new THREE.BoxGeometry(TABLE_W + 12, 6, TABLE_H + 12);
    const table = new THREE.Mesh(tableGeo, std(t.table, { roughness: 0.35, metalness: 0.5 }));
    table.position.y = -3.2;
    table.receiveShadow = true;
    g.add(table);
    this._disposables.push(tableGeo);

    // Playing surface with authored markings (procedural canvas texture).
    const surfTex = this._surfaceTexture(t);
    const surfGeo = new THREE.PlaneGeometry(TABLE_W, TABLE_H);
    const surf = new THREE.Mesh(surfGeo, new THREE.MeshStandardMaterial({ map: surfTex, roughness: 0.45, metalness: 0.25 }));
    surf.rotation.x = -Math.PI / 2;
    surf.position.y = 0.01;
    surf.receiveShadow = true;
    g.add(surf);
    this._disposables.push(surfGeo, surf.material, surfTex);

    // Luminous rails: emissive boxes around the edge, with goal-mouth gaps.
    const railMat = glow(t.rail, 2.4);
    const railH = 3, railT = 2.4;
    const mkRail = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, railH, d), railMat);
      m.position.set(x, railH / 2 - 0.2, z);
      m.castShadow = this.key.castShadow;
      g.add(m);
      this._disposables.push(m.geometry);
      return m;
    };
    const gw = GOAL_W / 2;
    mkRail(railT, TABLE_H + railT * 2, -TABLE_W / 2 - railT / 2, 0);                    // left
    mkRail(railT, TABLE_H + railT * 2, TABLE_W / 2 + railT / 2, 0);                     // right
    const segW = (TABLE_W - GOAL_W) / 2;
    for (const sgn of [-1, 1]) {
      const z = sgn * (TABLE_H / 2 + railT / 2);
      const cx = (GOAL_W / 2 + segW / 2);
      mkRail(segW, railT, -cx, z);
      mkRail(segW, railT, cx, z);
    }

    // Goal glow strips (player 0 = near/-z uses goal0 color).
    this.goalStrips = [];
    for (const [i, sgn] of [[0, -1], [1, 1]]) {
      const geo = new THREE.BoxGeometry(GOAL_W, 1.2, 2);
      const mat = glow(i === 0 ? t.goal0 : t.goal1, 2.0);
      const strip = new THREE.Mesh(geo, mat);
      strip.position.set(0, 0.4, sgn * (TABLE_H / 2 + railT + 1.2));
      g.add(strip);
      this._disposables.push(geo, mat);
      this.goalStrips.push(strip);
    }

    // Puck.
    const puckGeo = new THREE.CylinderGeometry(PUCK_R, PUCK_R, 1.6, 28);
    const puckMat = std(t.puck, { emissive: t.puck, emissiveIntensity: 0.35, roughness: 0.3, metalness: 0.6 });
    this.puckMesh = new THREE.Mesh(puckGeo, puckMat);
    this.puckMesh.position.y = 0.8;
    this.puckMesh.castShadow = true;
    this.puckMesh.layers.set(LAYER_GAME);
    g.add(this.puckMesh);
    this._disposables.push(puckGeo, puckMat);

    // Puck trail (bounded line, updated in place).
    const TRAIL = 26;
    this.trailLen = TRAIL;
    this.trailPos = new Float32Array(TRAIL * 3);
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    const tMat = new THREE.LineBasicMaterial({ color: t.rail, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending });
    this.trail = new THREE.Line(tGeo, tMat);
    this.trail.frustumCulled = false;
    this.trail.layers.set(LAYER_FX);
    this.trail.raycast = () => {};
    g.add(this.trail);
    this._disposables.push(tGeo, tMat);

    // Mallets: body + emissive ring. Player 0 warm, player 1 cool.
    this.malletMeshes = [];
    this.malletRings = [];
    for (const i of [0, 1]) {
      const color = i === 0 ? t.mallet0 : t.mallet1;
      const grp = new THREE.Group();
      const bodyGeo = new THREE.CylinderGeometry(MALLET_R, MALLET_R * 0.85, 2.6, 28);
      const body = new THREE.Mesh(bodyGeo, std(color, { roughness: 0.35, metalness: 0.55 }));
      body.position.y = 1.3;
      body.castShadow = true;
      const ringGeo = new THREE.TorusGeometry(MALLET_R - 0.4, 0.55, 10, 32);
      const ring = new THREE.Mesh(ringGeo, glow(color, 2.6));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.5;
      const handleGeo = new THREE.CylinderGeometry(2.2, 2.6, 3.4, 16);
      const handle = new THREE.Mesh(handleGeo, std(0x181c2c, { roughness: 0.5 }));
      handle.position.y = 4.2;
      grp.add(body, ring, handle);
      grp.layers.set(LAYER_GAME);
      grp.traverse(o => o.layers.set(LAYER_GAME));
      g.add(grp);
      this._disposables.push(bodyGeo, ringGeo, handleGeo, ring.material);
      this.malletMeshes.push(grp);
      this.malletRings.push(ring);
    }

    // Obstacles.
    this.obstacleMeshes = [];
    for (const o of obstacles) {
      const geo = new THREE.CylinderGeometry(o.r, o.r * 1.15, 2.8, 20);
      const mat = std(0x1a2038, { roughness: 0.4, metalness: 0.6 });
      const m = new THREE.Mesh(geo, mat);
      const [wx, wz] = toWorld(o.x, o.y);
      m.position.set(wx, 1.4, wz);
      m.castShadow = true;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(o.r - 0.3, 0.5, 8, 24), glow(t.accent, 1.8));
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 1.2;
      m.add(rim);
      m.layers.set(LAYER_GAME);
      g.add(m);
      this._disposables.push(geo, mat, rim.geometry, rim.material);
      this.obstacleMeshes.push(m);
    }

    // Drag target marker (selection layer): grounded ring, never bloom-only.
    const markGeo = new THREE.RingGeometry(2.2, 3.2, 32);
    const markMat = new THREE.MeshBasicMaterial({ color: t.mallet0, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
    this.targetMarker = new THREE.Mesh(markGeo, markMat);
    this.targetMarker.rotation.x = -Math.PI / 2;
    this.targetMarker.position.y = 0.05;
    this.targetMarker.visible = false;
    this.targetMarker.layers.set(LAYER_UI);
    this.targetMarker.raycast = () => {};
    g.add(this.targetMarker);
    this._disposables.push(markGeo, markMat);

    // Invisible picking plane on the gameplay layer.
    const pickGeo = new THREE.PlaneGeometry(TABLE_W + 20, TABLE_H + 20);
    this.pickPlane = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ visible: false }));
    this.pickPlane.rotation.x = -Math.PI / 2;
    g.add(this.pickPlane);
    this._disposables.push(pickGeo);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(LAYER_ENV); // pickPlane lives on the default layer

    // Rebuild composer for the (possibly new) bloom state and prewarm shaders.
    this._buildComposer();
    this.renderer.compile(this.scene, this.camera);
    this._lastState = null;
  }

  _surfaceTexture(t) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 512;
    const ctx = c.getContext('2d');
    const col = (n) => '#' + n.toString(16).padStart(6, '0');
    ctx.fillStyle = col(t.table);
    ctx.fillRect(0, 0, 256, 512);
    // subtle vertical sheen
    const grad = ctx.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.03)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.07)');
    grad.addColorStop(1, 'rgba(255,255,255,0.03)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 512);
    ctx.strokeStyle = col(t.line);
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 2;
    // centre line + circle
    ctx.beginPath(); ctx.moveTo(0, 256); ctx.lineTo(256, 256); ctx.stroke();
    ctx.beginPath(); ctx.arc(128, 256, 34, 0, Math.PI * 2); ctx.stroke();
    // goal boxes
    ctx.strokeRect(78, 0, 100, 26);
    ctx.strokeRect(78, 486, 100, 26);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  // ------------------------------------------------------------------ quality

  setQuality(tierName) {
    if (!QUALITY_TIERS[tierName]) tierName = 'medium';
    this._tierName = tierName;
    const tier = QUALITY_TIERS[tierName];
    this.tier = tier;
    this.renderer.shadowMap.enabled = tier.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.key.castShadow = tier.shadows;
    this.particleBudget = tier.particles;
    this._buildComposer();
    this.resize();
  }

  _buildComposer() {
    if (this.tier?.bloom) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      // High threshold: only HDR emissive rails/rings bloom; gameplay whites
      // and UI never feed the pass.
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), this.theme?.bloom ?? 0.8, 0.55, 1.0);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    } else {
      this.composer = null;
      this.bloomPass = null;
    }
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.tier?.dpr ?? 1.5) * (this.tier?.renderScale ?? 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w * dpr, h * dpr);
  }

  // ------------------------------------------------------------------ camera

  /** Authored transition to the play framing; interruptible, spring-free. */
  transitionToPlay() {
    this._camFrom = this.camera.position.clone();
    this._camFromQ = this.camera.quaternion.clone();
    this._camT = 0;
  }

  _playCameraPose() {
    // Frame the table from player 0's end; portrait screens pull back/up.
    const portrait = this.camera.aspect < 1;
    const back = CAMERA.back * (portrait ? 1.55 : 1);
    const height = CAMERA.height * (portrait ? 1.45 : 1);
    const pos = new THREE.Vector3(0, height, -TABLE_H / 2 - back);
    const target = new THREE.Vector3(0, 0, -TABLE_H / 2 + back * 0.62 + CAMERA.lookAhead);
    return { pos, target };
  }

  // ------------------------------------------------------------------ events

  /** Event-tiered feedback. tier: 1 ack, 2 move, 3 goal, 4 round end. */
  feedback(kind, worldPos = null, tier = 1) {
    const reduced = this.settings.reducedMotion;
    if (kind === 'strike' || kind === 'wall' || kind === 'obstacle') {
      this.spawnBurst(worldPos, kind === 'strike' ? 10 : 5, kind === 'strike' ? 26 : 12);
    } else if (kind === 'goal') {
      this.spawnBurst(worldPos, 60, 60);
      if (!reduced) this._shake = Math.min(1, this._shake + 0.5);
    } else if (kind === 'terminal') {
      if (worldPos) this.spawnBurst(worldPos, 120, 80);
      if (!reduced) this._shake = Math.min(1, this._shake + 0.8);
    }
    if (tier >= 3 && !reduced) this._shake = Math.min(1, this._shake + 0.1);
  }

  spawnBurst(worldPos, count, speed) {
    if (!worldPos) return;
    const n = Math.min(count, this.particleBudget);
    const t = this.theme;
    const cr = ((t.rail >> 16) & 255) / 255, cg = ((t.rail >> 8) & 255) / 255, cb = (t.rail & 255) / 255;
    for (let k = 0; k < n; k++) {
      const i = this.pCount < this.pMax ? this.pCount++ : (Math.random() * this.pMax) | 0;
      if (this.pCount > this.particleBudget && i >= this.particleBudget) continue;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.7 + 0.3;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.pPos[i * 3] = worldPos.x; this.pPos[i * 3 + 1] = worldPos.y + 1; this.pPos[i * 3 + 2] = worldPos.z;
      this.pVel[i * 3] = Math.cos(a) * s * (1 - up * 0.5);
      this.pVel[i * 3 + 1] = up * s;
      this.pVel[i * 3 + 2] = Math.sin(a) * s * (1 - up * 0.5);
      this.pLife[i] = this.pMaxLife[i] = 0.5 + Math.random() * 0.5;
      this.pCol[i * 3] = cr; this.pCol[i * 3 + 1] = cg; this.pCol[i * 3 + 2] = cb;
    }
  }

  // ------------------------------------------------------------------ frame

  /**
   * Render one frame.
   * prev/cur: position snapshots {puck:{x,y}, mallets:[{x,y},{x,y}]}; alpha in [0,1).
   * state: full rules state for phase-dependent presentation.
   */
  render(dt, prev, cur, alpha, state) {
    const reduced = this.settings.reducedMotion;

    // Camera transition (authored duration/easing, interruptible).
    if (this._camT < 1 && this._camFrom) {
      this._camT = Math.min(1, this._camT + dt / (reduced ? 0.01 : CAMERA.transitionTime));
      const e = 1 - Math.pow(1 - this._camT, 3);
      const { pos, target } = this._playCameraPose();
      this.camera.position.lerpVectors(this._camFrom, pos, e);
      const m = new THREE.Matrix4().lookAt(this.camera.position, target, new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      this.camera.quaternion.slerpQuaternions(this._camFromQ, q, e);
      if (this._camT >= 1) this._camFrom = null;
    } else if (!this._camFrom) {
      const { pos, target } = this._playCameraPose();
      this.camera.position.copy(pos);
      this.camera.lookAt(target);
    }

    // Tiered, reduced-motion-aware shake that never changes raycast truth
    // (it is applied to the camera only after picking for the frame).
    if (this._shake > 0.001) {
      const s = this._shake * 0.9;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.6;
      this._shake *= Math.pow(0.001, dt); // fast decay
    } else this._shake = 0;

    // Interpolate gameplay meshes from simulation snapshots.
    if (cur) {
      const lerp = (a, b) => a + (b - a) * alpha;
      const px = lerp(prev?.puck.x ?? cur.puck.x, cur.puck.x);
      const py = lerp(prev?.puck.y ?? cur.puck.y, cur.puck.y);
      const [wx, wz] = toWorld(px, py);
      this.puckMesh.position.set(wx, 0.8, wz);
      // Debug view: tint puck by speed field.
      if (this.debugView === 'speed' && state) {
        const s = Math.hypot(state.puck.vx, state.puck.vy) / MAX_PUCK_SPEED;
        this.puckMesh.material.emissive.setHSL(0.6 - s * 0.6, 1, 0.5);
        this.puckMesh.material.emissiveIntensity = 1.2;
      }
      for (const i of [0, 1]) {
        const mx = lerp(prev?.mallets[i].x ?? cur.mallets[i].x, cur.mallets[i].x);
        const my = lerp(prev?.mallets[i].y ?? cur.mallets[i].y, cur.mallets[i].y);
        const [mwx, mwz] = toWorld(mx, my);
        this.malletMeshes[i].position.set(mwx, 0, mwz);
      }
      // Trail follows the puck.
      this._pushTrail(wx, 0.8, wz);

      // Goal strips pulse while play is live.
      const active = state && state.phase === PHASE.ACTIVE;
      for (const [i, strip] of this.goalStrips.entries()) {
        strip.material.emissiveIntensity = active ? 2.0 + Math.sin(performance.now() / 300 + i * 2) * 0.5 : 1.2;
      }
      // Player mallet ring breathes to show ownership; stronger when it's your mallet.
      this.malletRings[0].material.emissiveIntensity = 2.2 + Math.sin(performance.now() / 240) * 0.6;
    }

    this._updateParticles(dt, reduced);

    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  _pushTrail(x, y, z) {
    const p = this.trailPos;
    for (let i = this.trailLen - 1; i > 0; i--) {
      p[i * 3] = p[(i - 1) * 3]; p[i * 3 + 1] = p[(i - 1) * 3 + 1]; p[i * 3 + 2] = p[(i - 1) * 3 + 2];
    }
    p[0] = x; p[1] = y; p[2] = z;
    this.trail.geometry.attributes.position.needsUpdate = true;
  }

  _updateParticles(dt, reduced) {
    if (reduced) dt *= 1; // timing preserved; spawn counts already reduced
    let alive = 0;
    for (let i = 0; i < this.pCount; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) { this.pPos[i * 3 + 1] = -999; continue; }
      alive++;
      this.pVel[i * 3 + 1] -= 60 * dt; // gravity
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      if (this.pPos[i * 3 + 1] < 0.2) { this.pPos[i * 3 + 1] = 0.2; this.pVel[i * 3 + 1] *= -0.4; }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    this.points.visible = alive > 0;
  }

  // ------------------------------------------------------------------ picking

  /** Raycast a pointer against the gameplay picking plane only. */
  pick(nx, ny) {
    this.raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    const hit = this.raycaster.intersectObject(this.pickPlane, false)[0];
    if (!hit) return null;
    const [tx, ty] = fromWorld(hit.point.x, hit.point.z);
    return { x: tx, y: ty };
  }

  showTargetMarker(x, y, visible = true) {
    const [wx, wz] = toWorld(x, y);
    this.targetMarker.position.set(wx, 0.05, wz);
    this.targetMarker.visible = visible;
  }

  setDebug(view) {
    this.debugView = view;
    if (view === 'none' && this.theme) {
      this.puckMesh?.material.emissive.set(this.theme.puck);
      if (this.puckMesh) this.puckMesh.material.emissiveIntensity = 0.35;
    }
  }

  /** Draw-call / triangle evidence for the performance overlay. */
  stats() {
    const i = this.renderer.info;
    return { drawCalls: i.render.calls, triangles: i.render.triangles, tier: this._tierName };
  }

  dispose() {
    for (const d of this._disposables) d.dispose?.();
    this.renderer.dispose();
  }
}

function autoTier() {
  const mobile = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent) || (navigator.hardwareConcurrency ?? 8) <= 4;
  return mobile ? 'low' : 'high';
}
