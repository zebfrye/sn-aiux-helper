/*
 * AIUX DevTools panel: component tree (left) + details inspector (right).
 */
(function () {
  'use strict';

  const { call } = window.AiuxBridge;
  const Settings = window.AiuxSettings;
  const h = window.aiuxH;

  if (chrome.devtools.panels.themeName === 'dark') document.body.classList.add('dark');

  const $ = (id) => document.getElementById(id);
  const treeEl = $('tree');
  const statusEl = $('status');

  let settings = Settings.load();
  let tree = []; // agent tree nodes
  let byId = new Map(); // id -> { node, parent }
  let collapsed = new Set(); // ids collapsed by the user
  let selectedId = null;
  let treeSig = '';
  let pollTimer = null;
  let treeTick = 0;
  let picking = false;

  const opts = (extra) => Settings.agentOptions(settings, extra);

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
    statusEl.title = msg || '';
  }

  const details = new window.AiuxDetailsView($('details'), {
    getOptions: opts,
    onStatus: setStatus,
    onSelectId: (id) => select(id, { reveal: true })
  });

  // ---------------------------------------------------------------------------
  // Tree
  // ---------------------------------------------------------------------------

  function index(nodes, parent) {
    for (const n of nodes) {
      byId.set(n.id, { node: n, parent });
      index(n.c, n);
    }
  }

  async function loadTree(quiet) {
    try {
      const res = await call('getTree', opts());
      const sig = JSON.stringify(res.nodes);
      if (sig !== treeSig) {
        treeSig = sig;
        tree = res.nodes;
        byId = new Map();
        index(tree, null);
        renderTree();
      }
      if (!quiet || res.truncated) {
        setStatus(res.count + ' components' + (res.truncated ? ' (truncated)' : ''));
      }
    } catch (e) {
      setStatus('Cannot read page: ' + e.message, true);
    }
  }

  function matches(node, q) {
    if (!q) return true;
    return node.n.toLowerCase().includes(q) || (node.r && node.r.toLowerCase().includes(q));
  }

  /** Returns true if node or a descendant matches the filter. */
  function computeVisible(node, q, out) {
    let any = matches(node, q);
    for (const c of node.c) if (computeVisible(c, q, out)) any = true;
    if (any) out.add(node.id);
    return any;
  }

  function highlightText(text, q) {
    if (!q) return [text];
    const i = text.toLowerCase().indexOf(q);
    if (i === -1) return [text];
    return [text.slice(0, i), h('mark', { text: text.slice(i, i + q.length) }), text.slice(i + q.length)];
  }

  function renderTree() {
    const q = $('filter').value.trim().toLowerCase();
    const visible = new Set();
    for (const n of tree) computeVisible(n, q, visible);
    const frag = document.createDocumentFragment();

    const add = (node, depth) => {
      if (!visible.has(node.id)) return;
      const hasKids = node.c.some((c) => visible.has(c.id));
      // While filtering, show matches regardless of manual collapse state.
      const isCollapsed = !q && collapsed.has(node.id);
      const row = h(
        'div',
        {
          class: 'tree-row kind-' + node.k + (node.id === selectedId ? ' selected' : ''),
          style: 'padding-left:' + (depth * 14 + 4) + 'px',
          'data-id': node.id
        },
        h('span', { class: 'twisty' + (hasKids ? (isCollapsed ? '' : ' open') : ' leaf'), 'data-toggle': '1' }),
        h('span', { class: 'name' }, highlightText(node.n, q)),
        node.r ? h('span', { class: 'react-tag' }, '⚛ ', highlightText(node.r, q)) : null
      );
      frag.appendChild(row);
      if (!isCollapsed) for (const c of node.c) add(c, depth + 1);
    };
    for (const n of tree) add(n, 0);

    const scroll = treeEl.scrollTop;
    treeEl.replaceChildren(frag);
    if (!tree.length) {
      treeEl.appendChild(
        h(
          'div',
          { class: 'empty' },
          'No ServiceNow components found. ',
          h('br'),
          'Check the tag pattern in ⚙ Settings, or enable "Show every custom element".'
        )
      );
    }
    treeEl.scrollTop = scroll;
  }

  function scrollSelectedIntoView() {
    const row = treeEl.querySelector('.tree-row.selected');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function expandTo(id) {
    let entry = byId.get(id);
    while (entry && entry.parent) {
      collapsed.delete(entry.parent.id);
      entry = byId.get(entry.parent.id);
    }
  }

  async function select(id, { reveal } = {}) {
    if (!id) return;
    selectedId = id;
    if (reveal && !byId.has(id)) await loadTree(true);
    expandTo(id);
    renderTree();
    scrollSelectedIntoView();
    await details.show(id);
  }

  treeEl.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.dataset.toggle && !e.target.classList.contains('leaf')) {
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      renderTree();
      return;
    }
    select(id);
  });

  treeEl.addEventListener('mouseover', (e) => {
    const row = e.target.closest('.tree-row');
    if (row) call('highlight', Number(row.dataset.id)).catch(() => {});
  });
  treeEl.addEventListener('mouseleave', () => call('unhighlight').catch(() => {}));

  treeEl.addEventListener('keydown', (e) => {
    const rows = Array.from(treeEl.querySelectorAll('.tree-row'));
    if (!rows.length) return;
    let i = rows.findIndex((r) => Number(r.dataset.id) === selectedId);
    const id = i >= 0 ? selectedId : null;
    if (e.key === 'ArrowDown') i = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'ArrowLeft' && id !== null) {
      const entry = byId.get(id);
      if (entry && entry.node.c.length && !collapsed.has(id)) {
        collapsed.add(id);
        renderTree();
      } else if (entry && entry.parent) {
        select(entry.parent.id);
      }
      e.preventDefault();
      return;
    } else if (e.key === 'ArrowRight' && id !== null) {
      collapsed.delete(id);
      renderTree();
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    const next = Number(rows[i].dataset.id);
    select(next);
    call('highlight', next).catch(() => {});
  });

  $('filter').addEventListener('input', renderTree);
  $('refresh').addEventListener('click', () => {
    treeSig = '';
    loadTree(false);
    details.refresh(true);
  });

  // ---------------------------------------------------------------------------
  // Picker
  // ---------------------------------------------------------------------------

  async function pollPick() {
    if (!picking) return;
    try {
      const res = await call('pollPick');
      if (res === null) {
        setTimeout(pollPick, 150);
        return;
      }
      stopPicking();
      if (res) {
        await select(res, { reveal: true });
        setStatus('Picked component');
      }
    } catch (e) {
      stopPicking();
      setStatus(e.message, true);
    }
  }

  function stopPicking() {
    picking = false;
    $('pick').classList.remove('active');
  }

  $('pick').addEventListener('click', async () => {
    if (picking) {
      stopPicking();
      call('stopPick').catch(() => {});
      return;
    }
    picking = true;
    $('pick').classList.add('active');
    setStatus('Click a component in the page (Esc to cancel)');
    try {
      await call('startPick', opts());
      pollPick();
    } catch (e) {
      stopPicking();
      setStatus(e.message, true);
    }
  });

  // ---------------------------------------------------------------------------
  // Live updates
  // ---------------------------------------------------------------------------

  function schedule() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!settings.live) return;
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      details.refresh(false);
      // Rebuilding the tree walks the whole DOM, so do it less often.
      if (++treeTick % 3 === 0) loadTree(true);
    }, settings.pollMs || 1000);
  }

  $('live').checked = !!settings.live;
  $('live').addEventListener('change', () => {
    settings.live = $('live').checked;
    Settings.save(settings);
    schedule();
  });

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  function fillSettings() {
    $('tagPattern').value = settings.tagPattern;
    $('allCustomElements').checked = settings.allCustomElements;
    $('includeReact').checked = settings.includeReact;
    $('statePaths').value = (settings.statePaths || []).join('\n');
  }

  $('settings-toggle').addEventListener('click', () => {
    fillSettings();
    $('settings').classList.toggle('hidden');
    $('settings-toggle').classList.toggle('active');
  });

  $('settings').addEventListener('submit', (e) => {
    e.preventDefault();
    const pattern = $('tagPattern').value.trim() || Settings.DEFAULTS.tagPattern;
    try {
      new RegExp(pattern);
    } catch (err) {
      setStatus('Invalid RegExp: ' + err.message, true);
      return;
    }
    settings.tagPattern = pattern;
    settings.allCustomElements = $('allCustomElements').checked;
    settings.includeReact = $('includeReact').checked;
    settings.statePaths = $('statePaths')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    Settings.save(settings);
    treeSig = '';
    loadTree(false);
    details.refresh(true);
  });

  $('settings-reset').addEventListener('click', () => {
    const live = settings.live;
    settings = Object.assign({}, Settings.DEFAULTS, { live });
    fillSettings();
  });

  // ---------------------------------------------------------------------------
  // Splitter
  // ---------------------------------------------------------------------------

  $('splitter').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeEl.getBoundingClientRect().width;
    const move = (ev) => {
      treeEl.style.width = Math.max(160, startW + ev.clientX - startX) + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // ---------------------------------------------------------------------------
  // Page lifecycle
  // ---------------------------------------------------------------------------

  chrome.devtools.network.onNavigated.addListener(() => {
    selectedId = null;
    collapsed = new Set();
    treeSig = '';
    details.clear('Page navigated — select a component.');
    // Give the new page a moment to boot its components.
    setTimeout(() => loadTree(false), 1000);
  });

  // When the user selects a node in the Elements panel, follow it here too.
  chrome.devtools.panels.elements.onSelectionChanged.addListener(async () => {
    try {
      const id = await window.AiuxBridge.callSource('idForElement', '$0,' + JSON.stringify(opts()));
      if (id && byId.has(id) && id !== selectedId) select(id);
    } catch (e) {
      /* ignore */
    }
  });

  loadTree(false);
  schedule();
})();
