import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { assertLitPixelFloor } from "#browser/lit-floor.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import type { Coordinates } from "#engine/contract.ts";
import type { RetainedResourceWitness } from "#engine/renderer-handle.ts";
import {
  canonicalCameraFramingPoints,
  assertProjectedCameraFramingSubjectsInsideViewport,
  quantizeCameraFramingUpperBound,
  quantizeCameraFramingValue,
  requiredPerspectiveFramingTangent,
  sceneCameraFramingSubjects,
} from "#render3f/camera-framing.ts";
import { assertDarkestShippingField } from "./capture-field.ts";
import {
  resolveVisibleScreenLabelIds,
} from "#render3f/label-collision.ts";
import type { ScreenLabelBounds } from "#render3f/label-collision.ts";
import { ResourceRegistry } from "#render3f/resources.ts";
import { assertRetainedResourcesDoNotGrow } from "#test-render3f/retention.ts";
import {
  LiveSceneState,
  assertCameraSwitchInvariant,
} from "#render3f/state.ts";
import { resolvedCameraScenes } from "./support.ts";
import { immediateNeighbourhoodFraming } from "./review-framing.ts";
import { sceneFixtureGraph } from "#test-scene/support.ts";

test("projection changes preserve live anchors while screen label collisions preserve scene priority", (context) => {
  const scenes = resolvedCameraScenes();
  const live = new LiveSceneState(scenes, ORTHOGRAPHIC, cameraKindCount());
  const buffers = live.buffers;
  const beforeAnchors = live.readWorldAnchorWitnesses();
  const beforeLayoutPassCount = live.readLayoutPassCount();
  live.setCameraKind(PERSPECTIVE);
  const afterAnchors = live.readWorldAnchorWitnesses();
  const afterLayoutPassCount = live.readLayoutPassCount();
  assert.equal(live.buffers, buffers);
  assert.doesNotThrow(() => assertCameraSwitchInvariant(
    beforeAnchors,
    afterAnchors,
    beforeLayoutPassCount,
    afterLayoutPassCount,
  ));
  assert.equal(live.cameraKind, PERSPECTIVE);
  assert.equal(live.scene.camera.kind, PERSPECTIVE);

  assert.throws(
    () => assertCameraSwitchInvariant(
      beforeAnchors,
      afterAnchors,
      beforeLayoutPassCount,
      afterLayoutPassCount + 1,
    ),
    /camera switch changed layout pass count/,
  );

  const labels = collidingLabels();
  assert.deepEqual(resolveVisibleScreenLabelIds(labels), ["label:higher"]);
  assert.deepEqual(resolveVisibleScreenLabelIds([...labels].reverse()), ["label:higher"]);
  const reversedPriority = labels.map((label) => ({
    ...label,
    priority: label.id === "label:higher" ? 10 : 20,
  }));
  assert.throws(
    () => assert.deepEqual(
      resolveVisibleScreenLabelIds(reversedPriority),
      ["label:higher"],
      "priority-reversal control must retain the original survivor",
    ),
    /priority-reversal control/,
  );
  const reversedSurvivors = resolveVisibleScreenLabelIds(reversedPriority);
  assert.deepEqual(reversedSurvivors, ["label:lower"]);
  context.diagnostic(`label-priority reversal control observed survivor: ${reversedSurvivors.join(",")}`);

  const framingPoints: readonly Coordinates[] = [
    { x: 1, y: 2, z: 3 },
    { x: -4, y: 5, z: -0 },
    { x: 0, y: 0, z: 0 },
  ];
  const perturbed = framingPoints.map((point, index) => ({
    ...point,
    x: index === 0 ? point.x + Number.EPSILON : point.x,
  })).reverse();
  assert.notEqual(perturbed[2]?.x, framingPoints[0]?.x);
  assert.deepEqual(
    canonicalCameraFramingPoints(framingPoints),
    canonicalCameraFramingPoints(perturbed),
  );
  assert.equal(quantizeCameraFramingValue(1 + Number.EPSILON), Math.fround(1));
  assert.ok(quantizeCameraFramingUpperBound(1 + Number.EPSILON) >= 1 + Number.EPSILON);
  context.diagnostic("camera framing order and sub-single-precision control resolved identically");

  const perspectiveScene = scenes.perspective;
  const framingSubjects = sceneCameraFramingSubjects(perspectiveScene);
  assert.ok(framingSubjects.some((subject) => subject.sizeMode === "node" && subject.extentCssPx > 0));
  assert.ok(framingSubjects.some((subject) => subject.sizeMode === "filament" && subject.extentCssPx > 0));
  const bottomSubject = {
    id: "bottom-node",
    horizontalTangent: 0,
    verticalTangent: -1,
    extentCssPx: 40,
  };
  const extentAwareTangent = requiredPerspectiveFramingTangent([bottomSubject], 1_200, 800);
  const extentAwareCenterY = (1 - (bottomSubject.verticalTangent / extentAwareTangent)) * 800 / 2;
  const extentClearance = assertProjectedCameraFramingSubjectsInsideViewport(
    [{ id: bottomSubject.id, viewportCenter: { x: 600, y: extentAwareCenterY }, extentCssPx: 40 }],
    1_200,
    800,
    "extent-aware perspective control",
  );
  const anchorOnlyTangent = requiredPerspectiveFramingTangent(
    [{ ...bottomSubject, extentCssPx: 0 }],
    1_200,
    800,
  );
  const anchorOnlyCenterY = (1 - (bottomSubject.verticalTangent / anchorOnlyTangent)) * 800 / 2;
  const removedExtentOutput = failureOutput(() => assertProjectedCameraFramingSubjectsInsideViewport(
    [{ id: bottomSubject.id, viewportCenter: { x: 600, y: anchorOnlyCenterY }, extentCssPx: 40 }],
    1_200,
    800,
    "removed drawn-extent control",
  ));
  assert.match(removedExtentOutput, /removed drawn-extent control drawn extent .* falls .* outside the capture/);
  context.diagnostic(
    `perspective extent check observed ${extentClearance.checkedSubjectCount} subjects with minimum clearance `
      + `${extentClearance.minimumClearanceCssPx.toFixed(6)} CSS pixels`,
  );
  context.diagnostic(removedExtentOutput);

  const graph = sceneFixtureGraph();
  const anchorMap = new Map(perspectiveScene.nodes.map((node) => [node.id, node.position]));
  const microTarget = highestDegreeNodeId(graph);
  const neighbourhood = immediateNeighbourhoodFraming(graph, anchorMap, microTarget);
  const targetAnchor = anchorMap.get(microTarget);
  assert.ok(targetAnchor !== undefined);
  assert.notDeepEqual(neighbourhood.center, { x: targetAnchor.x, y: targetAnchor.y });
  assert.equal(neighbourhood.nodeIds.includes(microTarget), true);
  context.diagnostic(
    `micro neighbourhood control moved ${microTarget} from its anchor to the bounds midpoint of `
      + `${neighbourhood.nodeIds.length} nodes`,
  );

  const contentAtFirstPixel = pixelImage([11, 11, 11, 255, 9, 9, 9, 255], 2);
  const darkestField = assertDarkestShippingField(contentAtFirstPixel, "darkest-field content control");
  assert.deepEqual(darkestField, [9, 9, 9]);
  const whiteFieldOutput = failureOutput(() => assertDarkestShippingField(
    pixelImage([255, 255, 255, 255], 1),
    "review3d white-field control",
  ));
  assert.match(whiteFieldOutput, /darkest pixel rgb\(255, 255, 255\).*rgb\(9, 9, 9\)/);
  const lightenedFieldOutput = failureOutput(() => assertDarkestShippingField(
    pixelImage([10, 10, 10, 255], 1),
    "review3d lightened-field control",
  ));
  assert.match(lightenedFieldOutput, /darkest pixel rgb\(10, 10, 10\).*rgb\(9, 9, 9\)/);
  const blankFrameOutput = failureOutput(() => assertLitPixelFloor(
    pixelImage([9, 9, 9, 255], 1),
    "review3d blank-frame control",
  ));
  assert.match(blankFrameOutput, /has 0 lit pixels, below the required floor of 1/);
  context.diagnostic(`darkest-field content control observed rgb(${darkestField.join(", ")})`);
  context.diagnostic(whiteFieldOutput);
  context.diagnostic(lightenedFieldOutput);
  context.diagnostic(blankFrameOutput);
});

