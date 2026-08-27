# Prior art: Sharkmare's DeckReader

Someone else already solved most of this. `DeckReader - BolasVersion` imports a deck from a
pasted URL — Moxfield, ygoprodeck, pokemoncard.io, digimoncard.app — and builds the physical
cards in-world. Its author let us read it to understand the approach.

**We may read it. We may not modify or redistribute it.** Nothing from that package is copied
into this repo — not a slot, not an asset, not a node. This file records what the design
teaches, in our own words, and the changes we made because of it. The package itself was
unpacked in a scratch directory and is not committed anywhere.

Credit where it is due: the tool is by **Sharkmare / ProtogenFlux**, built on **Ukilop's Deck
Maker v1.4.3** — the same deck object ResoPal exports into — in a variant its own slot labels
call *"This Version allows card injection"*. Its backend is a set of per-game endpoints at
`eu01.voxelbone.cloud`.

## What it actually is

712 components, 492 of them ProtoFlux, in one flat pile under a single slot. No comment zones,
no Moduprint canvases, no relay discipline. **Our graph is better organised than theirs and
their logic is better than ours**, and those two facts are independent.

```
DeckReader
├── DeckData            167 flux nodes: fetch, parse, spawn
├── UI                  a text field, a checkbox, two 3D buttons, a card-back preview
├── Templates
│   ├── CardTemplate    ONE card. Duplicated per line of the response.
│   └── DeckTmplate     Ukilop's deck, with 112 nodes of deck behaviour
└── credits
```

## Seven things it does that we should

### 1 · There is no host-access pre-gate, because the request node is the gate

The package contains **no `IsHostAccessAllowedUrl` and no `RequestHostAccess` node at all**. It
just runs the request. From `WebRequestBase.RunAsync`:

```csharp
switch (await context.Engine.Security.RequestAccessPermission(
        url.Host, url.Port, HostAccessScope.HTTP, "Web Request Node"))
```

The request node asks for permission itself, at `HostAccessScope.HTTP`, and blocks until the
user answers. Our zone-2 gate was therefore **optional**, not required — and it is now
**gone**. It was kept for one turn because it let us pass a `Reason` string naming ResoPal
rather than the engine's generic "Web Request Node", but it could not be shared between two
request nodes without a multiplexer, and a pre-gate is one more way to fail for a prompt the
user gets anyway. The cost of dropping it is that generic reason string.

Three failure modes hide in that same method, and all three are silent:

```csharp
if (url == null) return null;                                        // no continuation
if (url.Scheme != "http" && ... != "ftp") return null;               // no continuation
default: return null;                                                // no continuation
```

`return null` runs nothing. No error, no branch, no log. **A malformed URL and a permission
that resolves to neither Allowed nor Denied look exactly like a button that does nothing.**

### 2 · Check the status code, not just the body

`GET_String` writes the exception message into `Content` **only on a transport failure**. A 404
or a 502 is a perfectly successful request whose body happens to be an error page, and a status
line reading `Content` shows you the first 64 characters of that page. DeckReader tests
`ValueEquals<HttpStatusCode>(StatusCode, OK)` and, when it fails, formats

```
Error: {0}
Tell the discord about this!
```

with `ValueToObjectCast<HttpStatusCode>` supplying the code. **Applied** — our event line now
reads `response received - HTTP NotFound`.

### 3 · Consume the string instead of walking a cursor

The response is `NAME|FRONT|BACK` per record, `|` between fields and a newline between records.
The parser holds a local `DataModelObjectFieldStore<string>` — named `MUTATED COPY`, seeded
`NULL|` — and each iteration:

```
idx  = IndexOfString(rest, "|")
field = Substring(rest, 0, idx)
rest  = Substring(rest, idx + 1)          ← written back over itself
if StartsWith(rest, NewLine) rest = Substring(rest, 1)
```

There is no cursor, so there is no cursor arithmetic, so there is no wrapping past the end —
the bug that once lit 62 cards for a 7-card pull here. The string simply gets shorter until
`StringLength(rest) > 3` goes false.

Field order comes from an int counter and `ValueMod 3` driving an `ImpulseMultiplexer`, so
adding a fourth field per card is a wider multiplexer and nothing else.

### 4 · Yield a frame per iteration

The loop re-enters through `StartAsyncTask → DelayUpdates(1) → If`. Sixty cards take sixty
frames instead of one long hitch. The same trick appears again on spawn: each new card fires a
`QueueResize` impulse whose handler waits `DelayUpdatesOrSecondsFloat(0.025)` before touching
the transform, so a 60-card import staggers rather than stalling.

### 5 · Duplicate one card template — do not pre-bake seventy

```
DuplicateSlot(Template = CardTemplate/Card, OverrideParent = the deck)
  → Sequence ─┬─ continue the parse loop
              └─ DynamicImpulseTriggerWithObject<Slot>("QueueResize", the new card)
```

