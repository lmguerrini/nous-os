/** Math.min/Math.max semantics without a data-sized argument list. */
export function minOf(values: Iterable<number>, initial = Infinity): number {
  let result = initial;
  for (const value of values) result = Math.min(result, value);
  return result;
}

export function maxOf(values: Iterable<number>, initial = -Infinity): number {
  let result = initial;
  for (const value of values) result = Math.max(result, value);
  return result;
}

/** Append a snapshot of the source length, including holes as undefined. */
export function appendAll<T>(target: T[], values: readonly T[]): number {
  const length = values.length;
  for (let index = 0; index < length; index++) target.push(values[index]!);
  return target.length;
}
