import { SHIPPING_DARK_FIELD_RGB } from "#browser/lit-floor.ts";
import type { PixelImage } from "#browser/lit-floor.ts";

/** This asserts the capture field from its darkest actual pixel and does not rely on an empty coordinate. */
export function assertDarkestShippingField(image: PixelImage, label: string): readonly [number, number, number] {
  const observed = darkestPixel(image);
  if (observed.some((channel, index) => channel !== SHIPPING_DARK_FIELD_RGB[index])) {
    throw new Error(
      `${label} darkest pixel rgb(${observed.join(", ")}) is not the required dark-theme field rgb(${SHIPPING_DARK_FIELD_RGB.join(", ")})`,
    );
  }
  return observed;
}

/** This returns the real pixel with the minimum summed RGB channels and does not synthesize channel minima. */
export function darkestPixel(image: PixelImage): readonly [number, number, number] {
  let darkest: readonly [number, number, number] = [
    image.data[0] ?? 0,
    image.data[1] ?? 0,
    image.data[2] ?? 0,
  ];
  let minimumChannelSum = darkest[0] + darkest[1] + darkest[2];
  for (let offset = 4; offset < image.data.length; offset += 4) {
    const candidate: readonly [number, number, number] = [
      image.data[offset] ?? 0,
      image.data[offset + 1] ?? 0,
      image.data[offset + 2] ?? 0,
    ];
    const channelSum = candidate[0] + candidate[1] + candidate[2];
    if (channelSum < minimumChannelSum) {
      darkest = candidate;
      minimumChannelSum = channelSum;
    }
  }
  return darkest;
}
