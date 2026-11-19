(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const view = document.body.dataset.shortlistView;
  const main = byId('main');
  const nav = document.querySelector('nav[aria-label="Workspace"]');
  const button = (label, action) => {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.addEventListener('click', action);
    return control;
  };
  const toggle = (control, active) => control.setAttribute('aria-pressed', String(active));

  if (view === 'reader') {
    const grid = main.querySelector('.reading-grid');
    const outline = grid.querySelector('.outline');
    const article = grid.querySelector('.article');
    const focus = byId('focus-toggle');
    const syncFocus = () => {
      const active = main.classList.contains('focus-mode');
      if (active) article.after(outline);
      else grid.prepend(outline);
      focus.textContent = active ? 'Side context' : 'Focus mode';
    };
    focus.addEventListener('click', syncFocus);
    if (document.body.classList.contains('studio')) focus.click();
  }

  if (view === 'kanban') {
    const board = main.querySelector('.board');
    const search = byId('search-tasks');
    const columns = [...board.querySelectorAll('.column')];
    const states = document.createElement('nav');
    states.className = 'shortlist-states';
    states.setAttribute('aria-label', 'Board status');
    states.hidden = true;
    let active = columns.find(column => column.dataset.state === '2') ?? columns[0];
    let vertical = false;
    const update = () => {
      const searching = search.value.trim() !== '' || byId('owner').selectedIndex > 0;
      columns.forEach((column, index) => {
        column.hidden = vertical && !searching && column !== active;
        toggle(states.children[index], !searching && column === active);
      });
      board.classList.toggle('vertical-board', vertical);
      states.hidden = !vertical;
      toggle(layout, vertical);
    };
    for (const column of columns) {
      const heading = column.querySelector('h2').textContent.trim();
      states.append(button(heading, () => {
        active = column;
        search.value = '';
        byId('owner').selectedIndex = 0;
        search.dispatchEvent(new Event('input'));
        update();
      }));
    }
    const layout = button('Vertical', () => {
      vertical = !vertical;
      update();
    });
    toggle(layout, false);
    main.querySelector('.toolbar').prepend(layout);
    board.before(states);
    search.addEventListener('input', update);
    byId('owner').addEventListener('change', update);
  }

  if (view === 'graph' && document.body.classList.contains('studio')) {
    main.querySelector('h1').textContent = 'Relationships';
    const canvas = byId('graph-canvas');
    requestAnimationFrame(() => {
      canvas.scrollLeft = (canvas.scrollWidth - canvas.clientWidth) / 2;
    });
    const inspector = byId('graph-inspector');
    const workspace = main.querySelector('.graph-workspace');
    inspector.hidden = true;
    const details = button('Details', () => {
      inspector.hidden = !inspector.hidden;
      details.setAttribute('aria-expanded', String(!inspector.hidden));
      if (!inspector.hidden) {
        const heading = inspector.querySelector('h2');
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    });
    details.setAttribute('aria-expanded', 'false');
    details.setAttribute('aria-controls', 'graph-inspector');
    main.querySelector('.graph-controls').append(details);
    const close = button('Close details', () => {
      inspector.hidden = true;
      details.setAttribute('aria-expanded', 'false');
      details.focus();
    });
    close.className = 'close-graph-details';
    workspace.append(close);
    workspace.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !inspector.hidden) close.click();
    });
  }

  const commands = document.createElement('dialog');
  commands.className = 'shortlist-commands';
  commands.setAttribute('aria-labelledby', 'command-title');
  commands.innerHTML = '<header><h2 id="command-title">Workspace commands</h2>' +
    '<button type="button" data-close>Close</button></header>' +
    '<label for="shortlist-command">Command</label>' +
    '<div class="command-input"><span aria-hidden="true">$</span>' +
    '<input id="shortlist-command" autofocus autocomplete="off" spellcheck="false">' +
    '<button type="button" data-run>Run</button></div>' +
    '<p class="command-help">Open kanban · Open reader · Open graph</p>' +
    '<p role="status" class="command-result"></p>';
  document.body.append(commands);
  const input = byId('shortlist-command');
  const result = commands.querySelector('[role="status"]');
  const search = byId('search-tasks') ?? byId('graph-search');
  const focus = byId('focus-toggle') ?? byId('graph-focus');
  const extra = [search && 'find &lt;text&gt;', focus && 'focus'].filter(Boolean).join(' · ');
  if (extra) commands.querySelector('.command-help').insertAdjacentHTML('beforeend', '<br>' + extra);
  const open = () => {
    if (commands.open) return;
    input.value = '';
    result.textContent = '';
    commands.showModal();
    input.focus();
  };
  const launch = button('Commands', open);
  launch.className = 'launch-commands';
  nav.append(launch);
  commands.querySelector('[data-close]').addEventListener('click', () => commands.close());
  const run = () => {
    const value = input.value.trim();
    const route = /^open (kanban|reader|graph)$/i.exec(value);
    if (route) {
      const target = route[1].toLowerCase();
      if (target === view) commands.close();
      else nav.querySelector('a[href$="-' + target + '.html"]').click();
    } else if (search && /^find\s+\S/i.test(value)) {
      search.value = value.replace(/^find\s+/i, '');
      search.dispatchEvent(new Event('input'));
      commands.close();
      search.focus();
    } else if (focus && value.toLowerCase() === 'focus') {
      focus.click();
      commands.close();
      focus.focus();
    } else {
      result.textContent = 'Choose one of the commands shown above.';
    }
  };
  commands.querySelector('[data-run]').addEventListener('click', run);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      run();
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      open();
    }
  });
})();
