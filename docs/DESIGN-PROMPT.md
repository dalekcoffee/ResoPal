# Design brief: ResoPal — Palworld TCG deck importer for Resonite

I need you to design the front end for a tool called **ResoPal**, hosted at
**resopal.dalek.coffee**. I'll give artistic direction separately — this brief covers what the
thing has to *do*, the screens it needs, and the constraints it must respect. Don't pick a visual
style from this document; ask me for it.

## What ResoPal is

A one-page utility that turns a Palworld Trading Card Game deck into a card deck you can use in
**Resonite** (a social VR platform). A user pastes a deck link, and gets back a file they drag
into Resonite to get a physical, shuffleable, searchable deck of their exact cards.

Audience: Resonite users who play the Palworld TCG. Most are at a desktop while in a headset
session, or on a phone. **The win condition is "paste, download, done" in well under a minute.**
It is a converter, not a storefront and not a deck builder.

The deck data and card art come from **Palify** (palify.org), a fan-run Palworld TCG site. The
deck object itself is built on the **Deck Maker by Ukilop**, an existing Resonite creation.

## Two export paths — this is the heart of the design

The export screen offers **two different outputs**, and the design has to make the choice obvious
without making the second one feel like a failure state. Most people want the first. The second
exists for people who own Ukilop's Deck Maker and want to build the deck themselves in-game.

### Path A — "Export for Resonite" (primary, recommended)

A single `.resonitepackage` file. The user drags it into Resonite and gets a finished deck. No
in-game setup, no numbers to type, nothing else to install.

This is the default and should carry the visual weight. Typical file size is 10–25 MB, so the
download is not instant — show size up front.

If the deck has a soul deck, that is a **second, separate `.resonitepackage`** (a soul deck is 10
copies of one card and becomes its own object in Resonite). Present them as two clearly separate
downloads, never interleaved.

### Path B — "Export card sheet only" (secondary)

For users who already own **Ukilop's Deck Maker** and prefer to bake the deck themselves in-game.
This exports the raw materials instead of a finished object:

1. **The card sheet** — one image containing every card in the deck laid out in a grid.
2. **The card back image** — whatever back the user has configured in the editor. This must be
   included; it is not optional, and it must reflect their custom back if they set one.
3. **Three numbers** the user types into the Deck Maker: **Columns**, **Rows**, and **Total**.

Design requirements for this path:

- **The three numbers must be large, unmissable, and individually copyable.** They are typed by
  hand into a VR panel and they are the single most likely thing to get wrong.
- Explain plainly that this sheet is for use with **Ukilop's Deck Maker**, and that the user needs
  that item to use this export.
- Show **this exact link** so the user can get the Deck Maker, and make it **one-click copyable** —
  it is pasted into Resonite, not opened in a browser, so a "Copy" affordance matters far more
  than a hyperlink:

  ```
  resrec:///U-ukilop/R-e7100d16-9b62-4d74-b8e0-058b0492764f
  ```

  Treat it like a copyable code block with a copy button and a clear confirmation state. It will
  look like a broken URL to a browser — that is expected and the copy should not apologise for it.
- A short numbered strip of what to do in-game: import both images, drop the sheet into
  `FrontTexture`, the back into `BackTexture`, set the three numbers, press bake. Six steps
  maximum, one line each. Illustration beats prose here.

## Screens and states

### 1. Input (landing)

One primary input that accepts **three different things** and works out which is which:

- a deck URL — `https://palify.org/decks/f2dd143c-8e6f-4142-87d2-051195185f96`
- a profile URL — `https://palify.org/u/dalek`
- a dropped or picked file — `.txt` or `.csv` exported from Palify

Needs:
- A single paste field plus a drop zone, not two competing entry points.
- Inline hint text showing a real example of each accepted form.
- The file path must look **equal** to the URL path, not a hidden fallback. Private decks cannot
  be fetched by URL at all, so file upload is the only route their owners have.
