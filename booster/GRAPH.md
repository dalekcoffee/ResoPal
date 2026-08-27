# Reading the graph

**One canvas, about 118 nodes, four zones.** Unpack `Flux - control` and you have the
whole thing. There is no second canvas any more: the 514-node decoder canvas is gone,
because cards are no longer pre-baked. See "How the cards work" below.

## Before you unpack anything

The panel tells you where it broke without opening the flux at all. Three driven lines
under the title:

- **The URL line** (small, dim) shows the request the panel will make. It is driven from
  the same relay that feeds the request, so pressing one of the five preset buttons
  **must** change it. If it changes → the button, the impulse, the variable write and the
  driver all work. If it does not → the problem is in zone 1.
- **The status line** (larger, cyan) shows the first card of the response — or, when the
  request fails at the transport level, the error text, because `GET_String` writes the
  exception message into the same `Content` the status reads.
- **The event line** (smallest, dim) names the branch the graph actually took:

  | It says | Written by |
  |---|---|
  | `idle - no request yet` | nothing yet — the default on the variable |
  | `could not set ResoPal/url` | the URL write's `OnNotFound` / `OnFailed` (zone 1) |
  | `host access refused` | either request's `OnDenied` (zone 2) |
  | `network error - no answer from the host` | either request's `OnError` (zone 2) |
  | `response received - HTTP 200` | either request's `OnResponse`, with the real code (zone 2) |
  | `a card would not take its art` | the per-card write's `OnNotFound` / `OnFailed` (zone 3) |
| `all cards placed` | the loop running out of records (zone 3) |

  The HTTP code is there because `GET_String` writes an exception into `Content` **only
  on a transport failure**. A 404 is a perfectly successful request whose body is not
  cards, so without the code the status line quietly shows the first 64 characters of an
  error page and the panel looks like it half worked.

  `all cards placed` matters for the opposite reason: cards appear one frame at a time,
  so "it finished" and "it never started" look identical without it.

Read them together:

| URL line | Event line | Status line | Means |
|---|---|---|---|
| unchanged | idle | unchanged | the button never reached the graph |
| changed | `could not set ResoPal/url` | unchanged | the variable space is wrong — zone 1 |
| changed | idle | unchanged | the request never ran — the async wrapper |
| changed | `host access refused` | unchanged | the prompt was denied |
| changed | `HTTP 404` / `HTTP 502` | an error page | the endpoint is not deployed, or is broken |
| changed | `network error` | the exception text | the host did not answer at all |
| changed | `HTTP 200` then `all cards placed` | a card URL | working |
| changed | `HTTP 200`, no `all cards placed` | a card URL | the response came back but the loop never ran |

## Zone by zone

### 1 · a button picks what to ask for

```
ButtonDynamicImpulseTrigger  ──"ResoPal/pack/3"──▶  DynamicImpulseReceiver
                                                            │ OnTriggered
                            ValueObjectInput ──Value──▶ WriteDynamicObjectVariable<string>
                          ("…packs=3&format=fixed")     │ OnSuccess      │ OnNotFound/OnFailed
                                                        ▼                ▼
                                        ContinuationRelay          "could not set ResoPal/url"
```

Five identical rows, one per preset button, joining **one trunk relay** so the request
takes a single incoming wire. A sixth receiver, `ResoPal/import`, skips all of this — it
goes straight to the POST in zone 2, because the paste field is the request body, not a
URL.

Buttons and graph never reference each other — the tag string is the only coupling.

Two traps live here, both of which have bitten this build:

- The write node is **`WriteDynamicObjectVariable<string>`**, not
  `WriteDynamicValueVariable<string>`. The latter is declared `where T : unmanaged` and
  cannot exist for a string. Emitting it is why every button did nothing.
- The trigger's `Target` is the **`Flux - control` slot**, never the object root. The
  encoder reserves id `00000000-…-000000000000` for the root, which is byte-identical to
  the null GUID, so a reference to the root deserializes as null — and a null `Target`
  silently broadcasts at the whole world root.

### 2 · ask resopal, and say what came back

```
trunk relay ─▶ StartAsyncTask ─TaskStart─▶ GET_String ──▶ Content
                                                         │ OnResponse / OnError / OnDenied
"ResoPal/import" ─▶ StartAsyncTask ─▶ POST_String ───────┤
                       (body: the paste field's Text)    ▼
                                              three relay stubs, one per outcome,
                                              each into its own -> ResoPal/event write
```

