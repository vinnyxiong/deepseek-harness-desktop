const api = window.desktopHosts;
const $ = s => document.querySelector(s);

// Elements
const tabBar = $('#tab-bar');
const tabList = $('#tab-list');
const progressBar = $('#progress-bar');
const progressBarText = $('#progress-bar-text');
const webviewContainer = $('#webview-container');
const webviewPlaceholder = $('#webview-placeholder');
const placeholderTitle = $('#placeholder-title');
const placeholderDesc = $('#placeholder-desc');
const placeholderError = $('#placeholder-error');
const placeholderErrorText = $('#placeholder-error-text');
const placeholderRetryBtn = $('#placeholder-retry-btn');
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
let refreshGeneration = 0;
// Map<hostId, webview>
const webviews = new Map();

// --- Platform setup ---

document.body.setAttribute('data-platform', api.platform);

// --- Window controls (Windows/Linux) ---

if (api.platform !== 'darwin') {
  const winControls = $('#window-controls');
  winControls.hidden = false;

  $('#minimize-btn').addEventListener('click', () => api.windowMinimize());
  $('#maximize-btn').addEventListener('click', () => api.windowMaximize());
  $('#close-btn').addEventListener('click', () => api.windowClose());

  api.onWindowState(state => {
    const btn = $('#maximize-btn');
    if (state.maximized) {
      btn.innerHTML = '&#x2752;'; // restore icon
      btn.title = '还原';
    } else {
      btn.innerHTML = '&#x25A1;'; // maximize icon
      btn.title = '最大化';
    }
  });

  // Double-click tab bar to maximize/restore (Windows/Linux)
  tabBar.addEventListener('dblclick', e => {
    if (e.target === tabBar) api.windowMaximize();
  });
}

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

  if (visible) {
    webviewPlaceholder.hidden = true;
    return;
  }

  // No webview visible — show placeholder
  webviewPlaceholder.hidden = false;
  placeholderError.hidden = true;

  // Remove any existing connect button
  const existingBtn = webviewPlaceholder.querySelector('.placeholder-connect-btn');
  if (existingBtn) existingBtn.remove();

  const host = hosts.find(h => h.id === hostId);
  const snap = host ? (snapshots[hostId] || { state: 'idle' }) : null;

  if (!hostId || !host) {
    placeholderTitle.textContent = '选择一个 Host';
    placeholderDesc.textContent = '点击上方标签页选择 Host 并连接';
  } else if (snap.state === 'error') {
    placeholderTitle.textContent = host.name;
    placeholderDesc.textContent = '连接失败';
    placeholderError.hidden = false;
    placeholderErrorText.textContent = snap.error || '未知错误';
    placeholderRetryBtn.onclick = () => doAction(async () => {
      const newSnap = await api.connect(hostId);
      if (newSnap.state === 'connected' && newSnap.endpoint) {
        getOrCreateWebview(hostId, newSnap.endpoint);
        showWebview(hostId);
      }
      await refresh();
    });
  } else if (snap.state === 'connecting') {
    placeholderTitle.textContent = host.name;
    placeholderDesc.textContent = snap.progress?.message || '连接中...';
  } else {
    placeholderTitle.textContent = host.name;
    placeholderDesc.textContent = '点击连接按钮开始连接';
    // Add a connect button
    const btn = document.createElement('button');
    btn.className = 'placeholder-connect-btn primary';
    btn.textContent = '连接';
    btn.addEventListener('click', () => doAction(async () => {
      const newSnap = await api.connect(hostId);
      if (newSnap.state === 'connected' && newSnap.endpoint) {
        getOrCreateWebview(hostId, newSnap.endpoint);
        showWebview(hostId);
      }
      await refresh();
    }));
    webviewPlaceholder.appendChild(btn);
  }
}

// --- Render Tab Bar ---

