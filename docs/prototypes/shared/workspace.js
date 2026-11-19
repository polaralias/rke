const main = document.querySelector('main');
const theme = document.querySelector('#theme');
const { nodes, edges, positions } = JSON.parse(document.querySelector('#graph-data').textContent);
const decision = 'Tracker boundaries';
const tasks = [
  ['RKE-041','Compare knowledge revisions','Proposed','Unassigned'],
  ['RKE-042','Group related task evidence','Proposed','James'],
  ['RKE-043','Review document section links','Proposed','Alex'],
  ['RKE-036','Preserve reader position','Ready','James','position'],
  ['RKE-038','Make status moves explicit','Ready','Unassigned'],
  ['RKE-040','Review keyboard navigation','Ready','Alex'],
  ['RKE-031','Unify task and knowledge views','In progress','James','unify'],
  ['RKE-034','Retain unsaved task drafts','In progress','Alex'],
  ['RKE-035','Clarify evidence provenance','In progress','James'],
  ['RKE-029','Reconcile tracker status mappings','Blocked','James','tracker','Approval pending on how unmapped statuses are handled.'],
  ['RKE-045','Review external status labels','Blocked','Alex'],
  ['RKE-026','Verify offline reader export','Validation','Alex','offline'],
  ['RKE-028','Validate repository boundaries','Validation','James','boundary'],
];
const statuses = [...new Set(tasks.map(task => task[2]))];
let focus = false;
let queue = false;
let status = 'Blocked';
let query = '';
let selected = 'repo';
let graphCleanup;

function link(label, href) {
  const element = document.createElement('a');
  element.textContent = label;
  element.href = '#' + href;
  return element;
}

function reader(section) {
  const isDecision = section === 'decision';
  main.innerHTML = `<div class="reading"><article>
    <div class="path">Knowledge / ${isDecision ? 'Example decision' : 'Repository reader'}</div>
    <h1>${isDecision ? decision : 'Repository reader workspace'}</h1>
    <div class="reader-tools"><button id="focus" aria-pressed="${focus}">Focus mode</button></div>
    <details class="outline"><summary>On this page</summary><nav aria-label="On this page"></nav></details>
    <div class="prose"></div></article>
    <aside class="evidence"><h2>Evidence and links</h2></aside></div>`;
  const layout = main.querySelector('.reading');
  const outlinePanel = main.querySelector('.outline');
  const evidence = main.querySelector('.evidence');
  function placeOutline() {
    const side = !focus && matchMedia('(min-width: 1100px)').matches;
    if (side) evidence.prepend(outlinePanel);
    else main.querySelector('.reader-tools').after(outlinePanel);
    outlinePanel.open = side;
  }
  layout.classList.toggle('focus', focus);
  main.querySelector('#focus').onclick = event => {
    focus = !focus;
    layout.classList.toggle('focus', focus);
    event.currentTarget.setAttribute('aria-pressed', focus);
    placeOutline();
  };
  const prose = main.querySelector('.prose');
  if (isDecision) {
    prose.innerHTML = '<p>This example decision is awaiting approval.</p><h2>Handling unmapped statuses</h2><p>Keep an external tracker status visible as reported until it has an approved mapping to a local task state. An unmapped status stays unresolved during synchronisation.</p><h2>Why this matters</h2><p>Automatically mapping an unfamiliar value could move a task into the wrong state. The mapping review needs an explicit fallback before the blocked task can proceed.</p>';
    evidence.append(link('Return to RKE-029', 'kanban/RKE-029'));
  } else {
    const content = document.querySelector('#reader-document').content.cloneNode(true);
    content.querySelector('h1')?.remove();
    const browserContract = content.querySelector('p');
    if (browserContract?.textContent.startsWith('The optional actual-browser contract')) {
      const heading = document.createElement('h2');
      heading.textContent = 'Browser verification';
      content.append(heading, browserContract);
    }
    for (const anchor of content.querySelectorAll('a')) anchor.replaceWith(document.createTextNode(anchor.textContent));
    prose.append(content);
    evidence.append('Source snapshot · docs/reader-workspace.md', document.createElement('br'), link('View reader relationships', 'graph/reader'));
  }
  const outline = main.querySelector('.outline nav');
  const headings = [...prose.querySelectorAll('h2,h3')];
  headings.forEach((heading, index) => {
    heading.id = 'section-' + index;
    heading.tabIndex = -1;
    const jump = link(heading.textContent, 'reader/' + (isDecision ? 'decision/' : '') + heading.id);
    outline.append(jump);
  });
  placeOutline();
}

