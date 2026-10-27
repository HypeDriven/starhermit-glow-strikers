// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the ambient motes and the spark budget scaled within the tier by the level
// (frame().levelIndex, at most twice the tier's), as the browser build scaled
// them by its hardware level. The runtime owns the rest of the old Graphics
// panel: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout, and the shadow-map
// size and MSAA samples it holds to the level. The per-category overrides of
// the old panel are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Floor, table, rails, puck, mallets: Lambert on Low, Standard above, clearcoat Physical where "physical". */
  material: "lambert" | "standard" | "physical";
  /** Playing-surface texture width in px (detailed). */
  surface: number;
  /** Multiplies the radial segments of round geometry. */
  segments: number;
  /** Glowing-capped pillars around the arena (detailed). */
  pillars: number;
  /** Ambient light motes (particles high). */
  motes: number;
  /** Multiplies the burst particle budget. */
  sparks: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "high", animated: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", surface: 256, segments: 0.5, pillars: 8, motes: 60, sparks: 0.5, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", surface: 512, segments: 0.75, pillars: 12, motes: 120, sparks: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", surface: 512, segments: 1, pillars: 16, motes: 180, sparks: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", surface: 1024, segments: 1.5, pillars: 24, motes: 300, sparks: 1.5, bloomRes: 1, aoRes: 1 },
};
export const MAX_MOTES = 600;
/** Burst budget per particles tier (js/gfx.js PARTICLE_BUDGET); the pool is one InstancedMesh. */
const PARTICLE_BUDGET = { low: 300, high: 2000 };
export const MAX_PARTICLES = 1200;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.motes = Math.min(MAX_MOTES, Math.round(b.motes * k));
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return { preset, ...TABLE[preset], budget: b };
}

/** Live burst particle cap for a look. */
export function particleCap(look: Look): number {
  return Math.min(MAX_PARTICLES, Math.round(PARTICLE_BUDGET[look.particles] * look.budget.sparks));
}
