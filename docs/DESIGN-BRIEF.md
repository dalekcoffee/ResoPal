# ResoPal web — design brief for Claude Design

Hand this over as-is. It describes what the front end must do; it deliberately does not
prescribe how it should look.

## What this thing is

A one-page tool that turns a Palworld TCG deck from Palify into two images and three numbers that
Resonite's Deck Maker can eat. Audience: Resonite users who play the TCG. Most will be on desktop
while in a headset session, or on a phone. It is a utility, not a storefront — the win condition
is "paste, download, done" in under thirty seconds.

## Screens / states to design

### 1. Input (landing)

One primary input that accepts **three different things** and figures out which is which:
- a deck URL — `https://palify.org/decks/f2dd143c-8e6f-4142-87d2-051195185f96`
- a profile URL — `https://palify.org/u/dalek`
- a dropped or picked file — `.txt` or `.csv` exported from Palify

Needs:
- A single paste field plus a drop zone, not two competing entry points.
- Inline hint text with a real example of each accepted form.
- The file path must be obviously equal to the URL path, not a hidden fallback — private decks
  are the *only* way private-deck owners can use this at all.
- Error states: unrecognised URL, deck not found, deck is private (with a nudge toward the file
  path), malformed file, empty deck.

### 2. Deck picker (only when a profile URL was given)

A list of that user's public decks: name, card count, and a small preview of a few card faces.
Select one to continue. Needs an empty state (no public decks) and a "this profile is private" state.

### 3. Deck review

Show what we parsed before anything is generated. This is the trust step.
- Deck name and total card count.
- The card list with **quantity, card code, card name** — e.g. `3x  TD02-005  Eikthyrdeer Terra – Guardian of Nature`.
- Thumbnails of each unique card.
- **Per-card art variant control.** A code can have printings: `BP01-025`, `BP01-025OSR`,
  `BP01-025SSP`. Where variants exist the user should be able to pick which art gets used for
  that card. Default to the base printing.
- Clear, non-alarming treatment for **cards whose art failed to load** — the deck must still be
  generatable with a placeholder rather than blocking.

### 4. Card back

- Default back is the official Palworld OCG card back (the image Dalek attached — still needs adding to the repo as an asset).
- Upload a custom back, then **pan / zoom / rotate within a fixed card-aspect crop frame**
  (aspect ≈0.71, i.e. a standard TCG card). The frame is the output; anything outside is trimmed.
  This is the whole point — trimming happens here so nothing is wrong once it is in Resonite.
- Live preview of the cropped result at card proportions.
- Reset to default back.

### 5. Quality / options

Small, secondary. Do not let it dominate the flow.
- Quality tier: **Standard (4096²)** vs **High (8192²)**, with a plain-language note that High is
  sharper but heavier for everyone in the session.
- The chosen grid (e.g. `9 x 6`) shown as derived output, not as an input the user sets.

### 6. Export / result — the most important screen

The user is about to alt-tab into a headset. Assume they will not read a paragraph.

Must present, in this order:
- **The three numbers, huge and copyable**: `Columns 9`, `Rows 6`, `Total 50`. These get typed
  into the Deck Maker by hand. They are the single most-likely thing to get wrong.
- **Download front atlas** and **Download back** as two obvious buttons, plus a "download both".
- A **short import code** (Phase 2) with a copy button, for the in-game companion panel.
- A compact numbered "what to do in Resonite" strip — import both images, drop front into
  `FrontTexture`, back into `BackTexture`, set the three numbers, press bake. Six steps maximum,
  each one line. Illustrations beat sentences here.
- A visual preview of the composed atlas grid (scaled down) so the user can sanity-check it.

### 7. Cross-cutting states

- **Loading / progress** — composing an atlas means fetching up to ~50 images; show real
  progress, not a spinner, and name what is happening ("fetching 34 of 50 card images").
- **Failure** — network, blocked, rate-limited. Always offer the file-upload path as the escape
  hatch.
- **Mobile layout** — the review list and the crop tool are the two hard ones. Crop must work with
  touch gestures.

## Fixed constraints the design must respect

- **Credit is mandatory and permanent.** Every page that produces an import credits
  `Deck Maker by Ukilop V1.4.4`, and the export screen must show it prominently — not in a footer
  disclaimer. Treat it as an attribution line, not fine print. The generated deck carries the
  credit slot in-world regardless; the site must not imply ResoPal built the deck system.
- Card art is Pocketpair IP served by Palify. The design should not read as an official Palworld
  or Palify product, and should link back to Palify as the source.
- Output is exactly **two images and three integers**. Resist any design that implies the site
  produces a finished Resonite object (until Phase 3 exists, at which point a third download
  button appears on the export screen — leave room for it).

## Explicitly out of scope for the front end

Deck editing, deck building, card search, collection tracking, price data, login. Palify already
does all of it. ResoPal is a converter and nothing else.