function renderTabBar() {
  tabList.innerHTML = '';
  for (const host of hosts) {
    const snap = snapshots[host.id] || { state: 'idle' };
    const tab = document.createElement('div');
    tab.className = `tab${selectedHostId === host.id ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(selectedHostId === host.id));
    tab.dataset.hostId = host.id;

    // Error tooltip
    if (snap.state === 'error' && snap.error) {
      tab.setAttribute('data-tooltip', snap.error);
    }

    const isRemote = host.type === 'remote';
    const needsUpdate = snap.needsUpdate && snap.state === 'connected';
    const isConnecting = snap.state === 'connecting';
    const progress = snap.progress;
    const showSpinner = isConnecting && progress?.phase !== 'connected';

    const icon = esc(host.icon || '🖥️');
    const name = esc(host.name);
    const statusCls = snap.state === 'connecting' && !showSpinner ? 'connecting' : snap.state;

    tab.innerHTML = `
      <span class="tab-icon">${icon}</span>
      <span class="tab-label">${name}</span>
      ${needsUpdate ? '<span class="tab-badge" title="远程 DSH 版本过旧"></span>' : ''}
      ${showSpinner ? '<span class="tab-spinner" title="正在连接..."></span>' : ''}
      <span class="tab-status-dot ${statusCls}"></span>
    `;

    // Click tab to select
    tab.addEventListener('click', e => {
      selectHost(host.id);
    });

    // Context menu
    tab.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(host.id, e.clientX, e.clientY);
    });

    tabList.appendChild(tab);
  }
}

function renderProgress() {
  const host = hosts.find(h => h.id === selectedHostId);
  const snap = host ? (snapshots[host.id] || { state: 'idle' }) : { state: 'idle' };
  const progress = snap.progress;

  // Show progress bar during any connection phase (except idle/connected/error)
  if (progress && progress.phase !== 'connected') {
    progressBar.hidden = false;
    progressBarText.textContent = progress.message || '正在处理...';
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
  renderTabBar();
  renderProgress();
  showWebview(hostId);
}

async function deleteHost(hostId) {
  const host = hosts.find(h => h.id === hostId);
  if (!host) return;
  if (hosts.length <= 1) return;
  if (!confirm(`确定要删除 ${host.name} 吗？`)) return;
  await doAction(async () => {
    await api.deleteHost(hostId);
    destroyWebview(hostId);
    hosts = hosts.filter(h => h.id !== hostId);
    if (selectedHostId === hostId) {
      selectedHostId = hosts.length > 0 ? hosts[0].id : null;
      if (selectedHostId) void api.setActiveHost(selectedHostId).catch(() => {});
    }
    renderTabBar();
    renderProgress();
    showWebview(selectedHostId);
  });
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
    renderTabBar();
    renderProgress();
    showWebview(selectedHostId);
    updateAddDialog();
  } catch (error) {
    console.error('Failed to refresh:', error);
  }
}

async function doAction(action) {
  try { await action(); } catch (error) {
    console.error(error);
  }
}

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

  // Delete (any host, but keep at least one)
  if (hosts.length > 1) {
    items.push({ separator: true });
    items.push({ label: '删除 Host', danger: true, action: () => doAction(async () => {
      if (!confirm('确定要删除这个 Host 吗？')) return;
      await api.deleteHost(hostId);
      destroyWebview(hostId);
      hosts = hosts.filter(h => h.id !== hostId);
      if (selectedHostId === hostId) selectedHostId = null;
      renderTabBar();
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

document.addEventListener('mousedown', e => {
  if (contextMenu && !contextMenu.contains(e.target)) hideContextMenu();
});

// --- Config dialog ---

function openConfigDialog(hostId) {
  selectedHostId = hostId;
  const host = hosts.find(h => h.id === hostId);
  if (!host) return;
  const isRemote = host.type === 'remote';
  cfgIcon.textContent = host.icon || '🖥️';
  cfgName.value = host.name || '';
  cfgSsh.hidden = !isRemote;
  cfgSshPolicy.hidden = !isRemote;
  cfgStartup.hidden = !isRemote;
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
  Object.assign(host, updated);
  configDialog.close();
  renderTabBar();
  renderProgress();
}));

$('#cancel-config-btn').addEventListener('click', () => configDialog.close());

// Emoji picker (in config dialog)
const EMOJI_LIST = [
  '🖥️', '💻', '🖥', '🖳', '🖧', '🖴', '🖵', '🖲️',
  '🗄️', '📦', '☁️', '🌐', '🌍', '🌎', '🌏', '📡',
  '⚡', '🔥', '💡', '⭐', '✨', '🌀', '🎯', '💎',
  '🚀', '🛸', '🛰️', '🛩️', '✈️',
  '🔧', '🔨', '🛠️', '⚙️', '🔌', '🔋', '💾', '📀',
  '🏠', '🏢', '🏗️', '🗼',
  '🤖', '🧠', '👾', '🦾', '🦿', '👁️',
  '🔮', '🧩', '🪄', '🛡️', '🔒', '🔑', '🗝️',
  '📊', '📈', '📉', '🧮', '💻', '⌨️', '🖱️', '🖨️',
  '🟢', '🔵', '🟣', '🟡', '🟠', '🔴', '⚪', '⚫',
  '🐧', '🐳', '🐙', '🦀', '🦊', '🐱', '🐶',
  '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', 'A', 'B', 'C',
];

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

// + button: show add dialog, local option only when no local host exists
$('#add-tab-btn').addEventListener('click', () => addDialog.showModal());
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

// Hide local option when a local host already exists
const updateAddDialog = () => {
  const hasLocal = hosts.some(h => h.type === 'local');
  const localBtn = addDialog.querySelector('[data-type="local"]');
  if (localBtn) localBtn.hidden = hasLocal;
};

// --- Keyboard shortcuts ---

document.addEventListener('keydown', e => {
  // Ctrl+1~9: switch to tab by index
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    const num = parseInt(e.key);
    if (num >= 1 && num <= 9 && hosts[num - 1]) {
      e.preventDefault();
      selectHost(hosts[num - 1].id);
    }
  }
  // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs
  if (e.ctrlKey && e.key === 'Tab' && hosts.length > 0) {
    e.preventDefault();
    const idx = hosts.findIndex(h => h.id === selectedHostId);
    const next = e.shiftKey
      ? (idx <= 0 ? hosts.length - 1 : idx - 1)
      : (idx >= hosts.length - 1 ? 0 : idx + 1);
    selectHost(hosts[next].id);
  }
});

// --- Status push ---

api.onStatus((hostId, snapshot) => {
  const current = snapshots[hostId];
  if (current && (snapshot.revision ?? 0) < (current.revision ?? 0)) return;
  snapshots[hostId] = snapshot;
  reconcileWebviews();
  renderTabBar();
  if (hostId === selectedHostId) {
    renderProgress();
    showWebview(selectedHostId);
  }
  updateAddDialog();
});

api.onRefresh(() => refresh());

// --- Init ---

refresh();