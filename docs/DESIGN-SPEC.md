# Handoff: ResoPal — Palworld TCG deck importer + booster pack ripper

## Overview

ResoPal converts a Palworld TCG deck into a ready-to-use, shuffleable deck object for Resonite.
Two front doors, one shared import flow:

1. **Import a deck** — paste a public Palify deck/profile URL, upload a .txt/.csv export of a private deck, or load one of the two trial decks.
2. **Rip a pack** — open Dawn of Palpagos booster packs (drag-to-tear + swipe-to-reveal), accumulate pulls in a binder, then import exactly what was pulled.

Both paths converge on: deck review (with per-card art variant picking) → soul deck (deck import only) → card back crop → export.

Export offers two paths: **Automatic** (a .resonitepackage per deck, drag into Resonite — recommended) and **Manual, in-game** (raw 8192² card sheet + back, baked in-world with Deck Maker by Ukilop).

## About the Design Files

The files in this bundle are **design references created in HTML** — a prototype showing intended look and behavior, **not production code to copy directly**.

The task is to **recreate these designs in the target codebase's existing environment** (React, Vue, Svelte, etc.) using its established patterns, component library, and state management. If no frontend environment exists yet in the ResoPal repo, choose the most appropriate framework for the project and implement there.

Specifically NOT production-ready in the prototype:
- Card data is a hardcoded 16-card demo array (`CARDS`). Real cards come from Palify's API.
- Deck parsing, atlas composition, and .resonitepackage generation are simulated with a timer. The real pipeline is in the repo (`docs/PIPELINE.md`).
- Pull weights are fetched from `data/pack-weights.json` but rolled client-side. Production should roll server-side (see `PULL-API.md`).
- The "Prototype shortcuts" strip under the URL input (happy path / no public decks / unrecognised link / force rate-limit) is a demo affordance. **Delete it.**

## Fidelity

**High-fidelity.** Final colors, typography, spacing, animation timings, and interactions. Recreate pixel-accurately using the codebase's libraries. All exact values are in Design Tokens below.

One caveat: it is desktop-only by design (agreed in the brief). Layout degrades gracefully below 1180px (nav credits drop out, export panels stack below 1080px) but mobile was never designed.

## Screens / Views

Everything lives on one continuously-revealing page. Sections appear below one another as the user progresses and stay expanded — nothing collapses, the user scrolls back freely. Auto-scroll glides to each newly revealed section (custom rAF tween, 240–700ms, ease-in-out-quad; `behavior:'smooth'` was unreliable).

### Top bar (fixed)

- Fixed, 18px from top, centered, max-width 1180px, z-index 60.
- `padding: 12px 16px 12px 20px`, `border-radius: 22px`, `background: rgba(13,19,38,.86)`, `backdrop-filter: blur(14px)`, `border: 1px solid rgba(150,170,230,.16)`, `box-shadow: 0 18px 44px rgba(2,5,16,.6)`.
- Left: 32×32px logo tile (`border-radius:10px`, `linear-gradient(150deg,#a9abee,#a8d3dc)`, containing an 11px rotated 45° navy square), then wordmark "ResoPal" (Newsreader 600 19px) over "PALWORLD TCG → RESONITE" (JetBrains Mono 500 9.5px, `letter-spacing:.13em`, `#69769c`, uppercase).
- Credits block (hidden below 1180px viewport): "Built on" eyebrow + "Deck Maker by **Ukilop** · art by **Palify**" (Palify is a link to palify.org).
- Mode switch: 2 pills in a `rgba(7,11,23,.6)` track — "Import a deck" / "Rip a pack". Active: `background:#a9abee; color:#1a2038; font-weight:600`. Inactive: transparent, `#9aa6c8`, weight 500.
- "resrec:///" copy button + "Start over" button. Both plain slate: `border:1px solid rgba(150,170,230,.18)`, `background:rgba(255,255,255,.03)`, `color:#9aa6c8`. On copy, the glyph text swaps to "copied ✓" in `#a4d4ba` and the border goes `rgba(164,212,186,.5)` for 1.8s. Below 1180px the label collapses, leaving only the glyph (keep the `title`/`aria-label`).