test("world-anchor witnesses read the mounted buffer copy rather than the handed scene", () => {
  const scenes = resolvedCameraScenes();
  const live = new LiveSceneState(scenes, ORTHOGRAPHIC, cameraKindCount());
  const before = requiredItem(live.readWorldAnchorWitnesses(), 0, "mounted witness before mutation");
  const sceneNode = scenes.orthographic.nodes.find((node) => node.id === before.id);
  assert.ok(sceneNode !== undefined);
  const sceneX = sceneNode.position.x;
  live.buffers.nodes.positions[0] = before.position.x + 1;
  const after = requiredItem(live.readWorldAnchorWitnesses(), 0, "mounted witness after mutation");
  assert.notEqual(after.position.x, before.position.x);
  assert.equal(sceneNode.position.x, sceneX);
});

test("resource registry disposes registered resources exactly once", () => {
  const registry = new ResourceRegistry();
  const geometry = registry.registerGeometry(new THREE.BufferGeometry());
  const material = registry.registerMaterial(new THREE.ShaderMaterial());
  const texture = registry.registerTexture(new THREE.Texture());
  let geometryDisposals = 0;
  let materialDisposals = 0;
  let textureDisposals = 0;
  geometry.addEventListener("dispose", () => { geometryDisposals += 1; });
  material.addEventListener("dispose", () => { materialDisposals += 1; });
  texture.addEventListener("dispose", () => { textureDisposals += 1; });
  registry.disposeAll();
  registry.disposeAll();
  assert.deepEqual(registry.readRetainedResources(0), {
    geometries: 0,
    materials: 0,
    textures: 0,
    domOverlayNodes: 0,
  });
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(textureDisposals, 1);
});

