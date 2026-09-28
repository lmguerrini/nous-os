import test from "node:test";
import assert from "node:assert/strict";
import { HARMONY_NAMES, adjustLightness, contrastRatio, harmonyHues, harmonize, oklchRoundTrip, oklchToSrgb, srgbToOklch } from "../../src/review/color-harmony.ts";
import { PALETTES, PALETTE_ROLES, contrast } from "../../src/review/palette.ts";

const roundTrips: Readonly<string[]> = ["#050505", "#ffffff", "#ffd38b", "#f4b48e", "#00ff88", "#b4e8db", "#140a06", "#7d57ff"];

test("OKLCH conversion round-trips within one LSB per channel", () => {
  for (const hex of roundTrips) {
    const back = oklchRoundTrip(hex);
    const [r1, g1, b1] = hexRgb(hex);
    const [r2, g2, b2] = hexRgb(back);
    for (const [a, b] of [[r1, r2], [g1, g2], [b1, b2]] as const)
      assert.ok(Math.abs(a! - b!) < 2 / 255, `${hex} -> ${back}`);
  }
});

test("OKLCH components are finite and hue is in [0,360)", () => {
  for (const hex of roundTrips) {
    const { L, C, H } = srgbToOklch(hex);
    assert.ok(Number.isFinite(L) && Number.isFinite(C) && Number.isFinite(H), hex);
    assert.ok(L >= 0 && L <= 1, `L ${hex}`);
    assert.ok(C >= 0, `C ${hex}`);
    assert.ok(H >= 0 && H < 360, `H ${hex}`);
  }
});

/** Smallest signed circular difference in (-180, 180]. */
const signedDiff = (actual: number, base: number) => ((actual - base + 540) % 360) - 180;

/** The canonical colour-theory definition of each harmony, as the sorted circular gaps between its hues. */
const GAPS: Readonly<Record<string, readonly number[]>> = {
  monochromatic: [0],
  analogous: [30, 30, 300],
  complementary: [180, 180],
  "split-complementary": [150, 60, 150],
  triadic: [120, 120, 120],
};

test("each harmony produces hue relations within ±3° of the definition", () => {
  for (const base of [0, 37, 79.173, 180, 273.5, 359]) {
    for (const name of HARMONY_NAMES) {
      const hues = harmonyHues(name, base).sort((a, b) => a - b);
      const gaps = hues.map((hue, i) => ((hues[(i + 1) % hues.length]! - hue) % 360 + 360) % 360).sort((a, b) => a - b);
      const expected = [...GAPS[name]!].sort((a, b) => a - b);
      assert.equal(gaps.length, expected.length, `${name} hue count @${base}`);
      for (let i = 0; i < expected.length; i++)
        assert.ok(Math.abs(gaps[i]! - expected[i]!) <= 3, `${name}@${base}: gaps ${gaps.join(",")} vs ${expected.join(",")}`);
    }
  }
});

test("contrast thresholds are met for every suggested harmony set", () => {
  for (const reference of ["#ffd38b", "#f0a06a", "#b4e8db", "#d2ddff", "#ff5a5a"]) {
    for (const background of ["#050505", "#120b05", "#140a06", "#140c13"]) {
      for (const name of HARMONY_NAMES) {
        const set = harmonize(reference, background, name);
        for (const role of PALETTE_ROLES) {
          if (role === "background") continue;
          const target = role === "text" ? 4.5 : 3;
          assert.ok(contrast(set[role], set.background) >= target, `${name}/${reference}/${background}.${role}`);
        }
      }
    }
  }
});

test("contrast thresholds hold for every preset, including the harmony-derived ones", () => {
  assert.ok(PALETTES.brace);
  assert.ok(PALETTES.miele);
  for (const [name, palette] of Object.entries(PALETTES)) {
    assert.deepEqual(Object.keys(palette).sort(), [...PALETTE_ROLES].sort(), name);
    for (const role of PALETTE_ROLES) {
      if (role === "background") continue;
      const target = role === "text" ? 4.5 : 3;
      assert.ok(contrast(palette[role], palette.background) >= target, `${name}.${role}`);
    }
  }
});

test("the new warm palettes are warm and harmonically coherent", () => {
  for (const name of ["brace", "miele"] as const) {
    const palette = PALETTES[name];
    const { H } = srgbToOklch(palette.aggregate);
    // Warm hues live between orange and yellow (roughly 45°–95°).
    assert.ok(H >= 40 && H <= 100, `${name} aggregate hue ${H}`);
    for (const role of ["aggregate", "concept", "exploratory", "container"] as const) {
      const diff = Math.abs(signedDiff(srgbToOklch(palette[role]).H, H));
      assert.ok(diff <= 40, `${name}.${role} stays within an analogous band of the base (${diff}°)`);
    }
  }
});

test("adjustLightness never darkens an already-sufficient colour", () => {
  const bright = oklchToSrgb({ L: 0.8, C: 0.1, H: 79 });
  assert.ok(contrastRatio(bright, "#120b05") >= 3);
  assert.equal(adjustLightness({ L: 0.8, C: 0.1, H: 79 }, "#120b05", 3), bright);
});

test("the warm preset families keep their warm character", () => {
  const warmPresets = ["warm", "earth", "amber", "old-gold", "ochre", "copper", "alchemical-red", "warm-twilight", "sepia", "brace", "miele"] as const;
  const warmHue = (hue: number) => (hue >= 0 && hue <= 110) || hue >= 340;
  for (const name of warmPresets) {
    const palette = PALETTES[name];
    for (const role of ["aggregate", "concept", "exploratory"] as const) {
      const hue = srgbToOklch(palette[role]).H;
      assert.ok(warmHue(hue), `${name}.${role} hue ${hue.toFixed(1)} is not warm`);
    }
  }
});

function hexRgb(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new TypeError("Invalid colour");
  const hex = match[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}
