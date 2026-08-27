import { fieldPixel, isLitPixel } from "#browser/filament-continuity.ts";
import type { DecodedPng } from "#browser/filament-continuity.ts";

/** This is the minimum non-background evidence required before a suite may claim a frame was drawn. */
export const MINIMUM_LIT_PIXEL_COUNT = 1;

/** This is the calibrated monochrome dark-theme field in the shipping capture configuration. */
export const SHIPPING_DARK_FIELD_RGB = [9, 9, 9] as const;

export type PixelImage = {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
};

export type LitPixelMeasurement = {
  readonly fieldRgb: readonly [number, number, number];
  readonly litPixels: number;
  readonly totalPixels: number;
};

/** This counts pixels with the established continuity lit-pixel predicate and does not create a second definition. */
export function measureLitPixels(image: PixelImage): LitPixelMeasurement {
  const fieldRgb = fieldPixel(image as DecodedPng);
  let litPixels = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (isLitPixel(
      image.data[offset] ?? 0,
      image.data[offset + 1] ?? 0,
      image.data[offset + 2] ?? 0,
      fieldRgb,
    )) {
      litPixels += 1;
    }
  }
  return { fieldRgb, litPixels, totalPixels: image.width * image.height };
}

/** This rejects an otherwise valid capture that contains no drawn pixel. */
export function assertLitPixelFloor(image: PixelImage, label: string): LitPixelMeasurement {
  const measurement = measureLitPixels(image);
  if (measurement.litPixels < MINIMUM_LIT_PIXEL_COUNT) {
    throw new Error(
      `${label} has ${measurement.litPixels} lit pixels, below the required floor of ${MINIMUM_LIT_PIXEL_COUNT} `
      + `against field rgb(${measurement.fieldRgb.join(", ")})`,
    );
  }
  return measurement;
}

/** This rejects a capture whose composited field is not the calibrated dark-theme field. */
export function assertShippingDarkField(image: PixelImage, label: string): readonly [number, number, number] {
  const observed = fieldPixel(image as DecodedPng);
  if (observed.some((channel, index) => channel !== SHIPPING_DARK_FIELD_RGB[index])) {
    throw new Error(
      `${label} field rgb(${observed.join(", ")}) is not the required dark-theme field rgb(${SHIPPING_DARK_FIELD_RGB.join(", ")})`,
    );
  }
  return observed;
}

/** This formats the calibrated field for the browser page without duplicating its channels. */
export function shippingDarkFieldCss(): string {
  return `rgb(${SHIPPING_DARK_FIELD_RGB.join(", ")})`;
}
