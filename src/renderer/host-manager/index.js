const api = window.desktopHosts;
const $ = s => document.querySelector(s);

// Elements
const sidebar = $('#sidebar');
const dragHandle = $('#drag-handle');
const hostList = $('#host-list');
const progressBar = $('#progress-bar');
const progressBarText = $('#progress-bar-text');
const webviewContainer = $('#webview-container');
const webviewPlaceholder = $('#webview-placeholder');
const addDialog = $('#add-dialog');
const configDialog = $('#config-dialog');

// Config dialog fields
const cfgName = $('#cfg-name');
const cfgIcon = $('#cfg-icon');
const cfgHost = $('#cfg-host');
const cfgUsername = $('#cfg-username');
const cfgSshPort = $('#cfg-ssh-port');
const cfgIdentityFile = $('#cfg-identity-file');
const cfgHostKeyPolicy = $('#cfg-host-key-policy');
const cfgSsh = $('#cfg-ssh');
const cfgSshPolicy = $('#cfg-ssh-policy');
const cfgStartup = $('#cfg-startup');
const cfgAutoStart = $('#cfg-auto-start');
const cfgAutoStop = $('#cfg-auto-stop');
const cfgAutoInstall = $('#cfg-auto-install');

let hosts = [];
let selectedHostId = null;
let snapshots = {};
let busy = false;
let refreshGeneration = 0;
// Map<hostId, webview>
const webviews = new Map();

// --- Context menu ---

let contextMenu = null;

function createContextMenu() {
  if (contextMenu) return;
  contextMenu = document.createElement('div');
  contextMenu.id = 'context-menu';
  contextMenu.className = 'context-menu';
  document.body.appendChild(contextMenu);
}

function showContextMenu(hostId, x, y) {
  createContextMenu();
  const host = hosts.find(h => h.id === hostId);
  const snap = host ? (snapshots[host.id] || { state: 'idle' }) : { state: 'idle' };
  const isConnected = snap.state === 'connected';
  const isTransferring = snap.progress?.phase === 'remote-transferring';
  const isConnecting = snap.state === 'connecting' || isTransferring;
  const isRemote = host?.type === 'remote';

  const items = [];

  // Connect / Disconnect
  if (isConnected) {
    items.push({ label: '断开', action: () => doAction(async () => { await api.disconnect(hostId); await refresh(); }) });
  } else if (!isConnecting) {
    items.push({ label: '连接', action: () => doAction(async () => {
      const snap = await api.connect(hostId);
      if (snap.state === 'connected' && snap.endpoint) {
        getOrCreateWebview(hostId, snap.endpoint);
        showWebview(hostId);
      }
      await refresh();
    }) });
  }

  // Remote-specific actions
  if (isRemote) {
    if (snap.remoteDsh?.running) {
      items.push({ label: '停止远程 DSH', action: () => doAction(async () => {
        if (!confirm('确定要停止远程 DSH 吗？SSH 隧道也会断开。')) return;
        await api.stopRemoteDsh(hostId);
        await refresh();
      }) });
    }
    items.push({ label: '重启远程 DSH', action: () => doAction(async () => {
      await api.restartRemoteDsh(hostId);
      await refresh();
    }) });
  }

  // Retry (on error)
  if (snap.state === 'error') {
    items.push({ label: '重试', action: () => doAction(async () => {
      const snap = await api.connect(hostId);
      if (snap.state === 'connected' && snap.endpoint) {
        getOrCreateWebview(hostId, snap.endpoint);
        showWebview(hostId);
      }
      await refresh();
    }) });
  }

  // Update
  if (isConnected && snap.needsUpdate) {
    items.push({ label: '更新远程 DSH', action: () => doAction(async () => {
      if (!confirm('确定要更新远程 DSH 吗？更新过程中连接会暂时中断。')) return;
      try { await api.updateRemoteDsh(hostId); } catch (error) { console.error('Failed to update remote DSH:', error); }
      await refresh();
    }) });
  }

  // Separator
  if (items.length > 0) items.push({ separator: true });

  // Config
  items.push({ label: '编辑配置', action: () => openConfigDialog(hostId) });

  // Refresh
  items.push({ label: '刷新', action: () => refresh() });

  // Delete (remote only)
  if (isRemote) {
    items.push({ separator: true });
    items.push({ label: '删除 Host', danger: true, action: () => doAction(async () => {
      if (!confirm('确定要删除这个 Host 吗？')) return;
      await api.deleteHost(hostId);
      destroyWebview(hostId);
      hosts = hosts.filter(h => h.id !== hostId);
      if (selectedHostId === hostId) selectedHostId = null;
      renderHostList();
      renderProgress();
      showWebview(null);
    }) });
  }

  // Build menu HTML
  contextMenu.innerHTML = items.map(item => {
    if (item.separator) return '<div class="context-menu-separator"></div>';
    const cls = item.danger ? 'context-menu-item danger' : 'context-menu-item';
    return `<div class="${cls}" data-action="${item.label}">${item.label}</div>`;
  }).join('');

  // Position menu
  const menuWidth = 180;
  const menuHeight = items.length * 32 + (items.filter(i => i.separator).length * 5);
  let left = x;
  let top = y;
  if (left + menuWidth > window.innerWidth) left = window.innerWidth - menuWidth - 8;
  if (top + menuHeight > window.innerHeight) top = window.innerHeight - menuHeight - 8;
  contextMenu.style.left = `${left}px`;
  contextMenu.style.top = `${top}px`;
  contextMenu.classList.add('visible');

  // Bind actions
  contextMenu.querySelectorAll('.context-menu-item').forEach(el => {
    el.addEventListener('click', () => {
      const item = items.find(i => i.label === el.dataset.action);
      if (item?.action) item.action();
      hideContextMenu();
    });
  });
}

