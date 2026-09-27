/** Stable FNV-1a seed; no frame-time random choice enters geometry. */
export function morphologyHash(id: string): number {
  let value = 2166136261;
  for (const character of id) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}