- Error states: unrecognised URL, deck not found, deck is private (nudge toward the file path),
  malformed file, empty deck.

### 2. Deck picker — only when a profile URL was given

A list of that user's public decks: name, card count, and a few card faces as a preview. Select
one to continue. Needs an empty state (no public decks) and a private-profile state.

### 3. Deck review — the trust step

Show what we parsed before anything is generated.

- Deck name and total card count.
- The card list with **quantity, card code, card name** — e.g.
  `3x  TD02-005  Eikthyrdeer Terra – Guardian of Nature`.
- A thumbnail per unique card.
- **Per-card art variant control.** A card can have several printings — `BP01-025`,
  `BP01-025OSR`, `BP01-025SSP` — with different art. Where variants exist, let the user choose.
  Default to the base printing. This is common: 78 of 158 cards have more than one printing and 28
  have three.
- **Landscape cards.** 26 cards in the game (all "Structure" type) are printed sideways and get
  rotated automatically. Show this so it doesn't look like a bug — a small rotated indicator on
  those thumbnails is enough.
- Cards whose art failed to load must be **non-blocking** — show a placeholder and let the deck
  generate anyway.

### 4. Soul deck

Small and simple — resist over-building it. In this game every "Soul" card is the same card; there
are just **8 different arts**, all named "Soul", with no cost, colour or power. A soul deck is 10
copies of one of them.

Palify decks **never** carry a soul deck, so this is always a fresh choice the user makes here,
on every single deck — not an edge case.

- A row of 8 card arts; pick one.
- A count, defaulting to 10.
- A clear way to skip it entirely — main deck alone must be able to proceed.
- Visually distinct from the main deck, because it becomes a separate object in Resonite.

### 5. Card back

- A default official card back ships with the tool.
- One back applies to both decks by default, with an opt-in to give the soul deck its own.
- Let the user upload a custom back and **pan / zoom / rotate it inside a fixed card-shaped crop
  frame** (card aspect ratio ≈ 0.71). The frame is the output; everything outside it is trimmed.
  All trimming happens here so nothing can be wrong once it is in Resonite.
- Live preview at card proportions. Reset to default.
- Whatever back is set here must flow into **both** export paths.

### 6. Options

Secondary, must not dominate.
- Quality: **High (default)** vs **Standard**, described in plain language — High keeps card
  effect text readable in-world, Standard is lighter for everyone in the session.
- No grids, dimensions or technical output shown here. (The three numbers appear only in Path B,
  where they're actually needed.)

### 7. Cross-cutting states

- **Progress.** Generating a deck means fetching up to ~50 card images, compositing a large sheet,
  and packing a multi-megabyte file. Show real progress with named phases — "fetching 12 of 24
  card images", "composing sheet", "packing deck" — not a spinner. Fetches are deliberately
  throttled to be kind to Palify's servers, so this is slow **by design**; the copy should own
  that rather than apologise.
- **Failure.** Network, blocked, rate-limited. Always offer the file-upload path as the escape
  hatch.
- **Mobile.** The review list and the crop tool are the hard ones; crop must work with touch.
  Large decks may be slow or memory-limited on a phone — warn gracefully rather than crashing.

## Constraints the design must respect

**Two credits are mandatory and permanent.** These are obligations, not niceties, and they need
real visual weight — attribution lines, not footer fine print:

1. **Deck Maker by Ukilop** — the deck system ResoPal builds on. The site must never imply ResoPal
   built it. Prominent on the export screen especially.
2. **Palify** — the deck data and card art source, linked back. Their API is free to use on the
   condition that it is credited.

Also:
- Card art is Pocketpair intellectual property served by Palify. The design must not read as an
  official Palworld or Palify product.
- ResoPal is credited as the import tool, alongside — never instead of — the other two.

## Out of scope

Deck editing, deck building, collection tracking, prices, login, card search. Palify already does
all of that; ResoPal converts and nothing else. The soul art picker is a single choice, not an
exception to this.
