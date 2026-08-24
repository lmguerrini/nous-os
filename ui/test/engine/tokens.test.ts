import assert from "node:assert/strict";
import test from "node:test";
import {
  PALETTES,
  TEMPERATURES,
  THEMES,
  TOKEN_RAMPS,
  contrastRatio,
  relativeLuminance,
  resolveTokens,
} from "#engine/tokens.ts";

test("every palette, temperature, and theme resolves every token", () => {
  let combinations = 0;
  let tokenCount = 0;
  for (const palette of PALETTES) {
    for (const temperature of TEMPERATURES) {
      for (const theme of THEMES) {
        combinations += 1;
        const tokens = resolveTokens(palette, temperature, theme);
        const names = Object.keys(tokens);
        assert.ok(names.length > 0);
        tokenCount += names.length;
        assert.ok(names.every((name) => tokens[name] !== undefined));
      }
    }
  }
  assert.equal(combinations, 45);
  assert.ok(tokenCount > combinations);
});

test("lightness ordering is preserved within every ramp", () => {
  let checkedRamps = 0;
  for (const palette of PALETTES) {
    for (const temperature of TEMPERATURES) {
      for (const theme of THEMES) {
        const tokens = resolveTokens(palette, temperature, theme);
        for (const names of Object.values(TOKEN_RAMPS)) {
          checkedRamps += 1;
          const lightness = names.map((name) => tokens[name]!.lightnessPermille);
          assert.equal(lightness.length, 6);
          assert.ok(lightness.every((value, index) => index === 0 || value > lightness[index - 1]!));
        }
      }
    }
  }
  assert.equal(checkedRamps, 90);
});

test("peak light remains neutral for every resolved combination", () => {
  let checkedPeaks = 0;
  for (const palette of PALETTES) {
    for (const temperature of TEMPERATURES) {
      for (const theme of THEMES) {
        checkedPeaks += 1;
        assert.ok(resolveTokens(palette, temperature, theme).peak!.chromaPermille < 25);
      }
    }
  }
  assert.equal(checkedPeaks, 45);
});

test("contrast is symmetric and identical tokens have ratio one", () => {
  const tokens = resolveTokens("interstellar", "balanced", "dark");
  const left = tokens.accent2!;
  const right = tokens.text!;
  assert.equal(contrastRatio(left, left), 1);
  assert.equal(contrastRatio(left, right), contrastRatio(right, left));
  assert.ok(relativeLuminance(tokens.peak!) >= 0);
});
