const api = window.desktopConnection;
const form = document.querySelector('#connection-form');
const tunnelFields = document.querySelector('#tunnel-fields');
const localPort = document.querySelector('#local-port');
const endpointPreview = document.querySelector('#endpoint-preview');
const statusElement = document.querySelector('#status');
const warningElement = document.querySelector('#warning');
const retryButton = document.querySelector('#retry');
const useLocalButton = document.querySelector('#use-local');

let currentState = null;
let busy = false;

function selectedMode() {
  return form.elements.mode.value;
}

function setBusy(value) {
  busy = value;
  for (const element of form.querySelectorAll('button, input')) element.disabled = value;
}

function updateMode() {
  const isTunnel = selectedMode() === 'tunnel';
  tunnelFields.classList.toggle('disabled', !isTunnel);
  localPort.disabled = busy || !isTunnel;
}

function updatePreview() {
  const port = localPort.value || '3080';
  endpointPreview.textContent = `http://127.0.0.1:${port}`;
}

function render(snapshot) {
  currentState = snapshot;
  const messages = {
    idle: '尚未连接。',
    connecting: snapshot.mode === 'tunnel' ? '正在检查现有 SSH 隧道…' : '正在启动本机 DSH…',
    connected: `已连接：${snapshot.endpoint}`,
    error: snapshot.error || '连接失败。',
  };
  statusElement.textContent = messages[snapshot.state] || snapshot.state;
  statusElement.className = `message ${snapshot.state === 'error' ? 'error' : snapshot.state === 'connected' ? 'success' : ''}`;
  retryButton.hidden = snapshot.state !== 'error';
  useLocalButton.hidden = snapshot.state !== 'error' || snapshot.mode === 'local';
}

function showError(error) {
  render({
    ...(currentState || { mode: selectedMode(), endpoint: null }),
    state: 'error',
    error: error?.message || String(error),
  });
}

async function perform(action) {
  if (busy) return;
  setBusy(true);
  try {
    render({ ...(currentState || {}), state: 'connecting', mode: selectedMode(), error: null });
    const snapshot = await action();
    render(snapshot);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    updateMode();
  }
}

form.addEventListener('change', () => {
  updateMode();
  updatePreview();
});
localPort.addEventListener('input', updatePreview);

form.addEventListener('submit', event => {
  event.preventDefault();
  const mode = selectedMode();
  const port = Number(localPort.value);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65_535;
  if (mode === 'tunnel' && !validPort) {
    showError(new Error('本地转发端口必须是 1 到 65535 之间的整数。'));
    return;
  }
  void perform(() => api.saveAndConnect({
    schemaVersion: 1,
    mode,
    tunnel: { localPort: validPort ? port : 3080 },
  }));
});

retryButton.addEventListener('click', () => void perform(() => api.retry()));
useLocalButton.addEventListener('click', () => {
  form.elements.mode.value = 'local';
  updateMode();
  void perform(() => api.useLocal());
});

function applyState(initial) {
  const settings = initial.settings;
  if (settings) {
    form.elements.mode.value = settings.mode;
    localPort.value = String(settings.tunnel.localPort);
  }
  warningElement.hidden = !initial.warning;
  warningElement.textContent = initial.warning || '';
  updateMode();
  updatePreview();
  render(initial);
}

async function refreshState() {
  try {
    applyState(await api.getState());
  } catch (error) {
    showError(error);
  }
}

api.onStatus(snapshot => render(snapshot));
api.onRefresh(() => void refreshState());
void refreshState();
