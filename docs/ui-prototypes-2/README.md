# RKE design studies: collection two

> All ten designs now have matching Graph views. Open **[the single-file review](../rke-ui-review-all.html)** for all 30 Kanban, Reader and Graph views, embedded fonts, and side-by-side comparison. The collection indexes below remain available for the original pairs.

Open **index.html** in a browser. It links to ten new static pages, desktop screenshots and an embedded preview. The first collection remains unchanged and is linked from the gallery header. The ZIP includes both collection folders so that link works offline after extraction.

Each design includes a Kanban page and a reader. They reuse collection one's example document and eleven active tasks across the same five lifecycle states. Content is illustrative, not live task or canonical knowledge truth. No runtime API, tracker, agent or repository mutation is connected.

## Five new systems

| Design | Kanban | Reader | Difference from the first collection |
| --- | --- | --- | --- |
| Atlas | Five workflow islands on a spatial canvas | Persistent concept map beside the document | Navigation is organised around relationships rather than a standard application rail |
| Prism | State picker, one wide lane and persistent selection | Prose alongside switchable binding/wording evidence | Changes the interaction model rather than recolouring a five-column board |
| Cabinet | Tabbed file folders and archival labels | Four section records in a catalogue grid | Condensed typography and file organisation replace editorial or minimalist reading |
| Studio | Outlined coral cards with hard offset shadows | Tactile chapters that expand individually or together | Expressive shape, strong edges and progressive disclosure |
| Console | Compact monospace text records and a selection register | Numbered display rows and a keyboard command strip | Amber terminal treatment, flat geometry and text-first interaction |

Each direction has its own geometry, typography, information structure and palette. Atlas uses Space Grotesk; Prism uses Manrope; Cabinet introduces Barlow Condensed; Studio uses Outfit; Console uses IBM Plex Mono throughout. Four new font families distinguish the collection from the first set.

## Skill choices

The specialist taste-skill entry points were reviewed in full during this conversation. The Engineering Workflow design method was used again for the bounded prototype slice. These are deliberate adaptations to a working application, rather than claims of strict compliance with marketing-page templates.

- **Atlas:** `high-end-visual-design`, adapted for asymmetrical spatial navigation. Its map depicts the actual example concepts; it is not a decorative product screenshot.
- **Prism:** `minimalist-ui`, adapted to a cobalt split workspace with selected-state disclosure. Its stronger brand area and persistent inspector are intentional departures from the skill's warm monochrome default.
- **Cabinet:** `industrial-brutalist-ui`, adapted toward archival file organisation. It uses olive catalogue surfaces rather than repeating Signal's Swiss red print system.
- **Studio:** `high-end-visual-design`, adapted toward expressive tactile components. Hard offset edges and coral blocks deliberately differ from Current's dark nested surfaces.
- **Console:** `industrial-brutalist-ui`, using its separate Tactical Telemetry archetype. It keeps one dark substrate and amber emphasis; it does not reproduce the first collection's light industrial print layout. Surface degradation is kept out of the text so it remains readable.

The broad taste and GSAP skills were already reviewed and their marketing hero, photography and scroll-pinning prescriptions remain unsuitable for these task and document interfaces. No official component library is impersonated.

## Interactions to review

All boards support task search, owner filtering and description visibility. Atlas, Cabinet and Studio use a task-preview dialog; Prism and Console update a persistent selection surface. Preview state changes do not mutate files or the example dataset. The new-task control explains the prototype boundary.

- **Atlas:** open a concept-map node to navigate to the corresponding section; expand or restore the map's desktop allocation.
- **Prism:** switch lifecycle states, select a task, search across states, and change the reader's evidence pane between bindings and wording.
- **Cabinet:** browse section records through the document index or read across the catalogue grid.
- **Studio:** expand/collapse all chapters or open them separately. Following a section link opens its chapter.
- **Console:** press `:` to focus the command strip. On Kanban, `find reader` filters the example tasks. In the reader, `focus` toggles context visibility. Other inputs show help. No shell command is executed.

All readers offer focus mode, larger text and an example wording comparison. Console's row numbers are display positions, not source-code line identities. Nothing persists across reloads.

## Verification and reproduction

The generated HTML embeds CSS and JavaScript. Fonts are local files in `assets/`. No install or server is needed to review the pages. Keep the font directory beside the HTML files.

```sh
node docs/ui-prototypes-2/generate.mjs
node docs/ui-prototypes-2/verify.mjs
```

The generator reads only the first collection's example task data and document markup; it does not regenerate or modify the first collection. Source edits live in `base.css`, `variants.css`, `prototype.js`, `interactions.js` and `index.css`.

The browser verifier uses an owned disposable headless Chrome and a temporary loopback server. `CHROME_PATH` can override its default Windows browser executable. It checks all ten pages at 1440, 1024 and 390 pixels, task interaction and search, persistent selection, state switching, map expansion, evidence tabs, catalogue structure, chapter expansion, command-strip actions, focus mode, wording comparison, text enlargement, reduced motion, index previews, direct-file opening and local font loading. `verification.json` records the result; desktop and phone screenshots remain in `screenshots/`.

Page-wide horizontal overflow, uncaught browser exceptions, broken local resources and external requests fail verification. Some boards intentionally scroll horizontally inside their canvas on smaller screens. Atlas stacks workflow islands; Prism turns its state picker into a horizontal rail; Cabinet and Studio simplify their reader layouts. Base text and control token contrast is reviewed separately; this is not an accessibility certification or exhaustive compatibility test.

Final result: all 30 layout cases and the listed interactions passed. The browser recorded zero uncaught exceptions and zero external requests. Direct-file opening and the local Space Grotesk font loaded successfully. The first collection and the live RKE application were not modified by this slice.

## Bundled fonts

Each font includes its upstream SIL Open Font License in `assets/`:

- [Space Grotesk](https://github.com/google/fonts/tree/main/ofl/spacegrotesk)
- [Manrope](https://github.com/google/fonts/tree/main/ofl/manrope)
- [Barlow Condensed](https://github.com/google/fonts/tree/main/ofl/barlowcondensed)
- [Outfit](https://github.com/google/fonts/tree/main/ofl/outfit)
- [IBM Plex Mono](https://github.com/google/fonts/tree/main/ofl/ibmplexmono)

Screenshots in the gallery come from the actual static pages. No generated image, remote font, external script or hosted service is required.
