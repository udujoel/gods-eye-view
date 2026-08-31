/**
 * Serverless adapter for the God's Eye View /api/* surface.
 *
 * Every backend route in this project is a Vite dev-server middleware: the
 * proxy plugins in vite.config.js register themselves through
 * `server.middlewares.use(mountPath, handler)` and are therefore only alive
 * while `vite dev` (or `vite preview`) is running. A production `vite build`
 * emits static assets and nothing else, so a plain static deploy answers 404
 * on every layer that needs a key-brokering or CORS-bypassing proxy.
 *
 * Rather than reimplement those twenty proxies, this module re-mounts the very
 * same plugin instances behind a minimal Connect-compatible dispatcher that a
 * Node serverless function can drive. One source of truth: fix a proxy for the
 * dev server and the deployed site inherits the fix.
 *
 * Two proxies cannot survive the move and are handled explicitly below:
 * the AIS vessel feed (needs a process-lifetime WebSocket) and the realtime
 * debug log (needs a writable checkout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * Point the proxies' disk caches at a writable directory.
 *
 * The plugins derive their cache roots from `process.cwd()` at module scope
 * (`.gev-cache/overpass`, `.gev-cache/tomtom`, …). On a serverless runtime the
 * deployment bundle is read-only and only the temp directory accepts writes,
 * so the working directory has to move BEFORE vite.config.js is evaluated —
 * hence the dynamic import further down rather than a static one.
 *
 * The cache survives only as long as the underlying instance, which is exactly
 * what it is for: collapsing repeat upstream calls made by one warm instance.
 */
function useWritableCacheRoot() {
  const root = process.env.GEV_CACHE_ROOT
    || (process.env.VERCEL ? path.join(os.tmpdir(), 'gev') : null);
  if (!root) return null;
  try {
    fs.mkdirSync(root, { recursive: true });
    process.chdir(root);
    return root;
  } catch {
    // A read-only temp dir is survivable: the proxies all treat their disk
    // cache as best-effort and fall back to memory + upstream.
    return null;
  }
}

useWritableCacheRoot();

const viteConfigModule = await import('../vite.config.js');

/**
 * Proxy plugins to mount, in registration order.
 *
 * `aisLiveProxy` is deliberately absent: it holds an open WebSocket to
 * AISStream and accumulates vessel positions in process memory. A serverless
 * instance is frozen between requests and discarded without warning, so the
 * socket would be opened and abandoned on every cold start while never
 * accumulating enough of a cache to answer with. `/api/ais-live` gets an
 * honest 503 instead (see `unavailableRoutes`).
 */
const PLUGIN_FACTORY_NAMES = [
  'openSkyProxy',
  'celestrakProxy',
  'tomtomProxy',
  'firmsProxy',
  'rocketLaunchesProxy',
  'terrainHeightsProxy',
  'adsbdbProxy',
  'overpassProxy',
  'militaryInstallationsProxy',
  'regionalBriefProxy',
  'weatherEffectsProxy',
  'cctvProxy',
  'radioBrowserProxy',
  'gbfsProxy',
  'adsbLolProxy',
  'trackBackfillProxies',
  'openAiRealtimeProxy',
  'googlePlacesContextProxy',
];

/**
 * Routes that exist in dev but cannot be served here, with the reason the
 * client should surface. Matched before the plugin stack so a stale mount can
 * never shadow them.
 */
const unavailableRoutes = [
  {
    route: '/api/ais-live',
    status: 503,
    body: {
      error: 'ais_live_unavailable',
      detail: 'The live AIS vessel feed needs a persistent WebSocket to AISStream, '
        + 'which a serverless deployment cannot hold open. Run the project locally '
        + 'with AISSTREAM_API_KEY set for this layer.',
    },
  },
  {
    route: '/api/realtime/debug-log',
    status: 204,
    body: null,
  },
];

/**
 * Connect's mount semantics, reduced to what the proxies actually rely on.
 *
 * A handler mounted at `/api/celestrak` expects to see `req.url` as `/active`
 * — Connect strips the mount prefix and leaves a leading slash. The prefix only
 * matches on a path boundary, which is what keeps `/api/opensky-track` from
 * being swallowed by the `/api/opensky` mount.
 *
 * @param {string} url — the incoming request URL, query string included
 * @param {string} route — the mount path a handler was registered at
 * @returns {string|null} the rewritten URL, or null when the mount misses
 */
export function stripMount(url, route) {
  if (route === '/' || route === '') return url;
  if (!url.startsWith(route)) return null;
  const rest = url.slice(route.length);
  if (rest === '') return '/';
  if (rest.startsWith('/')) return rest;
  if (rest.startsWith('?')) return `/${rest}`;
  return null;
}

