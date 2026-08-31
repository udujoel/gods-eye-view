# Deploying God's Eye View to Vercel

This project was built to run from `vite dev` on your own machine. Every backend
route — all 23 of them — is a Vite dev-server middleware registered by the proxy
plugins in `vite.config.js`. A plain `vite build` emits static assets and nothing
else, so a naive static deploy answers 404 on every layer that needs a
CORS-bypassing or key-brokering proxy.

These three files close that gap without forking the proxy logic:

| File | Role |
|---|---|
| `server/gevApi.js` | Re-mounts the same plugin instances behind a minimal Connect-compatible dispatcher |
| `api/[...path].js` | The single Vercel function that drives it |
| `vercel.json` | Build command, output directory, function limits, asset caching |

One source of truth: fix a proxy for the dev server and the deployed site
inherits the fix.

---

## Before you deploy: cap your spend

The app has **no authentication of its own**. Anyone who can load the page can
spend your Google Maps and OpenAI quota. Do these first.

1. **Restrict the Google Maps key.** Google Cloud Console → APIs & Services →
   Credentials → your key:
   - *Application restrictions* → **Websites**, and add your Vercel hostname
     (`https://<project>.vercel.app/*`). The key is compiled into the browser
     bundle by design and **is visible in devtools** — the referrer restriction,
     not secrecy, is what protects it.
   - *API restrictions* → restrict to **Map Tiles API** (plus Geocoding and
     Places only if you want search and voice place lookup).
2. **Set a hard quota**, not just an alert. APIs & Services → Map Tiles API →
   Quotas. A budget alert emails you *after* the money is spent; a quota cap
   stops the requests.
3. **Set a budget alert too.** Billing → Budgets & alerts.
4. **Set an OpenAI usage limit** if you add `OPENAI_API_KEY`. The app's in-session
   `$5` cap is a client-side guard, not a billing backstop.
5. **Keep Vercel Authentication on** (Project → Settings → Deployment Protection)
   until the above is done.

---

## Environment variables

Set these in **Project → Settings → Environment Variables**, then redeploy.
`GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` are read at **build** time (they are
compiled into the bundle), so a change to either needs a fresh deployment to
take effect.

| Variable | Required | Effect if missing |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | **Yes** | App throws on startup and renders nothing |
| `OPENAI_API_KEY` | No | Voice control and the AI HUD summary report unavailable |
| `CESIUM_ION_TOKEN` | No | Bing imagery map stacks unavailable |
| `TOMTOM_API_KEY` | No | Traffic falls back to its labeled simulation |
| `FIRMS_MAP_KEY` | No | Active Fires layer shows "KEY REQUIRED" |
| `OPENSKY_AUTH_MODE` | No | Defaults to `oauth`; set `anon` for keyless flights |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | No | Anonymous polling limits apply |
| `GEV_RATELIMIT_OPENAI_PER_MIN` | No | **Unlimited.** Set a value on a public deploy |
| `GEV_RATELIMIT_GOOGLE_PER_MIN` | No | **Unlimited.** Set a value on a public deploy |

`AISSTREAM_API_KEY` has no effect here — see below.

---

## What does not survive the move to serverless

**Live vessels (AIS).** `/api/ais-live` returns a 503 explaining itself. The
layer needs a WebSocket held open to AISStream, accumulating vessel positions in
process memory. A serverless instance is frozen between requests and discarded
without warning, so the socket would be opened and abandoned on every cold start
while never accumulating enough of a cache to answer with. Run the project
locally for this layer.

**Realtime debug log.** `/api/realtime/debug-log` returns 204. It writes into the
checkout, which is read-only here.

**Warm disk caches.** The proxies cache to `.gev-cache/` under the working
directory. On Vercel that moves to the instance's temp directory
(`server/gevApi.js` does this before the plugins are evaluated, because they
compute their cache roots at module scope). The cache lives only as long as the
instance, which is what it is for: collapsing repeat upstream calls made by one
warm instance. Expect more upstream traffic than a long-running local server,
and watch the metered layers accordingly.

**Long Overpass queries.** The Overpass proxy allows itself 22 s upstream; the
function is configured for `maxDuration: 60`. On a plan with a lower ceiling,
large boundary queries ("outline the state of Texas") may time out.

---

## Local development is unchanged

`npm run dev` still works exactly as before. The only change to `vite.config.js`
is that its default export is now an **async** factory that imports `vite` and
`vite-plugin-cesium` lazily, so that `server/gevApi.js` can import the proxy
plugins from a plain Node runtime without dragging the Vite toolchain into the
serverless bundle. Vite supports async config factories natively.

---

## Checking a deployment

`GET /api/_health` returns the mounted route table and the routes deliberately
disabled:

```bash
curl https://<your-deployment>/api/_health
```
