# Site review — issues found and fixed

A pass over `index.html` looking for defects, not for design changes. Every fix below is
behaviour-preserving: nothing moved, no colour changed, no element was added or removed from the
layout. Verified by rendering the page before and after.

---

## 1. "Copied ✓" appeared even when nothing was copied — *fixed*

**Issue.** `copy()` set `copied: key` unconditionally:

```js
try {
  const p = navigator.clipboard && navigator.clipboard.writeText(text);
  if (p && p.catch) p.catch(() => {});     // failure swallowed
} catch (e) {}
this.setState({ copied: key });            // success reported regardless
```

`navigator.clipboard` is `undefined` outside a secure context, and `writeText` rejects when the
document isn't focused or permission is refused. In both cases the button still read **Copied ✓**.

**Why it matters more than it looks.** Path B's entire instruction to the user is *paste this into
Resonite*. A user who sees "Copied ✓", switches to the game, and pastes nothing has no way to tell
what went wrong — the site told them it worked. This is the single highest-consequence bug on the
page: it breaks the manual import path silently.

**Fix.** Try `navigator.clipboard`; on absence or rejection fall back to a hidden `<textarea>` plus
`document.execCommand('copy')`, which works in non-secure contexts and older browsers. Report
success only when one of them actually wrote. If both fail the label simply stays "Copy", which is
the truth.

The synchronous branch runs inside the click gesture, where `execCommand` is permitted.

---

## 2. Failed card images painted a broken icon over the placeholder — *fixed*

**Issue.** None of the 15 `<img>` elements had an `onError` handler. The design deliberately puts a
striped placeholder behind every card "so a failed/slow load still looks intentional" — but a
broken `<img>` renders the browser's own broken-image glyph *on top of* that placeholder, which is
the opposite of intentional. Palify rate-limiting (HTTP 429) is a state the design explicitly
anticipates elsewhere, so this is a path users will hit.

**Fix.** One capture-phase `error` listener on `document` swaps a failed image's `src` for a
transparent GIF, letting the placeholder show through as designed. Capture phase because resource
`error` events do not bubble. A single listener rather than 15 attributes keeps the markup
untouched and covers any image added later.

---

## 3. No `prefers-reduced-motion` support — *fixed*

**Issue.** The page runs eleven animations, including a starfield that drifts continuously, section
entry rises, confetti bursts, expanding rings and a rotating ray sweep, plus a custom rAF scroll
tween. None of it responded to the OS "reduce motion" setting. For users with vestibular disorders
this is the difference between a usable page and an unusable one.

**Fix.** A `@media (prefers-reduced-motion: reduce)` block collapses animation and transition
durations, and `glide()` jumps straight to its target instead of tweening. Layout, colour and
typography are untouched — only movement stops, and only for users who asked. Everyone else sees
exactly what they saw before.

---

## 4. `copyT` survived unmount — *fixed*

**Issue.** `componentWillUnmount` cleared six timers but not `this.copyT`, so a copy within 1.8s of
unmount left a `setState` scheduled against a dead component.

**Fix.** Cleared alongside the others.

---

## 5. A missing `data-code` wiped the aspect-ratio map — *fixed*

**Issue.**

```js
if (!code || this.wide === undefined) this.wide = {};
```

Two unrelated conditions share one branch. The intent is "initialise the map if absent"; as written,
an image without a `data-code` *resets the entire map*, discarding every landscape flag learned so
far and re-rendering with cards in the wrong orientation until they reload.

Not currently reachable — every gauged `<img>` carries a `data-code` — but it is a trap for the next
person who adds one.

**Fix.** Split into initialise-then-guard.

---

## Verification

Rendered in headless Chromium with React served locally and `palify.org` blocked outright, to force
the image-failure path:

```
TITLE      : ResoPal — Palworld TCG decks in Resonite
RENDERED   : 748 chars of text
BUTTONS    : 11
IMGS       : 3 | blanked by error handler: 3
PAGE ERRORS: 0
```

All three hero images fell back to the striped placeholder with no broken icons, and the screenshot
matches the design.

---

## Considered and deliberately not changed

- **Broad ARIA sweep.** 37 buttons carry one `aria-label` between them. The one that genuinely needs
  it — the resrec copy button, whose text collapses below 1180px — already has both `title` and
  `aria-label`, as the spec requires. A blanket pass over the rest is worth doing, but it is a
  design-review conversation, not a bug fix, and belongs in its own change.
- **`gauge()` calling `forceUpdate()` per image.** Roughly one full re-render per distinct card
  while art loads. Measurable but not perceptible at deck sizes, and batching it would change load
  sequencing the design tuned deliberately (6 cards, then +2 every 260ms).
- **The unpkg dependency.** React, ReactDOM and Babel come from a CDN, and Babel transpiles the
  whole file in the browser on every visit. Real, but fixing it means introducing a build step —
  a structural change, not a repair.
