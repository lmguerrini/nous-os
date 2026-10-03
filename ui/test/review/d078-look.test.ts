import assert from "node:assert/strict";
import { test } from "node:test";
import { deepZoomShellOpacity } from "#render-common/container-canvas.ts";
import { PALETTES, PALETTE_ROLES, contrast, paletteName } from "../../src/review/palette.ts";
import { srgbToOklch } from "../../src/review/color-harmony.ts";

test("D-078 deep zoom fades enclosing 3D shells but leaves fit and pearl sized shells intact", () => {
  const bounds = { width: 1100, height: 850 };
  assert.equal(deepZoomShellOpacity(370, bounds), 1, "approved fit shell keeps its exact alpha");
  assert.equal(deepZoomShellOpacity(180, bounds), 1, "nested pearl keeps its rim");
  assert.ok(deepZoomShellOpacity(900, bounds) < 0.3, "near camera shell recedes");
  assert.equal(deepZoomShellOpacity(1200, bounds), 0, "enclosing shell no longer washes the field");
});

test("D-078 Stellar palettes are named, dark, restrained and legible", () => {
  for (const name of ["stellar-cold", "stellar-warm"] as const) {
    assert.equal(paletteName(name), name);
    const palette = PALETTES[name];
    const monochrome = PALETTES.bw;
    assert.ok(srgbToOklch(palette.background).L < 0.2);
    for (const role of PALETTE_ROLES) {
      if (role === "background") continue;
      assert.ok(contrast(palette[role], palette.background) >= (role === "text" ? 4.5 : 3), `${name} ${role} contrast`);
      if (role !== "selection" && role !== "hover") {
        assert.ok(contrast(palette[role], palette.background) >= contrast(monochrome[role], monochrome.background),
          `${name} ${role} contrast is at least Monocromatico`);
      }
      if (role !== "selection" && role !== "hover" && role !== "text")
        assert.ok(srgbToOklch(palette[role]).C < 0.08, `${name} ${role} chroma`);
    }
  }
  assert.ok(srgbToOklch(PALETTES["stellar-cold"].aggregate).H >= 190);
  assert.ok(srgbToOklch(PALETTES["stellar-cold"].aggregate).H <= 250);
  assert.ok(srgbToOklch(PALETTES["stellar-warm"].aggregate).H >= 60);
  assert.ok(srgbToOklch(PALETTES["stellar-warm"].aggregate).H <= 100);
  assert.ok(srgbToOklch(PALETTES["stellar-warm"].concept).H <= 35, "warm red remains in the restrained family");
});
