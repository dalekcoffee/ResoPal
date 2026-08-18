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

Two sections, because a Palify deck is really two decks.

Show what we parsed before anything is generated. This is the trust step.
- Deck name and total card count.
- The card list with **quantity, card code, card name** — e.g. `3x  TD02-005  Eikthyrdeer Terra – Guardian of Nature`.
- Thumbnails of each unique card.
- **Per-card art variant control.** A code can have printings: `BP01-025`, `BP01-025OSR`,
  `BP01-025SSP`. Where variants exist the user should be able to pick which art gets used for
  that card. Default to the base printing.
- Clear, non-alarming treatment for **cards whose art failed to load** — the deck must still be
  generatable with a placeholder rather than blocking.

**Soul deck sub-section.** Shown beneath the main deck, visually distinct so nobody confuses the
two — these become two separate objects in Resonite.
- If the source carried soul cards, they are listed the same way and pre-filled.
- If it did not (a `.txt` or `.csv`, which carry no soul section), show an inviting empty state
  rather than an error.
- Either way, a **soul-card picker** over every soul card Palify knows about: searchable,
  browsable by art, add and remove with quantities. This needs to feel like a small deck builder,
  not a dropdown — it is the one place in the tool where the user is making a choice rather than
  confirming one.
- A deck with no soul cards must be able to proceed with the main deck alone.

### 4. Card back

- Default back is the official Palworld OCG card back (the image Dalek attached — still needs adding to the repo as an asset).
- One back applies to both decks by default, with an opt-in to give the soul deck its own.
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
- **One block per deck** — main deck, and soul deck if present. Each block is self-contained and
  clearly labelled, because the user performs the whole Resonite procedure once per deck. Do not
  interleave them; a user working through the main deck should never accidentally read the soul
  deck's numbers.
- **The three numbers, huge and copyable**, per deck: `Columns 9`, `Rows 6`, `Total 50`. These get
  typed into the Deck Maker by hand. They are the single most-likely thing to get wrong.
- **Download front atlas** and **Download back** as two obvious buttons, plus a "download both".
- A **short import code** (Phase 2) with a copy button, for the in-game companion panel.
- A compact numbered "what to do in Resonite" strip — import both images, drop front into
  `FrontTexture`, back into `BackTexture`, set the three numbers, press bake. Six steps maximum,
  each one line. Illustrations beat sentences here.
- A visual preview of the composed atlas grid (scaled down) so the user can sanity-check it.

### 7. Cross-cutting states

- **Loading / progress** — composing an atlas means fetching up to ~50 images; show real
  progress, not a spinner, and name what is happening ("fetching 34 of 50 card images"). Fetches
  are deliberately throttled to be kind to Palify's servers, so this is not instant by design —
  the copy should own that rather than apologise for it.
- **Failure** — network, blocked, rate-limited. Always offer the file-upload path as the escape
  hatch.
- **Mobile layout** — the review list and the crop tool are the two hard ones. Crop must work with
  touch gestures.

## Fixed constraints the design must respect

- **Two credits are mandatory and permanent**, and both need real visual weight — attribution
  lines, not footer fine print:
  1. **`Deck Maker by Ukilop V1.4.4`** — shown on every page that produces an import, and
     prominently on the export screen. The generated deck carries this credit in-world regardless;
     the site must never imply ResoPal built the deck system.
  2. **Palify** — the data and card-art source, linked back. Using their free API is conditional
     on crediting them, so this is an obligation we have accepted, not a nicety.
- Card art is Pocketpair IP served by Palify. The design should not read as an official Palworld
  or Palify product.
- Output is exactly **two images and three integers**. Resist any design that implies the site
  produces a finished Resonite object (until Phase 3 exists, at which point a third download
  button appears on the export screen — leave room for it).

## Explicitly out of scope for the front end

Deck editing, deck building, collection tracking, price data, login. Palify already does all of
it. ResoPal is a converter and nothing else.

The one deliberate exception is the **soul-card picker**, which is a small building interface —
it exists because a soul deck may be absent from the source entirely, and because picking one is
a genuine choice the user makes here. Card search elsewhere in the tool is still out of scope.
