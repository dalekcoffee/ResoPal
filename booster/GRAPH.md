# Reading the graph

The object carries **two Moduprint canvases**, not one. That split is the whole
answer to "there is too much happening to investigate":

| Slot | Nodes | What it is |
|---|---|---|
| `Flux - control` | ~64 | Everything a human needs. Unpack this one. |
| `Flux - card decoders` | ~514 | Seventy copies of the same five-node slice. Generated. Don't read it. |

**If you are debugging, unpack `Flux - control` and ignore the other canvas entirely.**
Nothing in the decoder canvas is card-specific except one integer per card.

## Before you unpack anything

The panel tells you where it broke without opening the flux at all. **Three** driven
lines under the title:

- **The URL line** (small, dim) shows the request the panel will make. It is driven
  from the same relay that feeds the request, so pressing a button **must** change
  it. If it changes → the button, the impulse, the variable write and the driver all
  work, and any failure is downstream in the network. If it does not change → the
  problem is in zone 1 or 2 of the control canvas.
- **The status line** (larger, cyan) shows the first card of the response — or, when
  the request fails, the error text, because `GET_String` writes the exception
  message into the same `Content` field the status reads.

- **The event line** (smallest, dim) starts at `idle - no request yet` and names the
  branch the graph actually took. It is written from the graph's own terminal
  impulses, so it does not depend on the response having a body — it answers the
  one question the other two cannot: *what happened?*

  | It says | Written by |
  |---|---|
  | `idle - no request yet` | nothing yet — the default on the variable |
  | `could not set ResoPal/url` | the URL write's `OnNotFound` / `OnFailed` |
  | `host access refused` | the prompt's `OnDenied` / `OnIgnored`, or the request's `OnDenied` |
  | `network error - no answer from the host` | the request's `OnError` |
  | `response received - HTTP 200` | the request's `OnResponse`, with its real status code |

  The HTTP code is there because `GET_String` writes an exception message into
  `Content` **only on a transport failure**. A 404 is a perfectly successful
  request whose body is not cards, so without the code the status line quietly
  shows the first 64 characters of an error page and the panel looks like it half
  worked.

Read them together:

| URL line | Event line | Status line | Means |
|---|---|---|---|
| unchanged | idle | unchanged | the button never reached the graph |
| changed | `could not set ResoPal/url` | unchanged | the variable space is wrong — see zone 1 |
| changed | idle | unchanged | the request never ran — the async wrapper |
| changed | `host access refused` | unchanged | the prompt was denied or dismissed |
| changed | `HTTP 404` / `HTTP 502` | an error page | the endpoint is not deployed, or is broken |
| changed | `network error` | the exception text | the host did not answer at all |
| changed | `HTTP 200` | a card URL | working |

## `Flux - control`, zone by zone

The three comment zones run left to right in the order things happen.

### 1 · a button picks the URL

```
ButtonDynamicImpulseTrigger  ──"ResoPal/pack/3"──▶  DynamicImpulseReceiver
                                                            │ OnTriggered
                            ValueObjectInput ──Value──▶ WriteDynamicObjectVariable<string>
                          ("…packs=3&format=fixed")          │ OnSuccess
                                                             ▼
                                              ContinuationRelay "any button -> fetch"
```

Five identical rows, one per button. Each holds its URL as a constant and writes it
to `ResoPal/url`. All five join **one trunk relay** so the gate downstream takes a
single incoming wire rather than five.

Buttons and graph never reference each other — the tag string is the only coupling.

Two traps live here, both of which have bitten this build:

- The write node is **`WriteDynamicObjectVariable<string>`**, not
  `WriteDynamicValueVariable<string>`. The latter is declared `where T : unmanaged`
  and cannot exist for a string. Emitting it is why every button did nothing: the
  component never resolved and the chain dead-ended at a type that was not there.
- The trigger's `Target` is the **`Flux - control` slot**, never the object root.
  The encoder reserves id `00000000-…-000000000000` for the root, which is
  byte-identical to the null GUID, so a reference to the root deserializes as null.
  A null `Target` silently broadcasts at the whole world root instead.

`verify-classpaths.mjs` now catches the first, and `test-panel.mjs` catches the second.

### 2 · gate host access, then GET

```
ContinuationRelay ─▶ StartAsyncTask ─TaskStart─▶ If(allowed) ─┬─ true ──▶ GET_String
                                                              └─ false ─▶ RequestHostAccessUrl
                                                                              │ OnGranted
                                                                              ▼
                                                                         GET_String

ValueObjectInput ──driven by DynamicValueVariableDriver("ResoPal/url")
        └─▶ relay ─┬─▶ StringToAbsoluteURI ─▶ GET_String.URL
                   └─▶ (the URL readout)

ValueObjectInput("https://…") ─▶ StringToAbsoluteURI ─▶ relay ─┬─▶ IsHostAccessAllowedUrl
ValueInput<HostAccessScope>(HTTP) ─────────────────────────────┴─▶ RequestHostAccessUrl
```

