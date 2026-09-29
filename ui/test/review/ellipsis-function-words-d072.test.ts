import assert from "node:assert/strict";
import { test } from "node:test";
import { ellipsizeText } from "#render-common/container-canvas.ts";
import { compactDisplayLabel } from "../../src/review/graph-v2.ts";

const chars = (text: string) => [...text].length;

test("a shortened text never ends on a function word before its ellipsis", () => {
  // Invented titles shaped like the real failures: a conjunction, a preposition, an English «with».
  for (const text of [
    "Portolano invented per Alpha V1 e Beta per V2 lungo questo segnale",
    "Cartiglio inventato lucidato durante la traversa del cartiglio",
    "HB | L7-B7 | Charting with Invented Shoals and Buoys",
    "Registro inventato illuminato come segnale del battello",
  ]) {
    const cut = ellipsizeText(text, 33, chars);
    assert.ok(cut.endsWith("…"), cut);
    const last = cut.slice(0, -1).trim().split(/\s+/).pop()!.toLowerCase();
    assert.ok(!["e", "per", "durante", "with", "come", "la", "del"].includes(last), `${cut} ends on «${last}»`);
    assert.ok(chars(cut) <= 33, cut);
  }
  // «AI» is kept as a word.
  assert.equal(ellipsizeText("Una guida inventata sulla AI e sul resto del mondo", 33, chars), "Una guida inventata sulla AI…");
  // A text that fits is untouched.
  assert.equal(ellipsizeText("Breve e chiaro", 33, chars), "Breve e chiaro");
});

test("the compact canvas label goes through the same rule", () => {
  const label = compactDisplayLabel({ title: "x", display_label: "Portolano invented per Alpha V1 e Beta per V2…" } as never);
  assert.ok(!/\s(e|per)…$/u.test(label), label);
});
