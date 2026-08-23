const api = window.desktopHosts;
const $ = s => document.querySelector(s);

// Elements
const sidebar = $('#sidebar');
const dragHandle = $('#drag-handle');
const hostList = $('#host-list');
const statusText = $('#status-text');
const statusEndpoint = $('#status-endpoint');
const connectBtn = $('#connect-btn');
const disconnectBtn = $('#disconnect-btn');
const retryBtn = $('#retry-btn');
const updateBtn = $('#update-btn');
const configBtn = $('#config-btn');
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
// Map<hostId, webview>
const webviews = new Map();

// --- Webview management ---

function getOrCreateWebview(hostId, endpoint) {
  let wv = webviews.get(hostId);
  if (wv) return wv;

  wv = document.createElement('webview');
  wv.id = `webview-${hostId}`;
  wv.setAttribute('src', endpoint);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('partition', `persist:dsh-${hostId}`);
  wv.style.cssText = 'display:none;';

  // Ensure the DSH page fills the webview — the DSH frontend
  // doesn't set height:100% on html/body/#root by default.
  wv.addEventListener('dom-ready', () => {
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

function showWebview(hostId) {
  for (const [id, wv] of webviews) {
    wv.style.display = id === hostId ? '' : 'none';
  }
  webviewPlaceholder.hidden = webviews.size > 0;
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
      <span class="host-item-emoji" title="点击修改图标">${esc(host.icon || '🖥️')}</span>
      <div class="host-item-info">
        <div class="host-item-name">${esc(host.name)}</div>
        <div class="host-item-meta">${stateLabel(snap)}${snap.endpoint ? ' · ' + new URL(snap.endpoint).port : ''}</div>
      </div>
      <span class="host-item-dot ${snap.state}"></span>
    `;
    li.addEventListener('click', () => selectHost(host.id));
    li.querySelector('.host-item-emoji').addEventListener('click', e => {
      e.stopPropagation();
      showEmojiPicker(host.id);
    });
    hostList.appendChild(li);
  }
}

function renderStatus() {
  const host = hosts.find(h => h.id === selectedHostId);
  const snap = host ? (snapshots[host.id] || { state: 'idle' }) : { state: 'idle' };
  const isConnected = snap.state === 'connected';
  const isTransferring = snap.progress?.phase === 'remote-transferring';
  const isConnecting = snap.state === 'connecting' || isTransferring;

  // Status text
  if (snap.state === 'error' && snap.error) {
    statusText.textContent = snap.error;
  } else {
    statusText.textContent = snap.progress?.message || statusLabel(snap);
  }
  if (snap.needsUpdate && snap.remoteVersion && snap.bundledVersion) {
    statusText.textContent += ` (远程: ${snap.remoteVersion} → 可用: ${snap.bundledVersion})`;
  }

  // Endpoint
  if (snap.endpoint) {
    statusEndpoint.hidden = false;
    statusEndpoint.textContent = snap.endpoint;
  } else {
    statusEndpoint.hidden = true;
  }

  // Progress bar
  if (isTransferring) {
    progressBar.hidden = false;
    progressBarText.textContent = snap.progress?.message || '正在传输 DSH...';
  } else {
    progressBar.hidden = true;
  }

  // Buttons
  connectBtn.hidden = !host || isConnected || isConnecting;
  disconnectBtn.hidden = !isConnected;
  retryBtn.hidden = snap.state !== 'error';
  updateBtn.hidden = !isConnected || !snap.needsUpdate;
  configBtn.hidden = !host;
}

function statusLabel(snap) {
  if (snap.progress?.message) return snap.progress.message;
  const labels = { idle: '未连接', connecting: '连接中...', connected: '已连接', error: '错误' };
  return labels[snap.state] || snap.state;
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
  renderHostList();
  renderStatus();
  showWebview(hostId);
}

async function refresh() {
  try {
    const state = await api.getState();
    hosts = state.hosts;
    snapshots = {};
    for (const s of state.snapshots) {
      snapshots[s.hostId] = s;
    }
    if (!selectedHostId && hosts.length > 0) {
      selectedHostId = hosts[0].id;
    }
    renderHostList();
    renderStatus();
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

// --- Event handlers ---

connectBtn.addEventListener('click', () => doAction(async () => {
  const snap = await api.connect(selectedHostId);
  if (snap.state === 'connected' && snap.endpoint) {
    getOrCreateWebview(selectedHostId, snap.endpoint);
    showWebview(selectedHostId);
  }
  await refresh();
}));

disconnectBtn.addEventListener('click', () => doAction(async () => {
  await api.disconnect(selectedHostId);
  destroyWebview(selectedHostId);
  showWebview(selectedHostId);
  await refresh();
}));

retryBtn.addEventListener('click', () => doAction(async () => {
  const snap = await api.connect(selectedHostId);
  if (snap.state === 'connected' && snap.endpoint) {
    getOrCreateWebview(selectedHostId, snap.endpoint);
    showWebview(selectedHostId);
  }
  await refresh();
}));

updateBtn.addEventListener('click', () => doAction(async () => {
  if (!confirm('确定要更新远程 DSH 吗？更新过程中连接会暂时中断。')) return;
  try {
    await api.updateRemoteDsh(selectedHostId);
  } catch (error) {
    console.error('Failed to update remote DSH:', error);
  }
  await refresh();
}));

// Config dialog
configBtn.addEventListener('click', () => {
  const host = hosts.find(h => h.id === selectedHostId);
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
});

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
  configDialog.close();
  await refresh();
}));

$('#delete-config-btn').addEventListener('click', () => doAction(async () => {
  const host = hosts.find(h => h.id === selectedHostId);
  if (!host) return;
  if (host.type === 'local') return;
  if (!confirm('确定要删除这个 Host 吗？')) return;
  await api.deleteHost(selectedHostId);
  destroyWebview(selectedHostId);
  selectedHostId = null;
  configDialog.close();
  await refresh();
}));

$('#cancel-config-btn').addEventListener('click', () => configDialog.close());

// Emoji picker
const EMOJI_LIST = ['🖥️', '🖥', '🖳', '💻', '🖧', '🖴', '🖵', '🗄️', '🛠️', '📦', '🚀', '⚡', '🔧', '🔮', '🌐', '💡', '🦾', '🏠', '🌍', '📡', '🖥️', '⌨️', '🖱️', '🖲️', '🔌', '💾', '📀', '🔋', '🧠', '🤖', '🔥', '⭐', '🌀', '🎯', '🏗️', '📊', '🧩', '🪄', '✨', '🛡️'];
let editingIconForHostId = null;

function showEmojiPicker(hostId) {
  editingIconForHostId = hostId;
  let picker = $('#emoji-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'emoji-picker';
    picker.className = 'emoji-picker';
    picker.innerHTML = EMOJI_LIST.map(e => `<span class="emoji-option" data-emoji="${e}">${e}</span>`).join('');
    picker.addEventListener('click', e => {
      const opt = e.target.closest('.emoji-option');
      if (!opt) return;
      const emoji = opt.dataset.emoji;
      doAction(async () => {
        const host = hosts.find(h => h.id === editingIconForHostId);
        if (!host) return;
        const updated = { ...host, icon: emoji };
        await api.updateHost(updated);
        await refresh();
      });
      picker.classList.remove('visible');
    });
    document.body.appendChild(picker);
  }
  // Position near the clicked emoji
  const el = document.querySelector(`.host-item-emoji`);
  const rect = el?.getBoundingClientRect();
  if (rect) {
    picker.style.top = `${rect.bottom + 4}px`;
    picker.style.left = `${rect.left}px`;
  }
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
}

$('#cfg-icon-btn').addEventListener('click', () => {
  let picker = $('#emoji-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'emoji-picker';
    picker.className = 'emoji-picker';
    picker.innerHTML = EMOJI_LIST.map(e => `<span class="emoji-option" data-emoji="${e}">${e}</span>`).join('');
    picker.addEventListener('click', e => {
      const opt = e.target.closest('.emoji-option');
      if (!opt) return;
      cfgIcon.textContent = opt.dataset.emoji;
      picker.classList.remove('visible');
    });
    document.body.appendChild(picker);
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
  snapshots[hostId] = snapshot;
  if (snapshot.state === 'connected' && snapshot.endpoint) {
    getOrCreateWebview(hostId, snapshot.endpoint);
  }
  renderHostList();
  if (hostId === selectedHostId) renderStatus();
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
  dragHandle.classList.remove('active');
});

api.onToggleSidebar(() => {
  if (sidebar.classList.contains('hidden')) {
    setSidebarWidth(240);
  } else {
    sidebar.classList.add('hidden');
  }
});