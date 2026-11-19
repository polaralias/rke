# All ten RKE designs: one review file

Open **`docs/rke-ui-review-all.html`** in a browser. This is the deliverable: one self-contained HTML file, with all 30 views, eight embedded font files and their full licenses. It needs no server, adjacent assets, ZIP extraction or internet connection.

Each of the ten established designs now contains **Kanban, Reader and Graph**. The original Kanban and reader styling, content and local interactions remain. Graph links were added to their workspace navigation. Individual graph HTML files also exist beside the earlier prototypes, but they are not required by the single-file review.

## Review controls

- Start from the overview to open any of the 30 design/view combinations.
- Keep Kanban, Reader or Graph selected while moving across the ten designs.
- Use **Compare two** to inspect the same view in two design systems side by side. On narrow windows comparison stacks vertically.
- Use **Viewport** to inspect the responsive layout, or constrain the embedded preview to 1440, 1024 or 390 pixels. Oversized previews scroll inside their frame wrapper.
- Navigate between Kanban, Reader and Graph from inside a prototype. The navigation bridge keeps those routes inside the same HTML file.
- Browser history and the `design`, `view`, `compare` and `width` fragment fields retain the review selection. Alt+Left/Right moves between designs when focus is in the review shell.
- **About** contains scope notes and the full bundled font licenses.

The shell deliberately stays neutral. Each embedded page retains its own design tokens, typography, layout and interaction conventions. The existing specialist taste-skill choices continue to govern the visual interpretations; Engineering Workflow supplies the bounded delivery and validation method.

## Ten graph treatments

| Design | Graph presentation |
| --- | --- |
| Still | Quiet layered node map and restrained relationship inspector |
| Folio | Serif reference plate, curved connectors and marginal notes |
| Signal | Directed adjacency matrix with explicit source rows and target columns |
| Lens | Large, readable incoming / selected record / outgoing explorer |
| Current | Dark orbital constellation with optional replay and pause controls |
| Atlas | Spatial concept neighbourhood on the existing dotted map canvas |
| Prism | Cobalt type filters, hierarchical graph and selected-record evidence panel |
| Cabinet | Cross-referenced catalogue records rather than a node canvas |
| Studio | Tactile outlined node stickers, curved links and coral surfaces |
| Console | Text dependency records with a selected relationship register |

Every graph uses the same **14 example records and 20 declared relationships**. Records include architecture, knowledge, a decision, tasks, source references and workstreams. These are illustrative relationships for comparing designs; they are not inferred or verified repository truth. Opening a source reference in the inspector is not a filesystem operation.

Graph controls support record selection, incoming/outgoing inspection, type filtering, search with an explicit empty result, neighbour focus and reset. Filters dim context rather than claiming that other records have ceased to exist. Diagram presentations additionally support zoom and dragging the empty canvas to pan. Native scrolling remains available inside wide graph and matrix workspaces. The other presentations use their own appropriate navigation rather than meaningless zoom buttons.

Selecting a relationship navigates to its other record. **Open reader** and **Open Kanban** switch the review to the corresponding matching prototype. Console's `find <text>` and `focus` commands affect only its example graph; no shell command is executed.

## Packaging and boundaries

The build embeds each complete page as an inert JSON string and stores each font once. Required font data URLs are inserted only when loading an active preview. The preview runs in a sandbox that allows scripts while retaining an opaque origin. A small bridge sends a validated design/view route to the parent. Parent messages are accepted only from the active preview windows, with known design and view identities; ready messages must match the pending route.

The parent and preview content security policies deny network connections. Fonts and favicon assets are embedded data. External and neighbouring-file navigation is intercepted. No task, knowledge, tracker or agent APIs are connected. Example edits and preview selections are local and do not persist as repository state.

These are review prototypes, not a runtime redesign installation, performance qualification, screen-reader certification or exhaustive browser compatibility claim. The source repository's earlier application changes remain outside this slice.

## Reproduction

```sh
node docs/ui-review-all/build.mjs
node docs/ui-review-all/verify.mjs
```

The builder consumes the two earlier prototype collections. It adds Graph to their HTML navigation, generates ten matching graph pages and writes `docs/rke-ui-review-all.html`. If their CSS/content sources change, regenerate those collections first and then run this builder. Their generators now preserve the Graph navigation item.

The browser verifier opens the final single HTML file directly from disk. It uses an owned disposable headless Chrome, including its isolated preview targets. `CHROME_PATH` can override the default Windows Chrome executable. It checks all 30 views at desktop, tablet and phone sizes, graph selection/filter/search/focus/zoom, special matrix/explorer/catalogue/text coverage, navigation back into matching readers, original task search and wording comparison, side-by-side comparison, viewport controls, licenses, embedded fonts, reduced motion and absence of network or neighbouring-file requests. Results are recorded in `verification.json`; desktop and phone graph captures remain in `screenshots/` for visual review.

The static page scripts are tested in their actual sandboxed packaging. Backend tests are not a substitute for this check, and this prototype delivery does not change the RKE runtime or the OKF Tasks specification.
