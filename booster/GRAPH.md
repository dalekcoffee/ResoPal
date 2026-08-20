# Reading the graph

The object carries **two Moduprint canvases**, not one. That split is the whole
answer to "there is too much happening to investigate":

| Slot | Nodes | What it is |
|---|---|---|
| `Flux - control` | ~42 | Everything a human needs. Unpack this one. |
| `Flux - card decoders` | ~514 | Seventy copies of the same five-node slice. Generated. Don't read it. |

**If you are debugging, unpack `Flux - control` and ignore the other canvas entirely.**
Nothing in the decoder canvas is card-specific except one integer per card.

## Before you unpack anything

The panel tells you where it broke without opening the flux at all. Two driven
lines under the title:

- **The URL line** (small, dim) shows the request the panel will make. It is driven
  from the same relay that feeds the request, so pressing a button **must** change
  it. If it changes → the button, the impulse, the variable write and the driver all
  work, and any failure is downstream in the network. If it does not change → the
  problem is in zone 1 or 2 of the control canvas.
- **The status line** (larger, cyan) shows the first card of the response — or, when
  the request fails, the error text, because `GET_String` writes the exception
  message into the same `Content` field the status reads.

So: URL changed + status shows an error = the endpoint. URL unchanged = the graph.

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
ValueObjectInput ──driven by DynamicValueVariableDriver("ResoPal/url")
        │
        └─▶ relay ─┬─▶ StringToAbsoluteURI ─▶ GET_String.URL
                   └─▶ (the URL readout)

ValueObjectInput("https://…") ─▶ StringToAbsoluteURI ─▶ relay ─┬─▶ IsHostAccessAllowedUrl
                                                               └─▶ RequestHostAccessUrl

                     If(allowed) ─┬─ true ──▶ GET_String
                                  └─ false ─▶ RequestHostAccessUrl ─ OnGranted ─▶ GET_String
```

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
- **The control canvas stays under 60 nodes** — the inspectability budget.
- **No two nodes overlap a node visual**, on either canvas.
- **Comment zones are disjoint and every one is titled.**
- **No producer fans past a dozen consumers**, so the relay banks cannot silently rot.
- **The parse graph, evaluated out of the built package** against live Worker
  responses for all five buttons, modelling the decompiled nodes' own clamping.