function hideContextMenu() {
  if (contextMenu) contextMenu.classList.remove('visible');
}

document.addEventListener('click', e => {
  if (contextMenu && !contextMenu.contains(e.target)) hideContextMenu();
});

// --- Webview management ---

function getOrCreateWebview(hostId, endpoint) {
  let wv = webviews.get(hostId);
  if (wv) {
    if (wv.getAttribute('src') !== endpoint) {
      console.log(`[webview] ${hostId}: switching src to ${endpoint}`);
      wv.setAttribute('src', endpoint);
    }
    return wv;
  }

  console.log(`[webview] ${hostId}: creating webview for ${endpoint}`);
  wv = document.createElement('webview');
  wv.id = `webview-${hostId}`;
  wv.setAttribute('src', endpoint);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('partition', `persist:dsh-${hostId}`);
  wv.style.cssText = 'display:none;';

  wv.addEventListener('did-start-loading', () => console.log(`[webview] ${hostId}: started loading`));
  wv.addEventListener('did-stop-loading', () => console.log(`[webview] ${hostId}: stopped loading`));
  wv.addEventListener('did-navigate', (e) => console.log(`[webview] ${hostId}: navigated to ${e.url}`));
  wv.addEventListener('did-navigate-in-page', (e) => console.log(`[webview] ${hostId}: in-page nav to ${e.url}`));
  wv.addEventListener('did-fail-load', (e) => console.error(`[webview] ${hostId}: FAILED ${e.errorCode} ${e.errorDescription} for ${e.validatedURL}`));
  wv.addEventListener('console-message', (e) => console.log(`[webview] ${hostId}: console[${e.level}] ${e.message}`));
  wv.addEventListener('page-title-updated', (e) => console.log(`[webview] ${hostId}: title = ${e.title}`));

  wv.addEventListener('dom-ready', () => {
    console.log(`[webview] ${hostId}: dom-ready`);
    wv.insertCSS('html,body,#root{height:100%;margin:0;padding:0}');
  });

  webviewContainer.appendChild(wv);
  webviews.set(hostId, wv);
  return wv;
}

function destroyWebview(hostId) {
  const wv = webviews.get(hostId);
  if (wv) {
    wv.remove();
    webviews.delete(hostId);
  }
}

function reconcileWebviews() {
  const validHostIds = new Set(hosts.map(host => host.id));
  for (const [hostId] of webviews) {
    const snap = snapshots[hostId];
    if (!validHostIds.has(hostId) || snap?.state !== 'connected' || !snap.endpoint) destroyWebview(hostId);
  }
  for (const snap of Object.values(snapshots)) {
    if (snap.state === 'connected' && snap.endpoint) getOrCreateWebview(snap.hostId, snap.endpoint);
  }
}

function showWebview(hostId) {
  let visible = false;
  for (const [id, wv] of webviews) {
    const show = id === hostId;
    wv.style.display = show ? 'flex' : 'none';
    visible ||= show;
  }
  webviewPlaceholder.hidden = visible;
}

// --- Render ---

