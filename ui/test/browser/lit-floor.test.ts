import assert from "node:assert/strict";
import test from "node:test";
import { assertLitPixelFloor, MINIMUM_LIT_PIXEL_COUNT, SHIPPING_DARK_FIELD_RGB } from "#browser/lit-floor.ts";
import type { PixelImage } from "#browser/lit-floor.ts";

// This is the control the CAP-13 human review audit's own finding demands: `assertLitPixelFloor`'s own
// floor is deliberately low (MINIMUM_LIT_PIXEL_COUNT), so a handful of anti-aliased label glyphs already
// clears it -- which is exactly how 22 of 96 review-temporal frames and 18 of 99 review-opening frames
// shipped with no node or filament drawn anywhere, yet passed the guard that exists to prove a frame was
// drawn, because a label was legible on an otherwise-black frame. Neither a higher floor nor a brightness
// threshold can repair this: an early structural-reveal node can be dimmer than a label glyph (see
// #scene/build.ts's own resolveStructuralGeometry), so no pixel-value predicate can tell the two apart.
// What tells them apart is the SURFACE a pixel was drawn to -- render3f draws every node, relation, and
// halo exclusively to its own WebGL canvas and every label exclusively to a DOM overlay layered above it
// (see #render3f/mount.tsx, #render3f/labels.tsx) -- so the fix `review-temporal-mycelium.spec.ts` and
// `review-opening.spec.ts` now apply is to feed `assertLitPixelFloor` a canvas-only capture, never the
// composited one, for the "was the graph itself drawn" question. This file pins that this distinction is
// real: if it ever passes with the composited-image call silently repaired to also reject a label-only
// frame, or with the canvas-only call silently accepting one, the review suites' own strengthened guard
// has quietly gone decorative again.

const FIELD = SHIPPING_DARK_FIELD_RGB;
const IMAGE_WIDTH = 64;
const IMAGE_HEIGHT = 32;
// The calibrated label token composites well under a shipped node or relation's own brightness (see the
// human review audit's own measured maxR=97 on a real shipped frame, against calibration.labels' own
// dampened ceiling) but well clear of the field it sits on -- legible, not merely a rounding artifact.
const LABEL_GLYPH_RGB: readonly [number, number, number] = [178, 178, 178];

/** This fills every pixel with the shipping dark field and paints nothing else -- render3f's own canvas whenever every node and relation resolves to exactly zero opacity. */
function blankCanvas(): PixelImage {
  return { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, data: solidField() };
}

/** This is the composited frame a real shipped Assemble phase-0 capture produced pre-fix: the canvas is exactly the field above, with a handful of label-glyph pixels painted over it by the DOM overlay `page.locator("#temporal-root").screenshot()` also captures. */
function compositedFrameWithLabelOnly(): PixelImage {
  const data = solidField();
  for (let column = 10; column < 18; column += 1) {
    const offset = ((4 * IMAGE_WIDTH) + column) * 4;
    data[offset] = LABEL_GLYPH_RGB[0];
    data[offset + 1] = LABEL_GLYPH_RGB[1];
    data[offset + 2] = LABEL_GLYPH_RGB[2];
    data[offset + 3] = 255;
  }
  return { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, data };
}

function solidField(): Buffer {
  const data = Buffer.alloc(IMAGE_WIDTH * IMAGE_HEIGHT * 4);
  for (let index = 0; index < IMAGE_WIDTH * IMAGE_HEIGHT; index += 1) {
    data[index * 4] = FIELD[0];
    data[(index * 4) + 1] = FIELD[1];
    data[(index * 4) + 2] = FIELD[2];
    data[(index * 4) + 3] = 255;
  }
  return data;
}

test("a label-only composited frame still clears assertLitPixelFloor's own floor, exactly the gap the audit found", () => {
  const measurement = assertLitPixelFloor(compositedFrameWithLabelOnly(), "control composited frame");
  assert.ok(
    measurement.litPixels >= MINIMUM_LIT_PIXEL_COUNT,
    "the label-only composited control must itself clear the floor, or this test proves nothing about the gap it exists to pin",
  );
});

test("the same frame's canvas-only capture -- no DOM label overlay in it -- correctly reports nothing was drawn", () => {
  assert.throws(
    () => assertLitPixelFloor(blankCanvas(), "control canvas-only capture"),
    /has 0 lit pixels, below the required floor/,
  );
});

test("a genuinely drawn canvas (a real node or relation pixel present) still clears the floor", () => {
  const data = solidField();
  const offset = ((16 * IMAGE_WIDTH) + 32) * 4;
  data[offset] = 200;
  data[offset + 1] = 60;
  data[offset + 2] = 60;
  data[offset + 3] = 255;
  const measurement = assertLitPixelFloor({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT, data }, "control canvas with a real node pixel");
  assert.ok(measurement.litPixels >= MINIMUM_LIT_PIXEL_COUNT);
});
