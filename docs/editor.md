# Editor and writing modes (#180)

The Notarium editor always edits the **raw markdown file** — the single source of truth (P1/P5/P9). Whatever the user does, clean markdown goes to disk with no cruft (no re-escaping, no re-normalizing of bullets, no collapsing of frontmatter). This is what sets Notarium apart from rich-WYSIWYG editors that store a normalized tree and re-serialize the file on save (a provably lossy round-trip — rejected forever, see the editor/content-authoring decisions behind this canon).

On top of this single body sit **writing modes** — a personal setting for how the text looks while you edit it. A mode does not change the bytes: it is only decoration over an unchanged string, so switching modes and saving are byte-for-byte identical.

## The title is the first line (#156)

There is no separate "Title" field. **A note's title is its leading `# H1`**, which you edit right in the document as the first line (in Source it shows as `# `, in WYSIWYM it is styled large). This gives the user a single editing surface instead of "field + body", which could drift apart (and would get in the way of a future true-WYSIWYG #120). If there is no leading `# H1`, the title becomes the first non-empty **prose** line (as in Bear/Apple Notes; equivalently — a setext heading `Title` over `====`), so quick capture does not turn into a database of "Untitled". But if the document opens with a **structural block** (code fence, list, quote, table, heading ≥H2) and no title is set, the note is not saved until a title appears: this way the first line of a code block/list does not silently leak into the title. A new note opens already on the `# ` line with the cursor at the title's position.

