/**
 * Vercel catch-all function backing the whole /api/* surface.
 *
 * A single catch-all rather than one file per route: the proxies are mounted
 * by vite.config.js in a fixed order and several of them (Overpass/route,
 * the three OpenAI realtime paths, the two Google Places paths) share
 * per-instance caches and budget counters. Splitting them across functions
 * would give each its own cold instance and quietly multiply upstream calls.
 */
import { handleGevApi } from '../server/gevApi.js';

export default async function handler(req, res) {
  return handleGevApi(req, res);
}
