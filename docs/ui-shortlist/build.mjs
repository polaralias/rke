import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { signalConnector, signalGraphLayouts } from './signal-graph.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../rke-ui-review-all.html');
const payload = /(<script type="application\/json" id="review-data">)([\s\S]*?)(<\/script>)/;
const match = source.match(payload);
if (!match) throw new Error('Build the full review first.');

const all = JSON.parse(match[2]);
const directions = [
  ['studio', 'Default candidate', 'Coral, tactile cards and a chapter-based reader.'],
  ['current', 'Dark workspace', 'Deep green surfaces and a layered reader. The orbit graph and subtle motion keep the darker option distinct.'],
  ['signal', 'Technical workspace', 'Swiss print structure, red signals and olive file tabs.'],
];
const views = ['kanban', 'reader', 'graph'];
const style = read('./workspace.css');
const controls = read('./workspace.js');
const graphEngine = read('../ui-review-all/graph.js');
const reviewDirectory = new URL('../prototypes/', import.meta.url);
mkdirSync(reviewDirectory, { recursive: true });
writeFileSync(new URL('01-original-ten.html', reviewDirectory), source);

function buildShortlist({ file, title, note, focusWidth, graphVariants, graphDescriptions }) {
  const designs = directions.map(([id, focus, description]) => ({
    ...all.designs.find(design => design.id === id),
    focus,
    description: [description, graphDescriptions[id]].filter(Boolean).join(' '),
    skill: '',
  }));
  const pages = {};
  for (const { id } of designs) {
    for (const view of views) {
      const key = id + '-' + view;
      let page = all.pages[key];
      const layouts = view === 'graph' && graphVariants[id];
      if (layouts) {
        const graphScript = /<script>\/\/ Same example graph,[\s\S]*?<\/script>/;
        if (!graphScript.test(page)) throw new Error('Graph script is missing for ' + key);
        const script = 'const graphLayouts = ' + JSON.stringify(layouts) + ';\n' +
          signalConnector.toString() + '\n' + graphEngine;
        page = page
          .replace('<h1>Link matrix</h1>', '<h1>Relationships</h1>')
          .replace(graphScript, () => '<script>' + script + '</script>');
      }
      pages[key] = page
        .replace('</head>', () => '<style>' + style +
          ':root{--focus-reader-width:' + focusWidth + '}</style></head>')
        .replace('</body>', () => '<script>document.body.dataset.shortlistView=' + JSON.stringify(view) +
          ';' + controls + '</script></body>');
    }
  }

  const data = JSON.stringify({ ...all, designs, pages })
    .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  const intro = '<div class="overview-intro"><p class="eyebrow">RKE / Design shortlist</p>' +
    '<h1>' + title + '</h1><p>' + note + '</p>' +
    '<p class="fine">Try Vertical on any board, Focus mode in any reader, and Commands from each workspace.</p></div>';
  const output = source
  .replace(payload, (_whole, open, _data, close) => open + data + close)
  .replace(/<div class="overview-intro">[\s\S]*?<\/div><div id="overview-grid"/, () => intro + '<div id="overview-grid"')
  .replaceAll('10 design systems', '3 design directions')
  .replaceAll('All ten designs', 'Design shortlist')
  .replaceAll('30 views', '9 views')
  .replaceAll("design:'still'", "design:'studio'")
  .replaceAll("other:'folio'", "other:'current'")
  .replace("(i+(e.key==='ArrowRight'?1:9))%10", "(i+(e.key==='ArrowRight'?1:data.designs.length-1))%data.designs.length")
  .replace('ten static interface studies', 'three shortlisted interface studies')
  .replace('Design review</span>', 'Design shortlist</span>')
  .replace('</head>', '<style>.card-skill:empty{display:none}</style></head>');

  writeFileSync(new URL(file, reviewDirectory), output);
}

buildShortlist({
  file: '02-exploration.html',
  title: 'Shortlist exploration',
  note: 'Compare the narrower Focus reader and alternate graph layouts. Studio switches between a link matrix and a square flowchart. Signal switches between a flowchart and an angular network.',
  focusWidth: '68ch',
  graphVariants: {
    studio: {
      matrix: { label: 'Link matrix', description: 'Read across a row to follow outgoing relationships.' },
      flow: signalGraphLayouts.flow,
    },
    signal: signalGraphLayouts,
  },
  graphDescriptions: {
    studio: 'Switch between the link matrix and square flowchart.',
    signal: 'Switch between the square flowchart and angular network.',
  },
});

buildShortlist({
  file: '03-final.html',
  title: 'Final prototype',
  note: 'Studio opens on the large graph canvas, Current retains its orbit graph, and Signal uses the angular network. The wider Focus reader is available in all three themes.',
  focusWidth: '880px',
  graphVariants: { signal: { network: signalGraphLayouts.network } },
  graphDescriptions: {
    studio: 'The graph opens on a large canvas with details on demand.',
    signal: 'The angular network shows relationships around the architecture record.',
  },
});

console.log('Built three offline review files in docs/prototypes.');
