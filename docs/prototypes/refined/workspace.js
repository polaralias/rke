(() => {
  const view = document.body.dataset.shortlistView;
  const main = document.querySelector('main');
  if (view === 'reader') {
    const article = main.querySelector('.article');
    const contents = document.createElement('details');
    contents.className = 'reader-contents';
    contents.innerHTML = '<summary>On this page</summary>';
    for (const heading of article.querySelectorAll('h2[id]')) {
      const link = document.createElement('a');
      link.href = '#' + heading.id;
      link.textContent = heading.textContent;
      contents.append(link);
    }
    const intro = article.querySelector('.studio-intro');
    const before = (intro ?? article).querySelector('.lede');
    if (before) before.before(contents);
    else article.prepend(contents);
    for (const chapter of article.querySelectorAll('details.chapter')) {
      const section = document.createElement('section');
      section.className = 'chapter';
      section.append(chapter.querySelector('h2'), chapter.querySelector('.chapter-body'));
      chapter.replaceWith(section);
    }
    document.getElementById('expand-chapters')?.remove();
    return;
  }
  if (view === 'kanban') {
    const descriptions = document.getElementById('toggle-meta');
    if (descriptions.getAttribute('aria-pressed') === 'true') descriptions.click();
    return;
  }
  if (view !== 'graph') return;

  const canvas = document.getElementById('graph-canvas');
  const mobile = matchMedia('(max-width: 700px)');
  const contacts = new Map();
  let bounds, camera, moved = false;
  const midpoint = (a,b) => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });
  const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  const svg = () => canvas.querySelector('.graph-svg');
  function paint() {
    const graph = svg();
    if (!graph || !mobile.matches) return;
    graph.setAttribute('viewBox', [camera.x,camera.y,camera.w,camera.h].join(' '));
    document.body.dataset.graphDetail = camera.w > 850 ? 'dots' : camera.w > 470 ? 'labels' : 'cards';
    for (const node of graph.querySelectorAll('.graph-node')) {
      if (node.querySelector('circle')) continue;
      const dot = document.createElementNS('http://www.w3.org/2000/svg','circle');
      dot.setAttribute('cx','92');
      dot.setAttribute('cy','36');
      dot.setAttribute('r','12');
      node.prepend(dot);
    }
  }
  function fit() {
    if (!bounds) return;
    const width = canvas.clientWidth;
    const height = svg().clientHeight;
    if (!width || !height) return;
    const w = Math.max(bounds.w, bounds.h * width / height);
    const h = w * height / width;
    camera = { x:(bounds.w-w)/2, y:(bounds.h-h)/2, w,h };
    paint();
  }
  function setup() {
    const graph = svg();
    if (!graph || !mobile.matches) return;
    const { width:w, height:h } = graph.viewBox.baseVal;
    bounds ??= { w,h };
    if (camera) paint();
    else fit();
  }
  function local(event) {
    const rect = svg().getBoundingClientRect();
    return { x:event.clientX-rect.left, y:event.clientY-rect.top };
  }
  function zoom(factor, from, to = from) {
    if (!camera) return;
    const rect = svg().getBoundingClientRect();
    const w = Math.max(170,Math.min(2100,camera.w/factor));
    const h = w * rect.height / rect.width;
    camera.x += (from.x*camera.w-to.x*w)/rect.width;
    camera.y += (from.y*camera.h-to.y*h)/rect.height;
    camera.w = w;
    camera.h = h;
    paint();
  }
  canvas.addEventListener('pointerdown', event => {
    if (!mobile.matches || event.button !== 0 || !camera || contacts.size >= 2) return;
    event.stopPropagation();
    moved = contacts.size > 0;
    contacts.set(event.pointerId,local(event));
    event.target.setPointerCapture(event.pointerId);
  }, true);
  canvas.addEventListener('pointermove', event => {
    const previous = contacts.get(event.pointerId);
    if (!previous) return;
    const next = local(event);
    const other = [...contacts].find(([id]) => id !== event.pointerId)?.[1];
    contacts.set(event.pointerId,next);
    if (other) {
      zoom(distance(next,other)/Math.max(1,distance(previous,other)),midpoint(previous,other),midpoint(next,other));
    } else {
      if (distance(next,previous)>2) moved = true;
      zoom(1,previous,next);
    }
  },true);
  for (const type of ['pointerup','pointercancel','lostpointercapture']) {
    canvas.addEventListener(type,event => contacts.delete(event.pointerId),true);
  }
  canvas.addEventListener('click',event => {
    if (mobile.matches && moved) event.stopPropagation();
  },true);
  for (const [id, factor] of [['graph-in',1.4],['graph-out',1/1.4],['graph-reset',null]]) {
    document.getElementById(id).addEventListener('click',event => {
      if (!mobile.matches || !camera || !factor) return;
      event.stopImmediatePropagation();
      zoom(factor,{ x:canvas.clientWidth/2,y:svg().clientHeight/2 });
    },true);
  }
  document.getElementById('graph-reset').addEventListener('click',() => { if (mobile.matches) fit(); });
  const observer = new MutationObserver(setup);
  observer.observe(canvas,{ childList:true });
  mobile.addEventListener('change',() => {
    camera = undefined;
    if (mobile.matches) setup();
    else if (bounds) {
      svg().setAttribute('viewBox',`0 0 ${bounds.w} ${bounds.h}`);
      delete document.body.dataset.graphDetail;
    }
  });
  setup();
})();
