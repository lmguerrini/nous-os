import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PALETTES } from "../src/review/palette.ts";
import { srgbToOklch } from "../src/review/color-harmony.ts";
import { resolveUIAccent, uiAccentContrast, UI_ACCENT_MIN_CONTRAST } from "../src/review/ui-accent.ts";

const html = readFileSync(new URL("../review/index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/review/main.ts", import.meta.url), "utf8");
const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

test("monochrome and both Stellar palettes use subdued accents with a visible palette identity", () => {
  const bw = srgbToOklch(resolveUIAccent(PALETTES.bw, "bw"));
  const cold = srgbToOklch(resolveUIAccent(PALETTES["stellar-cold"], "stellar-cold"));
  const warm = srgbToOklch(resolveUIAccent(PALETTES["stellar-warm"], "stellar-warm"));
  assert.ok(bw.C < 0.015, `Monocromatico should remain neutral; chroma=${bw.C}`);
  assert.ok(cold.H >= 190 && cold.H <= 250, `Stellar Cold hue=${cold.H}`);
  assert.ok(warm.H >= 35 && warm.H <= 100, `Stellar Warm hue=${warm.H}`);
  assert.ok(cold.C <= 0.08 && warm.C <= 0.08, "preset accent chroma stays low");
});

test("all supported active palettes meet the non-text contrast floor against the toolbar surface", () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    const accent = resolveUIAccent(palette, name === "bw" ? "bw" : name === "stellar-cold" ? "stellar-cold" : name === "stellar-warm" ? "stellar-warm" : "preset");
    assert.ok(uiAccentContrast(accent) >= UI_ACCENT_MIN_CONTRAST, `${name} contrast=${uiAccentContrast(accent)}`);
  }
  const custom = { ...PALETTES.bw, aggregate: "#3a9baf", concept: "#446fbe", attested: "#379b78", exploratory: "#567fa0" };
  assert.ok(uiAccentContrast(resolveUIAccent(custom, "custom")) >= UI_ACCENT_MIN_CONTRAST);
});

test("Custom accent is a deterministic capped OKLCH harmony of node and edge roles", () => {
  const custom = { ...PALETTES.bw, aggregate: "#ed653c", concept: "#d84979", attested: "#b75447", exploratory: "#e27448" };
  const accent = resolveUIAccent(custom, "custom");
  const again = resolveUIAccent({ ...custom }, "custom");
  const oklch = srgbToOklch(accent);
  const sourceHues = [custom.aggregate, custom.concept, custom.attested, custom.exploratory].map((colour) => srgbToOklch(colour).H);
  assert.equal(accent, again);
  assert.ok(oklch.C <= 0.06, `chroma cap exceeded: ${oklch.C}`);
  assert.ok(sourceHues.some((hue) => hueDistance(oklch.H, hue) < 55), `accent hue ${oklch.H} must harmonize with the selected palette`);
});

test("selected chrome, keyboard focus, drawer tabs and quote borders all use the live accent token", () => {
  assert.match(html, /--ui-accent:#dedede/);
  assert.match(html, /focus-visible[^}]*outline:2px solid var\(--ui-accent\)/);
  assert.match(html, /button\[aria-pressed="true"\][^{]*\{[^}]*border-color:var\(--ui-accent\)/);
  assert.match(html, /\.node-drawer-tabs button\[aria-selected="true"\]\s*\{border-color:var\(--ui-accent\)/);
  assert.match(html, /\.node-drawer-passage blockquote[^}]*border-left:2px solid var\(--ui-accent\)/);
  assert.match(html, /\.node-drawer-quote[^}]*border-left:2px solid var\(--ui-accent\)/);
  assert.match(main, /function syncUIAccent\([\s\S]*?setProperty\("--ui-accent", resolveUIAccent/);
  assert.match(main, /syncUIAccent\(next\);[\s\S]*?void setAxes\(\{ colour: next \}\)/, "accent updates immediately on palette change");
  assert.match(main, /writeLocal\(storage, "d069\.palette", partial\.colour\)/, "palette persistence stays on its existing localStorage path");
});

test("UI chrome contains no fixed gold selection accent", () => {
  const fixedAccent = /#(?:e0b97a|d8b37a|70573d|e0c18f|e9d4b3|f0d3a4|f0c987|ffd5ab)|rgba?\(\s*(?:154\s*,\s*116\s*,\s*65|216\s*,\s*179\s*,\s*122)\b/i;
  assert.doesNotMatch(html, fixedAccent);
  assert.doesNotMatch(main, fixedAccent);
});
