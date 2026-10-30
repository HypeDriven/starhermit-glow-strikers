// The luminous arena on starhermit:scene, ported from the browser build's
// three.js layer (js/render.js): the neon floor grid, the table's underglow,
// the ring of glowing-capped pillars, the lacquered table with its marked
// playing surface (grain, air holes, markings and their emissive halo), the
// rails with luminous cores and the goal mouths, the goal strips, the puck
// with its glowing rim and trail, the two mallets, the obstacles, the drag
// target marker, the pooled particle bursts, the ambient motes, the menu's
// attract orbit, the authored camera transition into the play framing and
// the camera shake. It consumes position snapshots and an interpolation
// alpha; it never mutates rules state.
//
// What changed from three.js, and why:
// - The EffectComposer chain (GTAO, UnrealBloom, OutputPass, the grade
//   ShaderPass, SMAA / FXAA / MSAA) is renderer.ao / bloom / grade /
//   antialias; the grade's GLSL (an S-curve blended 0.22, saturation 1.12,
//   cool shadows / warm highlights, the vignette) is the built-in
//   display-space grade with the same tints, split and vignette.
// - The key light's fitted orthographic shadow box, PCF soft shadows and light
//   intensities are three.js r160's as written (minor 28). r160 scaled
//   scene.environment by each material's envMapIntensity; r185 scales only a
//   material's own envMap, so standard materials carry the room as envMap. Canvas textures are starhermit:canvas CanvasTextures (sRGB,
//   as the browser build's SRGBColorSpace ones); the radial sprite is a
//   DataTexture.
// - The surface's per-pixel grain (an LCG over every texel) would take
//   seconds in the native interpreter: the same LCG fills a 128-px tile
//   once, drawn as a repeating pattern (light and dark halves).
// - Layers and the picking plane: picking intersects the table's plane
//   (y = 0) with the pointer's ray directly.
// - Hosted matches seen from seat 1 mirror the camera to the far end, so
//   your own mallet is always the near one.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  CylinderGeometry, DataTexture, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, Line, LineBasicMaterial,
  Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PMREMGenerator,
  PerspectiveCamera, Plane, PlaneGeometry, PointLight, Points, PointsMaterial, Quaternion, Raycaster, RepeatWrapping,
  OrthographicCamera, PCFSoftShadowMap, RingGeometry, RoomEnvironment, SRGBColorSpace, TorusGeometry, Vector2, Vector3, pointerToNdc, renderer, scene,
} from "starhermit:scene";
import type { Material, Texture } from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { TABLE_W, TABLE_H, MALLET_R, PUCK_R, GOAL_W, PHASE } from "../js/rules.js";
import { themeById } from "../js/content.js";
import { MAX_MOTES, MAX_PARTICLES, particleCap, type Look } from "./quality.ts";

type Theme = ReturnType<typeof themeById>;
export interface Pose { puck: { x: number; y: number }; mallets: { x: number; y: number }[] }
interface Obstacle { x: number; y: number; r: number }

const PI = Math.PI;
// World mapping: table (x,y) -> world (x - W/2, 0, y - H/2). Player 0 at -z.
export function toWorld(x: number, y: number): [number, number] { return [x - TABLE_W / 2, y - TABLE_H / 2]; }
export function fromWorld(wx: number, wz: number): [number, number] { return [wx + TABLE_W / 2, wz + TABLE_H / 2]; }

// Authored camera framing constants (no magic offsets inline).
const CAMERA = {
  fov: 46,
  height: 165,
  back: 118,          // distance behind player 0's goal
  lookAhead: 18,      // look target pulled toward table centre
  transitionTime: 0.9,
  orbitRadius: 230,   // menu attract view
  orbitHeight: 120,
  orbitSpeed: 0.05,   // rad/s
};
const IDLE_POSE: Pose = {
  puck: { x: TABLE_W / 2, y: TABLE_H / 2 },
  mallets: [{ x: TABLE_W / 2, y: TABLE_H * 0.18 }, { x: TABLE_W / 2, y: TABLE_H * 0.82 }],
};

const camera = new PerspectiveCamera(CAMERA.fov, 16 / 9, 1, 900);
let look: Look | null = null;
let theme: Theme = themeById("neon-dusk");
let reducedMotion = false;
let arenaArgs: [string, Obstacle[]] | null = null;
let arena: Group | null = null;
let made: { dispose(): void }[] = [];
let time = 0;
/** Wall seconds (the goal strips' and ring's pulse ran on performance.now). */
let wall = 0;
let orbit = 0;
let shake = 0;
let camT = 1;
let camFrom: Vector3 | null = null;
let camFromQ: Quaternion | null = null;
/** 0: your end is -z (seat 0, every solo mode); 1: the far end (hosted seat 1). */
let viewSeat = 0;
let aspect = 16 / 9;
let radial: Texture | null = null;