**There is no host-access gate, on purpose.** `WebRequestBase.RunAsync` calls
`Engine.Security.RequestAccessPermission(host, port, HostAccessScope.HTTP, "Web Request
Node")` itself, before it sends — so a pre-gate is only a second way to fail for a prompt
the user gets anyway, and it cannot be shared between two request nodes without a
multiplexer. The cost is the prompt saying "Web Request Node" rather than naming ResoPal.
See `PRIOR-ART.md` §1.

**Both request nodes are `AsyncActionNode`, so each is entered through its own
`StartAsyncTask`.** An ordinary impulse cannot run one: the chain reaches it and stops,
with no error anywhere. `verify-classpaths.mjs` walks every impulse edge from the
synchronous entry points and fails if any async node is reachable without crossing one.

Three things inside that same method return `null` — a null URI, a non-`http` scheme, and
a permission that resolves to neither Allowed nor Denied. `return null` runs no
continuation at all. That is what the event line is for.

The chosen URL reaches the graph through a **driver on a plain input's `Value` field**, so
there is no Read node — the variable drives the constant. Its default is the 1-booster
URL, so the request is well-formed even before any press.

### 3 · unpack the response into cards

```
OnResponse ─▶ write  body := Content ─▶ write rest := Content ─▶ DestroySlotChildren(Cards)
                                                                         │
                                                          StartAsyncTask ─┘
                                                                 │ TaskStart
   ┌─────────────────────────────────────────────────────────────▼──────────┐
   │  relay ─▶ DelayUpdates(1) ─▶ If( IndexOfString(rest,"\n") > 8 )         │
   │                                 │ true                     │ false      │
   │                        DuplicateSlot(template → Cards)     "all cards placed"
   │                                 │ Next                                  │
   │            WriteDynamicObjectVariable(dup, "CARD/url", trim(record))     │
   │                                 │ OnSuccess                             │
   │                        SetLocalPosition(dup, grid(ChildrenCount))        │
   │                                 │ Next                                  │
   │                    write rest := Substring(rest, newline + 1)  ──────────┘
   └────────────────────────────────────────────  relay ─▶ relay ─▶ back to the top
```

Three properties are worth stating, because each was a bug in an earlier build:

**The remainder is written back over itself, minus the record just taken.** There is no
cursor, so there is no cursor arithmetic, so there is nothing to walk off the end of — the
defect that once lit 62 cards for a 7-card pull, all showing the first card's art.

**The loop provably terminates.** `IndexOfString` returns −1 when there is no newline
left, so the single guard `newline > 8` covers both "no more records" and "what is left is
too short to be a URL". Every pass removes at least ten characters, and the string only
ever gets shorter. `test-panel.mjs` asserts against the *built graph* that the guard reads
the same `IndexOfString` the remainder does — not that the builder meant to.

**Order is the whole correctness argument.** Every read above takes the *current*
remainder, so eating the record before writing the card would give each card the next
card's art. The test walks the impulse chain and asserts
`DuplicateSlot → write CARD/url → SetLocalPosition → write rest`, in that order.

`DelayUpdates(1)` makes each card cost one frame instead of stalling the world for the
length of the deck.

## How the cards work

There is **one card** in the package, inactive, under `Card template`. Everything in-world
is a duplicate of it.

```
card  (inactive)
├── DynamicVariableSpace "CARD"  +  DynamicValueVariable<string> "CARD/url"
├── StaticTexture2D + UnlitMaterial + QuadMesh + MeshRenderer      ← components, not assets
├── TextureSizeDriver   texture size ─▶ QuadMesh.Size
└── three nodes:  ObjectValueSource ─▶ StringToAbsoluteURI ─▶ drive StaticTexture2D.URL
```

`DuplicateSlot` copies the ProtoFlux **inside** the slot and rewires the copy's references
to the copy's own components, so those three nodes exist once in the package and once per
card in-world.

Two things about this are easy to get wrong:

- **The texture and material are components on the slot, not entries in `doc.Assets`.**
  `doc.Assets` is shared; a card duplicated from a template whose texture lived there
  would point at the template's one texture and every card would show the same art.
- **The space is `CARD`, not `ResoPal`.** `DynamicVariableAction` walks *up* from its
  target looking for a space of that name, so a write aimed at a card would otherwise be
  able to land on the panel.

