import test from "node:test";
import assert from "node:assert/strict";
import { PALETTES, PALETTE_ROLES, contrast } from "../../src/review/palette.ts";
import { CUSTOM_STORAGE_KEY, applyColour, readColourPresets, saveColourPreset, validHex } from "../../src/review/appearance.ts";

test("every palette defines nine readable roles", () => {
  assert.equal(PALETTE_ROLES.length, 9);
  for (const [name, palette] of Object.entries(PALETTES)) {
    assert.deepEqual(Object.keys(palette).sort(), [...PALETTE_ROLES].sort(), name);
    for (const role of PALETTE_ROLES) {
      assert.ok(validHex(palette[role]), `${name}.${role}`);
      if (role !== "background") assert.ok(contrast(palette[role], palette.background) >= (role === "text" ? 4.5 : 3), `${name}.${role}`);
    }
  }
});

test("Custom validates, applies, saves, reloads, and restores colours", () => {
  const items = new Map<string, string>();
  const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } };
  const start = { ...PALETTES.amber };
  assert.equal(validHex("#abc"), false);
  assert.throws(() => applyColour(start, "aggregate", "orange"));
  const changed = applyColour(start, "aggregate", "#ABCDEF");
  assert.equal(changed.aggregate, "#abcdef");
  assert.equal(start.aggregate, PALETTES.amber.aggregate);
  saveColourPreset(storage, "  Studio  ", changed);
  assert.ok(items.has(CUSTOM_STORAGE_KEY));
  assert.deepEqual(readColourPresets(storage).Studio, changed);
  const restored = { ...start };
  assert.deepEqual(restored, PALETTES.amber);
  assert.notEqual(restored.aggregate, readColourPresets(storage).Studio!.aggregate);
});
