import assert from "node:assert/strict";
import { test } from "node:test";
import { HARMONY_NAMES, apartHue, harmonize, oklchToSrgb, srgbToOklch } from "../../src/review/color-harmony.ts";

const hueDistance = (a: number, b: number): number => {
  const raw = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(raw, 360 - raw);
};

/** The audit's capture: triadic from #ffd38b — exploratory must now be one of the brighter roles. */
test("G11 the verified triadic set draws a bright, hue-apart exploratory line", () => {
  const set = harmonize("#ffd38b", "#050505", "triadic");
  const exploratory = srgbToOklch(set.exploratory);
  assert.ok(exploratory.L >= 0.72, `exploratory L ${exploratory.L.toFixed(3)}`);
  for (const role of ["aggregate", "concept", "attested"] as const) {
    const other = srgbToOklch(set[role]);
    assert.ok(other.C < 0.03 || exploratory.C < 0.03 || hueDistance(exploratory.H, other.H) >= 55,
      `${role}: hue distance ${hueDistance(exploratory.H, other.H).toFixed(1)}°`);
  }
});

/** The same sweep G9 used: exploratory keeps L ≥ 0.72 on the dark backgrounds and its hue stays
 * clearly apart from the node and attested roles wherever chroma carries a hue at all. */
test("G11 exploratory lightness and hue separation hold across the harmony sweep", () => {
  const backgrounds = ["#050505", "#120b05", "#140a06", "#140c13"];
  for (const background of backgrounds) {
    for (const L of [0.5, 0.7, 0.9]) {
      for (let hue = 0; hue < 360; hue += 30) {
        for (const C of [0.0, 0.09, 0.16]) {
          const reference = oklchToSrgb({ L, C, H: hue });
          for (const name of HARMONY_NAMES) {
            const set = harmonize(reference, background, name);
            const context = `${name}/${background}/L${L}/H${hue}/C${C}`;
            const exploratory = srgbToOklch(set.exploratory);
            assert.ok(exploratory.L >= 0.72 - 1e-6, `${context}: exploratory L ${exploratory.L.toFixed(3)}`);
            for (const role of ["aggregate", "concept", "attested"] as const) {
              const other = srgbToOklch(set[role]);
              // A hue comparison only means something when both colours carry chroma.
              if (other.C < 0.03 || exploratory.C < 0.03) continue;
              const distance = hueDistance(exploratory.H, other.H);
              assert.ok(distance >= 55, `${context} ${role}: hue distance ${distance.toFixed(1)}°`);
            }
          }
        }
      }
    }
  }
});

/** The mirror on light backgrounds: exploratory joins the darker roles instead. */
test("G11 on light backgrounds the exploratory role mirrors to the darker half", () => {
  for (const background of ["#ffffff", "#f4f1ea", "#e8e4dc"]) {
    for (const name of HARMONY_NAMES) {
      const set = harmonize("#8c5a2b", background, name);
      const exploratory = srgbToOklch(set.exploratory);
      assert.ok(exploratory.L <= 0.28 + 1e-6, `${name}/${background}: exploratory L ${exploratory.L.toFixed(3)}`);
    }
  }
});

test("G11 apartHue picks the largest empty arc, deterministically", () => {
  for (let hue = 0; hue < 360; hue += 15) {
    // Monochromatic: the complement. Triadic: a 60° midpoint. Complementary: a 90° midpoint.
    assert.ok(hueDistance(apartHue([hue]), hue) >= 179, `mono ${hue}`);
    assert.ok(hueDistance(apartHue([hue, (hue + 120) % 360, (hue + 240) % 360]), hue) >= 59, `triadic ${hue}`);
    assert.ok(hueDistance(apartHue([hue, (hue + 180) % 360]), hue) >= 89, `complementary ${hue}`);
    assert.equal(apartHue([hue, (hue + 120) % 360, (hue + 240) % 360]), apartHue([hue, (hue + 120) % 360, (hue + 240) % 360]));
  }
  // The analogous set leaves one 300° arc; the midpoint sits opposite the reference.
  for (let hue = 0; hue < 360; hue += 15) {
    const apart = apartHue([hue, (hue + 30) % 360, (hue + 330) % 360]);
    assert.ok(hueDistance(apart, hue) >= 149, `analogous ${hue}: ${hueDistance(apart, hue)}`);
  }
});
