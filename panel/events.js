/*
 * AIUX DevTools panel — Events tab: a logger of events dispatched by AIUX
 * components (recorded by the page agent), with a detail inspector.
 */
(function () {
  'use strict';

  const { call, reloadAndRecord } = window.AiuxBridge;
  const Settings = window.AiuxSettings;
  const h = window.aiuxH;

  const $ = (id) => document.getElementById(id);
  const listEl = $('ev-list');
  const statusEl = $('ev-status');
  const badgeEl = $('events-badge');

  const MAX_ROWS = 5000;
  const POLL_MS = 500;

  let settings = Settings.load();
  let recording = false;
  let fromReload = false;
  let session = null; // agent session the log is currently following
  let lastSeq = 0;
  let entries = []; // { id, session, s, t, type, cls, src, sl, p, f, pv, d } | { divider }
  let selected = null;
  let pollTimer = null;
  let inflight = null; // the poll in progress, if any

  const opts = (extra) => Object.assign(window.AiuxPanel.agentOptions(), { eventMode: settings.eventMode }, extra || {});

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.title = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

  function eventCount() {
    return entries.filter((e) => !e.divider).length;
  }

  function updateChrome() {
    $('ev-record').classList.toggle('active', recording);
    $('ev-record').textContent = recording ? '■ Stop' : '● Record';
    const n = eventCount();
    badgeEl.textContent = String(n);
    badgeEl.classList.toggle('hidden', n === 0);
    if (recording) setStatus('Recording' + (fromReload ? ' from page load' : '') + ' · ' + n + ' events');
    else setStatus(n ? n + ' events' : 'Press Record, then use the page');
  }

  const details = new window.AiuxDetailsView($('ev-details'), {
    getOptions: opts,
    onStatus: setStatus,
    onSelectId: (id) => window.AiuxPanel.selectComponent(id),
    emptyMessage: 'Select an event to see its detail.',
    goneMessage: 'This event is no longer available (the page navigated, or it was cleared from the log).'
  });

  // ---------------------------------------------------------------------------
  // Filtering & rendering
  // ---------------------------------------------------------------------------

  function filterFn() {
    const tokens = $('ev-filter').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return () => true;
    return (e) => {
      if (e.divider) return true;
      const hay = (e.type + ' ' + e.sl).toLowerCase();
      return tokens.every((t) => (t.charAt(0) === '-' && t.length > 1 ? !hay.includes(t.slice(1)) : hay.includes(t)));
    };
  }

  function pad(n, w) {
    return String(n).padStart(w || 2, '0');
  }

  function timeLabel(ms) {
    const d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }

  function rowFor(e) {
    if (e.divider) return h('div', { class: 'event-divider', text: e.divider });
    const flags = [];
    if (e.f.includes('B')) flags.push('bubbles');
    if (e.f.includes('C')) flags.push('composed');
    if (e.f.includes('X')) flags.push('cancelable');
    if (e.pv) flags.push('defaultPrevented');
    return h(
      'div',
      {
        class: 'event-row' + (e.pv ? ' prevented' : '') + (e.cls === 'CustomEvent' ? '' : ' native') + (e.id === selected ? ' selected' : ''),
        'data-id': e.id,
        title: e.type + ' (' + e.cls + (flags.length ? ', ' + flags.join(', ') : '') + ') — listeners took ' + e.d + ' ms'
      },
      h('span', { class: 'c-time', text: timeLabel(e.t) }),
      h('span', { class: 'c-type', text: e.type }),
      h('span', { class: 'c-src', text: e.sl }),
      h('span', { class: 'c-detail', text: e.p })
    );
  }

  function renderAll() {
    const match = filterFn();
    const frag = document.createDocumentFragment();
    for (const e of entries) if (match(e)) frag.appendChild(rowFor(e));
    listEl.replaceChildren(frag);
    listEl.scrollTop = listEl.scrollHeight;
    updateChrome();
  }

  function append(newEntries) {
    if (!newEntries.length) return;
    const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 30;
    const match = filterFn();
    const frag = document.createDocumentFragment();
    for (const e of newEntries) {
      entries.push(e);
      if (match(e)) frag.appendChild(rowFor(e));
    }
    listEl.appendChild(frag);
    if (entries.length > MAX_ROWS) {
      const drop = entries.length - MAX_ROWS;
      const dropped = new Set(entries.slice(0, drop).map((e) => e.id));
      entries = entries.slice(drop);
      listEl.querySelectorAll('.event-row').forEach((row) => {
        if (dropped.has(row.dataset.id)) row.remove();
      });
    }
    if (atBottom) listEl.scrollTop = listEl.scrollHeight;
    updateChrome();
  }

  function clearLog() {
    entries = [];
    selected = null;
    details.clear();
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Polling the agent
  // ---------------------------------------------------------------------------

  /** Fetch new events. Concurrent callers share the poll already in flight. */
  function poll() {
    if (!inflight) {
      inflight = fetchEvents().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  async function fetchEvents() {
    try {
      let res = await call('getEvents', lastSeq);
      if (res.session !== session) {
        // A new page (or the first poll): start following its agent.
        if (session !== null) {
          if (settings.preserveLog) append([{ divider: 'Navigated · ' + timeLabel(Date.now()), id: 'div-' + Date.now() }]);
          else clearLog();
        }
        session = res.session;
        lastSeq = 0;
        if (res.events.length && res.events[0].s !== 1) res = await call('getEvents', 0);
        fromReload = fromReload && res.active;
      }
      if (recording && !res.active) {
        // The page navigated and its fresh agent isn't recording yet.
        res = Object.assign(await call('startEventCapture', opts()), { events: res.events });
      }
      const batch = res.events.map((e) => Object.assign(e, { id: 'event:' + res.session + ':' + e.s }));
      if (batch.length) {
        lastSeq = batch[batch.length - 1].s;
        append(batch);
      } else {
        updateChrome();
      }
      if (res.dropped) setStatus(res.dropped + ' events were dropped (buffer full); the log continues', true);
      if (batch.length === 500) setTimeout(poll, 0);
    } catch (e) {
      setStatus('Cannot read page: ' + e.message, true);
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!document.hidden) poll();
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function startRecording() {
    try {
      const res = await call('startEventCapture', opts());
      if (res.session !== session) {
        session = res.session;
        lastSeq = res.seq; // only log what happens from now on
      }
      recording = true;
      fromReload = false;
      startPolling();
      updateChrome();
    } catch (e) {
      setStatus('Cannot record: ' + e.message, true);
    }
  }

  async function stopRecording() {
    recording = false;
    fromReload = false;
    stopPolling();
    try {
      await call('stopEventCapture');
      // Collect what was dispatched since the last poll: let a poll already
      // in flight finish, then fetch once more now that recording has stopped.
      await poll();
      await poll();
    } catch (e) {
      /* page gone */
    }
    updateChrome();
  }

  // ---------------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------------

  function select(id) {
    selected = id;
    listEl.querySelectorAll('.event-row.selected').forEach((r) => r.classList.remove('selected'));
    const row = listEl.querySelector('.event-row[data-id="' + CSS.escape(id) + '"]');
    if (row) {
      row.classList.add('selected');
      row.scrollIntoView({ block: 'nearest' });
    }
    details.show(id);
  }

  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.event-row');
    if (row) select(row.dataset.id);
  });

  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(listEl.querySelectorAll('.event-row'));
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.dataset.id === selected);
    i = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    e.preventDefault();
    select(rows[i].dataset.id);
  });

  $('ev-record').addEventListener('click', () => (recording ? stopRecording() : startRecording()));

  $('ev-reload').addEventListener('click', async () => {
    if (!settings.preserveLog) clearLog();
    recording = true;
    fromReload = true;
    await reloadAndRecord(opts());
    startPolling();
    updateChrome();
  });

  $('ev-clear').addEventListener('click', async () => {
    clearLog();
    try {
      await call('clearEvents');
    } catch (e) {
      /* ignore */
    }
  });

  $('ev-filter').addEventListener('input', renderAll);

  $('ev-mode').value = settings.eventMode;
  $('ev-mode').addEventListener('change', async () => {
    settings = Settings.update({ eventMode: $('ev-mode').value });
    if (recording) await call('startEventCapture', opts());
  });

  $('ev-preserve').checked = !!settings.preserveLog;
  $('ev-preserve').addEventListener('change', () => {
    settings = Settings.update({ preserveLog: $('ev-preserve').checked });
  });

  $('ev-splitter').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const log = document.querySelector('.event-log');
    const startX = e.clientX;
    const startW = log.getBoundingClientRect().width;
    const move = (ev) => {
      log.style.width = Math.max(240, startW + ev.clientX - startX) + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  updateChrome();
})();
