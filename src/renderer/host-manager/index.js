const api = window.desktopHosts;
const $ = s => document.querySelector(s);

// Elements
const sidebar = $('#sidebar');
const dragHandle = $('#drag-handle');
const hostList = $('#host-list');
const emptyState = $('#empty-state');
const detailPanel = $('#detail-panel');
const detailStatus = $('#detail-status');
const statusText = $('#status-text');
const statusEndpoint = $('#status-endpoint');
const installProgress = $('#install-progress');
const installProgressText = $('#install-progress-text');
const connectBtn = $('#connect-btn');
const disconnectBtn = $('#disconnect-btn');
const retryBtn = $('#retry-btn');
const sshConfig = $('#ssh-config');
const startupOptions = $('#startup-options');
const addDialog = $('#add-dialog');
const deleteBtn = $('#delete-btn');

// Form fields
const hostName = $('#host-name');
const hostField = $('#host-field');
const usernameField = $('#username-field');
const sshPortField = $('#ssh-port-field');
const identityFileField = $('#identity-file-field');
const hostKeyPolicyField = $('#host-key-policy-field');
const autoStartField = $('#auto-start-field');
const autoStopField = $('#auto-stop-field');
const autoInstallField = $('#auto-install-field');

let hosts = [];
let selectedHostId = null;
let snapshots = {};
let busy = false;

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
      <span class="host-item-icon ${snap.state}"></span>
      <div class="host-item-info">
        <div class="host-item-name">${esc(host.name)}</div>
        <div class="host-item-meta">${stateLabel(snap)}${snap.endpoint ? ' · ' + new URL(snap.endpoint).port : ''}</div>
      </div>
    `;
    li.addEventListener('click', () => selectHost(host.id));
    hostList.appendChild(li);
  }
}

function renderDetail() {
  const host = hosts.find(h => h.id === selectedHostId);
  if (!host) {
    emptyState.hidden = false;
    detailPanel.hidden = true;
    return;
  }
  emptyState.hidden = true;
  detailPanel.hidden = false;

  const snap = snapshots[host.id] || { state: 'idle' };
  const isLocal = host.type === 'local';
  const isRemote = host.type === 'remote';
  const isTunnel = host.host === 'tunnel';
  const isConnected = snap.state === 'connected';

  // Status
  const phaseLabels = {
    connecting: '正在连接...',
    starting: '正在启动本机 DSH...',
    'remote-start': '正在启动远程 DSH...',
    'ssh-tunnel': '正在建立 SSH 隧道...',
    'health-check': '正在检查服务状态...',
    checking: '正在检查环境...',
    preparing: '正在准备安装 DSH...',
    installing: '正在下载并安装 DSH，请稍候...',
    connected: '已连接',
  };
  if (snap.state === 'error' && snap.error) {
    statusText.textContent = snap.error;
  } else {
    statusText.textContent = snap.progress?.message || phaseLabels[snap.progress?.phase] || stateLabel(snap);
  }
  detailStatus.className = `detail-status ${snap.state}`;
  if (snap.endpoint) {
    statusEndpoint.hidden = false;
    statusEndpoint.textContent = snap.endpoint;
  } else {
    statusEndpoint.hidden = true;
  }

  // Install progress
  if (snap.state === 'installing') {
    installProgress.hidden = false;
    const phases = { preparing: '正在准备安装...', installing: '正在下载并安装 DSH，请稍候...', done: '安装完成，正在启动...' };
    installProgressText.textContent = phases[snap.progress?.phase] || '正在安装 DSH...';
  } else {
    installProgress.hidden = true;
  }

  // Buttons
  connectBtn.hidden = isConnected || snap.state === 'connecting' || snap.state === 'installing';
  disconnectBtn.hidden = !isConnected;
  retryBtn.hidden = snap.state !== 'error';

  // Config form
  hostName.value = host.name || '';
  sshConfig.hidden = isLocal;
  startupOptions.hidden = isLocal || isTunnel;
  deleteBtn.hidden = isLocal; // Can't delete local host

  if (isRemote) {
    hostField.value = host.host || '';
    usernameField.value = host.username || '';
    sshPortField.value = host.sshPort || 22;
    identityFileField.value = host.identityFile || '';
    hostKeyPolicyField.value = host.hostKeyPolicy || 'accept-new';
    autoStartField.checked = host.autoStartRemoteDsh ?? true;
    autoStopField.checked = host.autoStopRemoteDsh ?? true;
    autoInstallField.checked = host.autoInstallRemoteDsh ?? true;
  }
}

function stateLabel(snap) {
  if (snap.progress?.message) return snap.progress.message;
  const labels = { idle: '未连接', connecting: '连接中...', installing: '安装中...', connected: '已连接', error: '错误' };
  return labels[snap.state] || snap.state;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// --- Actions ---

function selectHost(hostId) {
  selectedHostId = hostId;
  renderHostList();
  renderDetail();
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
    renderDetail();
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
  await api.connect(selectedHostId);
  await refresh();
}));

disconnectBtn.addEventListener('click', () => doAction(async () => {
  await api.disconnect(selectedHostId);
  await refresh();
}));

retryBtn.addEventListener('click', () => doAction(async () => {
  await api.connect(selectedHostId);
  await refresh();
}));

$('#save-btn').addEventListener('click', () => doAction(async () => {
  const host = hosts.find(h => h.id === selectedHostId);
  if (!host) return;
  const updated = {
    ...host,
    name: hostName.value.trim() || host.name,
  };
  delete updated.localPort;
  if (host.type === 'remote') {
    updated.host = hostField.value.trim();
    updated.username = usernameField.value.trim();
    updated.sshPort = Number(sshPortField.value) || 22;
    updated.identityFile = identityFileField.value.trim() || null;
    updated.hostKeyPolicy = hostKeyPolicyField.value;
    updated.autoStartRemoteDsh = autoStartField.checked;
    updated.autoStopRemoteDsh = autoStopField.checked;
    updated.autoInstallRemoteDsh = autoInstallField.checked;
  }
  await api.updateHost(updated);
  await refresh();
}));

deleteBtn.addEventListener('click', () => doAction(async () => {
  if (!confirm('确定要删除这个 Host 吗？')) return;
  await api.deleteHost(selectedHostId);
  selectedHostId = null;
  await refresh();
}));

$('#add-host-btn').addEventListener('click', () => addDialog.showModal());
$('#cancel-add-btn').addEventListener('click', () => addDialog.close());

addDialog.querySelectorAll('.add-option').forEach(btn => {
  btn.addEventListener('click', () => doAction(async () => {
    const type = btn.dataset.type;
    const name = type === 'local' ? '本机' : '新服务器';
    await api.addHost({ type, name });
    addDialog.close();
    await refresh();
    // Select the newly added host
    const state = await api.getState();
    const last = state.hosts[state.hosts.length - 1];
    if (last) selectHost(last.id);
  }));
});

// Status push
api.onStatus((hostId, snapshot) => {
  snapshots[hostId] = snapshot;
  renderHostList();
  if (hostId === selectedHostId) renderDetail();
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

// Double-click drag handle to toggle collapsed
dragHandle.addEventListener('dblclick', () => {
  if (sidebar.classList.contains('collapsed') || sidebar.classList.contains('hidden')) {
    setSidebarWidth(240);
  } else {
    setSidebarWidth(SIDEBAR_MIN);
  }
});

// Drag
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

// Expose toggle for menu
api.onToggleSidebar(() => {
  if (sidebar.classList.contains('hidden')) {
    setSidebarWidth(240);
  } else {
    sidebar.classList.add('hidden');
  }
});