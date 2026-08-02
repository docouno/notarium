# Demo screenshots and the README artwork

Every picture of the product — the banner at the top of the README, the repository's
social card, the stills on the landing page and the docs site — is **generated**, not
hand-taken: one command re-cuts the whole set after a design change, a copy change or a
new release. This document is that command, plus the decisions behind it. Canon for the
seed catalog itself is [seeds.md](seeds.md).

```bash
make footage             # both stages: photograph the app, then compose the artwork
make demo-shots          # stage 1 only → test/demo/out/en/ (git-ignored)
make demo-preview        # stage 2 only → assets/ (committed) + assets/og/
make demo-plates         # stage 2, plates only → assets/og/ (git-ignored here; the docs repo commits them)
LOCALE=en make footage   # the same; other locales are not authored yet
```

Stage one takes about a minute and writes twelve stills: six frames × two themes, at
2880×1800 — 1440×900 at `deviceScaleFactor: 2`, because every surface that publishes
them (the landing, this repo's README, the docs site) displays them on a retina screen
at close to their CSS width, where a 1× still is visibly soft.

Stage two takes seconds. That is why it is a separate target: re-cutting the banner
after a wording change should not mean re-shooting the application.

## What it photographs

A dedicated seed case, `demo` — a self-hosting developer's knowledge base about
the machine and the services they run. Nothing in it is about Notarium: a demo of
us documenting ourselves proves nothing about what a reader would keep here.

Frames, and what each is for:

| Frame | Shows |
|---|---|
| `reader` | An overview note: tree, rendered markdown with a diagram and a callout, the note's metadata and its links |
| `editor` | The same note as raw markdown in the editor |
| `history` | A revision chain where **an agent's edit sits beside the human's**, signed and versioned identically |
| `graph` | The link web the notes actually spell out |
| `search` | Spotlight over the base |
| `dashboard` | Ten months of backdated activity — the heatmap, the feed, the tiles |

`history` is the one that earns the set. It puts the product's core claim — one
base, one set of rules, for a person and for an agent — on screen as a fact rather
than a claim in prose.

## The artwork stage two composes

| Artifact | What it is |
|---|---|
| `assets/banner.webp` | The README hero: the product under the tagline, on authored light, cropped by the bottom edge |
| `assets/social-card.jpg` | 1280×640, the size GitHub wants for **Settings → Social preview**. Upload it there by hand — GitHub has no API for that field |
| `assets/app-<frame>.webp` | The legible stills behind the README's "More screenshots" fold |

These are the only generated binaries the repository carries; the stills they are cut
from stay git-ignored. **Dark theme only** — one deliberate look reads as a designed
plate on GitHub's white page, and it halves what has to be committed and kept in sync.

`make demo-plates` writes three more files, into `assets/og/` — and those are **not**
committed here (see the OG plates below): their reader is the docs site, and a binary
belongs in the repository that serves it.

| Artifact | What it is |
|---|---|
| `assets/og/og-hero.webp` | 1200×630 background plate for the docs site's front-door card: light, discs, product window — no words |
| `assets/og/og-doc.webp` | The same light without the window, for the docs site's per-page cards |
| `assets/og/plates.json` | The plates' contract: canvas size and the text zone each one leaves free |

The composition is the landing hero's arrangement minus everything that belongs to a
website: no nav, no CTA buttons (a button painted into an image is a button that does
not click), no "Open Source" eyebrow above a reader who is already looking at the
repository.

**Nothing in it is transcribed.** The palette is `packages/web/src/styles/tokens.scss`
injected verbatim as CSS, the typeface is the variable Inter the app itself ships, the
mark is `favicon.svg` (the file the PWA icon set is generated from), and the one line of
type is the headline parsed out of `README.md`'s own tagline. A re-theme, a re-brand or
a re-worded tagline lands in the banner on the next run instead of quietly disagreeing
with it. Each of
those reads asserts its shape and fails loudly: a tokens file that grows nesting, or a
README whose tagline stops being `**headline.** subheading`, stops the run rather than
publishing half a theme or last month's copy.

The one number that is not derived: the rose disc colour in the light cluster, which is
a decorative marketing hue with no token in the product palette. It is declared once,
in `test/demo/preview/template.ts`.

## The OG plates, and why they carry no text

The docs site needs a social card per page: nine languages over its whole tree, ~480
images, every one of them derived from content authored in *that* repository. Two
obvious arrangements both fail. Export finished cards from here and every wording change
over there means re-exporting the set by hand and committing ~25 MB of pictures. Rebuild
the atmosphere over there and this recipe exists twice, in two technologies, drifting
apart on the next re-theme.

So this exports what never varies — the light, the discs, the product window — and the
docs build sets the type. The plates are cut by the same `make demo-plates`, which is
also why they re-cut on their own: the README artwork answers to the README's copy and
has no reason to churn when a plate's geometry moves.

`plates.json` is the part that makes it safe. The consumer sets type over a picture it
cannot see, so it needs the canvas and the line its text must clear — `textZone`, the
point where the plate's own content begins — from the export rather than from a number
someone copied into another repo. `test/demo/preview/plates.test.ts` guards the geometry
at this end; the docs build checks the plate it imported against the manifest that came
with it, which is where a stale import can actually be caught.

`assets/og/` is git-ignored, unlike the rest of `assets/`. That is not an inconsistency:
GitHub serves the README's artwork straight out of this repository, so those files have
to live here, while nothing here ever reads a plate. The docs site does — and its build
cannot see a sibling checkout, so the plate is committed over there, beside the
screenshots that repository already imports. One set of bytes, in the repository that
serves it; this one keeps the recipe.

The plates are encoded **lossy** (WebP q95) even though they are an intermediate — the
docs build decodes one, draws on it and re-encodes it. Lossless looks like the careful
choice for exactly that reason, and measured it is the wrong one: 493 KB against 42 KB
for a difference that lives in the noise tile and disappears in the consumer's own
encode. (Nothing here is lossless, including the README artwork — WebP q82 for the
banner and the gallery, JPEG q92 for the social card.)

## How it works

```
test/cases/demo/en.ts      the strings — paths, titles, bodies
        ↓
test/cases/cases/demo.ts   the shape — folders, dates, who edited what
        ↓
caseToFixture              the fake projection (docs/seeds.md)
        ↓
test/fake-server (CASE=demo)  a real HTTP host serving the built SPA
        ↓
test/demo/screenshots.spec.ts  Playwright drives it and writes the PNGs
        ↓
test/demo/preview/            a static composition page, screenshotted at 2× and
scripts/demoPreview.ts        encoded — banner + social card + gallery into assets/
```

It runs against the **fake backend**, not a seeded stand: no Docker stack, no
data-root wipe, a fresh world every run, and the frames are reproducible. The
trade is that fake-only surfaces can't be photographed this way — connected apps,
the agent audit, jobs, favourites, archived spaces (see seeds.md). A frame that
needs one of those has to come from a real stand (`make seed CASE=demo`).

Everything runs **in the Playwright container**, like the visual matrix and for
the same reason: host fonts differ, and these pixels get published.

## Decisions worth not re-litigating

**Structure and strings are separate files.** `demo/en.ts` holds only what a
reader sees; `cases/demo.ts` holds folders, dates, revision chains and the
activity spread, addressing notes by a stable `key`. So a translation pass can
re-word a screenshot but can never move a note or reshuffle the heatmap.

**English only, for now.** The product's UI chrome has no i18n layer — no
`locales/`, no translation call, ~235 strings compiled into the components. A
localized bundle would render national note text inside an English interface,
which promises a localization that doesn't exist. The bundle shape is already
per-locale, so once the chrome is translated, adding the docs site's other eight
locales is a translation pass over `en.ts` and `LOCALE=de make demo-shots` — not a
rewrite. Until then, `demo_locales()` has one entry on purpose.

**English is the original, not a translation.** The EN copy is authored directly,
because it leads the landing page, the README and Show HN; the docs site's
`LOCALES[0] = 'en'` is the pivot every other locale is translated from.

**The world is anchored to the day of the shoot.** The catalog's default anchor is
a fixed past instant (byte-reproducible worlds for visual baselines), but a demo
stand is read against the real clock: "3 this week", "yesterday" and the heatmap's
right edge all come from it. A world ending three weeks ago photographs as an
abandoned base. The config passes `NOW` = noon UTC of today to both the seeded
world and the browser clock, so frames depend on the DAY of the run, not the
minute. `DEMO_NOW=<iso>` re-shoots an older run's world — with one caveat: it moves
the seeded world and the browser clock, but not the server-side aggregates that read
the process clock (the tree's "N this week", the activity window's default `to`). Set
it far from today and the dashboard's tile reads 0 beside a feed that says
"yesterday". For a faithful frame, shoot at today's anchor.

Two runs on the same day therefore produce the same WORLD and visually identical
frames — but not promised-identical *bytes*: the force-graph canvas and font
rasterisation are not pinned the way the visual matrix pins its baselines. Compare
frames by eye, not by hash.

That anchor has a cost worth stating plainly, because `assets/` is committed: a run on
a different day photographs a different world (the dates move, the heatmap slides), so
`make footage` always produces a binary diff, whether or not anything about the product
changed. Re-cut when the product, the design or the tagline moved — not as a habit, and
not "to be safe" before a release.

Because of that anchor, **the bundle carries no absolute dates** — not in a body,
not in a path. A literal date in an ADR header stays put while the note's real
created-date moves with the anchor, and both are legible in the same frame; the
incident's filename would freeze the same way (it is also the note's id and the
file the real applier writes). This case shed exactly that defect — keep it shed
when adding a locale.