// lights
const hemi = new HemisphereLight(0x8899cc, 0x0a0c18, 0.55);
const key = new DirectionalLight(0xffffff, 1.6);
key.position.set(-60, 140, -40);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.4;
/** Fit the key light's orthographic shadow box tightly around the table and its pieces (the page's _fitShadow). */
function fitShadow(): void {
  const cam = key.shadow.camera as OrthographicCamera;
  cam.position.copy(key.position);
  cam.lookAt(key.target.position);
  cam.updateMatrixWorld();
  const hx = TABLE_W / 2 + 8, hz = TABLE_H / 2 + 8;
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  const v = new Vector3();
  for (const x of [-hx, hx]) for (const y of [-6, 8]) for (const z of [-hz, hz]) {
    v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    min.min(v); max.max(v);
  }
  cam.left = min.x - 2; cam.right = max.x + 2; cam.top = max.y + 2; cam.bottom = min.y - 2;
  cam.near = Math.max(1, -max.z - 10); cam.far = -min.z + 10;
  cam.updateProjectionMatrix();
}
fitShadow();
const fill = new PointLight(0x4466ff, 0.4, 500, 0);
fill.position.set(40, 60, 60);
scene.add(hemi, key, key.target, fill);

// meshes the arena rebuild re-points
let floorMat: MeshStandardMaterial | MeshLambertMaterial | null = null;
let pillarCaps: Mesh[] = [];
let goalStrips: Mesh[] = [];
let puckMesh: Mesh | null = null;
let malletMeshes: Group[] = [];
let malletRings: Mesh[] = [];
let targetMarker: Mesh | null = null;
let trail: Line | null = null;
let trailPos: Float32Array = new Float32Array(26 * 3);

// ---------------------------------------------------------------- particles and motes
const pPos = new Float32Array(MAX_PARTICLES * 3);
const pVel = new Float32Array(MAX_PARTICLES * 3);
const pLife = new Float32Array(MAX_PARTICLES);
const pCol = new Float32Array(MAX_PARTICLES * 3);
let pCount = 0;
let pCap = 300;
const pGeo = new BufferGeometry();
pGeo.setAttribute("position", new BufferAttribute(pPos, 3));
pGeo.setAttribute("color", new BufferAttribute(pCol, 3));
for (let i = 0; i < MAX_PARTICLES; i++) pPos[i * 3 + 1] = -999;
const points = new Points(pGeo, new PointsMaterial({
  size: 1.6, vertexColors: true, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true,
}));
points.frustumCulled = false;
points.visible = false;
scene.add(points);

const motePos = new Float32Array(MAX_MOTES * 3);
const moteSeed = new Float32Array(MAX_MOTES * 3); // angle, radius, phase
for (let i = 0; i < MAX_MOTES; i++) {
  moteSeed[i * 3] = Math.random() * PI * 2;
  moteSeed[i * 3 + 1] = 95 + Math.random() * 170;
  moteSeed[i * 3 + 2] = Math.random();
}
const moteGeo = new BufferGeometry();
moteGeo.setAttribute("position", new BufferAttribute(motePos, 3));
let moteCount = 120;
const moteMat = new PointsMaterial({
  size: 1.3, map: radialTexture(), color: 0xffffff, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true,
});
const motes = new Points(moteGeo, moteMat);
motes.frustumCulled = false;
scene.add(motes);
updateMotes(0);

function updateMotes(t: number): void {
  for (let i = 0; i < moteCount; i++) {
    const a = moteSeed[i * 3]! + t * 0.03, r = moteSeed[i * 3 + 1]!;
    const y = ((moteSeed[i * 3 + 2]! + t * 0.025) % 1) * 90 - 4;
    motePos[i * 3] = Math.cos(a) * r * 0.75;
    motePos[i * 3 + 1] = y;
    motePos[i * 3 + 2] = Math.sin(a) * r;
  }
  moteGeo.getAttribute("position")!.needsUpdate = true;
}

