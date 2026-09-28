import assert from "node:assert/strict";
import { test } from "node:test";
import { HARMONY_NAMES, HARMONY_SEPARATIONS, contrastRatio, deltaEok, harmonize, oklchToSrgb } from "../../src/review/color-harmony.ts";

/** The audit's failing capture: triadic from #ffd38b on the dark default background. */
test("G9 the verified triadic set separates every constrained role pair", () => {
  const set = harmonize("#ffd38b", "#050505", "triadic");
  assert.notEqual(set.hover, set.selection);
  for (const { roles: [roleA, roleB], minDeltaE } of HARMONY_SEPARATIONS)
    assert.ok(deltaEok(set[roleA], set[roleB]) >= minDeltaE, `${roleA}-${roleB}: ${deltaEok(set[roleA], set[roleB]).toFixed(4)}`);
});

/** Hues every 30°, three lightnesses, several chromas: the separation floors hold for every harmony
 * type and reference colour, and the contrast rules survive the repair pass. */
test("G9 harmony separations and contrast floors hold across the reference sweep", () => {
  const backgrounds = ["#050505", "#120b05", "#140a06", "#140c13"];
  for (const background of backgrounds) {
    for (const L of [0.5, 0.7, 0.9]) {
      for (let hue = 0; hue < 360; hue += 30) {
        for (const C of [0.0, 0.09, 0.16]) {
          const reference = oklchToSrgb({ L, C, H: hue });
          for (const name of HARMONY_NAMES) {
            const set = harmonize(reference, background, name);
            const context = `${name}/${background}/L${L}/H${hue}/C${C}`;
            for (const { roles: [roleA, roleB], minDeltaE } of HARMONY_SEPARATIONS)
              assert.ok(deltaEok(set[roleA], set[roleB]) >= minDeltaE,
                `${context} ${roleA}-${roleB} ΔE ${deltaEok(set[roleA], set[roleB]).toFixed(4)} < ${minDeltaE}`);
            for (const role of ["aggregate", "concept", "attested", "exploratory", "selection", "hover", "container"] as const)
              assert.ok(contrastRatio(set[role], background) >= 3, `${context}.${role} contrast ${contrastRatio(set[role], background).toFixed(2)}`);
            assert.ok(contrastRatio(set.text, background) >= 4.5, `${context}.text contrast ${contrastRatio(set.text, background).toFixed(2)}`);
          }
        }
      }
    }
  }
});

test("G9 harmony proposals are deterministic", () => {
  for (const name of HARMONY_NAMES)
    assert.deepEqual(harmonize("#ffd38b", "#050505", name), harmonize("#ffd38b", "#050505", name));
});
