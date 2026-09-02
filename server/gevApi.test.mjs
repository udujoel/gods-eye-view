/**
 * Dispatcher tests for the serverless /api/* adapter.
 *
 * These cover the two pieces of logic the adapter owns rather than borrows:
 * mount-prefix stripping, and rebuilding a request body the platform already
 * parsed. Everything else is the proxy plugins' own behaviour, exercised by
 * their own tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripMount } from './gevApi.js';

test('stripMount hands the handler its mount-relative URL', () => {
  assert.equal(stripMount('/api/celestrak/active', '/api/celestrak'), '/active');
  assert.equal(stripMount('/api/celestrak', '/api/celestrak'), '/');
  assert.equal(stripMount('/api/celestrak?group=x', '/api/celestrak'), '/?group=x');
  assert.equal(stripMount('/api/terrain/heights?lat=1', '/api/terrain/heights'), '/?lat=1');
});

test('stripMount only matches on a path boundary', () => {
  // The regression this guards: /api/opensky-track is its own mount and must
  // not be swallowed by the /api/opensky one registered before it.
  assert.equal(stripMount('/api/opensky-track?icao24=abc', '/api/opensky'), null);
  assert.equal(stripMount('/api/opensky/states', '/api/opensky'), '/states');
  assert.equal(stripMount('/api/adsblol/trace?hex=a', '/api/adsblol/mil'), null);
  assert.equal(stripMount('/api/radiography', '/api/radio'), null);
});

test('stripMount misses cleanly on an unrelated URL', () => {
  assert.equal(stripMount('/api/nope', '/api/celestrak'), null);
  assert.equal(stripMount('/', '/api/celestrak'), null);
});

test('a root mount passes the URL through untouched', () => {
  assert.equal(stripMount('/api/anything?q=1', '/'), '/api/anything?q=1');
});

/**
 * The vercel.json rewrite carries the pre-rewrite path in a query parameter,
 * because the `[...path].js` catch-all filename was observed to match only one
 * path segment in production: `/api/_health` reached the function while
 * `/api/tomtom/status` fell through to Vercel's own 404.
 */
test('effectiveUrl restores the path the client asked for', async () => {
  const { effectiveUrl } = await import('../api/gev.js');
  const url = (raw) => effectiveUrl({ url: raw });

  // The failing case: a two-segment route.
  assert.equal(url('/api/gev?__gevPath=tomtom/status'), '/api/tomtom/status');
  // Deeper still — tile coordinates.
  assert.equal(url('/api/gev?__gevPath=tomtom/flow/12/34/56.pbf'), '/api/tomtom/flow/12/34/56.pbf');
  // Single segment, which worked even before the rewrite.
  assert.equal(url('/api/gev?__gevPath=overpass'), '/api/overpass');
});

test('effectiveUrl preserves the caller query and strips only the routing key', async () => {
  const { effectiveUrl } = await import('../api/gev.js');
  const out = effectiveUrl({ url: '/api/gev?__gevPath=celestrak/active&group=starlink' });
  assert.equal(out, '/api/celestrak/active?group=starlink');
  assert.ok(!out.includes('__gevPath'));
});

test('effectiveUrl leaves a direct request untouched', async () => {
  const { effectiveUrl } = await import('../api/gev.js');
  // No rewrite applied (local dev, or a direct hit on the function).
  assert.equal(effectiveUrl({ url: '/api/celestrak/active' }), '/api/celestrak/active');
  assert.equal(effectiveUrl({ url: '/api/_health' }), '/api/_health');
});
