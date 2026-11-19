# RKE UI prototypes

The [UI build specification](ui-build-spec.md) defines the three-theme workspace implementation and restart persistence.

Open any review file directly in a browser. Each contains its own views, controls and fonts.

| Review | Contents |
| --- | --- |
| [01 · Original ten](01-original-ten.html) | All ten initial designs, with 30 Kanban, Reader and Graph views. |
| [02 · Exploration](02-exploration.html) | Studio, Current and Signal with the narrower Focus reader. Studio Graph toggles between Link matrix and Flowchart. Signal Graph retains Flowchart and Angular network for comparison. |
| [03 · Final](03-final.html) | Studio's canvas with details on demand, Current's orbit graph and Signal's selected angular network. All three themes use the wider Focus reader. |
| [04 · Shared workspace](04-shared-workspace.html) | The same Reader, compact Kanban and angular Graph in Studio, Current and Signal. Switch themes from the header without leaving the current view. |
| [05 · Refined shortlist](05-refined-shortlist.html) | Studio, Current and Signal keep their distinct visual designs and graphs, with compact boards, a clearer Reader and mobile zoom. |
| [06 · Refined shortlist](06-refined-shortlist.html) | Fixes Reader rules and board dividers, tightens graph framing and smooths zoom. Studio and Current share the orbit arrangement. Signal keeps its angular network. |

Rebuild the review files from the repository root with `node docs/ui-shortlist/build.mjs`. It packages the existing full review and uses the shared shortlist sources for the two editions.

Rebuild the shared workspace with `node docs/prototypes/shared/build.mjs`. The Reader uses a snapshot of `docs/reader-workspace.md`. Board tasks and the tracker decision are examples. Try opening **RKE-029** in Blocked, following its decision, then returning to the task. On a phone, pinch the graph to move from dots to labels and cards.

Rebuild the refined shortlist with `node docs/prototypes/refined/build.mjs`. Use **Full-page preview** to hide the comparison controls while reviewing a single view.

Build revision 06 with `node docs/prototypes/refined/build.mjs --06`.
