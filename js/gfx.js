// Graphics quality model: presets, per-category overrides, hardware-level detection,
// per-preset budgets and a cost summary. Pure (no three.js) so the settings panel, the renderer and the
// unit tests agree on what every setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category -> allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],       // image-based lighting on puck, mallets, table
  particles: ['low', 'high'],       // burst budget + ambient motes
  background: ['static', 'animated'], // drifting motes, pillar shimmer, floor-grid pulse
  detail: ['plain', 'detailed'],    // pillar ring, floor grid, surface texture resolution
};

// Each preset is a row of tiers, a render scale (multiplies the capped device
// pixel ratio) and a device-pixel-ratio cap.
const TABLE = {
  low: { scale: 0.85, dpr: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low', background: 'static', detail: 'plain' },
  balanced: { scale: 1, dpr: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  high: { scale: 1, dpr: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, dpr: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_BUDGET = { low: 300, high: 2000 };

export const DEFAULT_GRAPHICS = { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false };

// StarHermit hardware level (0–20, js/gpu-level.js → window.StarHermitGpu) at which Auto starts
// choosing each preset. 0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX 5090; phones, tablets and
// ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0 (Low).
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

/*
 * Per-preset asset and effect budgets, each tuned to hold 60 FPS on the weakest GPU Auto gives the
 * preset (Low: level 0 phones / Intel UHD; Balanced: level 4 Iris Xe; High: level 10 GTX 1070;
 * Ultra: level 17 RTX 4080; measured with tests/gfx-bench.mjs). Gameplay is identical on every preset.
 *   material  floor, table, rails, puck, mallets: 'lambert' (Low) | 'standard'; clearcoated
 *             MeshPhysicalMaterial only where this is 'physical' (with Detail: detailed)
 *   surface   playing-surface texture width in px with Detail: detailed (plain is 256)
 *   segments  round-geometry LOD: multiplies the radial segments of puck, mallets, rings, obstacles, pillars
 *   pillars   glowing-capped pillars around the arena (Detail: detailed)
 *   motes     ambient light motes (Particles: high), scaled by the hardware level within the preset (≤ 2×)
 *   sparks    multiplies the Particles tier burst budget (low 300 / high 2000), level-scaled (≤ 2×)
 *   hudBlur   backdrop blur behind menu screens (re-composited every frame over the live 3D view);
 *             off below High, where they use a more opaque backing
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', surface: 256, segments: 0.5, pillars: 8, motes: 60, sparks: 0.5, hudBlur: false, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', surface: 512, segments: 0.75, pillars: 12, motes: 120, sparks: 0.75, hudBlur: false, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', surface: 512, segments: 1, pillars: 16, motes: 180, sparks: 1, hudBlur: true, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', surface: 1024, segments: 1.5, pillars: 24, motes: 300, sparks: 1.5, hudBlur: true, bloomRes: 1, aoRes: 1 },
};
export const MAX_MOTES = 600;
export const MAX_PARTICLES = 6000;

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  if (!G) return LEVELS.balanced;
  return G.detectLevel({ webgl: true, webgl2: true, ...system, gpu: String(gpu || '') });
}

/** Auto preset for a hardware level: Low 0, Balanced 4, High 10, Ultra 17. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, LEVELS);
  return PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU; phones and tablets are capped at Balanced by the hardware level. */
export function detectPreset(gpu, system = {}) {
  return presetForLevel(detectLevel(gpu, system));
}

/** A preset's concrete budget for a hardware level (motes and sparks scale within the preset, ≤ 2×). */
export function budget(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] ?? 0;
  const k = G ? Math.min(2, G.scaleBudget(1, Number.isFinite(level) ? level : floor, floor)) : 1;
  b.motes = Math.min(MAX_MOTES, Math.round(b.motes * k));
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return b;
}

/** Burst particle budget for a Particles tier under a preset budget. */
export function particleBudget(tier, b) {
  return Math.min(MAX_PARTICLES, Math.round((PARTICLE_BUDGET[tier] || PARTICLE_BUDGET.low) * (b ? b.sparks : 1)));
}

/**
 * Resolve saved settings into concrete tiers.
 * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: tier }.
 * A category key missing or holding an unknown value follows the preset.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset, auto,
    scale: row.scale * clamp(Number(s.render_scale) || 1, 0.5, 2),
    dprCap: row.dpr,
  };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budget(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every per-category override. */
export function withPreset(saved, preset) {
  const out = { preset: preset === 'auto' || PRESETS.includes(preset) ? preset : 'auto' };
  for (const k of ['render_scale', 'adaptive', 'show_fps']) if (saved && k in saved) out[k] = saved[k];
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Short cost summary, e.g. "2048² shadows · AO · bloom · SMAA · 1280×800 px". */
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full AO' : 'AO',
    r.bloom === 'on' ? 'bloom' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no AA' : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Readable GPU name from an unmasked renderer string (drops ANGLE wrapping and hex ids). */
export function shortGpu(gpu) {
  let g = String(gpu || '').trim();
  const m = /^ANGLE \((.*)\)$/.exec(g);
  if (m) {
    const parts = m[1].split(', ');
    g = parts.length >= 2 ? parts[1] : parts[0];
  }
  return g.replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\s+(Direct3D|vs_|ps_)\S*/g, '').replace(/\s+/g, ' ').trim();
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
