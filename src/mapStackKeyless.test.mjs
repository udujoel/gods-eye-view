// Running WITHOUT a Google Maps API key.
//
// The key buys two unrelated things: the photorealistic 3D tileset, which is
// metered per rendering session, and geocoding. Neither is needed for the live
// data layers, so a keyless deployment is a supported configuration — the app
// starts on OSM (or Bing, with a Cesium ion token) and every layer still works.
//
// These tests pin the two behaviours that make that safe: a session that does
// not start on Google 3D must not create the tileset (creating it IS the
// billable event), and it must still be able to switch to it on demand.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapStackController } from './mapStackController.js';

/** Minimal viewer stand-in — the paths under test only touch these. */
function makeViewer() {
  const added = [];
  return {
    added,
    scene: { primitives: { add: (p) => { added.push(p); return p; } }, globe: {} },
    imageryLayers: { add() {}, remove() {} },
  };
}

test('with no key and no factory, Google 3D is unavailable and OSM is the start stack', () => {
  const controller = new MapStackController(makeViewer(), {
    googleTileset: null,
    googleTilesetFactory: null,
    cesiumToken: '',
    initialStack: 'osm',
  });

  assert.equal(controller.getActiveId(), 'osm');
  assert.equal(controller.isStackAvailable('photoreal'), false);
  assert.equal(controller.isStackAvailable('osm'), true);
  // Bing needs an ion token, which this session has no more of than a Google key.
  assert.equal(controller.isStackAvailable('bing-aerial'), false);
});

test('the unavailable reason names the missing Google key, not a generic failure', () => {
  const controller = new MapStackController(makeViewer(), { cesiumToken: '' });
  const photoreal = controller.getStacks().find((s) => s.id === 'photoreal');
  assert.equal(photoreal.available, false);
  assert.match(photoreal.unavailableReason, /Google Maps API key/i);

  const bing = controller.getStacks().find((s) => s.id === 'bing-aerial');
  assert.match(bing.unavailableReason, /ion token/i);
});

test('an impossible start stack falls back instead of leaving a dead selection', () => {
  // Asked for Bing with no ion token.
  const bingNoToken = new MapStackController(makeViewer(), { initialStack: 'bing-aerial', cesiumToken: '' });
  assert.equal(bingNoToken.getActiveId(), 'osm');

  // Asked for Google 3D with no key at all.
  const photorealNoKey = new MapStackController(makeViewer(), { initialStack: 'photoreal' });
  assert.equal(photorealNoKey.getActiveId(), 'osm');
});

test('a requested Bing start stack is honoured when the ion token is present', () => {
  const controller = new MapStackController(makeViewer(), {
    initialStack: 'bing-aerial',
    cesiumToken: 'ion-token',
  });
  assert.equal(controller.getActiveId(), 'bing-aerial');
});

test('deferring Google 3D keeps it selectable without creating the tileset', () => {
  let calls = 0;
  const viewer = makeViewer();
  const controller = new MapStackController(viewer, {
    googleTileset: null,
    googleTilesetFactory: () => { calls += 1; return Promise.resolve({ show: false }); },
    initialStack: 'osm',
  });

  // Offered in the tray...
  assert.equal(controller.isStackAvailable('photoreal'), true);
  // ...but nothing was built, and nothing was billed.
  assert.equal(calls, 0);
  assert.equal(viewer.added.length, 0);
  assert.equal(controller.getActiveId(), 'osm');
});

test('concurrent switches into Google 3D create the tileset once, not twice', async () => {
  let calls = 0;
  const viewer = makeViewer();
  const controller = new MapStackController(viewer, {
    googleTilesetFactory: () => { calls += 1; return Promise.resolve({ show: false }); },
    initialStack: 'osm',
  });

  // A double-click must not buy two rendering sessions.
  const [a, b] = await Promise.all([
    controller._ensureGoogleTileset(),
    controller._ensureGoogleTileset(),
  ]);

  assert.equal(calls, 1);
  assert.equal(viewer.added.length, 1);
  assert.equal(a, b);
  assert.equal(controller.googleTileset, a);
});

test('a failed creation does not poison later attempts', async () => {
  let calls = 0;
  const controller = new MapStackController(makeViewer(), {
    googleTilesetFactory: () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('quota')) : Promise.resolve({ show: false });
    },
    initialStack: 'osm',
  });

  await assert.rejects(() => controller._ensureGoogleTileset(), /quota/);
  const tileset = await controller._ensureGoogleTileset();
  assert.ok(tileset);
  assert.equal(calls, 2);
});