function board(taskId) {
  main.innerHTML = `<div class="board-tools"><input type="search" aria-label="Find a task" placeholder="Find a task"><button id="queue" aria-pressed="${queue}">Vertical queue</button><label id="status">Status <select></select></label></div>
    <div class="board" aria-label="Task board"></div><dialog class="task-detail" aria-labelledby="task-title"></dialog>`;
  const board = main.querySelector('.board');
  const search = main.querySelector('input');
  const picker = main.querySelector('select');
  picker.replaceChildren(...statuses.map(value => new Option(value, value)));
  picker.value = status;
  search.value = query;
  const dialog = main.querySelector('dialog');
  function openTask(task) {
    const [id, title, state, owner, node, blocker] = task;
    dialog.innerHTML = `<div class="detail-head"><span class="path">${id} / ${state}</span><button autofocus>Close</button></div>
      <h2 id="task-title">${title}</h2><p>Owner: ${owner}</p>`;
    dialog.querySelector('button').onclick = () => dialog.close();
    if (state === 'Blocked') {
      const note = document.createElement('p');
      note.textContent = blocker || 'Blocker reason not recorded';
      dialog.append(note);
    }
    if (node === 'tracker') dialog.append(link('Read the decision · ' + decision, 'reader/decision/section-0'));
    if (node) dialog.append(link('View relationships', 'graph/' + node));
    dialog.showModal();
  }
  function renderTasks() {
    board.classList.toggle('queue', queue);
    main.querySelector('#status').hidden = !queue;
    main.querySelector('#queue').setAttribute('aria-pressed', queue);
    board.replaceChildren();
    const filter = query.trim().toLowerCase();
    for (const state of queue ? [status] : statuses) {
      const matching = tasks.filter(task => task[2] === state && task.join(' ').toLowerCase().includes(filter));
      const lane = document.createElement('section');
      lane.className = 'lane';
      lane.dataset.status = state;
      lane.innerHTML = `<h2>${state} <span>${matching.length}</span></h2>`;
      for (const task of matching) {
        const card = document.createElement('button');
        card.className = 'task';
        card.innerHTML = `<strong>${task[1]}</strong><span>${task[2] === 'Blocked' ? (task[5] ? 'Decision pending' : 'Blocker reason not recorded') : task[0] + ' · ' + task[3]}</span>`;
        card.onclick = () => openTask(task);
        lane.append(card);
      }
      if (!matching.length) lane.insertAdjacentHTML('beforeend', '<p class="empty">No matching tasks</p>');
      board.append(lane);
    }
  }
  search.oninput = () => { query = search.value; renderTasks(); };
  picker.onchange = () => { status = picker.value; renderTasks(); };
  main.querySelector('#queue').onclick = () => { queue = !queue; renderTasks(); };
  renderTasks();
  const task = tasks.find(item => item[0] === taskId);
  if (task) openTask(task);
}

