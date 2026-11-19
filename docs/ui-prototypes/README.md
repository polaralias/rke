# RKE: five design directions

> All ten designs now have matching Graph views. Open **[the single-file review](../rke-ui-review-all.html)** for all 30 Kanban, Reader and Graph views, embedded fonts, and side-by-side comparison. The collection indexes below remain available for the original pairs.

Open **index.html** in a browser. It contains all ten page links, desktop screenshots, trade-offs and an embedded design switcher. No development server, install or internet connection is required. Keep the `assets/` directory beside the HTML files so the bundled fonts remain available.

Each direction has a Kanban page and a reader page. The same eleven active example tasks, five lifecycle states and architecture document are used throughout. Two completed-task links are included. These records are illustrative, not a snapshot of repository task truth. The document is review copy, not verified canonical knowledge.

| Direction | Primary emphasis | Structure | Skill applied |
| --- | --- | --- | --- |
| Still | Clean view | Quiet navigation rail, minimal cards, restrained reader context | `minimalist-ui` |
| Folio | Serif and paper | Newsreader typography, paper task slips, long-form document and marginal notes | `high-end-visual-design`, Editorial Luxury adaptation |
| Signal | Distinct formatting and information density | Swiss print grid, rigid dividers, uppercase operational labels and monospace metadata | `industrial-brutalist-ui`, Swiss Industrial Print |
| Lens | Readability | Atkinson type, horizontal task swimlanes, centered reading column | `minimalist-ui`, readability adaptation |
| Current | Animation and hierarchy | Dark nested surfaces, floating navigation, staggered entry and animated task selection | `high-end-visual-design`, dark spatial adaptation |

## Skill review and adaptation

The complete entry points for `minimalist-ui`, `industrial-brutalist-ui` and `high-end-visual-design` were read before implementation. The full installed `design-taste-frontend` entry point, including its out-of-scope section, and `gpt-taste` were also reviewed. The requested Taste Skill repository's current 2.5.0 entry point was read as well. The local Engineering Workflow design method governs scope and acceptance.

The broad taste skills target marketing pages and explicitly exclude or poorly fit dense product interfaces. Their hero, conversion, photography, oversized section and GSAP scroll-pinning prescriptions are not used here. These are functioning interface studies, not marketing pages containing pictures of fake applications. The chosen specialist skill is recorded in every study on the index.

Each study is an independent aesthetic interpretation. It does not claim compliance with every prescription of a specialist package or impersonate an official component library. For example, Folio uses crisp paper edges rather than the high-end skill's universal exaggerated squircle radius; Lens uses a readable sans throughout rather than editorial serif contrast. Current uses native CSS and Web Animations rather than adding a network dependency. All differences are intentional consequences of the prototype brief.

The focus/density/motion choices are explicit: Still is quiet and sparse; Folio emphasizes long-form reading; Signal is dense with small metadata; Lens uses larger text and fewer simultaneous contexts; Current animates entry, selection and interaction feedback. Each has one fixed visual theme so the designs can be compared without a theme switch changing the premise.

## Review interactions

- Follow the Kanban/Reader navigation or the review bar's matching-page link.
- Change designs from the review bar while staying on the same page type.
- Search tasks, filter owners, and show or hide descriptions.
- Select a task to open a keyboard-accessible preview dialog. Escape closes it.
- Preview a status change. This only changes the preview label and does not mutate even the example board.
- Try reader focus mode, larger text and the example wording comparison.
- Follow outline links and related references within the example document.
- Replay or pause Current's motion. Reduced-motion preferences disable entry animation and replay; content remains visible.

The new-task control explains the prototype boundary rather than pretending to save data. No files, external agents, trackers or runtime APIs are accessed. Nothing persists across reloads. Example estimates and people are explicitly part of the review dataset.

## Files and reproduction

The ten HTML files embed their CSS and controller, with fonts loaded from `assets/`. They are the deliverables. `base.css`, `variants.css`, `prototype.js`, `index.css` and `generate.mjs` are editable sources. Rebuild the pages with:

```sh
node docs/ui-prototypes/generate.mjs
```

Visual QA uses the actual generated HTML with a disposable headless Chrome profile and a temporary local HTTP server:

```sh
node docs/ui-prototypes/verify.mjs
```

Set `CHROME_PATH` to an absolute Chrome/Chromium executable if needed. The default targets the local Windows Chrome installation. Screenshots are retained in `screenshots/`; `verification.json` records the executed checks and viewport sizes. The verifier never imports the RKE runtime.

Acceptance covers all ten pages at 1440, 1024 and 390 pixels, no page-wide overflow, local interactions, loaded screenshot previews, motion pause/replay, reduced motion, no uncaught browser errors and no external requests. Horizontal scrolling is intentional inside the column boards; Lens stacks its swimlanes on narrow screens. This is not screen-reader certification or an exhaustive browser compatibility test.

The final browser run passed all 30 layout cases, with zero uncaught exceptions, zero external requests and no broken local resources. Direct `file://` opening of the Still board and loading its local Geist font also passed. The base body, secondary-text and primary-button token pairs were checked separately: every study exceeds 4.5:1 for those pairs. This token check is not a claim that every rendered pixel or interaction has an accessibility certification.

## Fonts

Fonts are bundled from the Google Fonts source repository under their SIL Open Font Licenses; each upstream license is included in `assets/`:

- [Geist](https://github.com/google/fonts/tree/main/ofl/geist)
- [Newsreader](https://github.com/google/fonts/tree/main/ofl/newsreader)
- [IBM Plex Mono](https://github.com/google/fonts/tree/main/ofl/ibmplexmono)
- [Atkinson Hyperlegible Next](https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegiblenext)

No photograph, generated image, icon library or external script is required. Index thumbnails are screenshots of the actual prototype pages.
