# In-world booster packs — feasibility and plan

**Verdict: feasible with stock ProtoFlux. No mods, no plugin, no VPS.**

**Status: P0–P2 built, as a UIX panel.** `/api/pull` and `/api/deck` are in the Worker, the site
rolls through the former, and `booster/out/ResoPal_Panel.resonitepackage` is a grabbable panel with
five buttons — two trial decks and 1/3/10 boosters. See `booster/README.md`. P3 (cloud spawn) and
P4 (the tear wrapper) are not started.

The first attempt at this shipped logic-only ProtoFlux with no UI, and it was rightly rejected as
unusable: there was nothing to look at unless the network call already worked, and the node
positions were spaced tighter than a ProtoFlux node visual, so unpacking produced an overlapping
heap. Both are now gated by tests — `booster/test-panel.mjs` asserts the panel's UI exists and that
no two node groups overlap.

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

The roll happens **server-side**. That is the entire reason this endpoint exists — the website used
to roll in the browser with `Math.random()`, which anyone can edit in devtools. Moving it to the
Worker is what makes a pull mean something. There is now one roll, in `worker/src/roll.js`, reading
`data/pack-weights.json` and `data/pool-bp01.json`; the site keeps a local roll only as an offline
fallback, over the same two files. In-world and on-site odds cannot drift because they are not two
implementations kept in step.

## Two paths, one roll

There are two ways to end up holding a pack, and they are good at different things:

| | in-world spawner | site export |
|---|---|---|
| card art | 7 live textures from the proxy | one baked 8192² atlas |
| geometry | flat quads | Ukilop's beveled rounded cards |
| gets it to you | instantly, in the session | a download you drag in |
| good for | opening packs | keeping one |

They are not competing designs. Both call `/api/pull`, so **`?seed=` reproduces one from the
other**: open a pack in-world, hand the seed to the site, and the site bakes that exact pack as a
real deck object. That is the bridge, and it is the reason the endpoint takes a seed at all.

## Stack order

Cards come back **rarest first**, and that ordering is a contract, not a detail.

The deck bake lays the atlas out in deck-list order, and the deck's flux drives each card's offset
from its own `IndexOfChild` — verified by decoding the template, where the 52 card slots run +Z to
−Z in list order. So **list index is stack position**: entry 0 sits at one fixed end of the pile.

Putting the hit at index 0 means the stack reads commons-first when you flip it over and swipe, and
the rare is the last thing you uncover. Reveal order on the site is the exact reverse, for the same
reason.

Which physical end index 0 lands on is the one part only a VR check can settle. It is one constant
on each side — `STACK_RAREST_FIRST` in `index.html`, `CARD_GAP`'s sign in `booster/build-spawner.mjs`
— and nothing else depends on the direction.

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
  **Not done in the prototype.** 19 of BP01's 101 cards are landscape (`data/pool-bp01.json`
  lists them), and they will currently show sideways on the quad. The fix is per-card: rotate
  the card slot, or set the `QuadMesh.Rotation`, driven off the loaded texture's aspect.
  There is no aspect-ratio read in the graph yet, so this needs a node that exposes the loaded
  texture's size — worth confirming exists before designing around it.

## Build order

**P0 — the endpoint. DONE.** `GET /api/pull` in `worker/src/index.js`, rolling in
`worker/src/roll.js` against `data/pack-weights.json` and `data/pool-bp01.json`. Both formats,
`seed` implemented, per-IP throttle. `worker/test/routing.mjs` asserts the pack shape, the odds,
the ordering and the two cache policies.

**P1 + P2 — talk to it, show the cards. DONE, in one step.** Splitting them turned out not to be
worth it: the parse is pure data flow, so there was never a text-field-only intermediate worth
building. `booster/build-spawner.mjs` emits the whole thing, and `booster/test-parse.mjs` evaluates
the parse graph *out of the built package* against a live response — which is the debuggability P1
was there to buy, without the throwaway build.

The blank-card fallback is in: each card's URL runs through an `ObjectConditional<string>` gated on
whether that line actually parsed, so a missing or truncated response shows placeholder art rather
than a card that stays blank forever with no error.

**P3 — the spawner.** Cloud-spawn pattern: the tool writes the pack's record URI into a spawner slot
and it appears in front of the user.

**P4 — the wrapper.** The tear-and-reveal experience, matching the website's ripper.

P0–P2 is the honest milestone: a real randomized pack you can hold. P3 and P4 are presentation.

## Open questions

- **Rate limiting is a speed bump, not a guarantee.** The Worker's per-IP throttle counts inside one
  isolate, and Cloudflare runs many. It stops a lazy loop from one client and nothing more. Said
  plainly at the call site too. The real fix, if abuse ever appears, is Cloudflare's Rate Limiting
  binding or a Durable Object — both need account config the Worker currently avoids.
- **Landscape cards.** See above; 19 BP01 cards will render sideways in-world until the graph can
  read a loaded texture's aspect.
- **Who pays for a re-roll?** Still open. The spawner fires on `OnStart`, so re-triggering it means
  re-spawning the object — cheap. If a pull is ever meant to be scarce, the roll has to be bound to
  something: a short-lived token issued per spawn, or per-user limiting.
- **No retry.** If the host-access prompt is still open when `OnStart` fires, the first pull lands
  on the fallback art and nothing tries again. A `SecondsTimer` gated on "no cards yet" would fix
  it; left out of the prototype deliberately, so the failure is visible rather than papered over.
- **Multi-pack.** `/api/pull?packs=12` works and returns a box. Nothing in-world consumes it yet —
  the spawner reads exactly seven lines.

## Adding BP02

Data, not code:

1. `node tools/fetch-pool.mjs set=BP02` → `data/pool-bp02.json`
2. Add a `BP02` entry to `data/pack-weights.json` (slots, hit odds, `packSize`)
3. Add `BP02: poolBP02` to `POOLS` in `worker/src/index.js`
4. `SET=BP02 npm run build` in `booster/`

The site reads its set from one constant and its label from the weights file, so the ripper picks
up the name and the `BP01`/`BP02` badge on its own.
