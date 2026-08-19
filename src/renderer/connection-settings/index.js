const api = window.desktopConnection;
const $ = selector => document.querySelector(selector);
const form = $('#connection-form');
const statusElement = $('#status');
const warningElement = $('#warning');
const localFields = $('#local-fields');
const managedFields = $('#managed-fields');
const externalFields = $('#external-fields');
const host = $('#ssh-host');
const username = $('#ssh-username');
const sshPort = $('#ssh-port');
const managedLocalPort = $('#managed-local-port');
const remotePort = $('#remote-port');
const identityFile = $('#identity-file');
const hostKeyPolicy = $('#host-key-policy');
const externalLocalPort = $('#external-local-port');
const commandPreview = $('#command-preview');
const externalPreview = $('#external-preview');
const retryButton = $('#retry');
const disconnectButton = $('#disconnect');
const useLocalButton = $('#use-local');
const autoStartRemoteDsh = $('#auto-start-remote-dsh');
const autoStopRemoteDsh = $('#auto-stop-remote-dsh');
const remoteDshStatus = $('#remote-dsh-status');
const remoteDshControls = $('#remote-dsh-controls');
const remoteDshStatusText = $('#remote-dsh-status-text');
const remoteDshActions = $('#remote-dsh-actions');
const restartRemoteDshBtn = $('#restart-remote-dsh');
const stopRemoteDshBtn = $('#stop-remote-dsh');
const checkVersionBtn = $('#check-version-remote-dsh');
const viewLogBtn = $('#view-log-remote-dsh');
const remoteDshInfo = $('#remote-dsh-info');
const remoteDshVersionText = $('#remote-dsh-version-text');
const remoteDshDetails = $('#remote-dsh-details');
const remoteDshDetailsText = $('#remote-dsh-details-text');
const remoteDshLog = $('#remote-dsh-log');
const remoteDshLogText = $('#remote-dsh-log-text');
const remoteDshActionsSecondary = $('#remote-dsh-actions-secondary');
let currentState = null;
let busy = false;

