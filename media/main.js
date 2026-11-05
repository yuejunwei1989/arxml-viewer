/* global acquireVsCodeApi, window */
(function () {
  'use strict';

  const vs = acquireVsCodeApi();
  const DATA = window.__ARXML_DATA__ || {};
  const state = {
    tab: 'connections',
    // When set, the SWCs tab is replaced by the detail page of that component.
    detail: null,
    detailTab: 'connections',
    scope: (document.getElementById('app') && document.getElementById('app').dataset.scope) || 'file',
    query: '',
    kind: 'all',
    showUnconnected: true,
    sort: {
      connections: { key: 'providerComponent', dir: 1 },
      ports: { key: 'swc', dir: 1 },
      swcs: { key: 'name', dir: 1 },
      interfaces: { key: 'name', dir: 1 },
      dataTypes: { key: 'name', dir: 1 },
      runnables: { key: 'swc', dir: 1 },
    },
  };

  const $ = (sel, root) => (root || document).querySelector(sel);

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function badge(text, cls) {
    return '<span class="badge ' + cls + '">' + esc(text) + '</span>';
  }

  function dirBadge(dir) {
    if (dir === 'provides') return badge('P', 'b-provides');
    if (dir === 'requires') return badge('R', 'b-requires');
    if (!dir) return '';
    return badge(dir, 'b-neutral');
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                          */
  /* ------------------------------------------------------------------ */

  function render() {
    const app = $('#app');
    if (DATA.error) {
      app.innerHTML =
        '<div class="error-box"><h2>Parse failed</h2><p>' + esc(DATA.error) + '</p>' +
        '<button id="btn-open">Open as text</button></div>';
      $('#btn-open').onclick = () => vs.postMessage({ type: 'openSource' });
      return;
    }

    const inDetail = !!state.detail && DATA.swcs.some((s) => s.name === state.detail);
    if (state.detail && !inDetail) state.detail = null;

    app.innerHTML =
      headerHtml() +
      statsHtml() +
      (DATA.daVinci ? daVinciBanner() : '') +
      (inDetail ? '' : tabsHtml()) +
      '<div id="panel" class="panel"></div>';

    bindHeader();
    renderPanel();
  }

  function headerHtml() {
    const file = String(DATA.fileName || '').split(/[\\/]/).pop();
    return (
      '<header class="hdr">' +
      '<div class="hdr-left">' +
      (DATA.daVinci ? '<span class="dv-tag" title="' + esc(DATA.daVinci.projectFile) + '">' + esc(DATA.daVinci.tool) + '</span>' : '') +
      (DATA.projectMode ? '<span class="proj-tag">Project mode</span>' : '') +
      '<span class="filename" title="' + esc(DATA.fileName) + '">' + esc(file) + '</span>' +
      '<span class="meta">ARXML r' + esc(DATA.schemaVersion) + '</span>' +
      '</div>' +
      '<div class="hdr-right">' +
      '<input id="search" class="search" type="search" placeholder="Search SWC / port / interface…" />' +
      '<select id="scopeFilter" class="select" title="Parse scope">' +
      '<option value="file"' + (state.scope === 'file' ? ' selected' : '') + '>Current file</option>' +
      '<option value="folder"' + (state.scope === 'folder' ? ' selected' : '') + '>Parent folder</option>' +
      '<option value="workspace"' + (state.scope === 'workspace' ? ' selected' : '') + '>Whole workspace</option>' +
      '<option value="picked">Choose folder…</option>' +
      '</select>' +
      '<select id="kindFilter" class="select">' +
      '<option value="all">All connections</option>' +
      '<option value="assembly">Assembly</option>' +
      '<option value="delegate">Delegation</option>' +
      '</select>' +
      '<button id="btn-export" class="btn" title="Export CSV">Export CSV</button>' +
      '<button id="btn-refresh" class="btn ghost" title="Re-parse">Refresh</button>' +
      '<button id="btn-source" class="btn ghost" title="Open source file">Source</button>' +
      '</div>' +
      '</header>'
    );
  }

  function statsHtml() {
    const s = DATA.stats || {};
    const cards = [
      ['SWC', s.swcCount],
      ['Ports', s.portCount],
      ['Runnable', s.runnableCount, s.orphanRunnables > 0 ? 'warn' : ''],
      ['Assembly', s.assemblyCount],
      ['Delegation', s.delegateCount],
      ['Unconnected ports', s.unconnectedPorts, s.unconnectedPorts > 0 ? 'warn' : ''],
      ['Parse time', s.elapsedMs + ' ms'],
    ];
    if (DATA.projectMode) {
      cards.push(['Files', s.fileCount]);
      cards.push(['Issues', s.issueCount, s.issueCount > 0 ? 'warn' : '']);
    }
    return (
      '<div class="stats">' +
      cards
        .map(
          (c) =>
            '<div class="stat ' + (c[2] || '') + '"><div class="stat-v">' + esc(c[1]) + '</div><div class="stat-k">' + esc(c[0]) + '</div></div>'
        )
        .join('') +
      '</div>'
    );
  }

  function daVinciBanner() {
    const dv = DATA.daVinci;
    const rows = [
      ['Project file', '<a href="#" class="file-link" data-file="' + esc(dv.projectFile) + '">' + esc(baseName(dv.projectFile)) + '</a>'],
      ['Project root', '<code class="path">' + esc(dv.root) + '</code>'],
    ];
    if (dv.externalProjects && dv.externalProjects.length) {
      rows.push(['Linked workspaces', dv.externalProjects.map(fileLink).join(' ')]);
    }
    if (dv.scannedFolders && dv.scannedFolders.length) {
      rows.push(['Scanned folders', dv.scannedFolders.map((f) => '<code class="path">' + esc(f) + '</code>').join(' ')]);
    }
    return (
      '<div class="dv-banner">' +
      rows.map((r) => '<div class="dv-row"><span class="dv-k">' + esc(r[0]) + '</span><span class="dv-v">' + r[1] + '</span></div>').join('') +
      '</div>'
    );
  }

  function tabsHtml() {
    const tabs = [
      ['connections', 'Connections', DATA.connections.length],
      ['ports', 'Ports', DATA.ports.length],
      ['swcs', 'SWCs', DATA.swcs.length],
      ['runnables', 'Runnables', DATA.runnables ? DATA.runnables.length : 0],
      ['interfaces', 'Interfaces', DATA.interfaces ? DATA.interfaces.length : 0],
      ['dataTypes', 'Data types', DATA.dataTypes ? DATA.dataTypes.length : 0],
      ['matrix', 'Matrix', DATA.matrix ? DATA.matrix.cells.length : 0],
    ];
    if (DATA.projectMode) {
      tabs.push(['files', 'Files', DATA.files ? DATA.files.length : 0]);
      tabs.push(['issues', 'Issues', DATA.issues ? DATA.issues.length : 0]);
    }
    return (
      '<nav class="tabs">' +
      tabs
        .map(
          (t) =>
            '<button class="tab' + (state.tab === t[0] ? ' active' : '') + '" data-tab="' + t[0] + '">' +
            esc(t[1]) + '<span class="count">' + esc(t[2]) + '</span></button>'
        )
        .join('') +
      '</nav>'
    );
  }

  function bindHeader() {
    const search = $('#search');
    if (search) {
      search.value = state.query;
      search.oninput = debounce(() => {
        state.query = search.value.trim().toLowerCase();
        renderPanel();
      }, 120);
    }
    const sf = $('#scopeFilter');
    if (sf) {
      sf.onchange = () => {
        const v = sf.value;
        state.scope = v;
        vs.postMessage({ type: 'setScope', scope: v });
        if (v === 'picked') sf.value = 'folder';
      };
    }
    const kf = $('#kindFilter');
    if (kf) {
      kf.value = state.kind;
      kf.onchange = () => {
        state.kind = kf.value;
        renderPanel();
      };
    }
    $('#btn-export').onclick = () => vs.postMessage({ type: 'saveCsv' });
    $('#btn-refresh').onclick = () => vs.postMessage({ type: 'refresh' });
    $('#btn-source').onclick = () => vs.postMessage({ type: 'openSource' });

    document.querySelectorAll('.tab').forEach((btn) => {
      btn.onclick = () => {
        state.tab = btn.getAttribute('data-tab');
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
        renderPanel();
      };
    });
  }

  /** True when the row's SWC is the one currently drilled into (no filter otherwise). */
  function belongsTo(row) {
    return !state.detail || row.swc === state.detail;
  }

  /** True when either endpoint of a connection is the drilled-into component
   * (matched by instance name or by the type name behind the prototype). */
  function involving(conn) {
    if (!state.detail) return true;
    const hit = (comp, type) => comp === state.detail || (type && type === state.detail);
    return hit(conn.providerComponent, conn.providerComponentType) || hit(conn.requesterComponent, conn.requesterComponentType);
  }

  function matchRow(haystack) {
    if (!state.query) return true;
    return String(haystack).toLowerCase().indexOf(state.query) >= 0;
  }

  function renderPanel() {
    const panel = $('#panel');
    if (!panel) return;
    if (state.detail) panel.innerHTML = swcDetailHtml(state.detail);
    else if (state.tab === 'connections') panel.innerHTML = connectionsHtml();
    else if (state.tab === 'ports') panel.innerHTML = portsHtml();
    else if (state.tab === 'swcs') panel.innerHTML = swcsHtml();
    else if (state.tab === 'runnables') panel.innerHTML = runnablesHtml();
    else if (state.tab === 'interfaces') panel.innerHTML = interfacesHtml();
    else if (state.tab === 'dataTypes') panel.innerHTML = dataTypesHtml();
    else if (state.tab === 'files') panel.innerHTML = filesHtml();
    else if (state.tab === 'issues') panel.innerHTML = issuesHtml();
    else panel.innerHTML = matrixHtml();
    bindTable();
    bindDetail();
  }

  function sortRows(rows, table, keyFn) {
    const s = state.sort[table] || { key: '', dir: 1 };
    if (!s.key) return rows;
    const sorted = rows.slice().sort((a, b) => {
      const va = keyFn(a, s.key);
      const vb = keyFn(b, s.key);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * s.dir;
      return String(va).localeCompare(String(vb), 'en', { numeric: true }) * s.dir;
    });
    return sorted;
  }

  function th(label, table, key, cls) {
    const s = state.sort[table] || {};
    const active = s.key === key;
    const arrow = active ? (s.dir === 1 ? ' ▲' : ' ▼') : '';
    return '<th class="sortable' + (active ? ' sorted' : '') + (cls ? ' ' + cls : '') + '" data-table="' + table +
      '" data-key="' + key + '">' + esc(label) + arrow + '</th>';
  }

  function connectionsHtml() {
    let rows = DATA.connections.filter((c) => {
      if (!involving(c)) return false;
      if (state.kind !== 'all' && c.kind !== state.kind) return false;
      return matchRow(
        [c.providerComponent, c.providerPort, c.providerInterface, c.requesterComponent, c.requesterPort, c.requesterInterface, c.dataElements, c.composition].join(' ')
      );
    });
    rows = sortRows(rows, 'connections', (r, k) => r[k]);

    if (!rows.length) return emptyHtml('No matching connections');

    const body = rows
      .map(
        (c) =>
          '<tr class="' + (c.status === 'unresolved' ? 'row-warn' : '') + '">' +
          '<td class="cell-comp">' + compLink(c.providerComponent) + '</td>' +
          '<td>' + dirBadge(c.providerDirection) + ' <code>' + esc(c.providerPort) + '</code></td>' +
          '<td class="itf">' + esc(c.providerInterface || '—') + '</td>' +
          '<td class="arrow">→</td>' +
          '<td class="cell-comp">' + compLink(c.requesterComponent) + '</td>' +
          '<td>' + dirBadge(c.requesterDirection) + ' <code>' + esc(c.requesterPort) + '</code></td>' +
          '<td class="itf">' + esc(c.requesterInterface || '—') + '</td>' +
          '<td>' + (c.kind === 'delegate' ? badge('Delegation', 'b-delegate') : badge('Assembly', 'b-assembly')) + '</td>' +
          '<td class="de">' + esc(c.dataElements || '—') + '</td>' +
          '<td class="comp-cell">' + esc(c.composition || '—') + '</td>' +
          '<td class="file-cell">' + fileLink(c.sourceFile) + '</td>' +
          '<td><button class="copy" data-copy="' + esc(c.providerPath + ' -> ' + c.requesterPath) + '">Copy</button></td>' +
          '</tr>'
      )
      .join('');

    return (
      '<div class="table-wrap"><table class="grid">' +
      '<thead><tr>' +
      th('Provider SWC', 'connections', 'providerComponent') +
      th('Provider Port', 'connections', 'providerPort') +
      th('Interface', 'connections', 'providerInterface') +
      '<th class="arrow"></th>' +
      th('Requester SWC', 'connections', 'requesterComponent') +
      th('Requester Port', 'connections', 'requesterPort') +
      th('Interface', 'connections', 'requesterInterface') +
      th('Type', 'connections', 'kind') +
      th('Data elements', 'connections', 'dataElements') +
      th('Composition', 'connections', 'composition') +
      th('File', 'connections', 'sourceFile') +
      '<th></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="table-foot">' + rows.length + ' connections</div>'
    );
  }

  function portsHtml() {
    let rows = DATA.ports.filter((p) => {
      if (!belongsTo(p)) return false;
      if (!state.showUnconnected && p.status !== 'connected') return false;
      return matchRow([p.swc, p.port, p.interfaceName, p.connectedTo, p.dataElements].join(' '));
    });
    rows = sortRows(rows, 'ports', (r, k) => r[k]);
    if (!rows.length) return emptyHtml('No matching ports');

    const body = rows
      .map(
        (p) =>
          '<tr class="' + (p.status === 'unconnected' ? 'row-warn' : p.status === 'unresolved' ? 'row-dim' : '') + '">' +
          '<td class="cell-comp">' + compLink(p.swc) + '<div class="sub">' + baseName(p.sourceFile) + '</div></td>' +
          '<td><code>' + esc(p.port) + '</code></td>' +
          '<td>' + dirBadge(p.direction) + ' ' + esc(p.direction) + '</td>' +
          '<td class="itf">' + esc(p.interfaceName) + '</td>' +
          '<td class="de">' + esc(p.dataElements || '—') + '</td>' +
          '<td class="links">' + (p.connectedTo ? esc(p.connectedTo) : '<span class="muted">—</span>') + '</td>' +
          '<td>' +
          (p.status === 'connected' ? badge('Connected', 'b-ok') : p.status === 'unconnected' ? badge('Unconnected', 'b-warn') : badge('Unresolved', 'b-neutral')) +
          '</td>' +
          '</tr>'
      )
      .join('');

    return (
      '<div class="table-wrap"><table class="grid">' +
      '<thead><tr>' +
      th('SWC', 'ports', 'swc') +
      th('Port', 'ports', 'port') +
      th('Direction', 'ports', 'direction') +
      th('Interface', 'ports', 'interfaceName') +
      th('Data elements', 'ports', 'dataElements') +
      '<th>Connected to</th>' +
      th('Status', 'ports', 'status') +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="table-foot">' + rows.length + ' ports</div>'
    );
  }

  function swcsHtml() {
    let rows = DATA.swcs.filter((s) => matchRow([s.name, s.type, s.packagePath].join(' ')));
    rows = sortRows(rows, 'swcs', (r, k) => r[k]);
    if (!rows.length) return emptyHtml('No matching SWCs');

    const body = rows
      .map(
        (s) =>
          '<tr>' +
          '<td class="cell-comp">' + compLink(s.name) + '</td>' +
          '<td><span class="type">' + esc(s.type.replace(/-SW-COMPONENT-TYPE$/, '').replace(/-/g, ' ')) + '</span></td>' +
          '<td class="pkg">' + esc(s.packagePath) + '<div class="sub">' + baseName(s.sourceFile) + '</div></td>' +
          '<td class="num">' + s.providers + '</td>' +
          '<td class="num">' + s.requirers + '</td>' +
          '<td class="num">' + (s.connections || 0) + '</td>' +
          '</tr>'
      )
      .join('');

    return (
      '<div class="table-wrap"><table class="grid">' +
      '<thead><tr>' +
      th('SWC', 'swcs', 'name') +
      th('Type', 'swcs', 'type') +
      th('Package', 'swcs', 'packagePath') +
      th('P ports', 'swcs', 'providers', 'num') +
      th('R ports', 'swcs', 'requirers', 'num') +
      th('Connections', 'swcs', 'connections', 'num') +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="table-foot">' + rows.length + ' components</div>'
    );
  }

  /* ---- SWC detail page ---------------------------------------------- */

  /**
   * Per-component drill-down: the connections of one SWC and its runnables
   * live on separate sub-tabs so neither table drowns the other.
   */
  function swcDetailHtml(name) {
    const swc = DATA.swcs.filter((s) => s.name === name)[0];
    const conns = DATA.connections.filter(involving);
    const runns = (DATA.runnables || []).filter(belongsTo);
    const orphans = runns.filter((r) => r.status === 'orphan').length;

    const typeText = swc ? swc.type.replace(/-SW-COMPONENT-TYPE$/, '').replace(/-/g, ' ') : '';
    const sub = [
      ['Connections', conns.length],
      ['Runnables', runns.length],
      ['P ports', swc ? swc.providers : 0],
      ['R ports', swc ? swc.requirers : 0],
    ];

    const subTabs =
      '<nav class="subtabs">' +
      [['connections', 'Connections', conns.length], ['runnables', 'Runnables', runns.length]]
        .map(
          (t) =>
            '<button class="subtab' + (state.detailTab === t[0] ? ' active' : '') + '" data-detail-tab="' + t[0] + '">' +
            esc(t[1]) + '<span class="count">' + t[2] + '</span></button>'
        )
        .join('') +
      '</nav>';

    const head =
      '<div class="detail-head">' +
      '<div class="detail-title">' +
      '<button class="back" id="btn-back" title="Back to the SWC list">‹ SWCs</button>' +
      '<span class="comp detail-name">' + esc(name) + '</span>' +
      (typeText ? '<span class="type">' + esc(typeText) + '</span>' : '') +
      '</div>' +
      (swc ? '<div class="detail-path">' + esc(swc.packagePath) + (swc.sourceFile ? ' · ' + fileLink(swc.sourceFile) : '') + '</div>' : '') +
      '<div class="detail-sub">' +
      sub
        .map((x) => '<span class="chip">' + esc(x[0]) + ' <b>' + esc(x[1]) + '</b></span>')
        .join('') +
      (orphans ? '<span class="chip warn">Without trigger <b>' + orphans + '</b></span>' : '') +
      '</div>' +
      '</div>';

    const body =
      state.detailTab === 'runnables'
        ? runnablesHtml('All runnables of this component are shown')
        : conns.length
          ? connectionsHtml()
          : emptyHtml('This component has no connections');

    return head + subTabs + '<div class="detail-body">' + body + '</div>';
  }

  function bindDetail() {
    const back = $('#btn-back');
    if (back) {
      back.onclick = () => {
        state.detail = null;
        render();
      };
    }
    document.querySelectorAll('[data-detail-tab]').forEach((btn) => {
      btn.onclick = () => {
        state.detailTab = btn.getAttribute('data-detail-tab');
        renderPanel();
      };
    });
  }

  function openDetail(name) {
    state.detail = name;
    state.detailTab = 'connections';
    state.query = '';
    const search = $('#search');
    if (search) search.value = '';
    render();
  }

  /** Makes the SWC name in a table a link into its detail page. */
  function compLink(name) {
    return '<a href="#" class="comp-link" data-swc="' + esc(name) + '">' + esc(name) + '</a>';
  }

  /* ---- interfaces --------------------------------------------------- */

  function kindBadge(kind) {
    if (kind === 'S/R') return badge('S/R', 'b-sr');
    if (kind === 'C/S') return badge('C/S', 'b-cs');
    return badge(kind || '?', 'b-neutral');
  }

  /* ---- runnables ---------------------------------------------------- */

  function trigBadge(kind) {
    const map = {
      TimingEvent: ['Timing', 'b-timing'],
      DataReceivedEvent: ['Data recv', 'b-data'],
      DataSendComplete: ['Send done', 'b-data'],
      OperationInvokedEvent: ['Op invoked', 'b-op'],
      ModeSwitchEvent: ['Mode switch', 'b-mode'],
      InitEvent: ['Init', 'b-init'],
      BackgroundEvent: ['Background', 'b-neutral'],
      ExternalTrigger: ['Ext trigger', 'b-mode'],
      Asynchronous: ['Async', 'b-neutral'],
    };
    const m = map[kind];
    return m ? badge(m[0], m[1]) : badge(kind, 'b-neutral');
  }

  function runnablesHtml(emptyHint) {
    const all = (DATA.runnables || []).filter(belongsTo);
    let rows = all.filter(
      (r) => belongsTo(r) && matchRow([r.swc, r.name, r.runsOn, r.triggerKinds, r.triggers, r.ports, r.symbols].join(' '))
    );
    rows = sortRows(rows, 'runnables', (r, k) => r[k]);
    if (!rows.length) {
      return emptyHtml(
        all.length
          ? 'No matching runnables'
          : emptyHint ||
              'No runnables found (component has no SWC-INTERNAL-BEHAVIOR or declares no RUNNABLE-ENTITY)'
      );
    }

    const body = rows
      .map(
        (r) =>
          '<tr class="' + (r.status === 'orphan' ? 'row-warn' : '') + '">' +
          '<td class="cell-comp"><span class="comp">' + esc(r.name) + '</span>' +
          '<div class="sub">' + compLink(r.swc) + '</div></td>' +
          '<td class="trig">' +
          (r.triggers
            ? r.kinds.map(trigBadge).join(' ') +
              '<div class="trig-detail">' + esc(r.triggers) + '</div>'
            : badge('No trigger', 'b-warn') + '<div class="trig-detail muted">Not activated by any RTE event, never runs</div>') +
          '</td>' +
          '<td>' + (r.canEnter === '' ? '<span class="muted">—</span>' : badge(r.canEnter === 'yes' ? 'Yes' : 'No', r.canEnter === 'yes' ? 'b-ok' : 'b-warn')) + '</td>' +
          '<td><span class="type">' + esc(r.runsOn) + '</span></td>' +
          '<td class="interval">' + (r.interval ? '<code>' + esc(r.interval) + '</code>' : '<span class="muted">—</span>') + '</td>' +
          '<td class="ports">' + (r.ports ? esc(r.ports) : '<span class="muted">—</span>') + '</td>' +
          '<td class="symbols">' + (r.symbols ? '<code>' + esc(r.symbols) + '</code>' : '<span class="muted">—</span>') + '</td>' +
          '</tr>'
      )
      .join('');

    const kindCount = {};
    all.forEach((r) => r.kinds.forEach((k) => (kindCount[k] = (kindCount[k] || 0) + 1)));
    const summary = Object.keys(kindCount)
      .map((k) => trigBadge(k) + ' ' + kindCount[k])
      .join(' · ');
    const orphans = all.filter((r) => r.status === 'orphan').length;

    return (
      '<div class="table-wrap"><table class="grid">' +
      '<thead><tr>' +
      th('Runnable', 'runnables', 'name') +
      th('Trigger', 'runnables', 'triggers') +
      th('Can Enter', 'runnables', 'canEnter') +
      th('Runs On', 'runnables', 'runsOn') +
      th('Period', 'runnables', 'interval') +
      th('Trigger port', 'runnables', 'ports') +
      th('Symbol', 'runnables', 'symbols') +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="table-foot">' + rows.length + ' runnables' +
      (orphans ? ' · <span class="warn-text">' + orphans + ' without trigger</span>' : '') +
      (summary ? ' · ' + summary : '') + '</div>'
    );
  }

  function interfacesHtml() {
    const all = DATA.interfaces || [];
    let rows = all.filter((i) =>
      matchRow([i.name, i.path, i.category, i.members, i.types, i.usedBy].join(' '))
    );
    rows = sortRows(rows, 'interfaces', (r, k) => (k === 'usedBy' ? r.usedByCount : r[k]));
    if (!rows.length) return emptyHtml(all.length ? 'No matching interfaces' : 'No interface definitions found');

    const body = rows
      .map(
        (i) =>
          '<tr class="' + (i.usedByCount === 0 ? 'row-dim' : '') + '">' +
          '<td class="cell-comp"><span class="comp">' + esc(i.name) + '</span>' +
          (i.isService ? ' ' + badge('Service', 'b-service') : '') +
          '<div class="sub">' + esc(i.path) + '</div></td>' +
          '<td>' + kindBadge(i.kind) + '</td>' +
          '<td class="members">' + (i.members ? esc(i.members) : '<span class="muted">—</span>') + '</td>' +
          '<td class="types">' + (i.types ? typePills(i.types) : '<span class="muted">—</span>') + '</td>' +
          '<td class="links">' + (i.usedBy ? esc(i.usedBy) : '<span class="muted">Unused</span>') + '</td>' +
          '<td class="num">' + i.usedByCount + '</td>' +
          '<td><button class="copy" data-copy="' + esc(i.path) + '">Copy path</button></td>' +
          '</tr>'
      )
      .join('');

    return (
      '<div class="table-wrap"><table class="grid">' +
      '<thead><tr>' +
      th('Interface', 'interfaces', 'name') +
      th('Kind', 'interfaces', 'kind') +
      th('Elements / operations', 'interfaces', 'members') +
      th('Element types', 'interfaces', 'types') +
      th('Used by (SWC.port)', 'interfaces', 'usedBy') +
      th('Refs', 'interfaces', 'usedByCount', 'num') +
      '<th></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="table-foot">' + rows.length + ' interfaces' +
      (all.length !== rows.length ? ' (' + all.length + ' total)' : '') + '</div>'
    );
  }

  /** Renders "Speed: VehicleSpeed_T [APDT]; Gear: Gear_T [Record]" as pills. */
  function typePills(text) {
    const parts = String(text).split('; ').filter(Boolean);
    if (parts.length > 6) {
      return esc(parts.slice(0, 6).join('; ')) + ' <span class="muted">+ ' + (parts.length - 6) + '</span>';
    }
    return parts
      .map(function (p) {
        const idx = p.indexOf(': ');
        if (idx < 0) {
          // operation signature: keep as-is
          return '<span class="pill">' + esc(p) + '</span>';
        }
        const name = p.slice(0, idx);
        const type = p.slice(idx + 2);
        return '<span class="pill"><b>' + esc(name) + '</b> ' + esc(type) + '</span>';
      })
      .join('');
  }

  /* ---- data types --------------------------------------------------- */

  function dtBadge(kind) {
    const cls =
      kind === 'APDT' ? 'b-apdt' : kind === 'Record' ? 'b-record' : kind === 'Array' ? 'b-array' : kind === 'IDT' ? 'b-idt' : 'b-neutral';
    return badge(kind, cls);
  }

  function dataTypesHtml() {
    const all = DATA.dataTypes || [];
    let rows = all.filter((d) => matchRow([d.name, d.path, d.kind, d.category, d.baseType, d.unit, d.members, d.usedByInterfaces].join(' ')));
    rows = sortRows(rows, 'dataTypes', (r, k) => r[k]);
    if (!rows.length) return emptyHtml(all.length ? 'No matching data types' : 'No data type definitions found');

    const body = rows
      .map(
        (d) =>
          '<tr>' +
          '<td class="cell-comp"><span class="comp">' + esc(d.name) + '</span>' +
          '<div class="sub">' + esc(d.path) + '</div></td>' +
          '<td>' + dtBadge(d.kind) + (d.category ? ' <span class="muted">' + esc(d.category) + '</span>' : '') + '</td>' +
          '<td class="base">' + (d.baseType ? '<code>' + esc(d.baseType) + '</code>' : '<span class="muted">—</span>') + '</td>' +
          '<td class="members">' + (d.members ? esc(d.members) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + (d.unit ? esc(d.unit) : '<span class="muted">—</span>') + '</td>' +
          '<td class="range">' + (d.range ? '<code>' + esc(d.range) + '</code>' : '<span class="muted">—</span>') + '</td>' +
          '<td class="itf">' + (d.usedByInterfaces ? esc(d.usedByInterfaces) : '<span class="muted">Unreferenced</span>') + '</td>' +
          '</tr>'
      )
      .join('');

    const counts = { APDT: 0, IDT: 0, Record: 0, Array: 0 };
    all.forEach((d) => {
      if (counts[d.kind] != null) counts[d.kind]++;
    });
    const summary = Object.keys(counts)
      .filter((k) => counts[k] > 0)
      .map((k) => k + ' ' + counts[k])
      .join(' · ');

    return (
      '<div class="table-wrap"><table class="grid">' +
      '<thead><tr>' +
      th('Data type', 'dataTypes', 'name') +
      th('Kind', 'dataTypes', 'kind') +
      th('Base type', 'dataTypes', 'baseType') +
      th('Members / element type', 'dataTypes', 'members') +
      th('Unit', 'dataTypes', 'unit') +
      th('Range', 'dataTypes', 'range') +
      th('Used by interfaces', 'dataTypes', 'usedByInterfaces') +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="table-foot">' + rows.length + ' data types' + (summary ? ' (' + esc(summary) + ')' : '') + '</div>'
    );
  }

  function matrixHtml() {
    const m = DATA.matrix;
    if (!m || !m.components.length) return emptyHtml('No component connections to display');

    const idx = {};
    m.components.forEach((c, i) => (idx[c] = i));
    const grid = m.components.map(() => m.components.map(() => []));
    m.cells.forEach((cell) => {
      const r = idx[cell.from];
      const c = idx[cell.to];
      if (r != null && c != null) grid[r][c] = cell.links;
    });

    const head = '<tr><th class="corner">Provider \\ Requester</th>' + m.components.map((c) => '<th class="rot"><span>' + esc(c) + '</span></th>').join('') + '</tr>';
    const body = m.components
      .map((from, r) => {
        let row = '<tr><th class="rowhead">' + esc(from) + '</th>';
        for (let c = 0; c < m.components.length; c++) {
          const links = grid[r][c];
          if (links.length) {
            row += '<td class="hit" title="' + esc(links.join('\n')) + '">' + links.length + '</td>';
          } else {
            row += '<td class="miss">' + (r === c ? '·' : '') + '</td>';
          }
        }
        return row + '</tr>';
      })
      .join('');

    return (
      '<div class="matrix-wrap"><table class="matrix">' + head + body + '</table></div>' +
      '<div class="table-foot">Rows = provider, columns = requester. Numbers are connection counts; hover to see the port mapping</div>'
    );
  }

  function baseName(p) {
    if (!p) return '';
    return String(p).split(/[\\/]/).pop();
  }

  function fileLink(p) {
    if (!p) return '<span class="muted">—</span>';
    return '<a href="#" class="file-link" data-file="' + esc(p) + '" title="' + esc(p) + '">' + esc(baseName(p)) + '</a>';
  }

  function filesHtml() {
    const rows = DATA.files || [];
    if (!rows.length) return emptyHtml('No file information');
    const body = rows
      .map(
        (f) =>
          '<tr class="' + (f.error ? 'row-warn' : '') + '">' +
          '<td class="cell-comp">' + fileLink(f.path) + '</td>' +
          '<td class="pkg">' + esc(f.schemaVersion || '—') + '</td>' +
          '<td class="num">' + f.swcCount + '</td>' +
          '<td class="num">' + f.portCount + '</td>' +
          '<td class="num">' + f.connectorCount + '</td>' +
          '<td class="num">' + f.interfaceCount + '</td>' +
          '<td class="num">' + f.elements + '</td>' +
          '<td class="num">' + f.elapsedMs + '</td>' +
          '<td class="err">' + esc(f.error || '') + '</td>' +
          '</tr>'
      )
      .join('');
    return (
      '<div class="table-wrap"><table class="grid">' +
      '<thead><tr><th>File</th><th>Schema</th><th class="num">SWC</th><th class="num">Ports</th>' +
      '<th class="num">Conns</th><th class="num">Interfaces</th><th class="num">Elements</th><th class="num">ms</th><th>Error</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>' +
      '<div class="table-foot">' + rows.length + ' files parsed</div>'
    );
  }

  function issuesHtml() {
    const rows = DATA.issues || [];
    if (!rows.length) return emptyHtml('No issues found ✓');
    const order = { error: 0, warning: 1, info: 2 };
    const sorted = rows.slice().sort((a, b) => (order[a.severity] || 3) - (order[b.severity] || 3));
    const body = sorted
      .map(
        (i) =>
          '<tr>' +
          '<td>' + sevBadge(i.severity) + '</td>' +
          '<td class="code">' + esc(i.code) + '</td>' +
          '<td class="msg">' + esc(i.message) + '</td>' +
          '<td class="files">' + (i.files || []).map(fileLink).join('<br/>') + '</td>' +
          '</tr>'
      )
      .join('');
    return (
      '<div class="table-wrap"><table class="grid">' +
      '<thead><tr><th>Severity</th><th>Code</th><th>Message</th><th>Files</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>' +
      '<div class="table-foot">' + rows.length + ' issues</div>'
    );
  }

  function sevBadge(sev) {
    if (sev === 'error') return badge('Error', 'b-error');
    if (sev === 'warning') return badge('Warning', 'b-warn');
    return badge('Info', 'b-neutral');
  }

  function emptyHtml(msg) {
    return '<div class="empty">' + esc(msg) + '</div>';
  }

  function bindTable() {
    document.querySelectorAll('th.sortable').forEach((el) => {
      el.onclick = () => {
        const table = el.getAttribute('data-table');
        const key = el.getAttribute('data-key');
        const cur = state.sort[table] || { key: '', dir: 1 };
        state.sort[table] = { key, dir: cur.key === key ? -cur.dir : 1 };
        renderPanel();
      };
    });
    document.querySelectorAll('a.file-link').forEach((el) => {
      el.onclick = (ev) => {
        ev.preventDefault();
        vs.postMessage({ type: 'openFile', path: el.getAttribute('data-file') });
      };
    });
    document.querySelectorAll('button.copy').forEach((el) => {
      el.onclick = () => vs.postMessage({ type: 'copy', text: el.getAttribute('data-copy') });
    });
    document.querySelectorAll('a.comp-link').forEach((el) => {
      el.onclick = (ev) => {
        ev.preventDefault();
        openDetail(el.getAttribute('data-swc'));
      };
    });
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'update' || !e.data.data) return;
    // swap the payload in place and re-render without losing the active tab
    const fresh = e.data.data;
    Object.keys(DATA).forEach((k) => delete DATA[k]);
    Object.assign(DATA, fresh);
    if (e.data.scope) state.scope = e.data.scope;
    render();
  });

  render();
})();
