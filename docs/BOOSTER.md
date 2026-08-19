# In-world booster packs — feasibility and plan

**Verdict: feasible with stock ProtoFlux. No mods, no plugin, no VPS.**

Every capability it needs is confirmed first-party. The design below is shaped around three hard
constraints that are easy to design past by accident.

## What Resonite actually gives us

| Need | Node / mechanism | Confirmed |
|---|---|---|
| Call the site over HTTP | `Network.GET_String` — `URL` in, `Content` + `StatusCode` out, with `OnResponse`/`OnError`/`OnDenied` | yes |
| Ask the user for network permission | `IsHostAccessAllowedUrl` → `RequestHostAccess` → then GET | yes |
| Read the reply | the Strings family: `IndexOfString`, `Substring`, `StartsWith`, `Parse_Int` | yes |
| Show card art from a URL | `http`/`https` are supported asset schemes, so a `StaticTexture2D` URL can point straight at the site | yes |
| Spawn the pack in front of the user | the cloud-spawn pattern: GET the record URI → `StringToAbsoluteURI` → `ObjectFieldDrive<Uri>` into a spawner's record field | yes |

## The three constraints that shape the design

**1. There is no JSON parser in ProtoFlux.** Responses get taken apart with string operations, one
`IndexOfString` at a time. This is why `PULL-API.md` specifies `format=flat` — `code,rarity` one per
line. That format is not a convenience, it is the only pleasant option. Keep it.

**2. The HTTP nodes expose no custom-headers field.** No `Authorization`, no `X-API-Key`. Anything
resembling auth has to ride in the query string or the POST body. Design the endpoint assuming its
URL is fully public, because in practice it is.

**3. Texture loads fail silently.** An unreachable or malformed asset URL does not raise anything —
the texture simply never arrives and the card stays blank. The tool needs its own timeout and a
visible fallback, or a bad pull looks like a frozen pack.

## Architecture

```
  in-world tool                     Cloudflare Worker              site
  ─────────────                     ─────────────────              ────
  IsHostAccessAllowedUrl
      └ RequestHostAccess  ─────►  (user grants once)
  GET_String  /api/pull?packs=1&format=flat
                              ──►  roll against data/pack-weights.json
                              ◄──  BP01-011,C
                                   BP01-004,U
                                   …7 lines
  parse lines (Strings)
  for each code:
      drive StaticTexture2D.URL ──────────────────────────────────►  /cards/w1024/<CODE>.webp
  reveal
```

The roll happens **server-side**. That is the entire reason this endpoint exists — the website
currently rolls in the browser with `Math.random()`, which anyone can edit in devtools. Moving it
to the Worker is what makes a pull mean something. Both read the same `data/pack-weights.json`, so
in-world and on-site odds cannot drift.

## Card visuals: don't reuse the deck format

The deck object built by `tools/` and `web/` uses **one atlas texture** with `AtlasInfo` GridSize
10×7 and per-card UVs baked into the mesh. There is no way to point card 3 at a different URL —
the atlas is a single image, so changing one card means re-baking the whole sheet. A Worker cannot
do that bake (see `WORKER.md`: an 8192² RGBA bitmap is 256 MiB against a 128 MB ceiling).

So the booster is a **different object**: 7 card quads, each with its own material and its own
`StaticTexture2D`, whose URL is written at runtime. No baking at all, and the pull appears as fast
as the images download.

Practical consequences:
- Card art comes from the site at full size; budget ~150 KB × 7.
- The card **back** and the geometry (rounded corners, thickness) are authored once into the rig,
  not fetched.
- Landscape cards need the same 90° clockwise turn the atlas does. Decide it from the loaded
  texture's aspect ratio, exactly as the front end does — do not hardcode a list.

## Build order

**P0 — the endpoint.** Add `GET /api/pull` to the Worker per `PULL-API.md`. Implement `format=flat`
first; `json` is for the website. Verify by hand in a browser. Nothing in-world yet.

**P1 — talk to it.** An in-world tool that gates host access, GETs the endpoint, parses the 7 lines,
and writes them into a text field. No card visuals. This proves the whole risky half — permissions,
parsing, error paths — while it is still trivial to debug.

**P2 — show the cards.** Seven quads; drive each `StaticTexture2D` URL from a parsed code. Add the
load timeout and blank-card fallback here, not later.

**P3 — the spawner.** Cloud-spawn pattern: the tool writes the pack's record URI into a spawner slot
and it appears in front of the user.

**P4 — the wrapper.** The tear-and-reveal experience, matching the website's ripper.

P0–P2 is the honest milestone: a real randomized pack you can hold. P3 and P4 are presentation.

## Open questions

- **Rate limiting.** With no header auth, `/api/pull` is a public URL anyone can curl in a loop.
  Per-IP limiting in the Worker is the cheap answer, and is probably enough for a fan tool.
- **Seeds.** `PULL-API.md` specifies `seed` for reproducible pulls but it is not implemented. Worth
  having before shared sessions, so everyone in a world sees the same pack.
- **Who pays for a re-roll?** If the tool can call `/api/pull` twice, a user can reroll a bad pack by
  re-triggering the spawner. If that matters, the roll has to be bound to something — a short-lived
  token issued per spawn, or per-user rate limiting.
