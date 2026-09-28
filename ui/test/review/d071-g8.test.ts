import assert from "node:assert/strict";
import { test } from "node:test";
import { ellipsizeText, stripTrailingSeparators } from "#render-common/container-canvas.ts";
import { shortLabelWithEllipsis } from "../../src/review/labels.ts";
import { formatVolumeProportions } from "../../src/review/volume.ts";

const charWidth = (text: string) => [...text].length * 7;

test("stripTrailingSeparators: commas, semicolons and colons are separators too", () => {
  assert.equal(stripTrailingSeparators("ciao,"), "ciao");
  assert.equal(stripTrailingSeparators("ciao ;"), "ciao");
  assert.equal(stripTrailingSeparators("Signal Stack ·"), "Signal Stack");
  assert.equal(stripTrailingSeparators("a : b —"), "a : b");
  assert.equal(stripTrailingSeparators("plain"), "plain");
});

test("ellipsizeText: a cut never ends on punctuation («Beacon,…», «Signal Stack ·…»)", () => {
  const measure = (text: string) => [...text].length * 7;
  // A budget that fits exactly up to the comma of «Beacon, Tides».
  const cut = ellipsizeText("Beacon, Tides", 7 * 7, measure);
  assert.ok(!/[,;:\u00B7\u2022\u2219\-—–|\s]…$/.test(cut), `cut ends on punctuation: «${cut}»`);
  assert.equal(cut, "Beacon…");
  const middot = ellipsizeText("Signal Stack · sistema", 13 * 7, measure);
  assert.ok(!/[,;:\u00B7\u2022\u2219\-—–|\s]…$/.test(middot), `cut ends on punctuation: «${middot}»`);
  assert.equal(middot, "Signal Stack…");
});

test("shortLabelWithEllipsis: a page-truncated short title never keeps its trailing separator", () => {
  const fits = () => 0;
  const middot = shortLabelWithEllipsis({ short: "Signal Stack ·", full: "Signal Stack · sistema", maxWidth: 180, measure: fits });
  assert.equal(middot, "Signal Stack…");
  const comma = shortLabelWithEllipsis({ short: "Beacon,", full: "Beacon, Tides", maxWidth: 180, measure: fits });
  assert.equal(comma, "Beacon…");
  const semicolon = shortLabelWithEllipsis({ short: "Sistema;", full: "Sistema; memoria", maxWidth: 180, measure: fits });
  assert.equal(semicolon, "Sistema…");
  // A mid-word page cut still backs off to a word boundary, separator or not.
  const midWord = shortLabelWithEllipsis({ short: "Signal Sta", full: "Signal Stack", maxWidth: 180, measure: fits });
  assert.equal(midWord, "Signal…");
});

test("formatVolumeProportions: Italian readout with decimal comma, largest axis first", () => {
  assert.equal(formatVolumeProportions({ second: 0.98, third: 0.47 }), "proporzioni 1 : 0,98 : 0,47");
  assert.equal(formatVolumeProportions({ second: 1, third: 1 }), "proporzioni 1 : 1,00 : 1,00");
  assert.equal(formatVolumeProportions({ second: 0.25, third: 0.12 }), "proporzioni 1 : 0,25 : 0,12");
  assert.ok(!formatVolumeProportions({ second: 0.5, third: 0.3 }).includes("."), "no decimal point survives");
  assert.ok(!formatVolumeProportions({ second: 0.5, third: 0.3 }).includes("λ"), "no λ jargon survives");
});

test("ellipsizeText regression: word-boundary and character cuts still work", () => {
  assert.equal(ellipsizeText("fits", 28, charWidth), "fits");
  assert.equal(ellipsizeText("one two three", 10 * 7, charWidth), "one two…");
  assert.equal(ellipsizeText("supercalifragilistic", 6 * 7, charWidth), "super…");
});