// ---------------------------------------------------------------- textures
const hex = (n: number): string => "#" + n.toString(16).padStart(6, "0");
/** Soft radial falloff (white centre -> transparent edge): 1 at 0, 0.45 at 0.35, 0 at 1. */
function radialTexture(): Texture {
  if (radial) return radial;
  const n = 64;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.min(1, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2));
      const a = d < 0.35 ? 1 - (d / 0.35) * 0.55 : 0.45 * (1 - (d - 0.35) / 0.65);
      const o = (y * n + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = 255;
      px[o + 3] = Math.round(Math.max(0, a) * 255);
    }
  }
  radial = new DataTexture(px, n, n);
  radial.colorSpace = SRGBColorSpace;
  radial.needsUpdate = true;
  return radial;
}
/** One tile of the floor's neon grid (tiled via repeat). */
function gridTexture(color: number): Texture {
  const c = new OffscreenCanvas(64, 64);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = hex(color);
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(0.75, 0.75, 62.5, 62.5);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}
let grainTiles: [OffscreenCanvas, OffscreenCanvas] | null = null;
/** The surface grain's LCG (seed 1234567, ±7 per channel) over a 128-px tile: its light and dark halves. */
function grain(): [OffscreenCanvas, OffscreenCanvas] {
  if (grainTiles) return grainTiles;
  const N = 128;
  const light = new OffscreenCanvas(N, N), dark = new OffscreenCanvas(N, N);
  const li = light.getContext("2d").createImageData(N, N), di = dark.getContext("2d").createImageData(N, N);
  let seed = 1234567;
  for (let i = 0; i < N * N; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = ((seed >> 16) & 15) - 7;
    const o = i * 4;
    if (n > 0) { li.data[o] = li.data[o + 1] = li.data[o + 2] = 255; li.data[o + 3] = n * 3; }
    else if (n < 0) { di.data[o + 3] = -n * 9; }
  }
  light.getContext("2d").putImageData(li, 0, 0);
  dark.getContext("2d").putImageData(di, 0, 0);
  grainTiles = [light, dark];
  return grainTiles;
}
const surfaceCache = new Map<string, { map: Texture; glowMap: Texture }>();
/** Playing-surface textures: a colour map (base tone, sheen, grain and air holes when detailed) and a markings-only emissive map. */
function surfaceTextures(t: Theme, detailed: boolean, size: number): { map: Texture; glowMap: Texture } {
  const id = `${t.id}:${detailed}:${size}`;
  const hit = surfaceCache.get(id);
  if (hit) return hit;
  const W = size, H = W * 2, k = W / 256;
  const base = new OffscreenCanvas(W, H);
  const ctx = base.getContext("2d");
  ctx.fillStyle = hex(t.table);
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "rgba(255,255,255,0.03)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.08)");
  grad.addColorStop(1, "rgba(255,255,255,0.03)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  if (detailed) {
    const [light, dark] = grain();
    for (const tile of [light, dark]) {
      const pat = ctx.createPattern(tile, "repeat");
      if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H); }
    }
    // Air-hole grid: dark pinholes with a faint lit lip.
    const step = 12 * k;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) { ctx.moveTo(x + 1.3 * k, y); ctx.arc(x, y, 1.3 * k, 0, PI * 2); }
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) { ctx.moveTo(x + 1.7 * k, y + 0.6 * k); ctx.arc(x + 0.6 * k, y + 0.6 * k, 1.1 * k, 0, PI * 2); }
    ctx.fill();
  }
  const glowC = new OffscreenCanvas(W, H);
  const gctx = glowC.getContext("2d");
  gctx.fillStyle = "#000";
  gctx.fillRect(0, 0, W, H);
  const markings = (c2: typeof ctx, width: number, alpha: number): void => {
    c2.save();
    c2.strokeStyle = hex(t.line);
    c2.globalAlpha = alpha;
    c2.lineWidth = width * k;
    c2.beginPath(); c2.moveTo(0, H / 2); c2.lineTo(W, H / 2); c2.stroke();
    c2.beginPath(); c2.arc(W / 2, H / 2, 34 * k, 0, PI * 2); c2.stroke();
    c2.strokeRect(78 * k, 0, 100 * k, 26 * k);
    c2.strokeRect(78 * k, H - 26 * k, 100 * k, 26 * k);
    if (detailed) { c2.beginPath(); c2.arc(W / 2, H / 2, 3 * k, 0, PI * 2); c2.stroke(); }
    c2.restore();
  };
  markings(ctx, 2, 0.8);
  if (detailed) markings(gctx, 6, 0.25); // soft halo
  markings(gctx, 2, 0.9);
  const mk = (c: OffscreenCanvas): Texture => {
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  };
  const out = { map: mk(base), glowMap: mk(glowC) };
  // At most two themes' surfaces stay cached (the menu's and the match's).
  if (surfaceCache.size >= 4) {
    const [first] = surfaceCache.keys();
    const old = surfaceCache.get(first!)!;
    old.map.dispose(); old.glowMap.dispose();
    surfaceCache.delete(first!);
  }
  surfaceCache.set(id, out);
  return out;
}