function mode() { return form.elements.mode.value; }
function port(input, label) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label}必须是 1 到 65535 之间的整数。`);
  return value;
}
function setBusy(value) {
  busy = value;
  form.setAttribute('aria-busy', String(value));
  for (const element of form.querySelectorAll('button,input,select')) element.disabled = value;
  updateMode();
}
function updateMode() {
  const selected = mode();
  form.dataset.mode = selected;
  localFields.hidden = selected !== 'local';
  managedFields.hidden = selected !== 'managedSsh';
  externalFields.hidden = selected !== 'external';
  const showControls = selected === 'managedSsh';
  autoStartRemoteDsh.closest('.checkbox-label').hidden = !showControls;
  autoStopRemoteDsh.closest('.checkbox-label').hidden = !showControls;
  if (!showControls) { remoteDshControls.hidden = true; remoteDshStatus.hidden = true; remoteDshActions.hidden = true; remoteDshActionsSecondary.hidden = true; remoteDshInfo.hidden = true; remoteDshDetails.hidden = true; remoteDshLog.hidden = true; }
  if (!busy) for (const element of form.querySelectorAll('input,select,button')) element.disabled = false;
}
function updatePreview() {
  const lp = managedLocalPort.value || '3080'; const rp = remotePort.value || '3080';
  const destination = `${username.value || '<用户>'}@${host.value || '<主机>'}`;
  commandPreview.textContent = `ssh -N -L ${lp}:127.0.0.1:${rp} ${destination}`;
  externalPreview.textContent = `http://127.0.0.1:${externalLocalPort.value || '3080'}`;
}
function render(snapshot) {
  currentState = snapshot;
  const messages = {
    idle: '尚未连接。',
    connecting: snapshot.mode === 'managedSsh' ? '正在启动 SSH 隧道…' : snapshot.mode === 'external' ? '正在检查现有 SSH 隧道…' : '正在启动本机 DSH…',
    connected: `已连接：${snapshot.endpoint}`,
    error: snapshot.error || '连接失败。',
  };
  statusElement.textContent = messages[snapshot.state] || snapshot.state;
  statusElement.className = `message status-message ${snapshot.state === 'error' ? 'error' : snapshot.state === 'connected' ? 'success' : ''}`;
  statusElement.dataset.connectionState = snapshot.state || 'idle';
  retryButton.hidden = snapshot.state !== 'error';
  disconnectButton.hidden = snapshot.state !== 'connected';
  useLocalButton.hidden = snapshot.state !== 'error' || snapshot.mode === 'local';
  const showRemoteDsh = snapshot.mode === 'managedSsh' && snapshot.state === 'connected';
  remoteDshControls.hidden = !showRemoteDsh;
  remoteDshStatus.hidden = !showRemoteDsh;
  remoteDshActions.hidden = !showRemoteDsh;
  remoteDshActionsSecondary.hidden = !showRemoteDsh;
  if (!showRemoteDsh) { remoteDshInfo.hidden = true; remoteDshDetails.hidden = true; remoteDshLog.hidden = true; }
  if (showRemoteDsh && snapshot.remoteDsh) {
    if (snapshot.remoteDsh.running) {
      remoteDshStatusText.textContent = `远程 DSH 运行中 (PID: ${snapshot.remoteDsh.pid})`;
      remoteDshStatus.className = 'remote-dsh-status running';
    } else {
      remoteDshStatusText.textContent = '远程 DSH 未运行';
      remoteDshStatus.className = 'remote-dsh-status stopped';
    }
  }
}
function showError(error) { render({ ...(currentState || { mode: mode(), endpoint: null }), state: 'error', error: error?.message || String(error) }); }
async function perform(action) {
  if (busy) return; setBusy(true);
  try { render({ ...(currentState || {}), state: 'connecting', mode: mode(), error: null }); render(await action()); }
  catch (error) { showError(error); }
  finally { setBusy(false); }
}
function validPortOrDefault(input, fallback) {
  const value = Number(input.value);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback;
}
function buildSettings() {
  const selected = mode();
  const managedActive = selected === 'managedSsh';
  return {
    schemaVersion: 2,
    mode: selected,
    externalTunnel: { localPort: selected === 'external' ? port(externalLocalPort, '外部隧道端口') : validPortOrDefault(externalLocalPort, 3080) },
    managedSsh: {
      host: managedActive ? host.value.trim() : (host.value.trim() || '10.37.117.240'),
      username: managedActive ? username.value.trim() : (username.value.trim() || 'xiongyuanwen'),
      sshPort: managedActive ? port(sshPort, 'SSH 端口') : validPortOrDefault(sshPort, 22),
      localPort: managedActive ? port(managedLocalPort, '本地转发端口') : validPortOrDefault(managedLocalPort, 3080),
      remotePort: managedActive ? port(remotePort, '远程 DSH 端口') : validPortOrDefault(remotePort, 3080),
      identityFile: identityFile.value.trim() || null, hostKeyPolicy: hostKeyPolicy.value || 'accept-new',
        autoStartRemoteDsh: autoStartRemoteDsh.checked, autoStopRemoteDsh: autoStopRemoteDsh.checked,
    },
  };
}
function applyState(initial) {
  const settings = initial.settings;
  if (settings) {
    form.elements.mode.value = settings.mode;
    externalLocalPort.value = settings.externalTunnel.localPort;
    host.value = settings.managedSsh.host; username.value = settings.managedSsh.username;
    sshPort.value = settings.managedSsh.sshPort; managedLocalPort.value = settings.managedSsh.localPort;
    remotePort.value = settings.managedSsh.remotePort; identityFile.value = settings.managedSsh.identityFile || '';
    hostKeyPolicy.value = settings.managedSsh.hostKeyPolicy;
    autoStartRemoteDsh.checked = settings.managedSsh.autoStartRemoteDsh ?? true;
    autoStopRemoteDsh.checked = settings.managedSsh.autoStopRemoteDsh ?? true;
  }
  warningElement.hidden = !initial.warning; warningElement.textContent = initial.warning || '';
  updateMode(); updatePreview(); render(initial);
}
async function refreshState() { try { applyState(await api.getState()); } catch (error) { showError(error); } }
form.addEventListener('change', () => { updateMode(); updatePreview(); });
form.addEventListener('input', updatePreview);
form.addEventListener('submit', event => { event.preventDefault(); try { const settings = buildSettings(); void perform(() => api.saveAndConnect(settings)); } catch (error) { showError(error); } });
retryButton.addEventListener('click', () => void perform(() => api.retry()));
disconnectButton.addEventListener('click', () => void perform(() => api.disconnect()));
useLocalButton.addEventListener('click', () => { form.elements.mode.value = 'local'; updateMode(); void perform(() => api.useLocal()); });
restartRemoteDshBtn.addEventListener('click', () => void perform(() => api.restartRemoteDsh()));
stopRemoteDshBtn.addEventListener('click', () => void perform(() => api.stopRemoteDsh()));
checkVersionBtn.addEventListener('click', async () => {
  if (busy) return; setBusy(true);
  try {
    const result = await api.getRemoteDshVersion();
    remoteDshInfo.hidden = false;
    remoteDshVersionText.textContent = result.version;
    remoteDshDetails.hidden = false;
    remoteDshDetailsText.textContent = result.output;
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
viewLogBtn.addEventListener('click', async () => {
  if (busy) return; setBusy(true);
  try {
    const result = await api.getRemoteDshLog();
    remoteDshLog.hidden = false;
    remoteDshLogText.textContent = result.output;
    remoteDshLog.open = true;
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
api.onStatus(render); api.onRefresh(() => void refreshState()); void refreshState();
