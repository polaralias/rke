  const canvas = document.getElementById('graph-canvas');
  const { edges } = JSON.parse(document.getElementById('graph-data').textContent);
  const angular = document.body.classList.contains('signal');
  const phone = matchMedia('(max-width: 700px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const contacts = new Map();
  const svg = () => canvas.querySelector('.graph-svg');
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const mix = (a, b, t) => a + (b - a) * t;
  const midpoint = (a, b) => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });
  const distance = (a, b) => Math.hypot(a.x-b.x, a.y-b.y);
  let camera, home, nodes, paths, size, animation = 0, frame = 0, moved = false;

  function connector(from, to, card, index) {
    const dx = to.x-from.x, dy = to.y-from.y;
    if (!angular) {
      const bend = clamp(dx * .14, -55, 55);
      const control = { x:(from.x+to.x)/2-dy*.13, y:(from.y+to.y)/2+bend };
      const port = point => {
        const x = control.x-point.x, y = control.y-point.y;
        const factor = card / Math.max(Math.abs(x)/95, Math.abs(y)/39);
        return { x:point.x+x*factor, y:point.y+y*factor };
      };
      const a = port(from), b = port(to);
      return `M${a.x} ${a.y} Q${control.x} ${control.y} ${b.x} ${b.y}`;
    }
    // Approach the centre of a card side. As cards fade, converge on the dot.
    const vertical = Math.abs(dx) < 200;
    const sign = Math.sign(vertical ? dy : dx) || 1;
    const inset = (vertical ? 39 : 95) * card;
    const a = { ...from }, b = { ...to };
    const axis = vertical ? 'y' : 'x';
    a[axis] += sign * inset;
    b[axis] -= sign * inset;
    const step = (b[axis]-a[axis]) * (.24 + (index % 4) * .045);
    return vertical
      ? `M${a.x} ${a.y} V${a.y+step} L${b.x} ${b.y-step} V${b.y}`
      : `M${a.x} ${a.y} H${a.x+step} L${b.x-step} ${b.y} H${b.x}`;
  }

  function paint() {
    const graph = svg();
    if (!graph || !camera || !size) return;
    graph.setAttribute('viewBox', [camera.x,camera.y,camera.w,camera.w*size.h/size.w].join(' '));
    const nodePixels = 184 * size.w / camera.w;
    const labels = phone.matches ? clamp((nodePixels-76)/30,0,1) : 1;
    const cards = phone.matches ? clamp((nodePixels-112)/44,0,1) : 1;
    graph.style.setProperty('--card-opacity', cards);
    graph.style.setProperty('--label-opacity', labels);
    graph.style.setProperty('--dot-opacity', 1-labels);
    document.body.dataset.graphDetail = cards > .5 ? 'cards' : labels > .5 ? 'labels' : 'dots';
    if (graph.dataset.edgeOpacity === String(cards)) return;
    graph.dataset.edgeOpacity = String(cards);
    edges.forEach((edge, i) => {
      const path = paths[i];
      path.setAttribute('d', connector(nodes.get(edge.from), nodes.get(edge.to), cards, i));
      // At overview the dots themselves mark the endpoints.
      if (cards < .8) path.removeAttribute('marker-end');
      else path.setAttribute('marker-end', 'url(#graph-arrow)');
    });
  }

  function schedulePaint() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; paint(); });
  }

  function setup() {
    const graph = svg();
    if (!graph || !graph.clientWidth || !graph.clientHeight) return;
    const previous = size;
    size = { w:graph.clientWidth, h:graph.clientHeight };
    graph.dataset.camera = '';
    delete graph.dataset.edgeOpacity;
    const layer = graph.querySelector('g');
    layer.removeAttribute('transform');
    nodes = new Map();
    const groups = [...graph.querySelectorAll('.graph-node')];
    groups.forEach((node, index) => {
      let point;
      if (angular) {
        const [x,y] = graphLayouts.network.positions[node.dataset.node];
        const spread = phone.matches ? clamp(size.h/size.w, 1, 1.65) : 1;
        point = { x:x+92, y:360+(y+36-360)*spread };
      } else {
        const angle = (index-1)*2*Math.PI/(groups.length-1)-Math.PI/2;
        const radiusY = phone.matches ? clamp(405*size.h/size.w, 350, 700) : 318;
        point = index ? { x:550+405*Math.cos(angle), y:380+radiusY*Math.sin(angle) } : { x:550, y:380 };
      }
      node.setAttribute('transform', `translate(${point.x-92} ${point.y-36})`);
      nodes.set(node.dataset.node,point);
      if (!node.querySelector('.overview-dot')) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg','circle');
        dot.classList.add('overview-dot');
        dot.setAttribute('cx','92');
        dot.setAttribute('cy','36');
        dot.setAttribute('r','12');
        node.append(dot);
      }
    });
    paths = [...graph.querySelectorAll('.graph-edge')];
    const points = [...nodes.values()];
    const padX = phone.matches ? 28 : 111;
    const padY = phone.matches ? 28 : 54;
    const left = Math.min(...points.map(p => p.x))-padX;
    const right = Math.max(...points.map(p => p.x))+padX;
    const top = Math.min(...points.map(p => p.y))-padY;
    const bottom = Math.max(...points.map(p => p.y))+padY;
    const w = Math.max(right-left, (bottom-top)*size.w/size.h);
    home = { x:(left+right-w)/2, y:(top+bottom-w*size.h/size.w)/2, w };
    if (!camera || previous?.w !== size.w || previous?.h !== size.h) camera = { ...home };
    paint();
  }

  function stop() { cancelAnimationFrame(animation); animation = 0; }
  function animate(target) {
    stop();
    if (reduced.matches) { camera = target; paint(); return; }
    const start = { ...camera }, time = performance.now();
    function tick(now) {
      const t = clamp((now-time)/190,0,1);
      const ease = 1-(1-t)**3;
      camera = { x:mix(start.x,target.x,ease), y:mix(start.y,target.y,ease), w:mix(start.w,target.w,ease) };
      paint();
      animation = t < 1 ? requestAnimationFrame(tick) : 0;
    }
    animation = requestAnimationFrame(tick);
  }
  function local(event) {
    const rect = svg().getBoundingClientRect();
    return { x:event.clientX-rect.left, y:event.clientY-rect.top };
  }
  function zoomTarget(factor, from, to = from) {
    const w = clamp(camera.w/factor,150,home.w*2);
    return { x:camera.x+(from.x*camera.w-to.x*w)/size.w,
      y:camera.y+(from.y*camera.w-to.y*w)/size.w, w };
  }
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !camera || contacts.size >= 2) return;
    stop();
    event.stopPropagation();
    moved = contacts.size > 0;
    contacts.set(event.pointerId,local(event));
    event.target.setPointerCapture(event.pointerId);
  },true);
  canvas.addEventListener('pointermove', event => {
    const previous = contacts.get(event.pointerId);
    if (!previous) return;
    const next = local(event);
    const other = [...contacts].find(([id]) => id !== event.pointerId)?.[1];
    contacts.set(event.pointerId,next);
    if (other) {
      camera = zoomTarget(distance(next,other)/Math.max(1,distance(previous,other)),midpoint(previous,other),midpoint(next,other));
    } else {
      if (distance(next,previous)>2) moved = true;
      camera = zoomTarget(1,previous,next);
    }
    schedulePaint();
  },true);
  for (const type of ['pointerup','pointercancel','lostpointercapture']) {
    canvas.addEventListener(type,event => contacts.delete(event.pointerId),true);
  }
  canvas.addEventListener('click',event => {
    if (moved && event.detail) event.stopPropagation();
  },true);
  canvas.addEventListener('wheel',event => {
    if (!camera || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    stop();
    camera = zoomTarget(Math.exp(-event.deltaY*.003),local(event));
    schedulePaint();
  },{ passive:false });
  for (const [id,factor] of [['graph-in',1.25],['graph-out',.8]]) {
    document.getElementById(id).addEventListener('click',event => {
      if (!camera) return;
      event.stopImmediatePropagation();
      animate(zoomTarget(factor,{ x:size.w/2, y:size.h/2 }));
    },true);
  }
  document.getElementById('graph-reset').addEventListener('click',() => { if (home) animate({ ...home }); });
  new MutationObserver(setup).observe(canvas,{ childList:true });
  new ResizeObserver(setup).observe(canvas);
  setup();