**Waits are explicit, and one of them is load-bearing.** Mermaid renders lazily,
after the markdown pass: without waiting for `.md-mermaid svg` the shutter catches
the raw ```` ```mermaid ```` source. That is exactly what happened the first time
the frame was taken without a slow neighbour accidentally hiding the race.

## Adding a locale (when the chrome is translated)

1. Copy `test/cases/demo/en.ts` to `<locale>.ts` and translate paths, titles,
   bodies, `spaceName`, `searchQuery` (it must still hit several notes) and the
   filler titles. Keep every `key` and every `[[wikilink]]` target consistent —
   links resolve by title, so a translated body must point at translated titles.
   Every authored version in `edits` must still change the text (see below).
2. Register it in `test/cases/demo/index.ts`.
3. `LOCALE=<locale> make demo-shots`, then look at all twelve frames. German runs
   ~30% longer than English and CJK has its own metrics: what breaks is layout —
   truncated breadcrumbs, wrapped table headers, a heading that no longer fits.
   That part is not automatable; budget the reading time.

Nothing outside the bundle needs editing: the spec resolves its frame subjects and
its search query FROM the bundle (by note `key`), so translated paths keep working.
What is *not* translated is the app's own chrome — there is no i18n layer — so the
frames will show English menus around national note text, and the spec still finds
its buttons by their English accessible names. That is the same reason only `en`
exists today.

## Adding or changing a frame

Frames live in `test/demo/screenshots.spec.ts`, one `test()` each. Two rules:

- **Wait for the thing you are photographing**, not for the page. Every frame
  waits for its own subject (a painted heatmap, a rendered diagram, a settled
  graph) — a shot of a half-loaded surface is worse than no shot.
- **Nothing here asserts.** `expect` is used only as a wait. This run produces
  artifacts; it must never gate a merge, which is why it has its own config
  (`playwright.demo.config.ts`) and never joins `npm run e2e`.

Renaming or dropping a frame breaks stage two, which names the ones it publishes in
`test/demo/preview/preview.ts` (`HERO_FRAME`, `GALLERY`). It fails with the missing
filename rather than composing around the gap — but the README still links whatever
`assets/app-<frame>.webp` it linked before, so a rename is three edits, not one.

Which frame carries the banner is `DEMO_HERO=<frame> make demo-preview` — a judgement
about the CROP, since the banner shows roughly the window's top half and a frame whose
subject sits low arrives half-eaten. Two picks are already settled: the dashboard is
out (a contribution heatmap on the first screen reads as a git profile, not as a
knowledge base), and so is the graph, until it is less raw.

Changing the composition itself is `test/demo/preview/template.ts`. Every run leaves
the page it screenshotted at `test/demo/out/<locale>/preview/<artifact>.html`: open it
in a browser and iterate there rather than re-running the encode for each nudge.