test("repeated renderer resource ownership cycles retain nothing after each teardown", () => {
  for (let cycle = 0; cycle < 16; cycle += 1) {
    const registry = new ResourceRegistry();
    registry.registerGeometry(new THREE.BufferGeometry());
    registry.registerMaterial(new THREE.ShaderMaterial());
    registry.registerTexture(new THREE.Texture());
    assert.deepEqual(registry.readRetainedResources(0), {
      geometries: 1,
      materials: 1,
      textures: 1,
      domOverlayNodes: 0,
    });
    registry.disposeAll();
    assert.deepEqual(registry.readRetainedResources(0), {
      geometries: 0,
      materials: 0,
      textures: 0,
      domOverlayNodes: 0,
    });
  }

  const retained: object[] = [];
  const subject = {
    setCameraKind(): void {
      retained.push({});
    },
    readRetainedResources(): RetainedResourceWitness {
      return {
        geometries: 3,
        materials: 3,
        textures: 1,
        domOverlayNodes: 1,
        jsRetention: {
          status: "MEASURED",
          retainedSceneReferences: retained.length,
        },
      };
    },
  };
  const beforeSwitches = subject.readRetainedResources();
  for (let index = 0; index < 32; index += 1) {
    subject.setCameraKind();
  }
  const growthOutput = failureOutput(() => assertRetainedResourcesDoNotGrow(
    beforeSwitches,
    subject.readRetainedResources(),
  ));
  assert.equal(
    growthOutput,
    "renderer JS retention grew from 0 to 32 retained scene references",
  );
  process.stdout.write(`JS retained-reference growth control observed: ${growthOutput}\n`);

  const unknownOutput = failureOutput(() => assertRetainedResourcesDoNotGrow(
    beforeSwitches,
    {
      geometries: 3,
      materials: 3,
      textures: 1,
      domOverlayNodes: 1,
      jsRetention: { status: "UNKNOWN", reason: "renderer-owned reference inventory unavailable" },
    },
  ));
  assert.equal(
    unknownOutput,
    "renderer JS retention is UNKNOWN after switching: renderer-owned reference inventory unavailable",
  );
  process.stdout.write(`JS retention unknown control observed: ${unknownOutput}\n`);
});

function cameraKindCount(): number {
  return [ORTHOGRAPHIC, PERSPECTIVE].length;
}

function collidingLabels(): readonly ScreenLabelBounds[] {
  return [
    {
      id: "label:lower",
      priority: 10,
      sceneOrder: 0,
      collisionPaddingPx: 5,
      minimumX: 10,
      minimumY: 10,
      maximumX: 30,
      maximumY: 20,
    },
    {
      id: "label:higher",
      priority: 20,
      sceneOrder: 1,
      collisionPaddingPx: 5,
      minimumX: 20,
      minimumY: 10,
      maximumX: 40,
      maximumY: 20,
    },
  ];
}

function requiredItem<T>(values: readonly T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function pixelImage(data: readonly number[], width: number): { readonly width: number; readonly height: 1; readonly data: Uint8Array } {
  return { width, height: 1, data: Uint8Array.from(data) };
}

function failureOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("field control unexpectedly passed");
}

function highestDegreeNodeId(graph: ReturnType<typeof sceneFixtureGraph>): string {
  const degrees = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    if (edge.target !== edge.source) {
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
    }
  }
  const target = [...degrees.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  if (target === undefined) {
    throw new TypeError("micro neighbourhood control has no node");
  }
  return target[0];
}
