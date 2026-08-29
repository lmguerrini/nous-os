import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_PALETTES,
  CATEGORICAL_MINIMUM_PAIRWISE_CONTRAST,
  EXPERIMENTAL_PALETTES,
  HUE_ANCHOR_DEGREES_COUNT,
  PALETTES,
  TEMPERATURES,
  THEMES,
  TOKEN_RAMPS,
  WCAG_AA_NON_TEXT_CONTRAST,
  WCAG_AA_TEXT_CONTRAST,
  contrastRatio,
  isHueAnchorDegrees,
  relativeLuminance,
  resolveTokens,
  simulatedContrastRatio,
} from "#engine/tokens.ts";
import type { OklchToken } from "#engine/tokens.ts";

/** This is a representative, deterministic hue-anchor sweep and does not claim to be exhaustive over all 360 degrees. */
const HUE_ANCHOR_SWEEP = Array.from({ length: 24 }, (_value, index) => index * 15);

const DICHROMACY_SIMULATIONS = ["protanopia", "deuteranopia"] as const;

function requiredToken(tokens: Readonly<Record<string, OklchToken>>, name: string): OklchToken {
  const token = tokens[name];
  if (token === undefined) {
    throw new TypeError(`fixture token is unavailable: ${name}`);
  }
  return token;
}

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

test("PALETTES is unchanged by this capability: five members, and ALL_PALETTES adds the two experimental modes alongside it", () => {
  assert.deepEqual(PALETTES, ["monochrome", "interstellar", "perceptual", "solar", "custom"]);
  assert.deepEqual(EXPERIMENTAL_PALETTES, ["accent-hue", "categorical"]);
  assert.deepEqual(ALL_PALETTES, [...PALETTES, ...EXPERIMENTAL_PALETTES]);
});

test("monochrome and every other shipping palette resolve exactly the tokens they resolved before this capability existed", () => {
  // This is a pinned byte-for-byte snapshot, not a re-derivation: if a future change to makeBase,
  // applyTemperature, or applyTheme ever moves monochrome's pixels, this fails loudly instead of
  // silently drifting alongside whatever produced the new numbers.
  const monochromeDarkBalanced = resolveTokens("monochrome", "balanced", "dark");
  assert.deepEqual(requiredToken(monochromeDarkBalanced, "background"), { lightnessPermille: 62, chromaPermille: 0, hueDegrees: 0 });
  assert.deepEqual(requiredToken(monochromeDarkBalanced, "text"), { lightnessPermille: 768, chromaPermille: 20, hueDegrees: 0 });
  assert.deepEqual(requiredToken(monochromeDarkBalanced, "edge"), { lightnessPermille: 642, chromaPermille: 20, hueDegrees: 0 });
  assert.deepEqual(requiredToken(monochromeDarkBalanced, "accent2"), { lightnessPermille: 444, chromaPermille: 20, hueDegrees: 0 });
  assert.deepEqual(requiredToken(monochromeDarkBalanced, "peak"), { lightnessPermille: 930, chromaPermille: 0, hueDegrees: 0 });
  const monochromeLightWarm = resolveTokens("monochrome", "warm", "light");
  assert.deepEqual(requiredToken(monochromeLightWarm, "background"), { lightnessPermille: 130, chromaPermille: 0, hueDegrees: 18 });
  assert.deepEqual(requiredToken(monochromeLightWarm, "text"), { lightnessPermille: 797, chromaPermille: 19, hueDegrees: 18 });
});

test("accent-hue requires an integer hue anchor in its closed domain and rejects everything else", () => {
  assert.throws(() => resolveTokens("accent-hue", "balanced", "dark"), /accent-hue palette requires an integer hue anchor/);
  assert.throws(() => resolveTokens("accent-hue", "balanced", "dark", 360), /accent-hue palette requires an integer hue anchor/);
  assert.throws(() => resolveTokens("accent-hue", "balanced", "dark", -1), /accent-hue palette requires an integer hue anchor/);
  assert.throws(() => resolveTokens("accent-hue", "balanced", "dark", 180.5), /accent-hue palette requires an integer hue anchor/);
  assert.equal(isHueAnchorDegrees(0), true);
  assert.equal(isHueAnchorDegrees(HUE_ANCHOR_DEGREES_COUNT - 1), true);
  assert.equal(isHueAnchorDegrees(HUE_ANCHOR_DEGREES_COUNT), false);
  assert.doesNotThrow(() => resolveTokens("accent-hue", "balanced", "dark", 0));
});