function renderHostList() {
  hostList.innerHTML = '';
  for (const host of hosts) {
    const snap = snapshots[host.id] || { state: 'idle' };
    const li = document.createElement('li');
    li.className = `host-item${selectedHostId === host.id ? ' active' : ''}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(selectedHostId === host.id));
    li.innerHTML = `
      <span class="host-item-emoji">${esc(host.icon || '🖥️')}</span>
      <div class="host-item-info">
        <div class="host-item-name">${esc(host.name)}</div>
        <div class="host-item-meta">${stateLabel(snap)}${snap.endpoint ? ' · ' + new URL(snap.endpoint).port : ''}</div>
      </div>
      <span class="host-item-dot ${snap.state}"></span>
      <span class="host-item-tooltip">${esc(host.name)} · ${stateLabel(snap)}</span>
    `;
    li.addEventListener('click', () => selectHost(host.id));
    li.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(host.id, e.clientX, e.clientY);
    });
    hostList.appendChild(li);
  }
}

function renderProgress() {
  const host = hosts.find(h => h.id === selectedHostId);
  const snap = host ? (snapshots[host.id] || { state: 'idle' }) : { state: 'idle' };
  const isTransferring = snap.progress?.phase === 'remote-transferring';

  if (isTransferring) {
    progressBar.hidden = false;
    progressBarText.textContent = snap.progress?.message || '正在传输 DSH...';
  } else {
    progressBar.hidden = true;
  }
}

function stateLabel(snap) {
  if (snap.progress?.message) return snap.progress.message;
  const labels = { idle: '未连接', connecting: '连接中...', connected: '已连接', error: '错误' };
  return labels[snap.state] || snap.state;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// --- Actions ---

function selectHost(hostId) {
  selectedHostId = hostId;
  void api.setActiveHost(hostId).catch(error => console.error('Failed to select active host:', error));
  renderHostList();
  renderProgress();
  showWebview(hostId);
}

async function refresh() {
  const generation = ++refreshGeneration;
  try {
    const state = await api.getState();
    if (generation !== refreshGeneration) return;
    hosts = state.hosts;
    const nextSnapshots = { ...snapshots };
    for (const s of state.snapshots) {
      const current = nextSnapshots[s.hostId];
      if (!current || (s.revision ?? 0) >= (current.revision ?? 0)) nextSnapshots[s.hostId] = s;
    }
    snapshots = nextSnapshots;
    if (!selectedHostId && hosts.length > 0) {
      selectedHostId = hosts[0].id;
      void api.setActiveHost(selectedHostId).catch(error => console.error('Failed to select active host:', error));
    }
    reconcileWebviews();
    renderHostList();
    renderProgress();
    showWebview(selectedHostId);
  } catch (error) {
    console.error('Failed to refresh:', error);
  }
}

async function doAction(action) {
  if (busy) return;
  busy = true;
  try { await action(); } catch (error) {
    console.error(error);
  } finally { busy = false; }
}

// --- Config dialog ---

function openConfigDialog(hostId) {
  // Ensure the correct host is selected for save to work
  selectedHostId = hostId;
  const host = hosts.find(h => h.id === hostId);
  if (!host) return;
  const isRemote = host.type === 'remote';
  cfgIcon.textContent = host.icon || '🖥️';
  cfgName.value = host.name || '';
  cfgSsh.hidden = !isRemote;
  cfgSshPolicy.hidden = !isRemote;
  cfgStartup.hidden = !isRemote;
  $('#delete-config-btn').hidden = !isRemote;
  if (isRemote) {
    cfgHost.value = host.host || '';
    cfgUsername.value = host.username || '';
    cfgSshPort.value = host.sshPort || 22;
    cfgIdentityFile.value = host.identityFile || '';
    cfgHostKeyPolicy.value = host.hostKeyPolicy || 'accept-new';
    cfgAutoStart.checked = host.autoStartRemoteDsh ?? true;
    cfgAutoStop.checked = host.autoStopRemoteDsh ?? true;
    cfgAutoInstall.checked = host.autoInstallRemoteDsh ?? true;
  }
  configDialog.showModal();
}

$('#save-config-btn').addEventListener('click', () => doAction(async () => {
  const host = hosts.find(h => h.id === selectedHostId);
  if (!host) return;
  const updated = { ...host, name: cfgName.value.trim() || host.name, icon: cfgIcon.textContent.trim() || host.icon };
  delete updated.localPort;
  if (host.type === 'remote') {
    updated.host = cfgHost.value.trim();
    updated.username = cfgUsername.value.trim();
    updated.sshPort = Number(cfgSshPort.value) || 22;
    updated.identityFile = cfgIdentityFile.value.trim() || null;
    updated.hostKeyPolicy = cfgHostKeyPolicy.value;
    updated.autoStartRemoteDsh = cfgAutoStart.checked;
    updated.autoStopRemoteDsh = cfgAutoStop.checked;
    updated.autoInstallRemoteDsh = cfgAutoInstall.checked;
  }
  await api.updateHost(updated);
  // Update local state directly instead of full refresh
  Object.assign(host, updated);
  configDialog.close();
  renderHostList();
  renderProgress();
}));

$('#delete-config-btn').addEventListener('click', () => doAction(async () => {
  const host = hosts.find(h => h.id === selectedHostId);
  if (!host) return;
  if (host.type === 'local') return;
  if (!confirm('确定要删除这个 Host 吗？')) return;
  await api.deleteHost(selectedHostId);
  destroyWebview(selectedHostId);
  hosts = hosts.filter(h => h.id !== selectedHostId);
  selectedHostId = null;
  configDialog.close();
  renderHostList();
  renderProgress();
  showWebview(null);
}));

$('#cancel-config-btn').addEventListener('click', () => configDialog.close());

// Emoji picker (in config dialog)
const EMOJI_LIST = ['🖥️', '🖥', '🖳', '💻', '🖧', '🖴', '🖵', '🗄️', '🛠️', '📦', '🚀', '⚡', '🔧', '🔮', '🌐', '💡', '🦾', '🏠', '🌍', '📡', '🖥️', '⌨️', '🖱️', '🖲️', '🔌', '💾', '📀', '🔋', '🧠', '🤖', '🔥', '⭐', '🌀', '🎯', '🏗️', '📊', '🧩', '🪄', '✨', '🛡️'];

$('#cfg-icon-btn').addEventListener('click', () => {
  let picker = configDialog.querySelector('.emoji-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.className = 'emoji-picker';
    picker.innerHTML = EMOJI_LIST.map(e => `<span class="emoji-option" data-emoji="${e}">${e}</span>`).join('');
    picker.addEventListener('click', e => {
      const opt = e.target.closest('.emoji-option');
      if (!opt) return;
      cfgIcon.textContent = opt.dataset.emoji;
      picker.classList.remove('visible');
    });
    configDialog.appendChild(picker);
  }
  const rect = cfgIcon.getBoundingClientRect();
  picker.style.top = `${rect.bottom + 4}px`;
  picker.style.left = `${rect.left}px`;
  picker.classList.toggle('visible');
  setTimeout(() => {
    const closePicker = e => {
      if (!picker.contains(e.target)) {
        picker.classList.remove('visible');
        document.removeEventListener('click', closePicker);
      }
    };
    document.addEventListener('click', closePicker);
  }, 0);
});

// Add host dialog
$('#add-host-btn').addEventListener('click', () => addDialog.showModal());
$('#cancel-add-btn').addEventListener('click', () => addDialog.close());

addDialog.querySelectorAll('.add-option').forEach(btn => {
  btn.addEventListener('click', () => doAction(async () => {
    const type = btn.dataset.type;
    const name = type === 'local' ? '本机' : '新服务器';
    await api.addHost({ type, name });
    addDialog.close();
    await refresh();
    const state = await api.getState();
    const last = state.hosts[state.hosts.length - 1];
    if (last) selectHost(last.id);
  }));
});

// Status push
api.onStatus((hostId, snapshot) => {
  const current = snapshots[hostId];
  if (current && (snapshot.revision ?? 0) < (current.revision ?? 0)) return;
  snapshots[hostId] = snapshot;
  reconcileWebviews();
  renderHostList();
  if (hostId === selectedHostId) {
    renderProgress();
    showWebview(selectedHostId);
  }
});

api.onRefresh(() => refresh());

// Init
refresh();

// --- Sidebar drag + collapse ---

let sidebarWidth = 240;
const SIDEBAR_MIN = 44, SIDEBAR_MAX = 400;

function setSidebarWidth(w) {
  sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
  if (sidebarWidth <= SIDEBAR_MIN + 10) {
    sidebar.classList.add('collapsed');
    sidebar.classList.remove('hidden');
    sidebarWidth = SIDEBAR_MIN;
  } else {
    sidebar.classList.remove('collapsed', 'hidden');
  }
  sidebar.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
}

dragHandle.addEventListener('dblclick', () => {
  if (sidebar.classList.contains('collapsed') || sidebar.classList.contains('hidden')) {
    setSidebarWidth(240);
  } else {
    setSidebarWidth(SIDEBAR_MIN);
  }
});

let dragging = false;
dragHandle.addEventListener('mousedown', e => {
  dragging = true;
  sidebar.classList.add('dragging');
  dragHandle.classList.add('active');
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const rect = dragHandle.parentElement.getBoundingClientRect();
  setSidebarWidth(e.clientX - rect.left);
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  sidebar.classList.remove('dragging');
  dragHandle.classList.remove('active');
});

api.onToggleSidebar(() => {
  if (sidebar.classList.contains('hidden')) {
    setSidebarWidth(240);
  } else {
    sidebar.classList.add('hidden');
  }
});