function graph(nodeId) {
  if (nodes.some(node => node.id === nodeId)) selected = nodeId;
  main.innerHTML = `<div class="graph-tools"><label>Find a record <select id="record"></select></label><button id="fit">Fit graph</button><button id="out" aria-label="Zoom out">−</button><button id="in" aria-label="Zoom in">+</button><button id="details" aria-expanded="false">Details</button></div>
    <div class="graph-layout"><div class="canvas"><svg role="group" aria-label="Repository relationships. Drag to pan, pinch to zoom.">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L8 4L0 8z"></path></marker></defs><g class="world"></g></svg></div>
    <aside class="relations" aria-label="Selected record"></aside></div>`;
  const picker = main.querySelector('#record');
  picker.replaceChildren(...nodes.map(node => new Option(node.title, node.id)));
  const svg = main.querySelector('svg');
  const world = svg.querySelector('.world');
  const layout = main.querySelector('.graph-layout');
  const panel = main.querySelector('.relations');
  const details = main.querySelector('#details');
  const mobile = matchMedia('(max-width: 700px)');
  const pointers = new Map();
  let scale = 1, x = 0, y = 0, fitScale = 1, dragged = false;
  const elements = new Map();
  const paths = [];
  const makeSvg = (tag, attributes) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  };
  const coord = id => {
    const [x, y] = positions[id];
    return { x, y };
  };
  edges.forEach((edge, index) => {
    const path = makeSvg('path', { d: signalConnector('network', coord(edge.from), coord(edge.to), index), class: 'edge', 'marker-end': 'url(#arrow)' });
    paths.push(path);
    world.append(path);
  });
  for (const node of nodes) {
    const point = coord(node.id);
    const item = makeSvg('g', { transform: `translate(${point.x} ${point.y})`, class: 'node', tabindex: 0, role: 'button', 'aria-label': node.title, 'data-node': node.id });
    const box = makeSvg('rect', { width: 184, height: 72, rx: 3 });
    const dot = makeSvg('circle', { cx: 92, cy: 36, r: 15 });
    const kind = makeSvg('text', { x: 10, y: 16, class: 'kind' });
    kind.textContent = node.type;
    const words = node.title.split(' ');
    const lines = [''];
    for (const word of words) {
      const last = lines.at(-1);
      if (last && last.length + word.length > 20) lines.push(word);
      else lines[lines.length - 1] = (last + ' ' + word).trim();
    }
    item.append(box, dot, kind);
    lines.forEach((line, index) => {
      const text = makeSvg('text', { x: 10, y: 36 + index * 17, class: 'label' });
      text.textContent = line;
      item.append(text);
    });
    item.addEventListener('click', () => { if (!dragged) choose(node.id, true); });
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(node.id, true); }
    });
    elements.set(node.id, item);
    world.append(item);
  }
  function paint() {
    svg.dataset.level = !mobile.matches || scale >= .84 ? 'cards' : scale >= .48 ? 'labels' : 'dots';
    world.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
  }
  function fit() {
    fitScale = Math.min(svg.clientWidth / 1200, svg.clientHeight / 720);
    scale = fitScale;
    x = (svg.clientWidth - 1200 * scale) / 2;
    y = (svg.clientHeight - 720 * scale) / 2;
    paint();
  }
  function center(id) {
    const point = coord(id);
    scale = mobile.matches ? Math.max(.9, scale) : scale;
    x = svg.clientWidth / 2 - (point.x + 92) * scale;
    y = svg.clientHeight / 2 - (point.y + 36) * scale;
    paint();
  }
  function showDetails(show) {
    layout.classList.toggle('show-details', show);
    details.setAttribute('aria-expanded', show);
  }
  function choose(id, reveal = false) {
    selected = id;
    picker.value = id;
    const node = nodes.find(item => item.id === id);
    for (const [key, item] of elements) {
      item.classList.toggle('selected', key === id);
      item.setAttribute('aria-pressed', key === id);
    }
    edges.forEach((edge, index) => paths[index].classList.toggle('active', edge.from === id || edge.to === id));
    panel.innerHTML = '<button class="close-sheet">Close details</button><p class="path"></p><h2></h2><p class="description"></p>';
    panel.querySelector('button').onclick = () => { showDetails(false); details.focus(); };
    panel.querySelector('.path').textContent = node.type;
    panel.querySelector('h2').textContent = node.title;
    panel.querySelector('.description').textContent = node.description;
    if (id === 'tracker') panel.append(link('Read the example decision', 'reader/decision/section-0'));
    if (id === 'reader') panel.append(link('Open Reader workspace', 'reader'));
    const task = tasks.find(item => item[4] === id);
    if (task) panel.append(link('Open ' + task[0], 'kanban/' + task[0]));
    const list = document.createElement('ul');
    for (const edge of edges.filter(edge => edge.from === id || edge.to === id)) {
      const outgoing = edge.from === id;
      const other = nodes.find(item => item.id === (outgoing ? edge.to : edge.from));
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = other.title;
      button.onclick = () => { choose(other.id, true); if (mobile.matches) center(other.id); panel.querySelector('h2').tabIndex = -1; panel.querySelector('h2').focus(); };
      row.append(outgoing ? edge.verb : 'Incoming · ' + edge.verb, button);
      list.append(row);
    }
    panel.append(list);
    if (reveal) showDetails(true);
  }
  function local(event) {
    const rect = svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function zoom(factor, from, to = from) {
    const next = Math.max(Math.min(.14, fitScale), Math.min(3.4, scale * factor));
    x = to.x - (from.x - x) * next / scale;
    y = to.y - (from.y - y) * next / scale;
    scale = next;
    paint();
  }
  const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointers.size === 2) return;
    if (!pointers.size) dragged = false;
    else dragged = true;
    pointers.set(event.pointerId, local(event));
    event.target.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    const old = pointers.get(event.pointerId);
    if (!old) return;
    const point = local(event);
    const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
    pointers.set(event.pointerId, point);
    if (other) {
      zoom(distance(point, other) / Math.max(1, distance(old, other)), middle(old, other), middle(point, other));
    } else {
      if (distance(old, point) > 2) dragged = true;
      x += point.x - old.x;
      y += point.y - old.y;
      paint();
    }
  });
  for (const event of ['pointerup','pointercancel','lostpointercapture']) {
    svg.addEventListener(event, event => pointers.delete(event.pointerId));
  }
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    zoom(Math.exp(-event.deltaY * .002), local(event));
  }, { passive: false });
  picker.onchange = () => { choose(picker.value, true); if (mobile.matches) center(picker.value); };
  main.querySelector('#fit').onclick = fit;
  for (const [id, factor] of [['in',1.4],['out',1/1.4]]) {
    main.querySelector('#' + id).onclick = () => zoom(factor, { x: svg.clientWidth / 2, y: svg.clientHeight / 2 });
  }
  details.onclick = () => showDetails(!layout.classList.contains('show-details'));
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { showDetails(false); details.focus(); } });
  choose(selected, Boolean(nodeId));
  fit();
  if (nodeId && mobile.matches) center(selected);
  const resize = new ResizeObserver(() => {
    const width = svg.clientWidth;
    const height = svg.clientHeight;
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    fit();
  });
  let lastWidth = svg.clientWidth, lastHeight = svg.clientHeight;
  resize.observe(svg);
  graphCleanup = () => resize.disconnect();
}

let rendered = '';
function route() {
  const [requested, record, section] = location.hash.slice(1).split('/');
  const view = ['reader','kanban','graph'].includes(requested) ? requested : 'reader';
  const key = view + '/' + (view === 'reader' && record !== 'decision' ? '' : record || '');
  if (key !== rendered) {
    graphCleanup?.();
    graphCleanup = undefined;
    if (view === 'reader') reader(record);
    if (view === 'kanban') board(record);
    if (view === 'graph') graph(record);
    rendered = key;
    window.scrollTo(0, 0);
  }
  for (const tab of document.querySelectorAll('.shell nav a')) {
    if (tab.hash === '#' + view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  const heading = view === 'reader' ? document.getElementById(section || record) : null;
  if (heading?.matches('.prose h2,.prose h3')) {
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start' });
  }
}
theme.onchange = () => { document.documentElement.dataset.theme = theme.value.toLowerCase(); };
window.addEventListener('hashchange', route);
route();