function envMaps(): void {
  const env = scene.environment;
  scene.traverse((o) => {
    const m = (o as Mesh).material;
    for (const x of Array.isArray(m) ? m : m ? [m] : []) if (x instanceof MeshStandardMaterial && x.envMap !== env) x.envMap = env;
  });
}

let envTex: Texture | null = null;
function envTexture(): Texture {
  if (!envTex) envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
  return envTex;
}

// ---------------------------------------------------------------- the arena
interface MatOpts { color?: number | Color; map?: Texture | null; emissive?: number | Color; emissiveMap?: Texture | null; emissiveIntensity?: number; roughness?: number; metalness?: number; envMapIntensity?: number; clearcoat?: number; clearcoatRoughness?: number }

function keep<T extends { dispose(): void }>(x: T): T { made.push(x); return x; }

/** Build/rebuild all theme-dependent meshes. */
export function buildArena(themeId: string, obstacles: readonly Obstacle[] = []): void {
  arenaArgs = [themeId, obstacles.map((o) => ({ x: o.x, y: o.y, r: o.r }))];
  if (!look) return;
  theme = themeById(themeId);
  const t = theme;
  const q = look;
  const detailed = q.detailed;
  if (arena) scene.remove(arena);
  for (const d of made) d.dispose();
  made = [];
  const g = new Group();
  arena = g;
  scene.add(g);
  scene.background = new Color(t.bg);
  scene.fog = new Fog(t.bg, 260, 560);
  moteMat.color.set(t.rail);

  const b = q.budget;
  const lambert = b.material === "lambert";
  const physical = detailed && b.material === "physical";
  const lam = (o: MatOpts): Material => keep(new MeshLambertMaterial({ color: o.color, map: o.map ?? null, emissive: o.emissive ?? 0x000000, emissiveMap: o.emissiveMap ?? null, emissiveIntensity: o.emissiveIntensity ?? 1 }));
  const phys = (color: number, opts: MatOpts = {}): Material => {
    const o: MatOpts = { color, roughness: 0.4, metalness: 0.4, envMapIntensity: 0.5, ...opts };
    if (lambert) return lam(o);
    if (physical) return keep(new MeshPhysicalMaterial(o));
    delete o.clearcoat; delete o.clearcoatRoughness;
    return keep(new MeshStandardMaterial(o));
  };
  const glow = (color: number, intensity = 2.2): Material => lambert
    ? lam({ color: 0x0a0a0a, emissive: color, emissiveIntensity: intensity })
    : keep(new MeshStandardMaterial({ color: 0x0a0a0a, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.2 }));
  const seg = (n: number): number => Math.max(6, Math.round(n * b.segments));
  const geo = <G extends { dispose(): void }>(x: G): G => keep(x);

  // Environment floor: an emissive neon grid on the detailed tier.
  const fm = lambert ? new MeshLambertMaterial({ color: t.floor })
    : new MeshStandardMaterial({ color: t.floor, roughness: 0.85, metalness: 0.15, envMapIntensity: 0.15 });
  keep(fm);
  if (detailed) {
    const gridTex = keep(gridTexture(t.rail));
    gridTex.repeat.set(50, 50);
    fm.emissiveMap = gridTex;
    fm.emissive = new Color(0xffffff);
    fm.emissiveIntensity = 0.1;
  }
  const floor = new Mesh(geo(new PlaneGeometry(1000, 1000)), fm);
  floor.rotation.x = -PI / 2;
  floor.position.y = -6;
  floor.receiveShadow = true;
  g.add(floor);
  floorMat = fm;

  // Neon underglow: the table's light spilling onto the floor.
  const spill = new Mesh(geo(new PlaneGeometry(TABLE_W * 2.6, TABLE_H * 1.8)),
    keep(new MeshBasicMaterial({ map: radialTexture(), color: t.rail, transparent: true, opacity: 0.32, blending: AdditiveBlending, depthWrite: false, fog: false })));
  spill.rotation.x = -PI / 2;
  spill.position.y = -5.9;
  spill.noAO = true;
  g.add(spill);

  // Ring of glowing-capped pillars (detailed tier).
  pillarCaps = [];
  if (detailed) {
    const n = b.pillars;
    const pilGeo = geo(new CylinderGeometry(2.2, 2.8, 60, seg(12)));
    const capGeo = geo(new CylinderGeometry(2.6, 2.6, 2, seg(12)));
    const pilMat = phys(t.table, { roughness: 0.55, metalness: 0.6 });
    for (let i = 0; i < n; i++) {
      const a = (i / n) * PI * 2;
      const p = new Mesh(pilGeo, pilMat);
      p.position.set(Math.cos(a) * 200, 24, Math.sin(a) * 200);
      const cap = new Mesh(capGeo, glow(t.rail, 1.6));
      cap.position.y = 31;
      p.add(cap);
      g.add(p);
      pillarCaps.push(cap);
    }
  }

  // Table body: dark lacquered slab.
  const table = new Mesh(geo(new BoxGeometry(TABLE_W + 12, 6, TABLE_H + 12)),
    phys(t.table, { roughness: 0.35, metalness: 0.6, clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.25 }));
  table.position.y = -3.2;
  table.receiveShadow = true;
  g.add(table);

  // Playing surface: glossy clearcoat with authored markings; the markings
  // also drive a faint emissive map so they read on every tier.
  const { map, glowMap } = surfaceTextures(t, detailed, detailed ? b.surface : 256);
  const surf = new Mesh(geo(new PlaneGeometry(TABLE_W, TABLE_H)), phys(0xffffff, {
    map, emissiveMap: glowMap, emissive: new Color(0xffffff), emissiveIntensity: 0.7,
    roughness: 0.6, metalness: 0.1, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.08,
  }));
  surf.rotation.x = -PI / 2;
  surf.position.y = 0.01;
  surf.receiveShadow = true;
  g.add(surf);

  // Rails: dark metal housing with a luminous core on top (goal-mouth gaps).
  const railH = 3, railT = 2.4;
  const housingMat = phys(0x1a2038, { roughness: 0.3, metalness: 0.8, clearcoat: 0.5, envMapIntensity: 0.4 });
  const coreMat = glow(t.rail, 2.4);
  const mkRail = (w: number, d: number, x: number, z: number): void => {
    const housing = new Mesh(geo(new BoxGeometry(w, railH, d)), housingMat);
    housing.position.set(x, railH / 2 - 0.2, z);
    housing.castShadow = true;
    housing.receiveShadow = true;
    const core = new Mesh(geo(new BoxGeometry(Math.max(w - 0.6, 0.9), 0.7, Math.max(d - 0.6, 0.9))), coreMat);
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
  goalStrips = [];
  for (const [i, sgn] of [[0, -1], [1, 1]] as const) {
    const strip = new Mesh(geo(new BoxGeometry(GOAL_W, 1.2, 2)), glow(i === 0 ? t.goal0 : t.goal1, 2.0));
    strip.position.set(0, 0.4, sgn * (TABLE_H / 2 + railT + 1.2));
    g.add(strip);
    goalStrips.push(strip);
  }

  // Puck: glossy disc with a luminous rim so it always reads against the table.
  const puckMat = phys(t.puck, { emissive: t.puck, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.2, envMapIntensity: 0.3 });
  puckMesh = new Mesh(geo(new CylinderGeometry(PUCK_R, PUCK_R, 1.6, seg(32))), puckMat);
  puckMesh.position.y = 0.8;
  puckMesh.castShadow = true;
  const puckRim = new Mesh(geo(new TorusGeometry(PUCK_R - 0.35, 0.3, seg(8), seg(32))), glow(t.rail, 1.6));
  puckRim.rotation.x = PI / 2;
  puckRim.position.y = 0.82;
  puckMesh.add(puckRim);
  g.add(puckMesh);

  // Puck trail (bounded line, updated in place).
  trailPos = new Float32Array(26 * 3);
  const tGeo = geo(new BufferGeometry());
  tGeo.setAttribute("position", new BufferAttribute(trailPos, 3));
  trail = new Line(tGeo, keep(new LineBasicMaterial({ color: t.rail, transparent: true, opacity: 0.45, blending: AdditiveBlending })));
  trail.frustumCulled = false;
  g.add(trail);

  // Mallets: lacquered body + emissive ring + dark handle with a lit cap.
  malletMeshes = [];
  malletRings = [];
  for (const i of [0, 1]) {
    const color = i === 0 ? t.mallet0 : t.mallet1;
    const grp = new Group();
    const body = new Mesh(geo(new CylinderGeometry(MALLET_R, MALLET_R * 0.85, 2.6, seg(36))),
      phys(color, { roughness: 0.35, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.25, envMapIntensity: 0.25 }));
    body.position.y = 1.3;
    body.castShadow = true;
    const ring = new Mesh(geo(new TorusGeometry(MALLET_R - 0.4, 0.55, seg(12), seg(40))), glow(color, 2.6));
    ring.rotation.x = PI / 2;
    ring.position.y = 0.5;
    const handle = new Mesh(geo(new CylinderGeometry(2.2, 2.6, 3.4, seg(20))),
      phys(0x181c2c, { roughness: 0.35, metalness: 0.7, clearcoat: 0.6 }));
    handle.position.y = 4.2;
    handle.castShadow = true;
    const cap = new Mesh(geo(new CylinderGeometry(1.4, 1.4, 0.3, seg(20))), glow(color, 1.4));
    cap.position.y = 6.0;
    grp.add(body, ring, handle, cap);
    g.add(grp);
    malletMeshes.push(grp);
    malletRings.push(ring);
  }

  // Obstacles.
  for (const o of obstacles) {
    const m = new Mesh(geo(new CylinderGeometry(o.r, o.r * 1.15, 2.8, seg(24))),
      phys(0x1a2038, { roughness: 0.3, metalness: 0.7, clearcoat: 0.6 }));
    const [wx, wz] = toWorld(o.x, o.y);
    m.position.set(wx, 1.4, wz);
    m.castShadow = true;
    const rim = new Mesh(geo(new TorusGeometry(o.r - 0.3, 0.5, seg(8), seg(28))), glow(t.accent, 1.8));
    rim.rotation.x = PI / 2;
    rim.position.y = 1.2;
    m.add(rim);
    g.add(m);
  }

  // Drag target marker: grounded ring, never bloom-only.
  targetMarker = new Mesh(geo(new RingGeometry(2.2, 3.2, 32)),
    keep(new MeshBasicMaterial({ color: t.mallet0, transparent: true, opacity: 0.8, side: DoubleSide })));
  targetMarker.rotation.x = -PI / 2;
  targetMarker.position.y = 0.05;
  targetMarker.visible = false;
  targetMarker.noAO = true;
  g.add(targetMarker);
  applyScene();
}

// ---------------------------------------------------------------- graphics level
/** The look for the frame's graphics level; rebuilds the arena when its assets change. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  renderer.camera = camera;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMappingExposure = 1.0;
  const pb = prev?.budget, b = next.budget;
  const structural = !prev || prev.detailed !== next.detailed || pb!.material !== b.material || pb!.surface !== b.surface || pb!.segments !== b.segments || pb!.pillars !== b.pillars;
  if (structural && arenaArgs) buildArena(...arenaArgs);
  else applyScene();
}

function applyScene(): void {
  const g = look!;
  const shadows = g.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  key.castShadow = shadows;
  if (shadows) key.shadow.mapSize = g.shadows;
  scene.environment = g.reflections ? envTexture() : null;
  envMaps();
  pCap = particleCap(g);
  motes.visible = g.particles === "high";
  moteCount = g.budget.motes;
  moteGeo.setDrawRange(0, moteCount);
  renderer.ao = g.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 6, distanceExponent: 1.5, thickness: 3, scale: 1,
    samples: g.ao === "high" ? 16 : 8, resolution: g.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === "high" ? 6 : 4, rings: 2, samples: g.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only HDR emissives (rails, rings, strips) and hot highlights bloom.
  // three r160 page: minor 29 bloom follows r185 UnrealBloomPass, so the page strength is squared (pages on r177+ keep theirs).
  renderer.bloom = g.bloom ? { strength: ((theme.bloom ?? 0.8) * 0.75) ** 2, radius: 0.5, threshold: 0.9, resolution: g.budget.bloomRes } : null;
  renderer.grade = g.grade ? {
    space: "display", contrast: 0.11, saturation: 1.12,
    shadows: [0.95, 0.98, 1.06], highlights: [1.03, 1.0, 0.97], split: [0.2, 0.8],
    vignette: { amount: 0.28, inner: 0.38, outer: 0.9, scale: [1, 0.9] },
  } : null;
  renderer.antialias = g.antialias;
}

export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on) shake = 0;
}

// ---------------------------------------------------------------- camera
/** Authored transition to the play framing; interruptible, spring-free. */
export function transitionToPlay(seat = 0): void {
  viewSeat = seat;
  camFrom = camera.position.clone();
  camFromQ = camera.quaternion.clone();
  camT = 0;
}
export function setViewSeat(seat: number): void { viewSeat = seat; }

function playCameraPose(): { pos: Vector3; target: Vector3 } {
  // Frame the table from your end; portrait screens pull back/up.
  const portrait = aspect < 1;
  const back = CAMERA.back * (portrait ? 1.55 : 1);
  const height = CAMERA.height * (portrait ? 1.45 : 1);
  const s = viewSeat === 1 ? -1 : 1;
  const pos = new Vector3(0, height, s * (-TABLE_H / 2 - back));
  const target = new Vector3(0, 0, s * (-TABLE_H / 2 + back * 0.62 + CAMERA.lookAhead));
  return { pos, target };
}

// ---------------------------------------------------------------- events
/** Event-tiered feedback. tier: 1 ack, 2 move, 3 goal, 4 round end. */
export function feedback(kind: string, at: { x: number; y: number } | null, tier = 1): void {
  const w = at ? (() => { const [wx, wz] = toWorld(at.x, at.y); return new Vector3(wx, 0, wz); })() : null;
  if (kind === "strike" || kind === "wall" || kind === "obstacle") {
    spawnBurst(w, kind === "strike" ? 10 : 5, kind === "strike" ? 26 : 12);
  } else if (kind === "goal") {
    spawnBurst(w, 60, 60);
    if (!reducedMotion) shake = Math.min(1, shake + 0.5);
  } else if (kind === "terminal") {
    if (w) spawnBurst(w, 120, 80);
    if (!reducedMotion) shake = Math.min(1, shake + 0.8);
  }
  if (tier >= 3 && !reducedMotion) shake = Math.min(1, shake + 0.1);
}

function spawnBurst(pos: Vector3 | null, count: number, speed: number): void {
  if (!pos) return;
  const n = Math.min(count, pCap);
  const c = new Color(theme.rail);
  for (let k = 0; k < n; k++) {
    const i = pCount < pCap ? pCount++ : (Math.random() * pCap) | 0;
    const a = Math.random() * PI * 2;
    const up = Math.random() * 0.7 + 0.3;
    const s = speed * (0.4 + Math.random() * 0.6);
    pPos[i * 3] = pos.x; pPos[i * 3 + 1] = pos.y + 1; pPos[i * 3 + 2] = pos.z;
    pVel[i * 3] = Math.cos(a) * s * (1 - up * 0.5);
    pVel[i * 3 + 1] = up * s;
    pVel[i * 3 + 2] = Math.sin(a) * s * (1 - up * 0.5);
    pLife[i] = 0.5 + Math.random() * 0.5;
    // Hot core: particles start brighter than the rail colour (HDR) so they bloom.
    pCol[i * 3] = c.r * 1.6; pCol[i * 3 + 1] = c.g * 1.6; pCol[i * 3 + 2] = c.b * 1.6;
  }
  pGeo.getAttribute("color")!.needsUpdate = true;
}

function updateParticles(dt: number): void {
  let alive = 0;
  for (let i = 0; i < pCount; i++) {
    if (pLife[i]! <= 0) continue;
    pLife[i] = pLife[i]! - dt;
    if (pLife[i]! <= 0) { pPos[i * 3 + 1] = -999; continue; }
    alive++;
    pVel[i * 3 + 1] = pVel[i * 3 + 1]! - 60 * dt; // gravity
    pPos[i * 3] = pPos[i * 3]! + pVel[i * 3]! * dt;
    pPos[i * 3 + 1] = pPos[i * 3 + 1]! + pVel[i * 3 + 1]! * dt;
    pPos[i * 3 + 2] = pPos[i * 3 + 2]! + pVel[i * 3 + 2]! * dt;
    if (pPos[i * 3 + 1]! < 0.2) { pPos[i * 3 + 1] = 0.2; pVel[i * 3 + 1] = pVel[i * 3 + 1]! * -0.4; }
  }
  if (alive || points.visible) pGeo.getAttribute("position")!.needsUpdate = true;
  if (!alive) pCount = 0;
  points.visible = alive > 0;
}

// ---------------------------------------------------------------- picking
const raycaster = new Raycaster();
const tablePlane = new Plane(new Vector3(0, 1, 0), 0);
const hitV = new Vector3();
const ndc = new Vector2();
/** The table point under a window pixel, in table units (null off the plane). */
export function pick(px: number, py: number): { x: number; y: number } | null {
  pointerToNdc(px, py, ndc);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.ray.intersectPlane(tablePlane, hitV);
  if (!hit) return null;
  const [x, y] = fromWorld(hit.x, hit.z);
  return { x, y };
}

export function showTargetMarker(x: number, y: number, visible = true): void {
  if (!targetMarker) return;
  const [wx, wz] = toWorld(x, y);
  targetMarker.position.set(wx, 0.05, wz);
  targetMarker.visible = visible;
}

// ---------------------------------------------------------------- frame
const _m = new Matrix4();
const UP = new Vector3(0, 1, 0);
/**
 * Render one frame. prev/cur: position snapshots; alpha in [0,1). cur === null
 * renders the menu attract view (slow orbit, pieces at rest). phase: the rules
 * phase for phase-dependent presentation. width/height: the window, for the aspect.
 */
export function render(dtRaw: number, prev: Pose | null, cur: Pose | null, alpha: number, phase: string | null, width: number, height: number): void {
  if (!look || !arena) return;
  const dt = Math.min(0.1, dtRaw);
  const animated = look.animated && !reducedMotion;
  if (animated) time += dt;
  wall += dt;
  const a2 = Math.max(1, width) / Math.max(1, height);
  if (a2 !== aspect) { aspect = a2; camera.aspect = aspect; camera.updateProjectionMatrix(); }

  if (!cur) {
    // Menu attract view: a slow orbit (static under reduced motion).
    if (!reducedMotion) orbit += dt * CAMERA.orbitSpeed;
    const a = orbit - PI / 2;
    camera.position.set(Math.cos(a) * CAMERA.orbitRadius, CAMERA.orbitHeight, Math.sin(a) * CAMERA.orbitRadius);
    camera.lookAt(0, 0, 0);
    cur = prev = IDLE_POSE;
    alpha = 1;
  } else if (camT < 1 && camFrom && camFromQ) {
    camT = Math.min(1, camT + dt / (reducedMotion ? 0.01 : CAMERA.transitionTime));
    const e = 1 - Math.pow(1 - camT, 3);
    const { pos, target } = playCameraPose();
    camera.position.copy(camFrom).lerp(pos, e);
    _m.lookAt(camera.position, target, UP);
    const q = new Quaternion().setFromRotationMatrix(_m);
    camera.quaternion.copy(camFromQ).slerp(q, e);
    if (camT >= 1) camFrom = null;
  } else {
    const { pos, target } = playCameraPose();
    camera.position.copy(pos);
    camera.lookAt(target);
  }

  // Tiered, reduced-motion-aware shake.
  if (shake > 0.001) {
    const s = shake * 0.9;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s * 0.6;
    shake *= Math.pow(0.001, dt);
  } else shake = 0;

  const lerp = (a: number, b: number): number => a + (b - a) * alpha;
  const px = lerp(prev?.puck.x ?? cur.puck.x, cur.puck.x);
  const py = lerp(prev?.puck.y ?? cur.puck.y, cur.puck.y);
  const [wx, wz] = toWorld(px, py);
  puckMesh!.position.set(wx, 0.8, wz);
  for (const i of [0, 1]) {
    const mx = lerp(prev?.mallets[i]!.x ?? cur.mallets[i]!.x, cur.mallets[i]!.x);
    const my = lerp(prev?.mallets[i]!.y ?? cur.mallets[i]!.y, cur.mallets[i]!.y);
    const [mwx, mwz] = toWorld(mx, my);
    malletMeshes[i]!.position.set(mwx, 0, mwz);
  }
  // trail
  for (let i = 25; i > 0; i--) { trailPos[i * 3] = trailPos[(i - 1) * 3]!; trailPos[i * 3 + 1] = trailPos[(i - 1) * 3 + 1]!; trailPos[i * 3 + 2] = trailPos[(i - 1) * 3 + 2]!; }
  trailPos[0] = wx; trailPos[1] = 0.8; trailPos[2] = wz;
  trail!.geometry.getAttribute("position")!.needsUpdate = true;

  // Goal strips pulse while play is live; your ring breathes to show ownership.
  const clock = wall * 1000;
  const live = phase === PHASE.ACTIVE;
  goalStrips.forEach((strip, i) => {
    (strip.material as MeshStandardMaterial).emissiveIntensity = live ? 2.0 + Math.sin(clock / 300 + i * 2) * 0.5 : 1.2;
  });
  const mine = malletRings[viewSeat];
  if (mine) (mine.material as MeshStandardMaterial).emissiveIntensity = 2.2 + Math.sin(clock / 240) * 0.6;

  // Ambient arena motion (frozen under reduced motion or a static background).
  if (motes.visible && animated) updateMotes(time);
  pillarCaps.forEach((cap, i) => { (cap.material as MeshStandardMaterial).emissiveIntensity = animated ? 1.4 + Math.sin(time * 1.3 + i * 0.7) * 0.5 : 1.6; });
  if (floorMat && floorMat.emissiveMap) floorMat.emissiveIntensity = animated ? 0.09 + Math.sin(time * 0.8) * 0.025 : 0.1;

  updateParticles(dt);
}
