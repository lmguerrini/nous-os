/** D-073 tranche F, row F2 — numerical vector/matrix primitives for the Holographic spectral core.
 * Pure module: no page, renderer or environment dependency; every routine is deterministic.
 * Vectors are Float64Array; dense matrices are column-major Float64Array with explicit shape. */

export type Vector = Float64Array;

export interface DenseMatrix {
  readonly rows: number;
  readonly cols: number;
  readonly data: Float64Array;
}

export function createMatrix(rows: number, cols: number): DenseMatrix {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 0 || cols < 0) {
    throw new Error(`holographic-linear-algebra: invalid matrix shape ${rows}x${cols}`);
  }
  return { rows, cols, data: new Float64Array(rows * cols) };
}

export function identityMatrix(n: number): DenseMatrix {
  const matrix = createMatrix(n, n);
  for (let index = 0; index < n; index += 1) matrix.data[index + index * n] = 1;
  return matrix;
}

/** Read-only view of one column; mutations through the view write through to the matrix. */
export function matrixColumn(matrix: DenseMatrix, col: number): Float64Array {
  if (col < 0 || col >= matrix.cols) throw new Error(`holographic-linear-algebra: column ${col} out of range`);
  return matrix.data.subarray(col * matrix.rows, (col + 1) * matrix.rows);
}

function requireSameLength(x: Vector, y: Vector, what: string): void {
  if (x.length !== y.length) throw new Error(`holographic-linear-algebra: ${what} length ${x.length} vs ${y.length}`);
}

export function dot(x: Vector, y: Vector): number {
  requireSameLength(x, y, 'dot operands');
  let sum = 0;
  for (let index = 0; index < x.length; index += 1) sum += x[index]! * y[index]!;
  return sum;
}

export function norm2(x: Vector): number {
  return Math.sqrt(dot(x, x));
}

export function maxAbs(x: Vector): number {
  let max = 0;
  for (let index = 0; index < x.length; index += 1) {
    const value = Math.abs(x[index]!);
    if (value > max) max = value;
  }
  return max;
}

export function sumEntries(x: Vector): number {
  let sum = 0;
  for (let index = 0; index < x.length; index += 1) sum += x[index]!;
  return sum;
}

/** target += alpha * source, in place. */
export function addScaledInPlace(target: Vector, source: Vector, alpha: number): void {
  requireSameLength(target, source, 'addScaledInPlace operands');
  for (let index = 0; index < target.length; index += 1) target[index] = target[index]! + alpha * source[index]!;
}

export function scaleInPlace(x: Vector, alpha: number): void {
  for (let index = 0; index < x.length; index += 1) x[index] = x[index]! * alpha;
}

export function matVec(matrix: DenseMatrix, x: Vector): Float64Array {
  if (x.length !== matrix.cols) throw new Error(`holographic-linear-algebra: matVec shape mismatch`);
  const y = new Float64Array(matrix.rows);
  for (let col = 0; col < matrix.cols; col += 1) {
    const coefficient = x[col]!;
    if (coefficient === 0) continue;
    const base = col * matrix.rows;
    for (let row = 0; row < matrix.rows; row += 1) y[row] = y[row]! + coefficient * matrix.data[base + row]!;
  }
  return y;
}

export function transposeMatVec(matrix: DenseMatrix, x: Vector): Float64Array {
  if (x.length !== matrix.rows) throw new Error(`holographic-linear-algebra: transposeMatVec shape mismatch`);
  const y = new Float64Array(matrix.cols);
  for (let col = 0; col < matrix.cols; col += 1) {
    const base = col * matrix.rows;
    let sum = 0;
    for (let row = 0; row < matrix.rows; row += 1) sum += matrix.data[base + row]! * x[row]!;
    y[col] = sum;
  }
  return y;
}

export function frobeniusNorm(matrix: DenseMatrix): number {
  let sum = 0;
  for (let index = 0; index < matrix.data.length; index += 1) {
    const value = matrix.data[index]!;
    sum += value * value;
  }
  return Math.sqrt(sum);
}

/** Gram matrix G = [v_i . v_j] of the given columns. */
export function gramMatrix(columns: readonly Vector[]): DenseMatrix {
  const count = columns.length;
  const gram = createMatrix(count, count);
  for (let col = 0; col < count; col += 1) {
    for (let row = col; row < count; row += 1) {
      const value = dot(columns[row]!, columns[col]!);
      gram.data[row + col * count] = value;
      if (row !== col) gram.data[col + row * count] = value;
    }
  }
  return gram;
}

/** ||V^T V - I||_F over the given columns: the orthogonality defect. */
export function orthogonalityDefect(columns: readonly Vector[]): number {
  const gram = gramMatrix(columns);
  let sum = 0;
  for (let col = 0; col < columns.length; col += 1) {
    for (let row = 0; row < columns.length; row += 1) {
      const delta = gram.data[row + col * columns.length]! - (row === col ? 1 : 0);
      sum += delta * delta;
    }
  }
  return Math.sqrt(sum);
}

/** Two modified Gram-Schmidt passes of w against the (assumed orthonormal) basis, in place.
 * Returns the resulting norm. Basis vectors are subtracted sequentially within each pass;
 * the second pass removes the first-pass roundoff residue, per the D-073 numerical policy. */
export function modifiedGramSchmidtTwice(w: Vector, basis: readonly Vector[]): number {
  for (let pass = 0; pass < 2; pass += 1) {
    for (const v of basis) {
      const coefficient = dot(v, w);
      if (coefficient !== 0) addScaledInPlace(w, v, -coefficient);
    }
  }
  return norm2(w);
}

/** Pivot index of the largest absolute entry. Magnitudes within `tieTolerance` of the maximum
 * (absolute, per the D-073 pivot-tie policy, default 10^-10 for sign conventions) count as
 * ties and resolve to the smallest index; the default 0 asks for exact comparison. */
export function largestEntryIndex(x: Vector, tieTolerance = 0): number {
  let max = 0;
  for (let index = 0; index < x.length; index += 1) {
    const value = Math.abs(x[index]!);
    if (value > max) max = value;
  }
  for (let index = 0; index < x.length; index += 1) {
    if (max - Math.abs(x[index]!) <= tieTolerance) return index;
  }
  return 0;
}