The template carries **its own ProtoFlux**, three nodes per face, and `DuplicateSlot` copies and
rewires it:

```
DynamicValueVariable<string> "FRONT"
        └─ ObjectValueSource<string> ─▶ StringToAbsoluteURI ─▶ ObjectFieldDrive<Uri> ─▶ ValueField<Uri>
```

So the *whole* per-card decode is six nodes that exist once. Ours is the same five-node slice
pre-baked seventy times — 350 nodes plus a relay bus — because the card slots are baked into the
package. **This is the single biggest structural lesson here**, and the fix for both our 70-card
ceiling and the unreadable second canvas.

### 6 · Aspect ratio is a component, not a node

Our known gap "landscape cards render sideways — the fix needs a node that exposes a loaded
texture's aspect; worth confirming one exists" was the wrong question. There is no such node
and none is needed:

```
TextureSizeDriver   Texture → the StaticTexture2D,  Target → QuadMesh.Size
Float2ToFloat3SwizzleDriver   QuadMesh.Size → BoxCollider.Size
```

`TextureSizeDriver.OnChanges` reads `Texture.Asset.Size`, normalises by `DriveMode`, scales by
`Ratio` and caps at `MaxSize`. **Applied** — every card now carries one, `UnitHeight` with
`Ratio = (CARD_H, CARD_H)` and `MaxSize = (CARD_W, CARD_H)`, so BP01's 19 landscape cards come
out landscape and shrink to fit their cell. Zero ProtoFlux.

### 7 · Flip is a driver pair, and a null URI is a sentinel

```
TouchToggle.State ─ValueCopy─▶ BooleanValueDriver<Uri>.State
                               FalseValue ◀─ Front.Value
                               TrueValue  ◀─ Back.Value
                               TargetField ─▶ StaticTexture2D.URL
ValueEqualityDriver<Uri>  TrueValue vs @http://null/  (Invert) ─▶ hides the flipper
```

One texture per card, two URLs, no flux, and a card with no back face hides its own flip
widget. `@http://null/` as "absent" falls out of how `StringToAbsoluteURI` works: it tries
`Uri.TryCreate(text, Absolute)` and, failing that, retries with `"http://" + text` — so the
literal string `null` becomes `http://null/` and can be compared against.

The same method is worth knowing for the opposite reason: on an **empty or whitespace** string
it returns `null`, and a null URI is one of the silent failures in §1 — `WebRequestBase` returns
no continuation at all for it.

## What it does that we should not copy

- **No comment zones, no canvases, no relay banks.** 492 nodes in one flat pile is exactly the
  thing the user could not read in our first build.
- **`MediaType: "plain/text"`** — transposed from `text/plain`. It works because their server
  ignores it. Ours would not be so lucky.
- **A `POST` carrying the deck URL as the body.** Reasonable for "resolve this arbitrary link";
  wrong for us, since our URLs are ours and a `GET` is cacheable at the edge.
- **No `unavailable` reporting.** A card their backend cannot resolve just does not appear.

## What changed here because of it

Applied in this commit:

| | |
|---|---|
| `TextureSizeDriver` per card | landscape cards render landscape — a documented gap, closed |
| `ValueToObjectCast<HttpStatusCode>` + `FormatString` | the event line names the HTTP code, so a 404 stops looking like a half-working panel |
| Every terminal impulse reports | `OnResponse`, `OnError`, `OnDenied`, the prompt's `OnDenied`/`OnIgnored`, and both failure paths of every URL write now land on the event line |
| A new test | `every way the request can end reports on the event line` — a null terminal is a dead end with nothing to say it happened, which is precisely what "I approved host access and nothing happened" looks like from inside the world |

Not applied, and worth doing next — see `docs/BOOSTER.md`:

1. **Replace the 70 pre-baked decoders with one duplicated card template.** Removes the
   514-node canvas, removes the 70-card ceiling, and removes `format=fixed`'s 63-character URL
   limit, because a consume-the-string parser does not need fixed-width records.
2. **Then carry more than a URL per card** — name, rarity, and a back-face URI — which is what
   the booster needs for a rarest-first stack that can be flipped and swiped.
3. **Then spawn into a deck rather than a grid.** Their shuffle swaps `OrderOffset` between a
   card and a random sibling, which confirms stack position is `OrderOffset`: writing offsets
   in pull order is how a booster comes out rarest-first without moving anything.

## How this was read

```bash
git clone https://github.com/dalekcoffee/Resonite-Knowledge-Library    # outside this repo
unzip DeckReader.resonitepackage -d unpacked
# R-Main.record → Assets/<sha256> → FrDT → Brotli → BSON, via the library's decode.mjs
```

Everything above is from the decoded object graph and from the decompiled engine source in that
library. The scratch copy lives outside the working tree and is not committed.