Under the hood the title is a **projection of the body**: it is derived on save at the single write checkpoint and materialized onward (frontmatter `title:`, journal #12, read-model, slug, file name) exactly as before — so search/graph/history/rename work as they did. On disk and in read mode there is exactly one title: a duplicate leading `# title` is stripped on write (the same checkpoint closes the agent-h1-duplicate bug — #156).

Because the title also picks the file name, typing one that a sibling already uses is a real collision, and a NEW note's save is refused rather than landing on that file. The draft stays in the editor and the dialog offers the three honest ways out — keep editing, save under a free name, open the note that is already there. canon: [note-model.md](note-model.md#create-collisions).

## The mode triad: Source / WYSIWYM / WYSIWYG

The names define the axis of difference — "how visible the markup is and how rendered the text is":

### Source

Raw markdown as-is: monospace font, themed syntax highlighting (like opening a `.md` in VS Code with an active theme). You edit the markup itself. For authors who prefer to work with the source directly — it stays first-class forever.

```
# Heading
Text with **bold** and a [link](https://example.com).
> Quote
```

Looks exactly as typed — the markers `#`, `**`, `[]()`, `>` are shown as plain text, highlighted by palette roles.

### WYSIWYM

"What you see is what you **mean**" — you edit the *meaning* of the markdown: the text is styled (headings larger, bold in boldface, quotes and code with a background), **but the markdown markers stay on screen** (muted). Line length does not change → the caret never "jumps" when you place it on a link or a heading.

The same fragment in WYSIWYM: "Heading" is large, **bold** is truly bold, the quote has a colored rail and a background — but `#`, `**`, `>` are still visible alongside, muted, as a semantic scaffold.

> **A caveat about the term.** Classic WYSIWYM (from LyX) *hides* the markup. In our case it is visible — so it is more accurate to call this **"WYSIWYM with visible markup"**. The acronym was chosen as a short name for the axis "I edit meaning, not the final look"; in the settings switcher there is always a one-line explanation beneath it.

The boundaries of WYSIWYM: it styles inline tokens and line-level blocks (headings/emphasis/code/quotes/lists/callouts/HR), **keeping the markers**. A render block that *replaces* the source (a table grid instead of pipe markup, an image instead of `![]()`) would have to hide the raw material — that is already the next mode.

### WYSIWYG (under research, #120)

Final render: markers hidden, tables as a grid, images as previews. The third mode of the triad; not built yet — being de-risked by spike #120 (which may reveal that WYSIWYM is enough).

## The common mode invariant

- **One file for all.** All modes edit the same raw md string; save writes exactly it, without normalization. Switching a mode does not touch the bytes.
- **Edit / Preview is an orthogonal axis.** The **Preview** button in the topbar, in any mode, shows the note's final HTML render (the same one as in read mode), without saving. "How I work" (Source/WYSIWYM) and "edit/view" (Edit/Preview) are independent.
- **The agent sees the same body.** An MCP agent reads and writes the same markdown as a human (P4) — the writing mode has nothing to do with it, it is purely client-side.

## Routed Role and Skill authoring (#309)

Owned Roles and Skills use the same global editing lifecycle as notes: one `EditingProvider`
owns dirty state, router blocking, `beforeunload`, Save/Cancel hotkeys, preview, and the honest
CAS conflict dialog. The ability surface changes the fields, not the lifecycle. It shows manifest
name + description + raw Markdown instructions; a Role additionally shows its ordered exact Skill
attachments. Generic note metadata (folder, slug, type, created date, tags) is hidden and omitted
from ability saves, so editing instructions cannot accidentally rewrite it.

A new ability is a routed document at `/agents/abilities/<roles|skills>/new/<draft-id>`. The URL
carries the stable draft identity; a versioned `sessionStorage` record carries the authored body
and creation settings under `(authenticated owner, draft-id)`. Reload restores only that exact
pair. Publish removes the record and replaces the history entry with the returned exact Owned
route; Cancel or confirmed discard removes it too. Logout, a mid-session 401, or a principal
change clears the previous owner's records, so a shared browser never offers one user's draft to
another.

The first Save calls the Role/Skill publication operation because no package exists yet. Every
later Owned Save goes through the ordinary id-addressed note update with its version token, so
history, replication, CAS refusal, and explicit overwrite behavior stay common. Role attachment
changes ride that same CAS write as an exact locator + complete ordered list. An unrelated body or
manifest edit omits the attachment fields and therefore preserves legacy invalid raw tokens;
explicit Detach removes them. Enabled state stays a one-shot kebab action outside authored dirty
state, while where an ability belongs and how far it reaches are fields of the document and commit
with its one Save. Covering anything other than exactly its own project is something only a Space
home can do, so a Project-homed Role given a wider answer relocates to its Space home inside that
same Save. Relocation is one-way: a package moves up to the Space, never down into a project or
across to another one.

## Distraction-free: Focus and Typewriter (#118)

On top of any writing mode sit two **independent writing aids** for long texts — they are orthogonal to both the triad (Source/WYSIWYM) and the Edit/Preview axis. Like a mode, these are pure decoration/scroll over an unchanged string: the bytes are not touched, the round-trip stays exact.

- **Focus** — dims everything except the **active unit** under the caret; you choose the unit: **Sentence / Line / Paragraph** (modeled on iA Writer). Sentence isolates a single sentence (it can cross a soft line break within a paragraph); Line — a logical line (for authors who write "one sentence — one line", this is effectively a sentence); Paragraph — the block between empty lines. On an empty line the focus **stays on the paragraph you are writing** (on the nearest non-empty one, preferring the previous): press Enter after a paragraph — the highlight does not flash across the whole screen and does not fade until you start the next paragraph (like iA Writer/Typora — stable, without flicker during fast typing). Nothing is dimmed only in a completely empty document. A selection highlights all affected units in full, so nothing "jumps" while you drag.
- **Typewriter** — keeps the line with the caret **vertically centered**: the document scrolls under it. Padding is added above and below so that both the first and the last lines can sit in the center.

Both are personal toggles that survive a reload (`localStorage`, server sync — groundwork #28). They are turned on three ways: a **hotkey** (Focus — `⌘/Ctrl+Shift+F`, Typewriter — `⌘/Ctrl+Shift+Y`), **two icons in the editor status bar** (on the left, next to the word count), and **Settings → Appearance** (which also has the Focus granularity choice). The hotkey toggles on/off, the remembered granularity is preserved.

> parts-of-speech highlighting (coloring parts of speech, iA Writer's unique differentiator) is deliberately **out** of scope — narrow and expensive; see research/.../market-landscape.md.

## Caret and floating bars (#231)

The editor's scroller is owned **not** by CodeMirror but by the ancestor page container (`.content-scroll` in `PageFrame`): `.cm-editor` grows to fit the content, and it is actually the page that scrolls. Two glassy bars float over its edges — the **topbar** (`--chrome-h`) at the top and the editor **status bar** (`--editor-statusbar-h`) at the bottom. CM's native caret-into-view brings the caret only to the raw edges of the scroller, so it slides under whichever bar it reached: typing at the end — under the status bar (the reported case), `Ctrl+Home`/up arrow — under the topbar (symmetrically).

This is fixed by `chromeInsetScroll` (`core/CodeEditor/chromeInset.ts`): the plugin **pushes the ancestor scroller directly** (like typewriter) when the caret lands in the top or bottom band — it keeps the line above the bar and below the topbar on any movement (typing, arrows, paste, click). Orthogonal to typewriter (a centered caret is already between the bands — the plugin stays silent) and to focus.

**Why NOT `EditorView.scrollMargins` (a pitfall, do not reinvent).** scrollMargins would reserve the bands in one clean pass — but with that same facet CM narrows the area in which it considers a tooltip anchor visible (`visible = scrollDOM.rect − scrollMargins`), while `.cm-scroller` ends at the last line (the padding-below-the-end is on `.body-col`, outside the scroller). A margin larger than the line height drops that area behind the caret on the first/last line — and CM hides the slash menu / autocomplete / formatting panel off-screen (`top:-10000`). So we scroll the ancestor directly: the tooltip geometry is not touched at all. CSS `scroll-padding-*` misses too — CM computes by `getBoundingClientRect`/`clientHeight`.

Invariant: the bar height is a single token `--editor-statusbar-h` (its CSS is in `EditorBody`, and it is the band the plugin clears); the top band is `--chrome-h`. The plugin reads both from CSS, so a token change is picked up on its own.

## Where to switch

**Settings → Appearance → Editor mode** — a segmented switch `Source / WYSIWYM`. Under the heading — a one-line description of the selected mode. The choice is personal, stored in the browser (`localStorage bm-editor-mode`; server sync in user_preferences — groundwork #28), and the default is **Source**.
