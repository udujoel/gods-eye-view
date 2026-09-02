/**
 * Vercel entrypoint for the whole /api/* surface.
 *
 * A single function rather than one per route: the proxies are mounted by
 * vite.config.js in a fixed order and several of them (Overpass/route, the
 * three OpenAI realtime paths, the two Google Places paths) share per-instance
 * caches and budget counters. Splitting them across functions would give each
 * its own cold instance and quietly multiply upstream calls.
 *
 * Requests arrive here through an explicit rewrite in vercel.json rather than
 * a `[...path].js` catch-all filename. The filename convention was observed to
 * match only a single path segment on this project — `/api/_health` reached the
 * function while `/api/tomtom/status` fell through to Vercel's own 404 — which
 * would have left most of the surface dead, since only 11 of the 23 mounts are
 * single-segment. The rewrite carries the original path in `__gevPath` so the
 * dispatcher still sees the URL the client actually asked for.
 */
import { handleGevApi } from '../server/gevApi.js';

/** Query parameter carrying the pre-rewrite path. Must match vercel.json. */
const ROUTED_PATH_PARAM = '__gevPath';

/**
 * Reconstruct the URL the client requested, undoing the vercel.json rewrite.
 *
 * The rewrite rewrites `/api/tomtom/status?x=1` to
 * `/api/gev?__gevPath=tomtom/status&x=1`. The proxies match on mount paths like
 * `/api/tomtom`, so the original path has to be put back before dispatch, with
 * the caller's own query string preserved and the routing parameter stripped.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string} the effective request URL, query string included
 */
export function effectiveUrl(req) {
  const raw = req.url || '/';
  const parsed = new URL(raw, 'http://gev.invalid');
  const routed = parsed.searchParams.get(ROUTED_PATH_PARAM);
  if (routed === null) return raw;

  parsed.searchParams.delete(ROUTED_PATH_PARAM);
  const path = `/api/${routed.replace(/^\/+/, '').replace(/^api\//, '')}`;
  const query = parsed.searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export default async function handler(req, res) {
  req.url = effectiveUrl(req);
  return handleGevApi(req, res);
}