test("accent-hue derivation is deterministic: the same anchor produces byte-identical tokens on every call", () => {
  for (const anchor of HUE_ANCHOR_SWEEP) {
    const first = resolveTokens("accent-hue", "balanced", "dark", anchor);
    const second = resolveTokens("accent-hue", "balanced", "dark", anchor);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  }
});

test("accent-hue moves the accent ramp's hue with the anchor while categorical never reads an anchor at all", () => {
  const anchorA = resolveTokens("accent-hue", "balanced", "dark", 20);
  const anchorB = resolveTokens("accent-hue", "balanced", "dark", 200);
  assert.notEqual(requiredToken(anchorA, "accent2").hueDegrees, requiredToken(anchorB, "accent2").hueDegrees);
  assert.equal(requiredToken(anchorA, "accent2").lightnessPermille, requiredToken(anchorB, "accent2").lightnessPermille);
  // categorical takes no anchor argument at all; passing one through the same call shape is inert.
  const categorical = resolveTokens("categorical", "balanced", "dark");
  assert.deepEqual(categorical, resolveTokens("categorical", "balanced", "dark"));
});

test("every experimental palette resolves the same complete token vocabulary as monochrome, for every temperature and theme", () => {
  const expectedNames = Object.keys(resolveTokens("monochrome", "balanced", "dark")).sort();
  let checked = 0;
  for (const temperature of TEMPERATURES) {
    for (const theme of THEMES) {
      checked += 1;
      const accentHue = resolveTokens("accent-hue", temperature, theme, 140);
      const categorical = resolveTokens("categorical", temperature, theme);
      assert.deepEqual(Object.keys(accentHue).sort(), expectedNames);
      assert.deepEqual(Object.keys(categorical).sort(), expectedNames);
    }
  }
  assert.equal(checked, TEMPERATURES.length * THEMES.length);
});

test("lightness ordering is preserved within every ramp for both experimental palettes, across the anchor sweep", () => {
  let checkedRamps = 0;
  for (const temperature of TEMPERATURES) {
    for (const theme of THEMES) {
      const categorical = resolveTokens("categorical", temperature, theme);
      for (const names of Object.values(TOKEN_RAMPS)) {
        checkedRamps += 1;
        const lightness = names.map((name) => requiredToken(categorical, name).lightnessPermille);
        assert.ok(lightness.every((value, index) => index === 0 || value > lightness[index - 1]!));
      }
      for (const anchor of HUE_ANCHOR_SWEEP) {
        const accentHue = resolveTokens("accent-hue", temperature, theme, anchor);
        for (const names of Object.values(TOKEN_RAMPS)) {
          checkedRamps += 1;
          const lightness = names.map((name) => requiredToken(accentHue, name).lightnessPermille);
          assert.ok(lightness.every((value, index) => index === 0 || value > lightness[index - 1]!));
        }
      }
    }
  }
  assert.ok(checkedRamps > 0);
});

/** This is every accent-hue role WCAG 2.2 AA holds to a background contrast floor, paired with its required ratio. */
const ACCENT_HUE_BACKGROUND_ROLES: readonly { readonly role: string; readonly minimumRatio: number }[] = [
  { role: "text", minimumRatio: WCAG_AA_TEXT_CONTRAST },
  { role: "textMuted", minimumRatio: WCAG_AA_TEXT_CONTRAST },
  { role: "edge", minimumRatio: WCAG_AA_NON_TEXT_CONTRAST },
  ...TOKEN_RAMPS.accent.map((role) => ({ role, minimumRatio: WCAG_AA_NON_TEXT_CONTRAST })),
];

