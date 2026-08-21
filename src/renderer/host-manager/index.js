const api = window.desktopHosts;
const $ = s => document.querySelector(s);

// Elements
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
const remoteControls = $('#remote-controls');
const remoteDshStatus = $('#remote-dsh-status');
const remoteDshStatusText = $('#remote-dsh-status-text');
const sshConfig = $('#ssh-config');
const startupOptions = $('#startup-options');
const addDialog = $('#add-dialog');
const deleteBtn = $('#delete-btn');

// Form fields
const hostName = $('#host-name');
const hostField = $('#host-field');
const usernameField = $('#username-field');
const sshPortField = $('#ssh-port-field');
const localPortField = $('#local-port-field');
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

  // Remote controls
  remoteControls.hidden = !isRemote || isTunnel;
  if (isRemote && !isTunnel && isConnected) {
    remoteDshStatus.hidden = false;
    if (snap.remoteDsh?.running) {
      remoteDshStatusText.textContent = `远程 DSH 运行中 (PID: ${snap.remoteDsh.pid})`;
      remoteDshStatus.className = 'remote-status';
    } else {
      remoteDshStatusText.textContent = '远程 DSH 未运行';
      remoteDshStatus.className = 'remote-status stopped';
    }
  } else {
    remoteDshStatus.hidden = true;
  }

  // Config form
  hostName.value = host.name || '';
  sshConfig.hidden = isLocal;
  startupOptions.hidden = isLocal || isTunnel;
  deleteBtn.hidden = isLocal; // Can't delete local host

  if (isRemote) {
    hostField.value = host.host || '';
    usernameField.value = host.username || '';
    sshPortField.value = host.sshPort || 22;
    localPortField.value = host.localPort || 3080;
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
  if (host.type === 'remote') {
    updated.host = hostField.value.trim();
    updated.username = usernameField.value.trim();
    updated.sshPort = Number(sshPortField.value) || 22;
    updated.localPort = Number(localPortField.value) || 3080;
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

// Remote DSH actions
$('#restart-dsh-btn').addEventListener('click', () => doAction(async () => {
  await api.restartRemoteDsh(selectedHostId);
  await refresh();
}));
$('#stop-dsh-btn').addEventListener('click', () => doAction(async () => {
  await api.stopRemoteDsh(selectedHostId);
  await refresh();
}));
$('#check-version-btn').addEventListener('click', () => doAction(async () => {
  const result = await api.getRemoteDshVersion(selectedHostId);
  $('#remote-dsh-info').hidden = false;
  $('#remote-dsh-version-text').textContent = result.version;
}));
$('#process-details-btn').addEventListener('click', () => doAction(async () => {
  const result = await api.getRemoteDshProcessDetails(selectedHostId);
  $('#remote-dsh-details').hidden = false;
  $('#remote-dsh-details-text').textContent = result.output;
  $('#remote-dsh-details').open = true;
}));
$('#view-log-btn').addEventListener('click', () => doAction(async () => {
  const result = await api.getRemoteDshLog(selectedHostId);
  $('#remote-dsh-log').hidden = false;
  $('#remote-dsh-log-text').textContent = result.output;
  $('#remote-dsh-log').open = true;
}));
$('#view-config-btn').addEventListener('click', () => doAction(async () => {
  const result = await api.getRemoteDshConfig(selectedHostId);
  $('#remote-dsh-config').hidden = false;
  $('#remote-dsh-config-text').textContent = JSON.stringify(result, null, 2);
  $('#remote-dsh-config').open = true;
}));
$('#update-dsh-btn').addEventListener('click', () => doAction(async () => {
  $('#remote-dsh-update').hidden = false;
  $('#remote-dsh-update-text').textContent = '正在更新远程 DSH，请稍候...';
  const result = await api.updateRemoteDsh(selectedHostId);
  $('#remote-dsh-update-text').textContent = result.output;
}));

// Status push
api.onStatus((hostId, snapshot) => {
  snapshots[hostId] = snapshot;
  renderHostList();
  if (hostId === selectedHostId) renderDetail();
});

api.onRefresh(() => refresh());

// Init
refresh();