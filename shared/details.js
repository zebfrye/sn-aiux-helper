/*
 * DetailsView — renders a subject's sections as expandable, editable value
 * trees. A subject is a component (properties, state, controllers, contexts,
 * events, listeners, React props/hooks, attributes, host internals), an event
 * from the Events logger (detail + event info), or the page's contexts. Used
 * by the AIUX panel and the Elements sidebar.
 */
(function (global) {
  'use strict';

  const { call, callWithListeners, revealInElements, revealValue } = global.AiuxBridge;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  const PRIMITIVES = new Set(['string', 'number', 'boolean', 'null', 'undefined', 'bigint', 'symbol']);

  function displayValue(node) {
    switch (node.t) {
      case 'string':
        return JSON.stringify(node.v) + (node.trunc ? ' … (' + node.trunc + ' chars)' : '');
      case 'number':
      case 'boolean':
        return String(node.v);
      default:
        return node.p;
    }
  }

  function editText(node) {
    if (node.t === 'string') return JSON.stringify(node.v);
    if (node.t === 'number' || node.t === 'boolean') return String(node.v);
    if (node.t === 'null') return 'null';
    if (node.t === 'undefined') return 'undefined';
    return '';
  }

  class DetailsView {
    /**
     * @param {HTMLElement} root container
     * @param {{getOptions: () => object, compact?: boolean, emptyMessage?: string, goneMessage?: string, onStatus?: (msg: string, isError?: boolean) => void, onSelectId?: (id: number) => void}} cfg
     */
    constructor(root, cfg) {
      this.root = root;
      this.cfg = cfg;
      this.id = null;
      this.expanded = {}; // sectionKey -> { pathKey: 1 }
      this.collapsedSections = new Set(['internals', 'listeners']);
      this.openedSections = new Set();
      this.previous = new Map(); // "section|pathKey" -> preview (for change flashes)
      this.editing = false;
      this.inflight = false;
      this.last = null;
      this.renderEmpty(this.emptyMessage());
    }

    emptyMessage() {
      return this.cfg.emptyMessage || 'Select a component to inspect its properties and state.';
    }

    status(msg, isError) {
      if (this.cfg.onStatus) this.cfg.onStatus(msg, isError);
    }

    renderEmpty(message) {
      this.root.replaceChildren(h('div', { class: 'empty', text: message }));
    }

    async show(id) {
      if (id !== this.id) {
        this.id = id;
        this.expanded = {};
        this.previous.clear();
        this.editing = false; // an edit in progress belonged to the previous subject
      }
      return this.refresh(true);
    }

    clear(message) {
      this.id = null;
      this.last = null;
      this.renderEmpty(message || this.emptyMessage());
    }

    async refresh(force) {
      if (this.id === null || this.editing || (this.inflight && !force)) return;
      this.inflight = true;
      const id = this.id;
      try {
        const data = await callWithListeners('inspect', id, this.cfg.getOptions({ expanded: this.expanded }));
        if (id !== this.id) return;
        if (!data || data.error) {
          this.last = null;
          this.renderEmpty(this.cfg.goneMessage || 'The selected component is no longer in the page.');
          return;
        }
        const sig = JSON.stringify(data);
        if (!force && this.last && this.lastSig === sig) return;
        this.lastSig = sig;
        this.last = data;
        this.render(data);
      } catch (e) {
        this.renderEmpty('Unable to inspect: ' + e.message);
      } finally {
        this.inflight = false;
      }
    }

    render(data) {
      const scrollTop = this.root.scrollTop;
      const header = h(
        'div',
        { class: 'details-header' },
        h('div', { class: 'title' }, h('span', { class: 'tag', text: data.subject !== 'component' || data.label.charAt(0) === '<' ? data.label : '<' + data.label + '>' })),
        h('div', { class: 'badges' }, data.kinds.map((k) => h('span', { class: 'badge badge-' + k.toLowerCase().replace(/\s+/g, '-'), text: k }))),
        h('div', { class: 'actions' }, this.headerActions(data))
      );

      const body = h('div', { class: 'sections' });
      for (const section of data.sections) body.appendChild(this.renderSection(section));
      this.root.replaceChildren(header, body);
      this.root.scrollTop = scrollTop;
    }

    headerActions(data) {
      if (data.subject === 'page') return [];
      const store = h('button', {
        title: data.subject === 'event' ? 'Store the Event object as a global variable in the console' : 'Store the host element as a global variable in the console',
        onclick: async () => {
          const name = await call('storeGlobal', this.id, null, null, this.cfg.getOptions());
          this.status(name ? 'Stored as ' + name : 'Could not store value', !name);
        }
      }, '$ Store');
      if (data.subject === 'event') {
        return [
          data.source && this.cfg.onSelectId
            ? h('button', { class: 'go-source', title: 'Inspect the component that dispatched this event', onclick: () => this.cfg.onSelectId(data.source) }, '⌖ ' + data.sourceLabel)
            : null,
          store
        ];
      }
      return [
        h('button', { title: 'Reveal in Elements panel', onclick: () => revealInElements(this.id) }, '⌖ Elements'),
        h('button', { title: 'Scroll into view', onclick: () => call('scrollIntoView', this.id) }, '↧ Scroll'),
        store
      ];
    }

    isSectionCollapsed(section) {
      if (this.openedSections.has(section.key)) return false;
      return this.collapsedSections.has(section.key) || section.collapsed;
    }

    renderSection(section) {
      const collapsed = this.isSectionCollapsed(section);
      const content = h('div', { class: 'section-body' + (collapsed ? ' hidden' : '') });
      const head = h(
        'div',
        {
          class: 'section-head',
          onclick: () => {
            const nowCollapsed = content.classList.toggle('hidden');
            head.classList.toggle('open', !nowCollapsed);
            if (nowCollapsed) {
              this.collapsedSections.add(section.key);
              this.openedSections.delete(section.key);
            } else {
              this.collapsedSections.delete(section.key);
              this.openedSections.add(section.key);
            }
          }
        },
        h('span', { class: 'twisty' }),
        h('span', { class: 'section-title', text: section.title }),
        section.editable ? h('span', { class: 'pill', title: 'Double-click a value to edit it', text: 'editable' }) : null
      );
      if (!collapsed) head.classList.add('open');
      if (section.note) content.appendChild(h('div', { class: 'note', text: section.note }));
      if (section.empty) {
        content.appendChild(h('div', { class: 'muted', text: 'Nothing found.' }));
      } else if (section.value) {
        const v = section.value;
        if (v.c) {
          if (!v.c.length) content.appendChild(h('div', { class: 'muted', text: 'empty' }));
          for (const c of v.c) content.appendChild(this.renderNode(section, c, [c.k], 0));
          if (v.more) content.appendChild(h('div', { class: 'muted', text: '… ' + v.more + ' more' }));
        } else {
          content.appendChild(this.renderNode(section, Object.assign({ k: '(value)' }, v), [], 0));
        }
      }
      return h('div', { class: 'section section-' + section.key.replace('.', '-') }, head, content);
    }

    renderNode(section, node, path, depth) {
      const pathKey = JSON.stringify(path);
      const expandedSet = this.expanded[section.key] || {};
      const isOpen = !!(node.c && expandedSet[pathKey]);
      const flashKey = section.key + '|' + pathKey;
      const prev = this.previous.get(flashKey);
      const now = node.t + ':' + displayValue(node);
      this.previous.set(flashKey, now);

      const valueEl = h('span', { class: 'val t-' + node.t, text: displayValue(node) });
      if (prev !== undefined && prev !== now) valueEl.classList.add('changed');
      if (node.el) {
        valueEl.classList.add('link');
        valueEl.title = 'Click to inspect this element';
        valueEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.cfg.onSelectId) this.cfg.onSelectId(node.el);
          else revealInElements(node.el);
        });
      }

      const row = h(
        'div',
        { class: 'row', style: 'padding-left:' + (depth * 14 + 4) + 'px' },
        h('span', { class: 'twisty' + (node.h ? '' : ' leaf') + (isOpen ? ' open' : '') }),
        h('span', { class: 'key', text: node.l || node.k }),
        h('span', { class: 'colon', text: ': ' }),
        valueEl,
        node.circular ? h('span', { class: 'muted', text: ' [circular]' }) : null,
        h(
          'span',
          { class: 'row-actions' },
          h('button', { title: 'Copy value as JSON', onclick: (e) => { e.stopPropagation(); this.copy(section, path); } }, '⧉'),
          h('button', { title: 'Store as global variable', onclick: (e) => { e.stopPropagation(); this.storeGlobal(section, path); } }, '$'),
          node.t === 'function'
            ? h('button', { title: 'Show function definition', onclick: (e) => { e.stopPropagation(); revealValue(this.id, section.key, path, this.cfg.getOptions()); } }, '{}')
            : null
        )
      );

      if (node.h) {
        row.addEventListener('click', () => this.toggle(section, path, node));
      }
      if (section.editable && this.isEditablePath(section, path)) {
        valueEl.classList.add('editable');
        valueEl.title = 'Double-click to edit';
        valueEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          this.beginEdit(section, path, node, valueEl);
        });
      }

      const wrap = h('div', { class: 'node' }, row);
      if (isOpen) {
        const kids = h('div', { class: 'children' });
        for (const c of node.c) kids.appendChild(this.renderNode(section, c, path.concat([c.k]), depth + 1));
        if (node.more) kids.appendChild(h('div', { class: 'muted', style: 'padding-left:' + ((depth + 1) * 14 + 18) + 'px', text: '… ' + node.more + ' more' }));
        wrap.appendChild(kids);
      }
      return wrap;
    }

    isEditablePath(section, path) {
      if (!path.length) return false;
      if (section.key === 'attributes') return path.length === 1;
      return true;
    }

    toggle(section, path, node) {
      const set = (this.expanded[section.key] = this.expanded[section.key] || {});
      const key = JSON.stringify(path);
      if (set[key]) delete set[key];
      else set[key] = 1;
      if (set[key] && !node.c) {
        this.refresh(true);
      } else if (this.last) {
        this.render(this.last);
      }
    }

    async beginEdit(section, path, node, valueEl) {
      // The edit is bound to the subject it started on: if the selection
      // changes before it is committed, it is dropped rather than applied to
      // whatever is selected by then.
      const id = this.id;
      this.editing = true;
      let text = editText(node);
      const multiline = !PRIMITIVES.has(node.t);
      if (multiline) {
        try {
          text = (await call('copyValue', id, section.key, path, this.cfg.getOptions())) || '';
        } catch (e) {
          if (this.id === id) this.editing = false;
          this.status('Cannot edit: ' + e.message, true);
          return;
        }
        if (this.id !== id) return;
        if (!valueEl.isConnected) {
          this.editing = false; // re-rendered while the value was loading
          return;
        }
      }
      const input = multiline
        ? h('textarea', { class: 'edit-input', rows: Math.min(14, text.split('\n').length + 1) })
        : h('input', { class: 'edit-input', type: 'text' });
      input.value = text;
      const parentRow = valueEl.parentNode;
      parentRow.replaceChild(input, valueEl);
      parentRow.classList.add('editing');
      input.focus();
      input.select();

      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        if (this.id !== id) return;
        this.editing = false;
        if (commit && input.value !== text) {
          try {
            const res = await call('setValue', id, section.key, path, input.value, this.cfg.getOptions());
            if (res && res.ok) {
              this.status('Updated ' + path.join('.') + ' via ' + res.method + (res.warning ? ' — ' + res.warning : ''), !!res.warning);
            } else {
              this.status('Edit failed: ' + ((res && res.error) || 'unknown error'), true);
            }
          } catch (e) {
            this.status('Edit failed: ' + e.message, true);
          }
        }
        if (this.id === id) this.refresh(true);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(false);
        else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish(true);
        }
      });
      input.addEventListener('blur', () => finish(true));
    }

    async copy(section, path) {
      const text = await callWithListeners('copyValue', this.id, section.key, path, this.cfg.getOptions());
      if (text === null || text === undefined) return this.status('Nothing to copy', true);
      // navigator.clipboard is blocked in DevTools pages; use a textarea.
      const ta = h('textarea', { style: 'position:fixed;left:-9999px' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      this.status('Copied ' + (path.join('.') || section.title));
    }

    async storeGlobal(section, path) {
      const name = await callWithListeners('storeGlobal', this.id, section.key, path, this.cfg.getOptions());
      this.status(name ? 'Stored as ' + name + ' — use it in the Console' : 'Could not store value', !name);
    }
  }

  global.AiuxDetailsView = DetailsView;
  global.aiuxH = h;
})(window);