test("accent-hue clears WCAG 2.2 AA contrast against its own background, plain and under both dichromacy simulations, at every swept anchor and theme/temperature", () => {
  let checked = 0;
  for (const theme of THEMES) {
    for (const temperature of TEMPERATURES) {
      for (const anchor of HUE_ANCHOR_SWEEP) {
        const tokens = resolveTokens("accent-hue", temperature, theme, anchor);
        const background = requiredToken(tokens, "background");
        for (const { role, minimumRatio } of ACCENT_HUE_BACKGROUND_ROLES) {
          checked += 1;
          const token = requiredToken(tokens, role);
          assert.ok(
            contrastRatio(token, background) >= minimumRatio,
            `accent-hue anchor ${anchor} ${theme}/${temperature} ${role} plain contrast below ${minimumRatio}`,
          );
          for (const simulation of DICHROMACY_SIMULATIONS) {
            assert.ok(
              simulatedContrastRatio(token, background, simulation) >= minimumRatio,
              `accent-hue anchor ${anchor} ${theme}/${temperature} ${role} ${simulation} contrast below ${minimumRatio}`,
            );
          }
        }
      }
    }
  }
  assert.equal(checked, THEMES.length * TEMPERATURES.length * HUE_ANCHOR_SWEEP.length * ACCENT_HUE_BACKGROUND_ROLES.length);
});

test("categorical clears WCAG 2.2 AA non-text contrast against its own background, plain and under both dichromacy simulations, for every theme and temperature", () => {
  let checked = 0;
  for (const theme of THEMES) {
    for (const temperature of TEMPERATURES) {
      const tokens = resolveTokens("categorical", temperature, theme);
      const background = requiredToken(tokens, "background");
      for (const role of TOKEN_RAMPS.accent) {
        checked += 1;
        const token = requiredToken(tokens, role);
        assert.ok(contrastRatio(token, background) >= WCAG_AA_NON_TEXT_CONTRAST, `categorical ${theme}/${temperature} ${role} plain contrast below AA`);
        for (const simulation of DICHROMACY_SIMULATIONS) {
          assert.ok(
            simulatedContrastRatio(token, background, simulation) >= WCAG_AA_NON_TEXT_CONTRAST,
            `categorical ${theme}/${temperature} ${role} ${simulation} contrast below AA`,
          );
        }
      }
    }
  }
  assert.equal(checked, THEMES.length * TEMPERATURES.length * TOKEN_RAMPS.accent.length);
});

test("every pair of categorical ramp entries stays distinguishable, plain and under both dichromacy simulations, for every theme and temperature", () => {
  let checkedPairs = 0;
  for (const theme of THEMES) {
    for (const temperature of TEMPERATURES) {
      const tokens = resolveTokens("categorical", temperature, theme);
      for (let left = 0; left < TOKEN_RAMPS.accent.length; left += 1) {
        for (let right = left + 1; right < TOKEN_RAMPS.accent.length; right += 1) {
          checkedPairs += 1;
          const leftToken = requiredToken(tokens, TOKEN_RAMPS.accent[left]!);
          const rightToken = requiredToken(tokens, TOKEN_RAMPS.accent[right]!);
          assert.ok(
            contrastRatio(leftToken, rightToken) >= CATEGORICAL_MINIMUM_PAIRWISE_CONTRAST,
            `categorical ${theme}/${temperature} ${TOKEN_RAMPS.accent[left]}/${TOKEN_RAMPS.accent[right]} plain pairwise contrast below the distinguishability floor`,
          );
          for (const simulation of DICHROMACY_SIMULATIONS) {
            assert.ok(
              simulatedContrastRatio(leftToken, rightToken, simulation) >= CATEGORICAL_MINIMUM_PAIRWISE_CONTRAST,
              `categorical ${theme}/${temperature} ${TOKEN_RAMPS.accent[left]}/${TOKEN_RAMPS.accent[right]} ${simulation} pairwise contrast below the distinguishability floor`,
            );
          }
        }
      }
    }
  }
  const pairsPerCombination = (TOKEN_RAMPS.accent.length * (TOKEN_RAMPS.accent.length - 1)) / 2;
  assert.equal(checkedPairs, THEMES.length * TEMPERATURES.length * pairsPerCombination);
});

test("dichromacy simulation actually changes colour: a chromatic accent-hue token's simulated luminance differs from its plain luminance for at least one swept anchor", () => {
  const background = resolveTokens("monochrome", "balanced", "dark").background!;
  let sawADifference = false;
  for (const anchor of HUE_ANCHOR_SWEEP) {
    const token = requiredToken(resolveTokens("accent-hue", "balanced", "dark", anchor), "accent2");
    for (const simulation of DICHROMACY_SIMULATIONS) {
      if (simulatedContrastRatio(token, background, simulation) !== contrastRatio(token, background)) {
        sawADifference = true;
      }
    }
  }
  assert.ok(sawADifference, "dichromacy simulation must be a real transform, not a no-op mirroring plain contrast");
});
