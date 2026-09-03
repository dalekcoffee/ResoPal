# The in-world panel, v1.0

`booster/out/ResoPal_Panel_v1.0.resonitepackage` — imports Palworld TCG decks from inside
Resonite. Supersedes `ResoPal_Panel.resonitepackage`; the older file is kept because
`docs/HANDOFF.md` describes it.

Everything below was established by decoding real packages and by reading the running
engine over ResoniteLink, not by guessing. Where something is unverified it says so.

## What it is: a shell and a transplant

The panel is **two things grafted together**:

- the **UIX Studio shell** — the whole visible panel: header, back cover, popups, credits,
  and the scrolling paste field. Authored in [UIX Studio](https://github.com/dalekcoffee/uix-studio)
  and exported as a `.resonitepackage`.
- the **ResoPal flux and templates** — the 161-node control graph, the card template, the
  deck holder, moved in wholesale.

This split is the point. The shell is regenerated whenever the design changes; the flux is
not rewritten to match. **A design change ships by re-exporting the shell and re-running the
transplant, not by hand-editing the panel.**

Only **four** flux connections ever touched the UI, which is why the transplant is cheap:

| flux node | drives |
|---|---|
| `drive the URL readout` | `Debug Dialog/Request Field/Text` |
| `drive the event readout` | `Debug Dialog/Response Field/Text` |
| `what you pasted` | `Deck Link Input/Text` |
| `drive the status line` | *deliberately unbound* — see below |

Everything else the flux touches (`Cards`, `Decks`, `Card template`, `Deck template`) moved
across with it and needed no rebinding.

## Cards are URLs now, not a baked atlas

The v1.0 panel does **not** bake card art. Each card carries its art as a URL in a dynamic
variable (`DATA/FRONT`), and the back is one shared URL for every card. Nothing is composited,
so there is no 8192² atlas in the package and no per-deck bake.

This is also what lets users supply their own backs later: the back is a URL like the fronts,
not pixels baked into a texture.

The card itself is **DeckReader's**, not Deck Maker's — it already has rounded corners in the
mesh and takes its face from a texture, so no corner mask is needed.

## Load-bearing facts

Each of these cost at least one wrong build. They are not visible from the code.

**A `Field_Uri` value needs a leading `@`.** `@https://…`, `@packdb:///…`. A bare URL in a Uri
field deserialises to **null on import, silently** — the card renders white and nothing errors.
String holders (`DynamicValueVariable<string>`, `ValueField<string>`) take URLs plain, and
adding `@` there would render the marker as text. The build audits for this.

**A dynamic-variable *driver* lags the impulse that wrote the variable.** Pressing a deck
button writes `ResoPal/url` and fires the GET in the same impulse, but the GET read a field fed
by a `DynamicValueVariableDriver`, which only writes on an engine update — so the request went
out with the *previous* url, and since the default was the booster endpoint, the first deck
press always imported a booster. `DelayUpdates` by one frame was tried and **did not** win the
race. The fix is to remove the dependency: read the variable at the point of use with
`ReadDynamicObjectVariable`.

**A ProtoFlux node with several outputs is referenced by its output FIELD's id, not the
component id.** `ReadDynamicObjectVariable` has `FoundValue` and `Value`; consumers point at
`Value`. Single-output nodes (`ValueObjectInput`, `SlotSource`, `ObjectRelay`) are referenced by
component id. Getting this wrong is **silent** — a component id is a defined id, so `validate()`
sees no dangling reference and the fetch simply returns nothing. To tell which convention a node
uses, count references to its component id in a known-good package: 1 (its own definition) means
the component id is not the output.

**`TextField`, `ButtonToggle` and `Hyperlink` all need a `UIX.Button` on the same slot.** All
three are `IButtonPressReceiver`, and `Button.RunPressed` dispatches with
`base.Slot.ForeachComponent<IButtonPressReceiver>` — same slot only, and only when the Button's
`SendSlotEvents` is true. Without it the control looks completely finished and silently ignores
every click. (`TextField.__text` being null is *not* a fault: the decompiled source marks it
`[NonPersistent]` and reads it only to migrate version-0 data.)

**UIX drawn outside the canvas rect renders but cannot be clicked.** Interaction is raycast
against the Canvas `BoxCollider`, which only covers the canvas rect. A dialog anchored past the
edge is fully visible and completely dead. This is why the debug popup has a **canvas of its
own** parked to the right rather than an off-edge rect: it keeps the main panel usable while
open, and still gets a collider.

**A `Sidedness=Back` material does not give a UIX panel a back.** The canvas builds
single-sided geometry, so culling the front face leaves nothing to draw. UIX Studio's back
elements are rotated 180° and use `Sidedness=Front`. The shell's own `Back Cover` handles this.

## Layout and behaviour

```
Header      icon (About) · logo · title · Loading Spinner · close
Description "Import Palworld TCG decks straight into Resonite"
Status      blank — nothing writes to it
Link Button → https://palify.org
QUICK IMPORT
  Trial Deck A / B, Booster BP01     → ResoPal/deck/td01, /td02, /pack/1
OR PASTE YOUR OWN (URL or DeckList)
  Deck Link Input   scrolling TextField, prefilled with a real deck link
  Button A "Import what I pasted"    → ResoPal/import
  Button B "Debug info"              → toggles Debug Canvas.Active
Footer
```

**The status line is deliberately unbound.** Its source node is
`status: first card, else the error, else Ready`, whose true branch is the first record of the
response — the card's *art URL*. Driving it put raw request detail on the front of the panel.
Both readouts it could carry live in the debug popup instead.

**The loading spinner** is animated by the shell (WorldTime → Mod → Mul → FieldDrive) and
exposed as a bool, `Loading Spinner`, in the Canvas's **unnamed** variable space. The flux sits
outside the Canvas and dynamic-variable lookup only walks *up*, so the write nodes carry an
explicit `Target` pointing into the Canvas. It goes on at request start and off at cards-placed,
no-answer, or refused.

*Known limitation:* on a deck import the holder fills **after** the cards-placed terminal, so
the spinner stops a moment before the deck lands.

**Two variable spaces coexist on the root** — the shell's unnamed one (`Loading Spinner`,
`Deck Link Input`, `Request Field`, `Response Field`) and ours named `ResoPal` (`ResoPal/url`,
`ResoPal/event`). Lookup matches by name and an unnamed space only answers unprefixed names, so
they do not collide.