### Background (all screens)

Layered, fixed behind everything:
- `radial-gradient(1200px 700px at 78% -8%, #17224a 0%, transparent 62%)`
- `radial-gradient(900px 600px at 8% 22%, #101a3c 0%, transparent 60%)`
- `linear-gradient(#070b17, #060916 62%, #080d1e)`
- Two starfield layers of `radial-gradient` dots on 260px / 400px tiles; layer 1 animates `rp-twinkle` 7s ease-in-out infinite (opacity .35↔.9), layer 2 `rp-drift` 120s linear infinite alternate (translate3d(-200px,-60px,0)).
- Two large blurred accent orbs: 620px at top-right `rgba(150,152,215,.13)`, 700px at left `rgba(150,190,205,.08)`.

### 1. Hero (deck mode only)

Two columns, `minmax(0,1.06fr) minmax(0,.94fr)`, `gap:44px`, `align-items:center`.

- H1: Newsreader 400 62px/1.04, `letter-spacing:-.015em`. Copy: "Paste a deck." / "Play it in Resonite." — "in Resonite" is `#a3cfd8` with a 5px `#e3c893` underline bar (absolute, `bottom:2px`, `border-radius:4px`).
- Subhead: Figtree 400 17px/1.62, `#9aa6c8`, max-width 460px: "Any Palify deck, public or private, becomes a real deck you can shuffle and search in-world."
- Right: three overlapping card mockups (186×260 at −13° and +11°, 212×296 at −2° in front), each `border-radius:14–16px`, `box-shadow:0 26px 60px rgba(3,6,18,.7)`, striped placeholder underlay + Palify art on top. A pill below reads "Card art & data from Palify".

### 2. Load a deck (step 01)

Card shell used by every section: `border-radius:28px`, `border:1px solid rgba(150,170,230,.16)`, `background:linear-gradient(180deg, rgba(20,28,54,.86), rgba(15,21,42,.86))`, `backdrop-filter:blur(10px)`, `padding:30px 32px`.

Section header pattern (all sections): 34×34px step number tile (`border-radius:11px`, `background:rgba(160,162,220,.16)`, `border:1px solid rgba(160,162,220,.42)`, `color:#b0b3ea`, JetBrains Mono 600 13px) + **big serif title** (Newsreader 400 25px/1.2) with **small description below** (Figtree 400 13.5px/1.5, `#8e9ac0`, `margin-top:9px`).

- Title "Your deck" / desc "Paste a public deck URL, or upload a file for a private one."
- Drop zone wrapper: `padding:18px`, `border-radius:22px`, `background:rgba(7,11,23,.35)`. On dragover: border `rgba(163,207,216,.6)`, background `rgba(163,207,216,.07)`.
- Eyebrow "PUBLIC DECK — PASTE THE URL" (JetBrains Mono 600 10.5px, `letter-spacing:.13em`, `#8e9ac0`).
- Input: 58px tall, `border-radius:16px`, `background:rgba(7,11,23,.72)`, `border:1px solid rgba(150,170,230,.2)`, Figtree 400 15px. Placeholder is the **full** URL including `https://` (no separate prefix chip — that caused double-https on paste).
- Submit button: label **"Load"**, `padding:0 34px`, `border-radius:16px`, `background:#a9abee`, `color:#1a2038`, Figtree 600 15px. Hover `#b8baf4`.
- "OR" divider, then eyebrow "PRIVATE DECK — UPLOAD THE FILE" and a dashed row: 40×40 "TXT" tile (`rgba(163,207,216,.12)`, border `rgba(163,207,216,.3)`, `#a3cfd8`), copy "Drop a .txt or .csv exported from Palify" + "Private decks can't be read from a URL.", and a "Choose file" button in the same cyan.
- **Starter decks row**: "Don't have a deck?" + two buttons — "Trial deck — Red / Blue" (TD01, dots `#dd9c9c`/`#9dc2dd`) and "Trial deck — Green / Purple" (TD02, dots `#a3ccae`/`#c2a3e2`) — plus a right-aligned link "Browse community decks on Palify ↗".
- "Accepts" example chips (deck / profile / file) that fill the input and submit.
- Error state: `border:1px solid rgba(216,162,171,.34)`, `background:rgba(216,162,171,.08)`, 26px "!" tile, title `#eed6da`, body `#bda3a8`, and an "Upload a file instead" action. Three messages: empty, "That Palify page isn't a deck or a profile", "That doesn't look like a Palify link" (body: "ResoPal only reads public Palify decks…").

