// Three.js presentation layer. Consumes immutable snapshots + interpolation
// alpha; never mutates rules state. Layers: environment / gameplay / effects /
// UI anchors. Graphics quality comes from js/gfx.js (presets + per-category
// overrides); post-processing is optional and the no-post path stays fully
// readable.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TABLE_W, TABLE_H, MALLET_R, PUCK_R, GOAL_W, MAX_PUCK_SPEED, PHASE } from './rules.js';
import { themeById } from './content.js';
import { resolve, describe, detectPreset, shortGpu, SHADOW_MAP, PARTICLE_BUDGET } from './gfx.js';

// World mapping: table (x,y) -> world (x - W/2, 0, y - H/2). Player 0 at -z.
export function toWorld(x, y) { return [x - TABLE_W / 2, y - TABLE_H / 2]; }
export function fromWorld(wx, wz) { return [wx + TABLE_W / 2, wz + TABLE_H / 2]; }

// Authored camera framing constants (no magic offsets inline).
export const CAMERA = {
  fov: 46,
  height: 165,
  back: 118,          // distance behind player 0's goal
  lookAhead: 18,      // look target pulled toward table centre
  transitionTime: 0.9,
  orbitRadius: 230,   // menu attract view
  orbitHeight: 120,
  orbitSpeed: 0.05,   // rad/s
};

const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_FX = 2, LAYER_UI = 3;
const MOTES = 180;

// Colour grade + vignette, applied after OutputPass (display-space in and out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve, a little extra saturation for the neon, cool shadows / warm highlights.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.12);
      s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.03, 1.0, 0.97), smoothstep(0.2, 0.8, l));
      s = s * 0.975 + 0.012;
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.9));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