## One font chain, and why the package is small

The donor and the shell carried the **same fonts by different routes**: the donor embedded
them as `@packdb:///` (bytes inside the package), the shell references them as `@resdb:///`
(cloud, no bytes). Carrying both put a **16.5 MB duplicate font** in a 16.7 MB package.

Every transplanted text now points at the shell's `FontChain`, which makes the donor's font
tree unreachable and lets the asset sweep drop it: **16.7 MB → 1.7 MB**, and the panel gets
consistent typography as a side effect. The build asserts that nothing still references a
donor chain, because one straggler keeps the whole 16.5 MB alive.

`@resdb:///` fonts do resolve on import — the shell's own text renders in-world with this
exact chain. Note that a *bare* `resdb:///` url is nulled on import; the `@` is what
preserves it, same rule as every other Uri field.

## Version and attribution

The root slot is named `ResoPal Panel v1.0` and the About dialog title carries the same
version, so a panel sitting in someone's inventory says what it is without being opened.

**Everything this tool produces credits the same people**, and the list lives in one place
(`credits.mjs`) because a deck built standalone and a deck spawned by the panel must not
drift apart — they did once. Decks carry it as **slot names**, which is all a deck has once
it is loose in a world: plain text, no rich text and no clickable links, so urls are written
out to be read. The About dialog is where the links live.

Sharkmake was missing from deck credits until v1.0 — the card templates every card is built
on are theirs, and Ukilop's line keeps its version because it matters when a future Deck
Maker changes the template.

## Deck geometry

The holder is Deck Maker's, with the values recorded in `docs/PIPELINE.md`. Two that bite:

- `Deck/cardSize` z **is** the per-card step; the holder lays buffers out by it.
- The card's own scale is **0.495** — what the play board assigns on contact. Do not derive it
  from mesh bounds: there is an inner `Visual` at scale 5.6 between the slot and the renderer.

The holder's `Edge (Baked)` mesh is identity-checked at build time. Two bakes of it exist with
the same 528-vertex topology — one rounded, one square-cornered — and the panel shipped the
wrong one for weeks with the right numbers beside it.

## Validating a build

`validate` should report **0 dangling**. Three unbound hooks are expected:

- two `ValueFieldHook` proxies inside the shell's scrollbar ProtoFlux (present in UIX Studio's
  own export; they bind at runtime)
- `drive the status line`, unbound on purpose

Anything beyond those three is a real problem.