**Landscape cards render landscape with no ProtoFlux at all.** `TextureSizeDriver` reads
the loaded texture's own pixel size; `UnitHeight` normalises it to `(aspect, 1)`, `Ratio`
scales that to the card height and `MaxSize` caps the width at one grid cell. The gap this
closes was recorded as needing "a node that exposes a loaded texture's aspect" — there is
none, and none is needed.

**Nothing counts the cards.** A card exists because a record existed. Each one asks
`IndexOfChild` for its **own** index — not `ChildrenCount` on the parent, which by that
point already includes the card being placed and would put every card one cell late. Seven
records make seven cards and fifty make fifty, with no ceiling anywhere in the graph. The
only cap is the Worker's, at 200.

**The card stays active; its holder is switched off.** `DuplicateSlot` calls
`slot.Duplicate()`, which copies `Active` verbatim — duplicating an inactive card gives an
inactive card, and nothing in the spawn chain turns it back on. Hiding the template behind
an inactive parent keeps it out of sight while the copy, reparented under the active `Cards`
slot, comes up visible.

## What the tests hold to

`npm test` runs two files. Between them they gate:

- **Every emitted type exists and satisfies its generic constraint**, checked against the
  decompiled engine source (`verify-classpaths.mjs`). This is the check that would have
  caught the dead buttons.
- **Every async node runs in an async context.**
- **Nothing references the null GUID.**
- **The card template is self-contained** — its own texture, its own material, its own
  variable, its own three nodes, in its own space.
- **The loop, simulated out of the built package** against live Worker responses for all
  five buttons and a 98-card double deck: the right number of cards, each with its own
  record's art, in order, on the right grid square — modelling the decompiled nodes' own
  clamping rather than JavaScript's.
- **The loop terminates**, asserted structurally rather than assumed.
- **Order of operations inside one pass.**
- **The graph stays under 120 nodes** — the inspectability budget.
- **Every way a request can end reports on the event line.**
- **The HTTP status code reaches that line.**
- **Comment zones are disjoint and every one is titled.**
- **No two nodes overlap a node visual.**
- **No wire runs through a constant.** This is the defect that made the URL constants read
  as unconnected: each sat in the lane between the receiver and the write it fed. A
  constant is a leaf — nothing wires into it — so a wire touching one can only be an
  accident of position. Wires crossing a node that *has* inputs read as what they are, two
  wires crossing; those are counted and capped rather than failed. **The count is currently
  zero**, held there by three habits worth keeping: a producer four columns from its
  consumers gets a relay tap beside them; a reference node is duplicated rather than wired
  across a zone (two components and no wire at all); and the loop's return runs three
  corners — down its own column, along a row below everything, back up the left edge —
  rather than one diagonal through every data row.

## Two things that fail silently, and now cannot

**Members are emitted in the order the class declares them.** Not cosmetic. Written in the
order the builder happened to list them, this package encoded cleanly, validated with zero
dangling references, and in-world every node was red with wires on the wrong ports:

| Node | What went out | What the class declares |
|---|---|---|
| `If` | `Condition, OnTrue, OnFalse` | `OnTrue, OnFalse, Condition` |
| `GET_String` | `URL, Content, StatusCode, OnSent, …` | `URL, StatusCode, OnSent, …, Content` |
| `DuplicateSlot` | `Template, OverrideParent, Duplicate, Next` | `Next, Template, OverrideParent, Duplicate` |

`Content` is declared **last** because it comes from a subclass, after the base's impulses.
Emitting it fifth shifted every impulse output by one — which is exactly what "the request
is connected to things but nothing calls it" looks like from inside the world.
`members.mjs` reads the real order out of each class's own `GetSyncMember(int index)`
switch; the builder emits in it, and `verify-classpaths.mjs` fails on any drift. A ProtoFlux
node also emits **every** member, unwired ones as null: they are all ports, and a port that
is not in the file is one the graph cannot resolve.

**Every wire connects two compatible ports.** The binding class says which kind each member
is:

| Declared as | Is | Must connect to |
|---|---|---|
| `SyncRef<INodeOperation>` | an impulse out | a node that can be **run** |
| `SyncRef<INodeObjectOutput<T>>` | a data in | something that produces a value |
| `Node*Output<T>` | the node's **own** output | nothing — others address its **field** id |

That last row is the rule this project keeps rediscovering. A node's data output is its
component id, but a *named* output like `GET_String.Content` or `DuplicateSlot.Duplicate` is
a **field** id, and wiring the component id instead reads the action node's own value —
which for an action node is nothing at all. The verifier now checks both directions, and
passing a field name the class does not have is a build error rather than a wire that
quietly goes nowhere.
