import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, detectPreset, resolve, presetTier, withPreset, describe, shortGpu,
  LEVELS, BUDGETS, MAX_MOTES, MAX_PARTICLES, budget, particleBudget, detectLevel, presetForLevel,
} from '../js/gfx.js';
// js/gpu-level.js is a classic script in the page; imported here it sets globalThis.StarHermitGpu.
await import('../js/gpu-level.js');
import { GFX_STRINGS, pickLocale } from '../js/gfx-strings.js';

test('hardware level picks the Auto preset (StarHermit gpu-level.js)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)'), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)'), 'ultra');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'ultra');
  assert.equal(detectLevel('NVIDIA GeForce RTX 5090'), 20);
  assert.equal(detectLevel('SwiftShader'), 0);
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(9), 'balanced');
  assert.equal(presetForLevel(16), 'high');
  // Phones and tablets are Balanced at most.
  assert.ok(['low', 'balanced'].includes(detectPreset('Adreno (TM) 740', { mobile: true })));
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'surface', 'segments', 'pillars', 'motes', 'sparks', 'hudBlur', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(k in BUDGETS[p], `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) {
    const a = BUDGETS[PRESETS[i - 1]], b = BUDGETS[PRESETS[i]];
    for (const k of ['surface', 'segments', 'pillars', 'motes', 'sparks', 'bloomRes', 'aoRes']) assert.ok(b[k] >= a[k], `${PRESETS[i]}.${k}`);
  }
  assert.equal(BUDGETS.low.material, 'lambert');
  assert.equal(BUDGETS.balanced.hudBlur, false);
  assert.equal(BUDGETS.high.hudBlur, true);
  assert.deepEqual(budget('high', 10), BUDGETS.high);
  assert.ok(budget('high', 14).motes > BUDGETS.high.motes);
  assert.ok(budget('ultra', 20).motes <= Math.min(MAX_MOTES, BUDGETS.ultra.motes * 2));
  assert.ok(budget('ultra', 2).sparks < BUDGETS.ultra.sparks);
  assert.ok(particleBudget('high', budget('ultra', 20)) <= MAX_PARTICLES);
  assert.equal(particleBudget('low', BUDGETS.low), 150);
  assert.deepEqual(resolve({ preset: 'low' }, 'low', 0).budget, BUDGETS.low);
  assert.equal(resolve({}, 'ultra', 20).level, 20);
});

test('resolve: auto follows the detected preset', () => {
  const r = resolve({ preset: 'auto' }, 'low');
  assert.equal(r.preset, 'low');
  assert.equal(r.auto, true);
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, false, 'Low renders without a post chain');
  assert.equal(resolve(undefined, undefined).preset, 'balanced');
});

test('resolve: explicit preset, overrides and invalid values', () => {
  const r = resolve({ preset: 'high', bloom: 'off', shadows: 'nonsense' }, 'low');
  assert.equal(r.preset, 'high');
  assert.equal(r.auto, false);
  assert.equal(r.bloom, 'off');
  assert.equal(r.shadows, presetTier('high', 'shadows'));
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    for (const p of PRESETS) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
  assert.equal(resolve({ preset: 'low', grade: 'on' }).post, true);
});

test('resolve: render scale is clamped to 50–200% of the preset scale', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).scale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({ preset: 'low' }).dprCap, 1);
  assert.equal(resolve({ preset: 'high', adaptive: false, show_fps: true }).adaptive, false);
  assert.equal(resolve({ preset: 'high', show_fps: true }).showFps, true);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
  const next = withPreset({ preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'low');
  assert.deepEqual(next, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.equal(withPreset({}, 'bogus').preset, 'auto');
});

test('describe and shortGpu', () => {
  const d = describe(resolve({ preset: 'high' }), [1280, 800]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows/);
  assert.equal(shortGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'NVIDIA GeForce RTX 3070');
});

test('graphics strings exist for every locale and key', () => {
  const locales = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const en = GFX_STRINGS['en-GB'];
  for (const loc of locales) {
    const L = GFX_STRINGS[loc];
    assert.ok(L, loc);
    for (const k of Object.keys(en)) assert.ok(L[k], `${loc}.${k}`);
    for (const p of PRESETS) assert.ok(L.presets[p], `${loc}.presets.${p}`);
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      assert.ok(L.cats[cat], `${loc}.cats.${cat}`);
      for (const t of tiers) assert.ok(L.tiers[t], `${loc}.tiers.${t}`);
    }
    assert.match(L.auto, /\{tier\}/);
    assert.match(L.fromPreset, /\{tier\}/);
  }
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('es-ES'), 'es-ES');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('en-AU'), 'en-GB');
  assert.equal(pickLocale('pt'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
});
