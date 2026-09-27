/** Optional review-only appearance channels. Absence is the exact engine baseline. */
export type NodePresentation = {
  readonly corePermille: number;
  readonly haloPermille: number;
  readonly opacityPermille: number;
  readonly tintSrgb?: readonly [number, number, number];
};
export type PresentationOptions = {
  readonly nodes?: ReadonlyMap<string, NodePresentation>;
  readonly emphasisIds?: ReadonlySet<string> | null;
  readonly nativeLabels?: boolean;
  readonly windowGeometryFromAnchors?: boolean;
};
export function tintToken(srgb: readonly [number, number, number]) {
  const linear = srgb.map((v) => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
  const [r,g,b] = linear;
  const l = Math.cbrt(.4122214708*r!+.5363325363*g!+.0514459929*b!);
  const m = Math.cbrt(.2119034982*r!+.6806995451*g!+.1073969566*b!);
  const s = Math.cbrt(.0883024619*r!+.2817188376*g!+.6299787005*b!);
  const L=.2104542553*l+.793617785*m-.0040720468*s;
  const a=1.9779984951*l-2.428592205*m+.4505937099*s;
  const bb=.0259040371*l+.7827717662*m-.808675766*s;
  return { lightnessPermille: Math.round(L*1000), chromaPermille: Math.round(Math.hypot(a,bb)*1000), hueDegrees: Math.round((Math.atan2(bb,a)*180/Math.PI+360)%360)%360 };
}
export function tintRgba(color: string, tint: readonly [number,number,number], opacityPermille: number): string {
  const match=color.match(/^rgba?\(\d+, \d+, \d+(?:, ([\d.]+))?\)$/);
  if (!match) throw new TypeError("invalid renderer colour");
  const alpha=Number(match[1] ?? 1)*opacityPermille/1000;
  return `rgba(${tint.map((v)=>Math.round(v*255)).join(", ")}, ${alpha})`;
}
export function multiplyAlpha(color: string, permille: number): string {
  const match=color.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/);
  if (!match) throw new TypeError("invalid renderer colour");
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${Number(match[4] ?? 1)*permille/1000})`;
}
/**
 * Dims a Sigma colour by moving it towards the field colour. Sigma's node and filament programs draw
 * the RGB channels opaquely, so an alpha multiply leaves an unemphasised node exactly as bright as
 * before; mixing towards the background is the dimming those programs can actually show.
 */
export function mixTowardField(color: string, field: string, permille: number): string {
  const parse = (value: string) => {
    const match = value.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/);
    if (!match) throw new TypeError("invalid renderer colour");
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: Number(match[4] ?? 1) };
  };
  const from = parse(color);
  const to = parse(field);
  const keep = permille / 1000;
  const channel = (value: number, background: number) => Math.round(background + ((value - background) * keep));
  return `rgba(${channel(from.r, to.r)}, ${channel(from.g, to.g)}, ${channel(from.b, to.b)}, ${from.a})`;
}
