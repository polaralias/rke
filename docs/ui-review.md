# Task workspace UI review

Reviewed 6 November 2026 against the working tree on `feat/integrated-tasks-visualisation`.

## Scope and direction

The review covers the integrated Board/List, task editor, collaboration controls, Documents navigation and relationship graph. Existing uncommitted task implementation was preserved. The redesign follows the requested [Taste Skill](https://github.com/leonxlnx/taste-skill), read at version 2.5.0, adapted to a working developer application: one neutral system, one restrained green accent, consistent typography, readable metadata and quiet interaction feedback. Its marketing hero, photography, screen-height and conversion requirements do not apply to this task workspace.

The implementation retains vanilla DOM rendering, offline exports, content-derived CSP hashes, native task operations, valid lifecycle transitions and digest conflict protection. It adds no UI dependencies, fonts fetched over the network or external assets.

## Findings and changes

| Finding | Evidence | Resolution |
| --- | --- | --- |
| Task editor appears in Documents after changing tabs | Reproduced in Chrome before modification: `editorLeaksIntoDocuments: true` | Editor rendering now checks the active view. |
| Exported and non-editable records can expose an editing panel after navigation | Source inspection of tab restoration and editor rendering | Both layout and editor respect read-only state; exported navigation is covered in the browser contract. |
| Five columns compete with the editor for width | Desktop screenshot review | Columns retain a readable minimum width and scroll inside the board; the editor has a separate bounded column. |
| Narrow screens bury editing below a long board | Source/layout review | The task editor becomes an inset full-screen panel with an accessible close control and contained scrolling. |
| Save and transition controls are pushed down by the Markdown body | Screenshot review of the first redesign | Full task Markdown is in an expandable editor; title, description and normal actions remain near the top. |
| Dark theme leaves light surfaces and graph colors | Source inspection and light/dark screenshots | Shared semantic tokens cover controls, cards, columns, errors and SVG graph nodes/edges. System preference supplies the initial theme; an explicit choice persists. |
| Theme button can describe the wrong action on startup | Source inspection of localStorage restoration | Its initial label reflects the restored theme. |
| Board controls and raw timestamps compete with task content | Baseline screenshot review | Separate Board/List switch, labelled sorting and expandable timestamp tools; raw card timestamps appear with timestamp signals. |
| Cancelled drag retains task/drop-target state | Source inspection of drag lifecycle | `dragend` clears the dragged record and all target highlights. |
| A drag reorder appears ineffective under another sort | Source inspection of ordering and rendering | Same-column reorder requests require Manual order, with an explanatory message. Cross-column lifecycle moves remain available. |
| Read-only discovered tasks advertise dragging | Source inspection of card creation | Only live editable records are draggable. |
| Async command cleanup enables controls that were deliberately disabled | Source inspection of command cleanup | Restore each surviving control's original disabled state. |
| Mobile errors sit behind the task editor | Inspection of the overlay and original global-only error region | Errors also appear inside the editor; dirty-draft errors survive background polling. |
| Tab roles lack expected arrow-key behavior | Source inspection | Arrow keys and Home/End activate tabs with a single tab stop. Selection focuses the editor; mobile Tab cycling stays within it. Escape closes a clean panel and preserves dirty edits. |
| Browser reload can discard a draft without a warning | Source inspection | A dirty editor registers the native browser unload warning. |
| A new-task bookmark can still identify the previous task | Source inspection | Starting or closing a task editor clears the old document selection in the address. |
| Secondary draft forms become hard to find after another save | Source inspection of editor reconstruction | Workstream, estimate and discussion forms with retained drafts reopen automatically. |
| Isolated graph records are visually indistinguishable dots | Screenshot/source review | Isolate controls show their document titles; an empty connected overview explains where to look. |

## Verification

Build before running the browser contract:

```sh
npm run build
node tests/visualisation-browser.contract.mjs
```

The contract creates disposable Git/task fixtures, starts the actual authenticated interface and drives an owned headless Chrome. It checks document navigation, task creation and editing with canonical file read-back, status transitions, dirty-draft navigation refusal, stale-save retention, conflict visibility, keyboard tabs, list/search, cancelled drag cleanup and read-only export navigation. Screenshots cover 1440, 1024, 820, 768 and 390 pixels in both themes, plus Documents, Relationships, List and desktop/mobile task panels. Assertions reject page-wide horizontal overflow and uncaught browser exceptions. Artifacts are retained under the temporary path printed by the contract; `RKE_UI_SHOTS` can select a screenshot directory. `CHROME_PATH` can select a browser executable.

Focused deterministic tests cover the integrated visualisation, export/reader security and freshness, collaboration operations, Markdown rendering and the existing reader. Build and ESLint checks accompany these tests. The Taste Skill's screenshot and consistency tools are also run against a generated export; marketing-only checker findings are assessed separately from application defects.

The Taste Skill performance run on a generated four-task export passed at 1440 and 390 pixels: 75.3 KiB transferred, one local request, no broken requests and zero measured layout shift. These are fixture measurements, not large-project performance guarantees. Its screenshot tool produced the desktop export capture. The consistency run on the first redesign reported 129 failures and 9 warnings across the five widths; it is **not** a passing marketing-site check. The failure families concern missing hero/closing CTAs, text-only task cards, whole-screen section sizing, section spacing, multiple status headings and marketing container/row alignment. Those expectations conflict with a compact Kanban application. The row-height observation prompted equal-height lanes in the final polish. Warnings concern three-line description clamping, a card extending below the viewport, application button wording, word budgets and inset control alignment. Task cards deliberately show summaries and open the complete record. Useful checks passed for contrast, text contrast, button contrast, horizontal spill, text overlap, reduced motion, hidden content, fonts, links and forms. The checker artifacts remain with its temporary fixture; the final application acceptance is the browser contract above.

The initial combined deterministic run passed 52 of 55 cases, but a concurrent rebuild removed compiled files while three visualisation cases were reading their renderer identity. This was an orchestration error in the review run. After the final build finished, all 22 visualisation/parity cases passed, including those three cases. Reader/Markdown and collaboration cases had completed successfully before that interruption. The final real-browser contract passed all enumerated flows, both themes and five widths, including the read-only export checks. Build and ESLint passed.

## Boundaries

This is a source-checkout UI delivery, not a package publication or an installed-service upgrade. Rebuild and restart the view process to load the changed interface. Existing running servers keep their loaded renderer.

The review does not claim screen-reader certification, human usability testing, exhaustive browser compatibility, or live installed-agent/provider qualification. Agent launches, real tracker writes and real project attachment deletion were not exercised. Existing domain tests cover collaboration operations; the browser contract covers the enumerated UI workflows. The embedded evidence reader retains its own existing presentation and behavior; this slice redesigns the surrounding task workspace and verifies reader integration.
