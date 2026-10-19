# Reader diagram rendering design

Status: shared reader implementation, focused deterministic checks and installed
distribution smoke complete; the earlier broad run passed 310 tests. This is not a
complete release qualification.

The reader should render explicitly labelled Mermaid fences on demand while
retaining exact original diagram text. Ordinary prose and source viewing should
not initialize a diagram engine. Invalid, unsupported, oversized or failed
diagrams keep readable source and a bounded explanation of unavailability.

## Authority and isolation

Use the pinned, licensed renderer in an opaque sandboxed iframe with
`allow-scripts` and no same-origin, navigation, forms, popups or downloads
permissions. Pass only the selected bounded diagram source. The child receives
no repository projection, roots, paths, sessions, credentials or command
interface. Source content cannot choose renderer assets, settings or endpoints.

The parent accepts only messages from the exact owned frame with the current
job identity. Messages may report bounded rendering state and dimensions; they
must never introduce SVG/HTML into the parent, change selection, choose a URL or
invoke an operation. Dispose frames and pending work on selection changes and
timeouts. Keep the original source available throughout failure and recovery.

Require strict library configuration, disabled HTML labels and protected
security/budget settings. Disable interaction and remove navigation attributes;
reject active content, images and foreign objects before revealing the result.
Block external images, connections, fonts, objects and nested frames. Rendering
provenance is presentation and cannot establish source or knowledge truth.

## Executed prototype findings — 2026-10-14

- An iframe containing the entire 2.7 MB library as a data URL remained blocked
  at `about:blank#blocked`. Do not repeat that transport as the production design.
- An opaque Blob frame rendered the pinned Mermaid 11.10.1 library. Flowchart
  and sequence fixtures produced SVG; invalid syntax produced an error state.
- Inline script text must normalize CRLF/CR to LF before calculating browser
  CSP hashes. The initial raw-byte hash was refused after HTML newline parsing.
  Preserve a separate raw asset digest for package identity and attribution.
- A hostile fixture attempted a loose security setting, HTML image/onerror
  content and a remote click target. The rendered result contained no images,
  could not read the parent document and issued no HTTP requests. These are
  owned fixtures, not a general security proof or model-quality measurement.
- Parent CSP also constrains Blob and data children. A child meta policy cannot
  loosen that inherited policy. Generated SVG styles and style attributes caused
  CSP refusals; nonce-bearing styles could be reinstated. Styling and geometry
  are not yet broadly qualified. A ready message alone does not prove fidelity.

The prototype lives in ignored workflow cache files and uses a separately
launched headless Chrome with a task-owned profile. The shared browser connection
was unavailable. No user browser profile or machine-wide configuration changed.

## Implementation and qualification still required

The shared implementation now provides bounded closed-fence detection, a lazy
raw-digest-pinned asset, on-demand opaque Blob frames, current-peer/job message
checks, 15-second timeout/disposal, original-source controls and bounded resize
reports. Static and live exports both use `renderReader`. Eight 8 KiB fences and
128 library edges remain separate from projection/body and syntax-token budgets.
The library and complete MIT license are included in package and artifact
inventory. Ordinary prose exports do not read or initialize the library.

Nine code/diagram tests and five live-core tests passed; six directional,
location, pane and CSP tests also passed. Type/build/lint, 62-operation/24-grammar
release checks, no-Python and canonical/catalogue feature equality passed.
Catalogue checks passed 34 descriptions/101 scenarios and the required major
version at 12.0.0; the initial canonical and mirrored EWF were 5.25.0. Installed smoke DpuQSQ
passed raw asset/license checks and the actual exported client controls, timeout
cleanup and retained source, in addition to the existing CLI/MCP/live lifecycle
checks. The prior broad run passed 310 tests; latest changes separately passed15 focused checks,28 retained contracts and installed hHi0aG. This is not a final-tree full-suite certificate.

Actual exported-reader browser fixtures rendered flowchart, sequence, class and
state labels. A hostile loose/HTML/click fixture remained encoded and made no
HTTP requests. Invalid syntax retained visible original source and disposed the
frame. A current-artifact sequence fixture also rendered after adding responsive
resize reporting. That initial artifact emitted two stylesheet CSP refusals.
The subsequent EWF 5.26.0 artifact assigns style nonces before insertion,
protects nonce retention during sanitization, and parses the bounded returned
SVG as XML before adopting it into the opaque child. It rejects malformed or
active content and strips navigation attributes before display. The parent
still receives only bounded job/state/dimension messages. Returned SVG is capped
at 512 KiB; authored dimensions remain scrollable inside the frame.

Current owned browser fixtures pass flowchart, sequence, class, state and hostile
encoded labels with zero HTTP requests and zero console/CSP errors. At a
390-pixel viewport, 30-node horizontal and vertical fixtures retain readable
16-pixel labels. Scrolling makes the final node visible without page-wide
overflow. Invalid syntax retains source and disposes its frame. The latest
artifact passed 15 focused code/diagram/export/live groups, type/lint, release,
asset/mirror checks and clean installed smoke fPXkec. These are bounded fixture
and distribution results; the formative study and complete coordinated release
remain open.

Broaden resize, contrast and reduced-motion qualification while retaining parent
script hashes, source-as-data handling and opaque frame isolation. Do not hide
style failures behind a ready result or weaken source handling to accommodate
the library.

Complete malformed/hostile source, configured bound, stale message,
navigation cleanup, no-network and actual installed-client qualification. Coordinate
the useful viewer behavior with OKF's producer and its active upstream package
in the same change slice, including their independent normative validation.