**The `StartAsyncTask` is not optional.** `GET_String` and `RequestHostAccessUrl`
both derive from `AsyncActionNode`; an ordinary impulse cannot run one. Without it
the chain reaches the gate and stops, with no error anywhere — the buttons appear to
do nothing. `verify-classpaths.mjs` walks every impulse edge from the synchronous
entry points and fails if any async node is reachable without crossing one.

**`Scope` is spelled out on both host-access nodes.** Left unwired it defaults to
`HostAccessScope.Everything`, which asks "is *every* kind of access allowed for this
host?" — a stricter question than the prompt grants. The check can then stay false
forever and re-prompt on every press. We only ever speak HTTP, so both nodes say so.

**The gate is optional, and that is worth knowing.** `WebRequestBase.RunAsync` calls
`Engine.Security.RequestAccessPermission(host, port, HostAccessScope.HTTP, "Web
Request Node")` itself, so a bare `GET_String` prompts on its own — Sharkmare's
DeckReader has no host-access node anywhere (`PRIOR-ART.md`). We keep ours only for
the `Reason` string, which names ResoPal instead of "Web Request Node". Because the
scope matches, the grant it records satisfies the request node's own check and no
second prompt appears.

Three things in that same method return `null` — a null URI, a non-http scheme, and
a permission that is neither Allowed nor Denied. `return null` runs no continuation
at all: no error, no branch, nothing. That is why the event line exists.

The chosen URL reaches the graph through a **driver on a plain input's `Value`
field**, so there is no Read node — the variable drives the constant. The default
value is the 1-booster URL, so the request is well-formed even before any press.

### 3 · what the panel shows you

```
GET_String.Content ─▶ relay ─┬─▶ StringLength ─▶ relay ─┬─▶ (decoders)
                             │                          └─▶ ValueGreaterThan(0)
                             ├─▶ Substring(0, 64) ─▶ TrimString ──┐
                             └──────────────────────────────────┐ │
                                          ObjectConditional ◀───┴─┘
                                                  │
                                     ObjectFieldDrive<string> ─▶ Text.Content
```

`Content` is an **output sentinel**: downstream nodes address it by *field* id, not
by the node's component id. Wiring the component id instead reads the node's own
value output, which for an action node is not the response body — a silent failure.

## `Flux - card decoders`

One `bus` zone on the left, then seven row zones of ten cards. Each row taps the
response, the record width and the response length through **its own relay bank**,
so no producer carries seventy wires.

Every card is the same five nodes:

```
ValueInput(i × 64) ─┬─▶ Substring(response, i×64, 64) ─▶ TrimString ─▶ StringToAbsoluteURI ─▶ drive StaticTexture2D.URL
                    └─▶ ValueGreaterThan(length, i×64) ─────────────────────────────────────▶ drive Slot.Active
```

**The only thing that differs between card 01 and card 70 is that integer.** Read
one row zone and you have read all seventy.

One honest exception to the house style lives here: the row bus wires cross the card
clusters they run past. Routing seventy identical clusters to standard needs a relay
chain per bus line — roughly 140 extra relays on a canvas nobody is meant to read.
The test reports the count rather than failing on it, so it cannot quietly grow.

**The real fix is to delete this canvas.** Pre-baking seventy decoders is not the
only way to get seventy cards: `DuplicateSlot` copies a template slot *including its
own ProtoFlux*, so the whole per-card decode can be six nodes that exist once and are
duplicated per record. That also removes the 70-card ceiling and the fixed-width
record format. See `PRIOR-ART.md` §5.

This shape is possible because `format=fixed` returns records of exactly 64
characters — the URL padded and newline-terminated. With variable-length lines,
card *i* could only be found by walking *i* newlines, which chains every card to the
one before it: three more nodes each, a seventy-deep dependency, and a graph that
genuinely cannot be read. The record width is a contract with
`worker/src/roll.js`; both sides hold the same 64.

A card is visible exactly when the response reaches its offset. Seven records light
seven cards and leave sixty-three dark. **Nothing counts anything.**

## What the tests hold to

`npm test` runs two files. Between them they gate:

- **Every emitted type exists and satisfies its generic constraint**, checked against
  the decompiled engine source (`verify-classpaths.mjs`). This is the check that would
  have caught the dead buttons.
- **Nothing references the null GUID.**
- **The control canvas stays under 70 nodes** — the inspectability budget.
- **Every way the request can end reports on the event line.** A terminal impulse left
  null is a dead end with nothing anywhere to say it happened.
- **The HTTP status code reaches the event line**, so a 404 cannot masquerade as cards.
- **No two nodes overlap a node visual**, on either canvas.
- **Comment zones are disjoint and every one is titled.**
- **No producer fans past a dozen consumers**, so the relay banks cannot silently rot.
- **No wire runs through a node box** in the control canvas. This is the defect that
  made the URL constants read as unconnected: each sat in the lane between the
  receiver and the write it fed, so the impulse wire crossed its box (pretty-flux §2).
  The gate is a segment/box intersection test over every wire on the canvas.
- **Every async node runs in an async context.**
- **The parse graph, evaluated out of the built package** against live Worker
  responses for all five buttons, modelling the decompiled nodes' own clamping.
