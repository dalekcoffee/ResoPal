# ResoPal proxy — Cloudflare Worker setup

## What this is (and isn't)

A Worker is **not a server you run or maintain.** There's no VM, no container, no uptime to babysit,
nothing to patch. You upload ~50 lines of JavaScript; Cloudflare runs it at the edge when a request
arrives and charges nothing until 100,000 requests a day. If nobody uses the site, nothing runs.

It exists for one reason: **Palify sends no CORS headers.** A browser can display a cross-origin
image but not read its pixels, and baking a card atlas is exactly pixel reading. This Worker
re-serves the same bytes with headers that make them readable — and caches them at the edge, so
Palify gets hit roughly once per image, ever, rather than once per user per bake.

It deliberately does **not** bake anything. An 8192×8192 RGBA bitmap is 256 MiB against a Worker's
128 MB ceiling. The bake stays in the browser. See `../docs/WORKER.md`.

## Routes

| Route | Purpose |
|---|---|
| `/health` | returns `{ok:true}` — use it to confirm the deploy |
| `/img/<CODE>?w=256\|512\|1024` | card art, CORS-enabled, edge-cached for a year |
| `/api/pull` | roll booster packs — see `../docs/PULL-API.md` |
| `/api/deck` | a committed deck list, in the same records |
| `/api/resolve` | **a pasted palify deck link or decklist**, in the same records |
| `/deck/<uuid>` | raw RSC flight payload for a deck page |
| `/profile/<handle>` | raw RSC flight payload for a profile page |

`/api/resolve` is the one route that also accepts **POST**, because ProtoFlux cannot put a 2 KB
decklist in a query string. The body is whatever the user pasted; `src/resolve.js` works out
whether that was a deck link, a bare deck id or a list, and every code is checked against Palify's
own catalogue before it is served. See `../docs/PULL-API.md`.

`/deck` and `/profile` return the payload **unparsed**. `/api/resolve` is the parsed form of the
first of those; these two stay for looking at what Palify actually returns when the format changes.

## Setup A — the Cloudflare dashboard (no CLI)

Everything here happens in the browser. `wrangler.toml` is **not** used on this path; the same
settings live in the dashboard UI instead.

### 1. Create the Worker

**Workers & Pages → Create → Start with Hello World!**

Not "Continue with GitHub" — that path wants a build configuration and a root directory, which is
more setup than this needs. You can switch to it later without losing anything.

Name it **`resopal-proxy`** and click **Deploy**. It deploys a placeholder; that's expected.

### 2. Paste the real code

**Edit code** (top right) → select everything in the editor → replace it with the contents of
[`worker/src/index.js`](src/index.js) → **Deploy**.

On GitHub, the raw view has a copy button:
`https://github.com/dalekcoffee/ResoPal/blob/main/worker/src/index.js`

The dashboard editor and this file are both ES-module format (`export default { fetch }`), so it
drops in as-is.

### 3. Test before touching DNS

The Worker's URL is on the overview page, like
`https://resopal-proxy.<account>.workers.dev`. In a browser:

- `…/health` → `{"ok":true,"service":"resopal-proxy"}`
- `…/img/TD01-001` → a card image

If `/health` works and `/img` doesn't, the problem is the card code or upstream — not your setup.
**Don't move on until both work**, or you'll be debugging DNS and the Worker at the same time.

### 4. Custom domain

**Settings → Domains & Routes → Add → Custom Domain**, enter `resopalworker.dalek.coffee`, save.

Requires `dalek.coffee` to be a zone in the same Cloudflare account. **Cloudflare creates the DNS
record itself — do not add a CNAME by hand**, it shadows the route and the Worker silently stops
answering.

### 5. Point the site at it

In `index.html`, set `ART_PROXY` to the Worker's URL, commit, push. Covered again below.

---

## Setup B — the CLI

**Prerequisites:** Node 18+ and a Cloudflare account (free tier is fine).

### 1. Log in

```bash
cd worker
npx wrangler login
```

Opens a browser to authorise. One time only.

### 2. Deploy

```bash
npx wrangler deploy
```

That's the whole deploy. It prints a URL like:

```
https://resopal-proxy.<your-account>.workers.dev
```

### 3. Test it before touching DNS

```bash
curl https://resopal-proxy.<your-account>.workers.dev/health
# {"ok":true,"service":"resopal-proxy"}

curl -sI https://resopal-proxy.<your-account>.workers.dev/img/TD01-001 | grep -i -E 'http/|content-type|access-control'
# HTTP/2 200
# content-type: image/webp
# access-control-allow-origin: https://resopal.dalek.coffee
```

If `/health` works but `/img` doesn't, the problem is upstream or the card code — not your setup.
**Do not move on until both work**, or you'll be debugging DNS and the Worker at the same time.

### 4. Custom domain (optional)

`resopalworker.dalek.coffee` works fine — the hostname doesn't matter to anything. It requires
`dalek.coffee` to be a zone in the **same** Cloudflare account.

Uncomment the route block in `wrangler.toml`:

```toml
[[routes]]
pattern = "resopalworker.dalek.coffee"
custom_domain = true
```

then `npx wrangler deploy` again. **Cloudflare creates the DNS record itself — do not add a CNAME
by hand**, it conflicts and the route silently fails to attach.

### 5. Point the site at it

In `index.html`, set the constant near the top of the script block:

```js
const ART_PROXY = 'https://resopalworker.dalek.coffee';
```

Commit and push. Every deck now bakes, not just ones with art committed under `data/art/`.

## Editing the Worker later

Dashboard: **Workers & Pages → resopal-proxy → Edit code**. Changes there are not reflected back
into this repo, so if you edit in the browser, paste the result into `worker/src/index.js` and
commit it — otherwise the repo copy silently becomes wrong.

## Changing the allowed origins

`ALLOWED` at the top of `src/index.js` lists who may read the responses. An origin that isn't on the
list gets the first entry back instead of its own, so the browser blocks it. Add entries there if
you serve the site from anywhere else, then redeploy.

## Cost

Free tier: **100,000 requests/day**. A 50-card deck import is ~24 image requests (one per distinct
card, not per copy), so roughly 4,000 imports a day before the limit — and cached responses are
served from the edge. Workers have no bandwidth charge.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no such route` | path typo — routes are `/img/`, `/deck/`, `/profile/` |
| `bad card code` | the code failed `^[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4}$` |
| `upstream 404` | Palify has no art at that code and width |
| CORS error in the browser, Worker returns 200 to curl | the site's origin isn't in `ALLOWED` |
| Custom domain 522/1016 | a hand-made DNS record is shadowing the Worker route; delete it and redeploy |

## Local development

```bash
npx wrangler dev
```

Serves on `http://localhost:8787` against the real Palify. `http://localhost:8000` is already in
`ALLOWED`, so a site served locally on port 8000 can talk to it.
