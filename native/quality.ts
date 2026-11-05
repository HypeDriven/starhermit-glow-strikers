// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, the surface texture, round-geometry LOD, the
// pillar ring, motes, sparks, reflections, motion, detail) is the browser
// build's four presets and budgets (js/gfx.js TABLE / BUDGETS) keyed by the
// level's quality tier, with the ambient motes and the spark budget scaled
// within the tier by the level's particle budget against the tier's anchor
// level (quantum, molecular, terrestrial, galactic), at most twice the
// tier's. The runtime owns the rest of the old Graphics panel: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution
// and the frame-rate limit and readout. The per-category overrides of the
// old panel are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Floor, table, rails, puck, mallets: Lambert on Low, Standard above, clearcoat Physical where "physical". */
  material: "lambert" | "standard" | "physical";
  /** Playing-surface texture width in px (detailed), within the level's largest texture. */
  surface: number;
  /** Multiplies the radial segments of round geometry. */
  segments: number;
  /** Glowing-capped pillars around the arena (detailed). */
  pillars: number;
  /** Ambient light motes (particles high). */
  motes: number;
  /** Multiplies the burst particle budget. */
  sparks: number;
}
export interface Look {
  preset: Preset;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  particles: "low" | "high";
  /** Drifting motes, pillar shimmer, floor-grid pulse. */
  animated: boolean;
  /** Pillar ring, floor grid, surface grain and air holes. */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "particles" | "animated" | "detailed">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { reflections: true, particles: "high", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", surface: 256, segments: 0.5, pillars: 8, motes: 60, sparks: 0.5 },
  balanced: { material: "standard", surface: 512, segments: 0.75, pillars: 12, motes: 120, sparks: 0.75 },
  high: { material: "physical", surface: 512, segments: 1, pillars: 16, motes: 180, sparks: 1 },
  ultra: { material: "physical", surface: 1024, segments: 1.5, pillars: 24, motes: 300, sparks: 1.5 },
};
export const MAX_MOTES = 600;
/** Burst budget per particles tier (js/gfx.js PARTICLE_BUDGET); the pool is one InstancedMesh. */
const PARTICLE_BUDGET = { low: 300, high: 2000 };
export const MAX_PARTICLES = 1200;
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // Motes and sparks grow with the level's particle budget above the tier's anchor, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.surface = Math.min(b.surface, s.maxTextureSize);
  b.motes = Math.min(MAX_MOTES, Math.round(b.motes * k));
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}

/** Live burst particle cap for a look. */
export function particleCap(look: Look): number {
  return Math.min(MAX_PARTICLES, Math.round(PARTICLE_BUDGET[look.particles] * look.budget.sparks));
}
