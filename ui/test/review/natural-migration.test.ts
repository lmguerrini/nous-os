import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deserializeBookmark, serializeBookmark, type Bookmark,
} from '../../src/engine/bookmark.ts';
import {
  deserializeSavedVisualState, serializeVisualState,
} from '../../src/engine/visual-state.ts';
import type { VisualGraph } from '../../src/engine/contract.ts';
import {
  normalizeAxesInput, parseSavedAxes, serializeAxes, type Axes,
} from '../../src/review/view-contract.ts';

const LEGACY_AXES = '{"projection":"2d","morphology":"neural","organization":"flat","colour":"bw","labels":true,"reading":"attested"}';
const LEGACY_EXPLICIT_AXES = '{"projection":"3d","morphology":"stellar","organization":"flat","colour":"sepia","labels":false,"reading":"combined","arrangement":"mycelium"}';
const NO_FLAT = /(?:"organization"\s*:\s*"flat"|%22organization%22%3A%22flat%22)/i;

function bookmark(organization: 'flat' | 'natural', arrangement?: 'constellation' | 'network' | 'mycelium'): Bookmark {
  return {
    temporalPosition: 'all-time', governedTargetId: null,
    viewState: { x: 0, y: 0, angle: 0, ratio: 1 },
    title: 'synthetic bookmark', note: '', visibility: 'graph',
    view: { organization: organization as 'natural', ...(arrangement ? { arrangement } : {}) },
  };
}

function legacyVisualState(organization: 'flat' | 'natural', arrangement?: 'constellation' | 'network' | 'mycelium') {
  return {
    selectedId: null, focusedId: null,
    camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },
    cameraKind: 'orthographic', morphology: 'neural', organization,
    palette: 'monochrome', temperature: 'balanced', theme: 'dark', lodBand: 'micro', reducedMotion: true,
    ...(arrangement ? { arrangement } : {}),
  };
}

test('saved JSON, local-storage text, URL hash and page-hook axes input migrate flat to Natural', () => {
  const parsed = parseSavedAxes(LEGACY_AXES);
  assert.equal(parsed.organization, 'natural');
  assert.equal(parsed.arrangement, 'network');

  // Local storage stores the saved JSON string; URL hash carries that same string in view=.
  const stored = serializeAxes(parsed);
  const loadedFromStorage = parseSavedAxes(stored);
  const urlHash = `#view=${encodeURIComponent(LEGACY_AXES)}`;
  const hashView = new URLSearchParams(urlHash.slice(1)).get('view');
  assert.ok(hashView);
  const loadedFromHash = parseSavedAxes(hashView);
  for (const loaded of [loadedFromStorage, loadedFromHash]) {
    assert.equal(loaded.organization, 'natural');
    assert.equal(loaded.arrangement, 'network');
    const wire = serializeAxes(loaded);
    assert.doesNotMatch(wire, NO_FLAT);
    assert.equal(serializeAxes(parseSavedAxes(wire)), wire, 'serialize/parse is a stable fixed point');
  }

  // __d067.setAxes passes its hook argument through this shared input boundary.
  const hookArgument: Partial<Axes> = normalizeAxesInput({ organization: 'flat', morphology: 'neural' });
  assert.equal(hookArgument.organization, 'natural');
  assert.throws(() => normalizeAxesInput({ organization: 'planar' as never }), /closed vocabulary/);
});

test('legacy visual-state JSON and explicit arrangements migrate without style-default replacement', () => {
  const emptyGraph = { schema_version: 'synthetic', policy_id: 'synthetic',
    question: { valid_at: null, recorded_as_of: null }, nodes: [], edges: [] } as VisualGraph;
  const old = JSON.parse(LEGACY_AXES) as Record<string, unknown>;
  const legacyState = { ...legacyVisualState('flat'), selectedId: null, focusedId: null };
  const serializedLegacy = JSON.stringify(legacyState);
  const migrated = deserializeSavedVisualState(emptyGraph, serializedLegacy);
  assert.equal(migrated.organization, 'natural');
  assert.equal(migrated.arrangement, 'network', 'legacy morphology resolves once on saved-state read');
  const wire = serializeVisualState(migrated);
  assert.doesNotMatch(wire, NO_FLAT);
  assert.equal(serializeVisualState(deserializeSavedVisualState(emptyGraph, wire)), wire);

  const explicit = deserializeSavedVisualState(emptyGraph, JSON.stringify(legacyVisualState('flat', 'mycelium')));
  assert.equal(explicit.organization, 'natural');
  assert.equal(explicit.arrangement, 'mycelium', 'an explicit arrangement wins over Neural’s default');
  assert.equal(JSON.parse(serializeVisualState(explicit)).arrangement, 'mycelium');
  assert.equal(parseSavedAxes(LEGACY_EXPLICIT_AXES).arrangement, 'mycelium');
  assert.equal(old.organization, 'flat', 'migration does not mutate caller data');
});

test('bookmark migration keeps a declared arrangement and serializes the canonical spelling', () => {
  const old = bookmark('flat', 'constellation');
  const loaded = deserializeBookmark(JSON.stringify(old));
  assert.equal(loaded.view?.organization, 'natural');
  assert.equal(loaded.view?.arrangement, 'constellation');
  const wire = serializeBookmark(loaded);
  assert.doesNotMatch(wire, NO_FLAT);
  assert.equal(serializeBookmark(deserializeBookmark(wire)), wire);
});
