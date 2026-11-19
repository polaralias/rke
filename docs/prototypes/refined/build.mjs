import { readFileSync, writeFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../03-final.html');
const payload = /(<script type="application\/json" id="review-data">)([\s\S]*?)(<\/script>)/;
const review = JSON.parse(source.match(payload)[2]);
const revision = process.argv.includes('--06');
const css = read('workspace.css') + (revision ? read('revision-06.css') : '');
const script = revision
  ? read('workspace.js').replace(/  const canvas =[\s\S]*$/, () => read('graph-camera.js') + '\n})();')
  : read('workspace.js');
for (const [key, page] of Object.entries(review.pages)) {
  review.pages[key] = page
    .replace('</head>', () => '<style>' + css + '</style></head>')
    .replace('</body>', () => '<script>' + script + '</script></body>');
}
const data = JSON.stringify(review).replaceAll('<', '\\u003c');
const output = source
  .replace(payload, (_match, open, _data, close) => open + data + close)
  .replace('<h1>Final prototype</h1>', revision ? '<h1>Refined shortlist · 06</h1>' : '<h1>Refined shortlist</h1>')
  .replace('</head>', '<style>body.clean-preview > :is(.review-header,.design-strip,.review-caption){display:none}#preview-mode{position:fixed;right:16px;bottom:12px;z-index:4;font-size:11px}</style></head>')
  .replace('</body>', '<button id="preview-mode" hidden aria-pressed="false">Full-page preview</button><script>const previewMode=document.getElementById("preview-mode");const frames=document.getElementById("frames");function syncPreview(){previewMode.hidden=frames.hidden||frames.classList.contains("compare");if(previewMode.hidden){document.body.classList.remove("clean-preview");previewMode.setAttribute("aria-pressed","false");previewMode.textContent="Full-page preview";}}new MutationObserver(syncPreview).observe(frames,{attributes:true,attributeFilter:["hidden","class"]});previewMode.onclick=()=>{const active=document.body.classList.toggle("clean-preview");previewMode.setAttribute("aria-pressed",active);previewMode.textContent=active?"Exit preview":"Full-page preview";};syncPreview();</script></body>')
  .replace('Studio opens on the large graph canvas, Current retains its orbit graph, and Signal uses the angular network. The wider Focus reader is available in all three themes.',
    revision ? 'Studio and Current use an orbit with their own node and canvas styling. Signal keeps its angular network.' :
      'Compare Studio’s tactile cards, Current’s dark layers and Signal’s technical layout. Each keeps its own graph and uses the same reading and task-scanning principles.');
writeFileSync(new URL(revision ? '../06-refined-shortlist.html' : '../05-refined-shortlist.html', import.meta.url), output);