### 3. Pick a deck (step 02, profile URLs only)

- Title "Pick a deck" / desc "Public decks by <handle>". Count chip on the right.
- One row per deck: `border-radius:18px`, `border:1px solid rgba(150,170,230,.14)`, `background:rgba(255,255,255,.025)`. Hover: border `rgba(160,162,220,.55)`, background `rgba(160,162,220,.09)`, `translateX(3px)`.
- Left: 4 overlapping 40×56 card thumbs (`margin-left:-10px` each). Then name (Figtree 600 15.5px), meta (mono 12px `#69769c`), card count, and a `#9a9ce0` arrow.
- **Auto-scrolls to this section** when a profile URL resolves with public decks.
- **No public decks** → does NOT render this section. Instead an amber notice takes over the bottom bar (see Bottom bar).

### 4. Deck review (step 02/03)

- Title "Deck review", deck name below it (Figtree 600 15px, `#dbe2f5`).
- Meta chips: "N cards · M unique", source, and a sage cache chip ("N card images cached today" / "loading art gently · a few at a time").
- Hint bar + "Reset all to base art" button.
- Two-column grid of card rows (`gap:10px`). Each row: 82×115 thumb (striped underlay in the card's hue at 20% + art on top, selected code label at the bottom) and, on the right: quantity (mono 700 15px), hue dot, code, then name (Figtree 600 13.5px), then rarity variant chips.
- Variant chips: selected = `border:1px solid rgba(160,162,220,.7)`, `background:rgba(160,162,220,.18)`, `#e8ecfa`; unselected = `rgba(150,170,230,.16)` border, `#8e9ac0`. Each carries a rarity-colored dot. **Base printing is selected by default.**
- Landscape (Structure) cards: art is rotated `rotate(90deg) scale(1.4)` and gets an oat ↻ badge + "Printed sideways — rotated on bake." Crucially, **the rotation decision is made from the loaded image's real aspect ratio** (`naturalWidth > naturalHeight * 1.05`), never from metadata — metadata-driven rotation produced wrong-looking cards.
- **Art loads in waves**: 6 cards initially, +2 every 260ms, `loading="lazy" decoding="async"` — deliberately gentle on Palify.
- In pull-import mode each row also gets a **Keep / Discarded** toggle (sage when keeping, dashed rose when discarded; discarded rows go `opacity:.45`, dashed border, and drop out of the totals).

### 5. Soul deck (step 03, deck import only — never for pulls)

- Purple-tinted shell: `border:1px solid rgba(194,163,226,.24)`, `background:linear-gradient(180deg, rgba(38,24,60,.8), rgba(22,17,42,.86))`.
- Title "Soul deck" / desc "Every Soul is the same card — just pick the art." Plus explanatory line that it exports as its own .resonitepackage.
- 8 art thumbs (96×134). Selected: `2px solid #c2a3e2`, `translateY(-3px)`, check badge. **Art 2 (index 1) is the default selection**; order is preserved.
- Copies stepper (− / value / +, 1–20, default 10).
- "Skip — main deck only" toggle; when skipped the body goes `opacity:.32; pointer-events:none; filter:saturate(.4)`.

### 6. Card back (step 04, or 03 for pulls)

- Title "Card back" / desc "Trim it here, so it can't be wrong in-world."
- Left: 300px-wide preview at `aspect-ratio:0.7156` (1024×1463), `border-radius:16px`, draggable to pan. A 3×3 rule-of-thirds grid fades in while dragging. Caption: "1024 × 1463 · ratio 0.7156" and "official default back" / "custom back".
- Right: "Upload your own back" / "Use default"; Scale (0.6–2.6×) and Rotate (−180–180°) sliders; −90° / +90° / Re-centre buttons.
- A plain note: "This back is used for every card in both decks." (There is deliberately **no** per-deck back option.)

### 7. Choose how to import (step 05, or 04 for pulls)

Shared header, then a two-column grid `minmax(0,1.12fr) minmax(0,.88fr)` (stacks to one column below 1080px).

**Path A — Automatic (recommended).** Elevated shell: `border:1px solid rgba(160,162,220,.4)`, `background:linear-gradient(170deg, rgba(42,46,80,.88), rgba(18,24,46,.9))`, plus a radial accent orb. Badges: oat "RECOMMENDED" pill (`#e3c893` on navy text) + "AUTOMATIC". Title Newsreader 400 31px "Export for Resonite". One row per file (main deck; soul deck if present, purple-tinted with a "SEPARATE OBJECT" tag) each with filename · size and a Generate button. Below: a full-width **"Generate and download both"** button (only when a soul deck exists).

**Path B — Manual, in-game.** Deliberately **neutral** (same slate shell as other sections, no gold) so it doesn't out-compete Path A. Badge: outlined "MANUAL, IN-GAME". Title "Card sheet only". Two download buttons (front.webp, back.webp) in plain slate. Then three big copyable numbers — **Columns 10 / Rows 7 / Total N** (mono 500 54px, `#f2f5ff`; on copy the tile border turns `#a4d4ba` and the hint reads "copied ✓"). Then the Deck Maker resrec link in a `#05080f` code block with a copy button, and six in-world steps.

**Credits block.** Three cards: Deck system (Deck Maker by Ukilop), Cards & data (Palify), Import tool (ResoPal by Dalek). Followed by the legal/disclaimer paragraph. Both Ukilop and Palify credits are mandatory.

### 8. Rip a pack (mode 2)

Header: title "Rip a pack" / desc "Dawn of Palpagos — 7 cards a pack: four commons, two uncommons, one hit slot that's always Rare or better." Right: two stat tiles (packs opened, cards collected).

Stage area: `min-height:520px`, `display:grid; place-items:center`.

**Sealed pack.** 250×527 (the art's true aspect is 0.4747 — do not squash it), `filter:drop-shadow(0 26px 44px rgba(4,7,18,.7))`. Composed of **two pieces of the same image** so they read as one pack:
- Top strip: `height:83px`, `overflow:hidden`, image at `top:0` — 83px puts the tear line just below the printed "1st Edition / 7 cards per pack" header band.
- Body: `top:83px`, `height:444px`, `overflow:hidden`, image at `top:-83px`.
- Behind them: three stacked inner cards (158×221). **Only the first card's art is visible**; the two behind are dimmed blank stock — showing them would spoil the pull.
- A 92px-tall invisible swipe strip across the top (`cursor:grab`, `touch-action:none`).

**Tear interaction.** Drag horizontally across the top; progress = `min(1, |dx| / 110)`. The top strip peels with `perspective(700px) translate(…) rotate(…) rotateX(t*58deg)` in the drag direction, transform-origin biased to the anchored side. Hint text: "Drag across the top of the pack to tear it" → "Keep tearing…" → "Let go to open it".
**Release commits** (threshold 0.55): strip flies fully off (`.55s`), body slides down 118px and fades (`.5s`), inner cards rise. At +300ms the first card animates `translate(0,131px) scale(1.8228)` over `.52s` — which lands it **exactly** on the reveal card's box (158→288px wide, centred) — and at +830ms the reveal stage takes over with the card already at that position and scale, so the handoff is invisible. Below threshold it springs back.

**Reveal / swipe.** Reveal area is 420×470 and the **whole area** is the drag target (not just the card) — grabbing was unreliable otherwise. Current card 288×402, face up. Behind it, the next two cards are rendered **face up with real art** so swiping uncovers the next card directly. Drag ±64px to commit; card flies to ±520px with `rotate(±26deg)` and fades over `.26s`, then goes to the binder. The incoming card is rendered with transitions suppressed for two frames (`snap`) so it never appears to slide in from the side. A "TO BINDER" pill fades in proportional to drag distance. Secondary text button: "or reveal all N cards".

**Celebrations** — four tiers by rarity:
| Tier | Rarities | Treatment |
|---|---|---|
| 0 | C, U, R | none |
| 1 | RR | halo (360px) + 14 confetti |
| 2 | SR, SP | halo 540px, 30 confetti, 2 expanding rings, rarity slams in at 52px |
| 3 | OSR, SSP, SSS | halo 630px, 52 confetti, 3 rings, rotating conic ray burst, rarity slams at 74px |

Tier 3 also **locks input for 1.5s** (drag, click, and reveal-all all ignored; tip reads "Take it in…") so the celebration actually plays. Celebration is always **centred on the pulled card** — in the reveal stage that's screen centre; on the pack summary it renders inside the specific card's cell at `scale(.4)` with a 2px rarity ring.

**Pack summary.** "Pack N — best pull X", the 7 cards at 112×157 with rarity badges (glow rarities get a colored border), then "Rip another pack" / "Import my pulls (N)".

**Binder.** Persistent strip below: 60×84 thumbs sorted by rarity with duplicate-count badges, a per-rarity tally, and a "Copy as code,rarity" button that emits exactly the `format=flat` shape from `PULL-API.md` for the planned in-game tool.

### Bottom bar (generation progress + notices)

Fixed bottom, max-width 1180px, `border-radius:22px`, `background:rgba(13,19,38,.94)`, `backdrop-filter:blur(16px)`, `box-shadow:0 -8px 40px rgba(2,5,16,.7)`, over a `linear-gradient(transparent, rgba(6,9,22,.92) 42%)` scrim.

- 40px status tile showing percent / "✓" / "429" / "!", title, detail, a 5px progress bar, and a note line.
- Four named phases in a strip: **Read deck · Fetch art · Compose sheet · Pack file**. Done = sage dot, active = periwinkle dot with `rp-pulse`, pending = grey. Phases hide when the bar is showing a notice instead.
- Copy owns the slowness rather than apologising: "Deliberately slow — we fetch a few images at a time to be kind to Palify's servers." When cached: "N already cached from today, so those are free."
- **Rate-limited (429)**: rose accent, "Palify is rate-limiting us", detail "HTTP 429 after N of M images", actions Retry / "Use a file instead".
- **No public decks**: oat accent, "No public decks on this profile", actions "Try another link" / "Import .txt / .csv".
- Success: sage accent, "Drag the file into Resonite. Both credits travel inside the deck object."

## Interactions & Behavior

- **Progressive reveal**: sections mount as `step` advances (0 input → 1 review → 2 soul → 3 back → 4 export). Pull imports skip soul entirely (review jumps straight to step 3) and renumber the visible step badges 01–04.
- **Entry animation**: newly revealed sections use `rp-rise` (`.45s cubic-bezier(.2,.7,.3,1)`, opacity 0→1 + `translateY(14px)→0`).
- **Auto-scroll**: custom rAF tween to `element.top - 120px`. Duration `min(700, 240 + |distance| * 0.5)`ms, ease-in-out-quad. Do not rely on `scrollTo({behavior:'smooth'})`.
- **URL routing**: `/u/<handle>` → deck picker; `/decks/<uuid>` → straight to review; a pasted decklist body → review; anything else → error.
- **Drag prevention is essential**: all `<img>` are `-webkit-user-drag:none; user-drag:none; user-select:none; pointer-events:none`, plus a `dragstart` listener that `preventDefault()`s on images. Without this the browser starts a native image drag and swallows the gesture.
- **All drag gestures use window-level pointer listeners**, not `setPointerCapture`. An unreleased capture from the tear gesture broke the first card's swipe on the following screen.
- **Day-scoped image cache**: `localStorage['resopal.demo.imgcache.v1'] = {day: 'YYYY-MM-DD', count: N}`. Surfaced in the UI as the cache chip. Production should cache the actual card metadata/art responses per day to minimise Palify calls.
- **Seeded PRNG**: pack rolls use a linear-congruential generator (`seed = (seed*1664525 + 1013904223) >>> 0`) so a `seed` param can reproduce a pull later.

## State Management

```
mode          'deck' | 'rip'
stage         'input' | 'picker' | 'deck'
step          0..4                        progressive reveal pointer
input         string                      URL or filename
error         null|'empty'|'unknown'|'notlink'
notice        null | 'noPublic'
handle        string                      profile handle
deckLabel     string                      deck name (drives export filenames)
variants      {cardKey: printCode}        chosen art per card
discarded     {cardKey: bool}             pull keep/discard
fromPulls     bool                        import came from pack ripping
soulCode      string  (default 'SOUL-001' = Art 2)
soulCount     int     (default 10)
soulSkipped   bool
backSrc/backCustom/zoom/rot/ox/oy         card back crop
imgBudget     int                         how many card arts may load (wave loader)
gen           null | {pct, failed}        generation progress
ready         bool
genKind       'package'|'soul'|'both'|'sheet'|'back'
copied        null | key                  copy-feedback target
cachedCount   int
vw            int                         viewport width for responsive branches

// pack ripping
pack          Card[]                      pre-rolled, least-rare first
packStage     'sealed' | 'reveal' | 'done'
tear          0..1        tearDir  ±1    tearDrag bool
torn          bool        lifting  bool   commit + card-lift phases
revealIdx     int
cardDX        px          cardOut  ±1    cardDrag bool   snap bool
celebrate     null | {rarity, tier, big}
celId         string                      which card the celebration is centred on
hold          bool                        input lock during tier-3 celebration
binder        Card[]                      all pulls across packs
packCount     int
```

Data fetching required in production: Palify card catalogue + deck/profile endpoints (throttled, day-cached), `data/pack-weights.json`, card art (`/cards/w256/` for review thumbs, `/cards/w512/` for the reveal card, full-size for the atlas bake).

## Design Tokens

**Colors**

```
Surfaces
  page base        #070b17   #060916   #080d1e
  panel            linear-gradient(180deg, rgba(20,28,54,.86), rgba(15,21,42,.86))
  panel raised     linear-gradient(170deg, rgba(42,46,80,.88), rgba(18,24,46,.9))
  panel purple     linear-gradient(180deg, rgba(38,24,60,.8), rgba(22,17,42,.86))
  inset / code     rgba(7,11,23,.5–.72)   #05080f
  border           rgba(150,170,230,.11 / .16 / .2)
  bar              rgba(13,19,38,.86–.94) + blur(14–16px)

Text
  primary          #e8ecfa      secondary   #dbe2f5 / #c3cbe4
  muted            #9aa6c8      dim         #8e9ac0
  faint            #69769c      faintest    #4f5c80 / #5b678a

Accents (all deliberately desaturated — no neon, no glow shadows)
  periwinkle       #a9abee  (primary action)   #9a9ce0  #b0b3ea  #b8baf4 (hover)
  dusty cyan       #a3cfd8   #a8d3dc   #bcd9e0
  sage             #a4d4ba   #8cc4a6      (success / keep / copied)
  oat              #e3c893   #e6d5b0      (Ukilop, recommended badge, warnings)
  lilac            #c2a3e2   #cdb4e8   #b39ad6   (soul deck)
  rose             #dfa2ab   #eed6da   #bda3a8   (errors)
  navy-on-accent   #1a2038  #08251a  #1a1408   (text on filled buttons)

Rarity
  C #9aa6c8   U #a4d4ba   R #a3cfd8   RR #c2a3e2
  SR #e3c893  OSR #e0b393  SP #dfa2ab  SSP #e5a8c0
```

**Typography**
- Display / titles: **Newsreader** 400–600. H1 62px/1.04 (`-.015em`); section titles 25px/1.2; Path A title 31px/1.15; Path B 27px/1.15.
- UI: **Figtree** 400/500/600/700. Body 17px/1.62; descriptions 13.5px/1.5; row titles 15.5px; labels 12.5px; buttons 13.5–15px.
- Mono / data: **JetBrains Mono** 400/500/700. Eyebrows 9.5–10.5px with `letter-spacing:.13–.14em` uppercase; codes 11.5px; big numbers 54px.

**Spacing** — 4px base: 4 5 6 7 8 9 10 11 12 14 16 18 20 22 24 26 28 30 32 44. Section gap 26px; panel padding 30px 32px; page padding 132px top / 200px bottom, max-width 1180px.

**Radii** — 6 7 8 9 10 11 12 13 14 15 16 18 20 22 28 px; 99px pills; 50% dots.

**Shadows** — `0 18px 44px rgba(2,5,16,.6)` (top bar) · `0 24px 60px rgba(3,6,18,.5)` (panels) · `0 22px 54px rgba(4,7,18,.6)` (reveal card) · `0 26px 44px rgba(4,7,18,.7)` (pack) · `0 -8px 40px rgba(2,5,16,.7)` (bottom bar). **No colored glow shadows** — they were removed deliberately for a pastel, non-AI-looking feel.

**Keyframes** — `rp-rise` (section entry) · `rp-twinkle` 7s · `rp-drift` 120s · `rp-pulse` (active dots) · `rp-bob` 2.4s (tear hint) · `rp-burst` (confetti, custom props `--tx/--ty/--tr`) · `rp-halo` · `rp-ring` · `rp-rays` 9s linear · `rp-slam` · `rp-cardpop`.

## Assets

| Asset | Source | Notes |
|---|---|---|
| `assets/DefaultBack.png` | ResoPal repo `assets/DefaultBack.png` | The real official default card back. 1024×1463. |
| `assets/pack-bp01.png` | user-supplied `BP01-Single.webp`, cropped to opaque bounds | 712×1500, aspect **0.4747**. Preserve this ratio. |
| Card art | `https://palify.org/cards/w256|w512/<CODE>.webp` | Hotlinked in the prototype. Production: throttle + cache. Palify requires credit. |
| Fonts | Google Fonts | Newsreader, Figtree, JetBrains Mono |

Striped placeholder underlay (used behind every card so a failed/slow load still looks intentional):
`repeating-linear-gradient(115deg, <hue>33 0 7px, transparent 7px 14px)` over `linear-gradient(150deg, rgba(30,26,52,.9), #141a3a)`.

## Data files (carry these over as-is)

- `data/pack-weights.json` — pack structure (7 cards: 4C/2U/1 hit) and hit-slot odds, with `perPackBonus` and `globalBonus` multipliers for events, and a `celebrate` block naming which rarities glow/burst. **Bushiroad has not published official Dawn of Palpagos pull rates** — the table is community box-math tuned for fun, and the file says so.
- `data/td01-red-blue.csv`, `data/td02-green-purple.csv` — the two trial decks behind "Don't have a deck?". Structure and codes are right; per-card quantities are an even 2× split pending an official decklist.
- `PULL-API.md` — draft contract for `GET /api/pull` (`format=json|flat`, `seed`, `packs`) for the planned in-game random-pack tool. Not implemented.

## Files

| File | What it is |
|---|---|
`ResoPal.dc.html` | The whole design. Self-contained: markup + logic + inline styles. Open directly in a browser.
`support.js` | Runtime for the prototype's component format. **Not needed** in the target codebase.
`assets/DefaultBack.png` | Default card back
`assets/pack-bp01.png` | Booster pack art, cropped
`data/*.json`, `data/*.csv` | Pull weights + trial decks
`PULL-API.md` | Draft in-game pull endpoint

To read the design source: the template (markup) and the logic class are both inside `ResoPal.dc.html`. Styles are inline on elements by design; only `@keyframes`, `@font-face` and body resets live in the `<helmet><style>` block.