/**
 * Collect the middleware registrations the proxy plugins would install on a
 * real Vite dev server, without starting one.
 *
 * @returns {Array<{route: string, handler: Function, plugin: string}>}
 */
function collectMiddlewareStack() {
  const stack = [];
  for (const name of PLUGIN_FACTORY_NAMES) {
    const factory = viteConfigModule[name];
    if (typeof factory !== 'function') continue;
    let plugin;
    try {
      plugin = factory();
    } catch {
      // A proxy that cannot even be constructed (bad env, missing optional
      // dependency) must not take the other nineteen down with it.
      continue;
    }
    const install = plugin?.configureServer;
    if (typeof install !== 'function') continue;
    const middlewares = {
      use(route, fn) {
        if (typeof route === 'function') stack.push({ route: '/', handler: route, plugin: plugin.name });
        else stack.push({ route, handler: fn, plugin: plugin.name });
        return middlewares;
      },
    };
    try {
      install({ middlewares, config: {}, httpServer: null });
    } catch {
      // Same rationale as above — installation side effects are best-effort.
    }
  }
  return stack;
}

/** Built once per instance and reused across warm invocations. */
const middlewareStack = collectMiddlewareStack();

/** Route table, for the /api/_health diagnostic. */
export function describeRoutes() {
  return {
    mounted: middlewareStack.map((entry) => ({ route: entry.route, plugin: entry.plugin })),
    unavailable: unavailableRoutes.map((entry) => entry.route),
  };
}

/**
 * Present a request to a handler under its mount-relative URL.
 *
 * Connect rewrites `req.url` in place, and so do we: prototype-cloning an
 * IncomingMessage (`Object.create(req)`) produces an object whose stream
 * internals are shared with the original, which crashes Node's readable
 * machinery the moment either side ends or errors.
 *
 * The one case that genuinely needs a different object is a body the platform
 * already drained. Vercel's Node runtime buffers the request and exposes it as
 * `req.body`, leaving the stream ended — but `/api/overpass` and
 * `/api/realtime/token` read the raw stream, so those bytes have to be handed
 * back as a fresh readable carrying the original method, url and headers.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} url — the mount-stripped URL to present to the handler
 * @returns {import('node:http').IncomingMessage|import('node:stream').Readable}
 */
function prepareRequest(req, url) {
  const originalUrl = req.originalUrl || req.url;
  const carriesBody = req.method !== 'GET' && req.method !== 'HEAD';
  const drained = req.readableEnded || req.complete;

  if (!carriesBody || !drained) {
    req.originalUrl = originalUrl;
    req.url = url;
    return req;
  }

  const body = req.body;
  let raw = null;
  if (Buffer.isBuffer(body)) raw = body;
  else if (typeof body === 'string') raw = Buffer.from(body);
  else if (body && typeof body === 'object') raw = Buffer.from(JSON.stringify(body));

  const shim = Readable.from(raw ? [raw] : []);
  shim.method = req.method;
  shim.headers = req.headers;
  shim.httpVersion = req.httpVersion;
  shim.socket = req.socket;
  shim.url = url;
  shim.originalUrl = originalUrl;
  return shim;
}

/**
 * Run one mounted handler to completion.
 *
 * Resolves when the handler has written a response, called `next()` to decline,
 * or returned without doing either. Rejects only on a thrown error.
 *
 * @param {Function} handler
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
function runHandler(handler, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res.off('finish', finish);
      res.off('close', finish);
      resolve();
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      res.off('finish', finish);
      res.off('close', finish);
      reject(err);
    };
    res.on('finish', finish);
    res.on('close', finish);
    try {
      Promise.resolve(handler(req, res, finish)).then(() => {
        // A handler that returned without responding is declining the request;
        // the loop moves on to the next mount.
        if (res.writableEnded || res.headersSent) finish();
        else finish();
      }, fail);
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Dispatch one request through the re-mounted proxy stack.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function handleGevApi(req, res) {
  const url = req.url || '/';

  for (const entry of unavailableRoutes) {
    if (stripMount(url, entry.route) === null) continue;
    if (entry.body === null) {
      res.writeHead(entry.status, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(entry.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(entry.body));
    return;
  }

  if (stripMount(url, '/api/_health') !== null) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, routes: describeRoutes() }, null, 2));
    return;
  }

  for (const entry of middlewareStack) {
    const rewritten = stripMount(url, entry.route);
    if (rewritten === null) continue;
    try {
      await runHandler(entry.handler, prepareRequest(req, rewritten), res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        // Sanitized: upstream error text can carry the API key that was used.
        res.end(JSON.stringify({ error: 'proxy_failed', route: entry.route }));
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    if (res.writableEnded || res.headersSent) return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'unknown_route', url }));
}
