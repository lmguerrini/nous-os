import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasNodeRadiusPx, createNativeSizeLaw, labNativeSizeLawApplies,
  nativeLawSizes } from '../src/render-common/native-node-law.ts';

// D086-F1 BEGIN: the same encoded member and open-pearl marker enter the native GPU buffer.
const compositions = ['canopy-ifs', 'sierpinski', 'lull'] as const;
const balancedCounts = [2_380, 2_420, 3_920] as const;
const fitScale = 0.827;
const shared = new Map([['domain:pearl', 2.5], ['member:record', 5.75], ['member:hub', 15.47]]);
const degrees = new Map([['domain:pearl', 8], ['member:record', 1], ['member:hub', 12]]);

test('Lab + Indra compositions use the native law at every density; standalone Indra and Natural do not', () => {
  for (const [index, topology] of compositions.entries()) {
    for (const count of [80, balancedCounts[index]!, 11_199])
      assert.equal(labNativeSizeLawApplies(topology, 11_199), true, `${topology}/${count}`);
  }
  assert.equal(labNativeSizeLawApplies(undefined, 11_199), false);
  assert.equal(labNativeSizeLawApplies('natural', 11_199), false);
});

test('each composition retains identical native size attributes for shared pearl and member IDs at one camera', () => {
  const essential = nativeLawSizes({ morphology: 'stellar', projectedScale: fitScale, floorPx: 2,
    given: shared, degree: degrees });
  for (const [index, topology] of compositions.entries()) {
    const given = new Map(shared);
    for (let i = given.size; i < balancedCounts[index]!; i++) given.set(`${topology}:extra:${i}`, 4);
    const balanced = new Map(given);
    const mountedLaw = createNativeSizeLaw({ morphology: 'stellar',
      active: labNativeSizeLawApplies(topology, 11_199),
      projectedScale: () => fitScale, floorPx: () => 2, given, degree: degrees,
      write: sizes => { for (const [id, size] of sizes) balanced.set(id, size); },
    });
    assert.equal(mountedLaw.settle(), true, `${topology} writes Sigma size attributes`);
    assert.equal(balanced.size, balancedCounts[index]);
    for (const [id, encoded] of shared) {
      assert.equal(balanced.get(id), essential.get(id), `${topology}/${id}`);
      assert.ok(Math.abs(balanced.get(id)! * fitScale - canvasNodeRadiusPx('stellar', encoded, fitScale,
        degrees.get(id)!, 2)) < 1e-12, `${topology}/${id} projected radius`);
    }
    assert.ok(balanced.get('domain:pearl')! < balanced.get('member:hub')!, topology);
  }
});
// D086-F1 END