export class Renderer {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.debugView = 'none';
    this._shake = 0;
    this._camFrom = null;
    this._camT = 1;
    this._orbit = 0;
    this._time = 0;
    this._disposables = [];
    this._arenaDisposables = [];
    this._arenaArgs = null;
    this.size = [0, 0];
    this.pixelRatio = 0;
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.postKey = null;
    this.composer = null;
    this.postFailed = false;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // GPU detection for the Auto preset.
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    const mobile = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent) || !!window.matchMedia?.('(pointer: coarse)').matches;
    this.detected = detectPreset(this.gpu, { mobile });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 1, 900);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_FX);
    this.camera.layers.enable(LAYER_UI);

    this._buildLights();
    this._buildParticles();
    this._buildMotes();
    this.setGraphics(settings.graphics);
    this.resize();
  }

  // ------------------------------------------------------------------ setup

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x8899cc, 0x0a0c18, 0.55);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.key.position.set(-60, 140, -40);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.4;
    this.scene.add(this.key, this.key.target);
    this._fitShadow();
    this.fill = new THREE.PointLight(0x4466ff, 0.4, 500, 0);
    this.fill.position.set(40, 60, 60);
    this.scene.add(this.fill);
  }

  /** Fit the key light's orthographic shadow box tightly around the table and its pieces. */
  _fitShadow() {
    const view = new THREE.Matrix4().lookAt(this.key.position, this.key.target.position, new THREE.Vector3(0, 1, 0));
    const inv = view.clone().invert();
    const hx = TABLE_W / 2 + 8, hz = TABLE_H / 2 + 8;
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = min.clone().negate();
    const v = new THREE.Vector3();
    for (const x of [-hx, hx]) for (const y of [-6, 8]) for (const z of [-hz, hz]) {
      v.set(x, y, z).sub(this.key.position).applyMatrix4(inv);
      min.min(v); max.max(v);
    }
    const cam = this.key.shadow.camera;
    Object.assign(cam, { left: min.x - 2, right: max.x + 2, top: max.y + 2, bottom: min.y - 2, near: Math.max(1, -max.z - 10), far: -min.z + 10 });
    cam.updateProjectionMatrix();
  }

  _buildParticles() {
    // Pooled particle system: fixed buffers, zero per-frame allocation.
    const MAX = PARTICLE_BUDGET.high;
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

  /** Ambient light motes drifting up around (never over) the table. */
  _buildMotes() {
    const pos = new Float32Array(MOTES * 3);
    this.moteSeed = new Float32Array(MOTES * 3); // angle, radius, phase
    for (let i = 0; i < MOTES; i++) {
      this.moteSeed[i * 3] = Math.random() * Math.PI * 2;
      this.moteSeed[i * 3 + 1] = 95 + Math.random() * 170;
      this.moteSeed[i * 3 + 2] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 1.3, map: radialTexture(), color: 0xffffff, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.motes.layers.set(LAYER_FX);
    this.motes.raycast = () => {};
    this.scene.add(this.motes);
    this._disposables.push(geo, mat, mat.map);
    this._updateMotes(0);
  }

  _updateMotes(t) {
    const p = this.motes.geometry.attributes.position.array, s = this.moteSeed;
    for (let i = 0; i < MOTES; i++) {
      const a = s[i * 3] + t * 0.03, r = s[i * 3 + 1];
      const y = ((s[i * 3 + 2] + t * 0.025) % 1) * 90 - 4;
      p[i * 3] = Math.cos(a) * r * 0.75;
      p[i * 3 + 1] = y;
      p[i * 3 + 2] = Math.sin(a) * r;
    }
    this.motes.geometry.attributes.position.needsUpdate = true;
  }

  _envTexture() {
    if (!this._env) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment(this.renderer);
      this._env = pmrem.fromScene(room, 0.04).texture;
      room.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
      pmrem.dispose();
      this._disposables.push(this._env);
    }
    return this._env;
  }

  /** Build/rebuild all theme-dependent meshes. */
  buildArena(themeId, obstacles = []) {
    this._arenaArgs = [themeId, obstacles];
    this.theme = themeById(themeId);
    const t = this.theme;
    const q = this.q;
    const detailed = q.detail === 'detailed';
    if (this.arena) {
      this.scene.remove(this.arena);
      this.arena.traverse(o => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); });
      for (const d of this._arenaDisposables) d.dispose?.();
    }
    const disp = this._arenaDisposables = [];
    const g = new THREE.Group();
    this.arena = g;
    this.scene.add(g);
    this.scene.background = new THREE.Color(t.bg);
    this.scene.fog = new THREE.Fog(t.bg, 260, 560);
    this.motes.material.color.set(t.rail);

    // Detailed tier: physical materials with clearcoat. Plain tier: cheaper standard materials.
    const phys = (color, opts = {}) => {
      const o = { color, roughness: 0.4, metalness: 0.4, envMapIntensity: 0.5, ...opts };
      if (detailed) return new THREE.MeshPhysicalMaterial(o);
      delete o.clearcoat; delete o.clearcoatRoughness;
      return new THREE.MeshStandardMaterial(o);
    };
    const glow = (color, intensity = 2.2) => new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.2 });

    // Environment floor: an emissive neon grid on the detailed tier.
    const floorGeo = new THREE.PlaneGeometry(1000, 1000);
    const floorMat = new THREE.MeshStandardMaterial({ color: t.floor, roughness: 0.85, metalness: 0.15, envMapIntensity: 0.15 });
    if (detailed) {
      const grid = gridTexture(t.rail);
      grid.repeat.set(50, 50);
      floorMat.emissiveMap = grid;
      floorMat.emissive = new THREE.Color(0xffffff);
      floorMat.emissiveIntensity = 0.1;
      disp.push(grid);
    }
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -6;
    floor.receiveShadow = true;
    floor.layers.set(LAYER_ENV);
    g.add(floor);
    this.floorMat = floorMat;

    // Neon underglow: the table's light spilling onto the floor.
    const spillTex = radialTexture();
    disp.push(spillTex);
    const spill = new THREE.Mesh(new THREE.PlaneGeometry(TABLE_W * 2.6, TABLE_H * 1.8),
      new THREE.MeshBasicMaterial({ map: spillTex, color: t.rail, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    spill.rotation.x = -Math.PI / 2;
    spill.position.y = -5.9;
    spill.raycast = () => {};
    g.add(spill);

    // Ring of glowing-capped pillars (detailed tier).
    this.pillarCaps = [];
    if (detailed) {
      const n = 16;
      const pilGeo = new THREE.CylinderGeometry(2.2, 2.8, 60, 12);
      const capGeo = new THREE.CylinderGeometry(2.6, 2.6, 2, 12);
      disp.push(pilGeo, capGeo);
      const pilMat = phys(t.table, { roughness: 0.55, metalness: 0.6 });
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const p = new THREE.Mesh(pilGeo, pilMat);
        p.position.set(Math.cos(a) * 200, 24, Math.sin(a) * 200);
        const cap = new THREE.Mesh(capGeo, glow(t.rail, 1.6));
        cap.position.y = 31;
        p.add(cap);
        p.layers.set(LAYER_ENV);
        g.add(p);
        this.pillarCaps.push(cap);
      }
    }

    // Table body: dark lacquered slab.
    const table = new THREE.Mesh(new THREE.BoxGeometry(TABLE_W + 12, 6, TABLE_H + 12),
      phys(t.table, { roughness: 0.35, metalness: 0.6, clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.25 }));
    table.position.y = -3.2;
    table.receiveShadow = true;
    g.add(table);

    // Playing surface: glossy clearcoat with authored markings; the markings
    // also drive a faint emissive map so they read on every tier.
    const { map, glowMap } = surfaceTextures(t, detailed, this.renderer.capabilities.getMaxAnisotropy());
    disp.push(map, glowMap);
    const surf = new THREE.Mesh(new THREE.PlaneGeometry(TABLE_W, TABLE_H), phys(0xffffff, {
      map, emissiveMap: glowMap, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.7,
      roughness: 0.6, metalness: 0.1, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.08,
    }));
    surf.rotation.x = -Math.PI / 2;
    surf.position.y = 0.01;
    surf.receiveShadow = true;
    g.add(surf);

    // Rails: dark metal housing with a luminous core on top (goal-mouth gaps).
    const railH = 3, railT = 2.4;
    const housingMat = phys(0x1a2038, { roughness: 0.3, metalness: 0.8, clearcoat: 0.5, envMapIntensity: 0.4 });
    const coreMat = glow(t.rail, 2.4);
    const mkRail = (w, d, x, z) => {
      const housing = new THREE.Mesh(new THREE.BoxGeometry(w, railH, d), housingMat);
      housing.position.set(x, railH / 2 - 0.2, z);
      housing.castShadow = true;
      housing.receiveShadow = true;
      const core = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w - 0.6, 0.9), 0.7, Math.max(d - 0.6, 0.9)), coreMat);
      core.position.y = railH / 2 + 0.1;
      housing.add(core);
      g.add(housing);
    };
    const gw = GOAL_W / 2;
    mkRail(railT, TABLE_H + railT * 2, -TABLE_W / 2 - railT / 2, 0);
    mkRail(railT, TABLE_H + railT * 2, TABLE_W / 2 + railT / 2, 0);
    const segW = (TABLE_W - GOAL_W) / 2;
    for (const sgn of [-1, 1]) {
      const z = sgn * (TABLE_H / 2 + railT / 2);
      const cx = gw + segW / 2;
      mkRail(segW, railT, -cx, z);
      mkRail(segW, railT, cx, z);
    }

    // Goal glow strips (player 0 = near/-z uses goal0 colour).
    this.goalStrips = [];
    for (const [i, sgn] of [[0, -1], [1, 1]]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(GOAL_W, 1.2, 2), glow(i === 0 ? t.goal0 : t.goal1, 2.0));
      strip.position.set(0, 0.4, sgn * (TABLE_H / 2 + railT + 1.2));
      g.add(strip);
      this.goalStrips.push(strip);
    }

    // Puck: glossy disc with a luminous rim so it always reads against the table.
    const puckMat = phys(t.puck, { emissive: t.puck, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.2, envMapIntensity: 0.3 });
    this.puckMesh = new THREE.Mesh(new THREE.CylinderGeometry(PUCK_R, PUCK_R, 1.6, 32), puckMat);
    this.puckMesh.position.y = 0.8;
    this.puckMesh.castShadow = true;
    const puckRim = new THREE.Mesh(new THREE.TorusGeometry(PUCK_R - 0.35, 0.3, 8, 32), glow(t.rail, 1.6));
    puckRim.rotation.x = Math.PI / 2;
    puckRim.position.y = 0.82;
    this.puckMesh.add(puckRim);
    this.puckMesh.traverse(o => o.layers.set(LAYER_GAME));
    g.add(this.puckMesh);

    // Puck trail (bounded line, updated in place).
    const TRAIL = 26;
    this.trailLen = TRAIL;
    this.trailPos = new Float32Array(TRAIL * 3);
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    this.trail = new THREE.Line(tGeo, new THREE.LineBasicMaterial({ color: t.rail, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending }));
    this.trail.frustumCulled = false;
    this.trail.layers.set(LAYER_FX);
    this.trail.raycast = () => {};
    g.add(this.trail);

    // Mallets: lacquered body + emissive ring + dark handle with a lit cap.
    this.malletMeshes = [];
    this.malletRings = [];
    for (const i of [0, 1]) {
      const color = i === 0 ? t.mallet0 : t.mallet1;
      const grp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(MALLET_R, MALLET_R * 0.85, 2.6, 36),
        phys(color, { roughness: 0.35, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.25, envMapIntensity: 0.25 }));
      body.position.y = 1.3;
      body.castShadow = true;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(MALLET_R - 0.4, 0.55, 12, 40), glow(color, 2.6));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.5;
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 3.4, 20),
        phys(0x181c2c, { roughness: 0.35, metalness: 0.7, clearcoat: 0.6 }));
      handle.position.y = 4.2;
      handle.castShadow = true;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.3, 20), glow(color, 1.4));
      cap.position.y = 6.0;
      grp.add(body, ring, handle, cap);
      grp.traverse(o => o.layers.set(LAYER_GAME));
      g.add(grp);
      this.malletMeshes.push(grp);
      this.malletRings.push(ring);
    }

    // Obstacles.
    this.obstacleMeshes = [];
    for (const o of obstacles) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r * 1.15, 2.8, 24),
        phys(0x1a2038, { roughness: 0.3, metalness: 0.7, clearcoat: 0.6 }));
      const [wx, wz] = toWorld(o.x, o.y);
      m.position.set(wx, 1.4, wz);
      m.castShadow = true;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(o.r - 0.3, 0.5, 8, 28), glow(t.accent, 1.8));
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 1.2;
      m.add(rim);
      m.layers.set(LAYER_GAME);
      g.add(m);
      this.obstacleMeshes.push(m);
    }

    // Drag target marker (selection layer): grounded ring, never bloom-only.
    this.targetMarker = new THREE.Mesh(new THREE.RingGeometry(2.2, 3.2, 32),
      new THREE.MeshBasicMaterial({ color: t.mallet0, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    this.targetMarker.rotation.x = -Math.PI / 2;
    this.targetMarker.position.y = 0.05;
    this.targetMarker.visible = false;
    this.targetMarker.layers.set(LAYER_UI);
    this.targetMarker.raycast = () => {};
    g.add(this.targetMarker);

    // Invisible picking plane on the default layer.
    this.pickPlane = new THREE.Mesh(new THREE.PlaneGeometry(TABLE_W + 20, TABLE_H + 20), new THREE.MeshBasicMaterial({ visible: false }));
    this.pickPlane.rotation.x = -Math.PI / 2;
    g.add(this.pickPlane);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(LAYER_ENV);

    this._applyShadowFlags();
    this.postKey = null; // rebuild the post chain on the next frame (bloom follows the theme)
    this.renderer.compile(this.scene, this.camera);
  }

  // ------------------------------------------------------------------ graphics settings

  /** Apply saved graphics settings ({} or undefined = Auto). Live, no reload. */
  setGraphics(saved) {
    const key = JSON.stringify(saved ?? {});
    if (key === this._gfxJson) return;
    this._gfxJson = key;
    const prev = this.q;
    const g = this.q = resolve(saved, this.detected);

    const size = SHADOW_MAP[g.shadows];
    this.renderer.shadowMap.enabled = size > 0;
    this.key.castShadow = size > 0;
    if (size > 0 && this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.scene.environment = g.reflections === 'on' ? this._envTexture() : null;
    this.particleBudget = PARTICLE_BUDGET[g.particles];
    this.motes.visible = g.particles === 'high';
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null;
    this.postFailed = false;
    this._fpsVisible(g.showFps);
    this.canvas.dataset.gfxPreset = g.preset;

    if (this._arenaArgs && prev && prev.detail !== g.detail) this.buildArena(...this._arenaArgs);
    else this._applyShadowFlags();
  }

  _applyShadowFlags() {
    // Materials pick up shadow-map / environment changes on recompile.
    this.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => { m.needsUpdate = true; }); });
  }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo() {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: shortGpu(this.gpu),
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: this.postFailed,
    };
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '— fps';
      document.getElementById('app')?.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio, this.theme?.id].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    this.composer?.dispose();
    this.composer = null;
    this.canvas.dataset.gfxPost = 'off';
    if (!g.post || this.postFailed) return;
    try {
      const pr = this.pixelRatio;
      const target = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0 });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, w * pr, h * pr);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.7;
        ao.updateGtaoMaterial({ radius: 6, distanceExponent: 1.5, thickness: 3, scale: 1, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only HDR emissives (rails, rings, strips) and hot highlights bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), (this.theme?.bloom ?? 0.8) * 0.75, 0.5, 0.9));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(w * pr, h * pr));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        composer.addPass(fxaa);
      }
      this.composer = composer;
      this.canvas.dataset.gfxPost = 'on';
    } catch (_) {
      // Post-processing is an enhancement: render directly; the panel shows a note.
      this.postFailed = true;
      this.composer = null;
      this.canvas.dataset.gfxPost = 'failed';
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  resize() { this._sized = false; }

  _applySize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    if (this._sized && w === this.size[0] && h === this.size[1] && ratio === this.pixelRatio) return;
    this._sized = true;
    this.size = [w, h];
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
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

  _reducedMotion() {
    return !!this.settings.reducedMotion || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  // ------------------------------------------------------------------ events

  /** Event-tiered feedback. tier: 1 ack, 2 move, 3 goal, 4 round end. */
  feedback(kind, worldPos = null, tier = 1) {
    const reduced = this._reducedMotion();
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
      // Hot core: particles start brighter than the rail colour (HDR) so they bloom.
      this.pCol[i * 3] = cr * 1.6; this.pCol[i * 3 + 1] = cg * 1.6; this.pCol[i * 3 + 2] = cb * 1.6;
    }
  }

  // ------------------------------------------------------------------ frame

  /**
   * Render one frame.
   * prev/cur: position snapshots {puck:{x,y}, mallets:[{x,y},{x,y}]}; alpha in [0,1).
   * cur === null renders the menu attract view (slow orbit, pieces at rest).
   * state: full rules state for phase-dependent presentation.
   */
  render(dt, prev, cur, alpha, state) {
    const reduced = this._reducedMotion();
    const animated = this.q.background === 'animated' && !reduced;
    if (animated) this._time += dt;
    const now = this._time;

    const dtMs = dt * 1000;
    const rescale = this._adapt(dtMs);
    if (rescale) this._sized = false;
    this._applySize();

    if (!cur) {
      // Menu attract view: a slow orbit (static under reduced motion).
      if (!reduced) this._orbit += dt * CAMERA.orbitSpeed;
      const a = this._orbit - Math.PI / 2;
      this.camera.position.set(Math.cos(a) * CAMERA.orbitRadius, CAMERA.orbitHeight, Math.sin(a) * CAMERA.orbitRadius);
      this.camera.lookAt(0, 0, 0);
      cur = prev = IDLE_POSE;
      alpha = 1;
    } else if (this._camT < 1 && this._camFrom) {
      // Camera transition (authored duration/easing, interruptible).
      this._camT = Math.min(1, this._camT + dt / (reduced ? 0.01 : CAMERA.transitionTime));
      const e = 1 - Math.pow(1 - this._camT, 3);
      const { pos, target } = this._playCameraPose();
      this.camera.position.lerpVectors(this._camFrom, pos, e);
      const m = new THREE.Matrix4().lookAt(this.camera.position, target, new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      this.camera.quaternion.slerpQuaternions(this._camFromQ, q, e);
      if (this._camT >= 1) this._camFrom = null;
    } else {
      const { pos, target } = this._playCameraPose();
      this.camera.position.copy(pos);
      this.camera.lookAt(target);
    }

    // Tiered, reduced-motion-aware shake applied to the camera only after picking.
    if (this._shake > 0.001) {
      const s = this._shake * 0.9;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.6;
      this._shake *= Math.pow(0.001, dt);
    } else this._shake = 0;

    // Interpolate gameplay meshes from simulation snapshots.
    const lerp = (a, b) => a + (b - a) * alpha;
    const px = lerp(prev?.puck.x ?? cur.puck.x, cur.puck.x);
    const py = lerp(prev?.puck.y ?? cur.puck.y, cur.puck.y);
    const [wx, wz] = toWorld(px, py);
    this.puckMesh.position.set(wx, 0.8, wz);
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
    this._pushTrail(wx, 0.8, wz);

    // Goal strips pulse while play is live; your ring breathes to show ownership.
    const clock = performance.now();
    const active = state && state.phase === PHASE.ACTIVE;
    for (const [i, strip] of this.goalStrips.entries()) {
      strip.material.emissiveIntensity = active ? 2.0 + Math.sin(clock / 300 + i * 2) * 0.5 : 1.2;
    }
    this.malletRings[0].material.emissiveIntensity = 2.2 + Math.sin(clock / 240) * 0.6;

    // Ambient arena motion (background tier; frozen under reduced motion).
    if (this.motes.visible && animated) this._updateMotes(now);
    for (const [i, cap] of this.pillarCaps.entries()) {
      cap.material.emissiveIntensity = animated ? 1.4 + Math.sin(now * 1.3 + i * 0.7) * 0.5 : 1.6;
    }
    if (this.floorMat.emissiveMap) this.floorMat.emissiveIntensity = animated ? 0.09 + Math.sin(now * 0.8) * 0.025 : 0.1;

    this._updateParticles(dt);

    const key = this._postKey(this.size[0], this.size[1]);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(this.size[0], this.size[1]);
    }
    if (this.composer) this.composer.render(dt);
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

  _updateParticles(dt) {
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
    if (view === 'none' && this.theme && this.puckMesh) {
      this.puckMesh.material.emissive.set(this.theme.puck);
      this.puckMesh.material.emissiveIntensity = 0.3;
    }
  }

  /** Draw-call / triangle evidence for the performance overlay. */
  stats() {
    const i = this.renderer.info;
    return { drawCalls: i.render.calls, triangles: i.render.triangles, tier: this.q.preset };
  }

  dispose() {
    this.composer?.dispose();
    for (const d of this._disposables) d.dispose?.();
    for (const d of this._arenaDisposables) d.dispose?.();
    this.renderer.dispose();
  }
}

const IDLE_POSE = {
  puck: { x: TABLE_W / 2, y: TABLE_H / 2 },
  mallets: [{ x: TABLE_W / 2, y: TABLE_H * 0.18 }, { x: TABLE_W / 2, y: TABLE_H * 0.82 }],
};

// ---------------------------------------------------------------------- procedural textures

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

/** Soft radial falloff (white centre -> transparent edge). */
function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** One tile of the floor's neon grid (tiled via repeat). */
function gridTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = hex(color);
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(0.75, 0.75, 62.5, 62.5);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Playing-surface textures: a colour map (base tone, sheen, air-hole grid and
 * subtle noise on the detailed tier) and a markings-only emissive map.
 */
function surfaceTextures(t, detailed, maxAniso) {
  const W = detailed ? 512 : 256, H = W * 2, k = W / 256;
  const base = document.createElement('canvas');
  base.width = W; base.height = H;
  const ctx = base.getContext('2d');
  ctx.fillStyle = hex(t.table);
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.03)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(255,255,255,0.03)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  if (detailed) {
    // Deterministic fine grain so the flat slab has some tooth.
    const img = ctx.getImageData(0, 0, W, H);
    let seed = 1234567;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = ((seed >> 16) & 15) - 7;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    // Air-hole grid: dark pinholes with a faint lit lip.
    const step = 12 * k;
    for (let y = step / 2; y < H; y += step) {
      for (let x = step / 2; x < W; x += step) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath(); ctx.arc(x, y, 1.3 * k, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath(); ctx.arc(x + 0.6 * k, y + 0.6 * k, 1.1 * k, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  const glowC = document.createElement('canvas');
  glowC.width = W; glowC.height = H;
  const gctx = glowC.getContext('2d');
  gctx.fillStyle = '#000';
  gctx.fillRect(0, 0, W, H);
  const markings = (c2, width, alpha) => {
    c2.save();
    c2.strokeStyle = hex(t.line);
    c2.globalAlpha = alpha;
    c2.lineWidth = width * k;
    c2.beginPath(); c2.moveTo(0, H / 2); c2.lineTo(W, H / 2); c2.stroke();
    c2.beginPath(); c2.arc(W / 2, H / 2, 34 * k, 0, Math.PI * 2); c2.stroke();
    c2.strokeRect(78 * k, 0, 100 * k, 26 * k);
    c2.strokeRect(78 * k, H - 26 * k, 100 * k, 26 * k);
    if (detailed) { c2.beginPath(); c2.arc(W / 2, H / 2, 3 * k, 0, Math.PI * 2); c2.stroke(); }
    c2.restore();
  };
  markings(ctx, 2, 0.8);
  if (detailed) markings(gctx, 6, 0.25); // soft halo
  markings(gctx, 2, 0.9);

  const mk = (c) => {
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, maxAniso || 1);
    return tex;
  };
  return { map: mk(base), glowMap: mk(glowC) };
}
