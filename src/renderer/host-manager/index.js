'use strict';

/*
 * Host manager renderer.
 *
 * Framework-free. Consumes window.desktopHosts (see preload/host-manager.js) and
 * window.HMI18n (see ./i18n.js). The main process is authoritative for validation
 * and host storage; this renderer mirrors the validation rules only to give fast,
 * localized inline errors before calling the API.
 *
 * Preload-integration TODOs (renderer intentionally does not touch preload here):
 *  - TODO(preload): expose host:remote-dsh-log so a "View remote log" action can be
 *    wired up. Currently window.desktopHosts has no log getter, so that action is
 *    omitted rather than shipped broken.
 */

const api = window.desktopHosts;
const i18n = window.HMI18n || { lang: 'en', t: k => k };
const t = (key, params) => i18n.t(key, params);

const $ = s => document.querySelector(s);
const cssEscape = (window.CSS && CSS.escape) ? CSS.escape.bind(CSS) : (s => String(s).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`));

// --- Element refs ---

const switcherBar = $('#switcher-bar');
const envList = $('#env-list');
const addEnvBtn = $('#add-env-btn');

const moreBtn = $('#more-btn');

const progressBar = $('#progress-bar');
const progressBarText = $('#progress-bar-text');
const webviewContainer = $('#webview-container');
const webviewPlaceholder = $('#webview-placeholder');
const placeholderTitle = $('#placeholder-title');
const placeholderDesc = $('#placeholder-desc');
const placeholderError = $('#placeholder-error');
const placeholderErrorText = $('#placeholder-error-text');
const placeholderActions = $('#placeholder-actions');

const toastRegion = $('#toast-region');

// Add-type dialog
const addDialog = $('#add-dialog');

// Config dialog + fields
const configDialog = $('#config-dialog');
const configForm = $('#config-form');
const configTitle = $('#config-dialog-title');
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
const cfgFormErr = $('#cfg-form-err');

// Confirm dialog
const confirmDialog = $('#confirm-dialog');
const confirmTitle = $('#confirm-title');
const confirmMessage = $('#confirm-message');
const confirmOkBtn = $('#confirm-ok-btn');
const confirmCancelBtn = $('#confirm-cancel-btn');

// --- State ---

let hosts = [];
let selectedHostId = null;
let snapshots = {};
let refreshGeneration = 0;
let isBusy = false;
let configDraft = null; // { mode: 'add'|'edit', type: 'local'|'remote', hostId: string|null }

const webviews = new Map();          // Map<hostId, <webview>>
const webviewFailures = new Map();   // Map<hostId, { type, detail }>

const EMOJI_LIST = [
  '🖥️', '💻', '🖥', '🖳', '🖧', '🖴', '🖵', '🖲️',
  '🗄️', '📦', '☁️', '🌐', '🌍', '🌎', '🌏', '📡',
  '⚡', '🔥', '💡', '⭐', '✨', '🌀', '🎯', '💎',
  '🚀', '🛸', '🛰️', '🛩️', '✈️',
  '🔧', '🔨', '🛠️', '⚙️', '🔌', '🔋', '💾', '📀',
  '🏠', '🏢', '🏗️', '🗼',
  '🤖', '🧠', '👾', '🦾', '🦿', '👁️',
  '🔮', '🧩', '🪄', '🛡️', '🔒', '🔑', '🗝️',
  '📊', '📈', '📉', '🧮', '⌨️', '🖱️', '🖨️',
  '🟢', '🔵', '🟣', '🟡', '🟠', '🔴', '⚪', '⚫',
  '🐧', '🐳', '🐙', '🦀', '🦊', '🐱', '🐶',
];

// --- Utilities ---

function errMessage(err) {
  if (!err) return String(err);
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err.message || err);
}

function snapFor(hostId) {
  return snapshots[hostId] || { hostId, state: 'idle', progress: null, error: null, remoteDsh: null, needsUpdate: false, endpoint: null };
}

function hostFor(hostId) {
  return hosts.find(h => h.id === hostId) || null;
}

function typeLabel(host) {
  return host?.type === 'remote' ? t('env.remote') : t('env.local');
}

function statusLabel(state) {
  switch (state) {
    case 'connected': return t('status.connected');
    case 'connecting': return t('status.connecting');
    case 'error': return t('status.error');
    default: return t('status.idle');
  }
}

function isPointerConnecting(snap) {
  return snap.state === 'connecting';
}

// --- Static i18n (labels/placeholders/aria) ---

function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const value = t(key);
    if (value) el.textContent = value;
  });

  envList.setAttribute('aria-label', t('a11y.switcher'));
  toastRegion.setAttribute('aria-label', i18n.lang === 'zh' ? '通知' : 'Notifications');

  setLabel(addEnvBtn, t('a11y.addEnv'));
  setLabel(moreBtn, t('action.more'));

  cfgName.placeholder = t('field.namePlaceholder');
  cfgHost.placeholder = t('field.hostPlaceholder');
  cfgUsername.placeholder = t('field.usernamePlaceholder');
  cfgIdentityFile.placeholder = t('field.identityFilePlaceholder');
  $('#cfg-icon-btn').setAttribute('aria-label', t('field.iconChange'));

  $('#add-dialog-title').textContent = t('add.title');
  $('#add-dialog-desc').textContent = t('add.desc');
}

function setLabel(el, label) {
  if (!el) return;
  el.setAttribute('aria-label', label);
  el.setAttribute('title', label);
}

// --- Platform + window controls ---

document.body.setAttribute('data-platform', api.platform);

if (api.platform !== 'darwin') {
  const winControls = $('#window-controls');
  winControls.hidden = false;

  const minBtn = $('#minimize-btn');
  const maxBtn = $('#maximize-btn');
  const closeBtn = $('#close-btn');
  setLabel(minBtn, t('win.minimize'));
  setLabel(maxBtn, t('win.maximize'));
  setLabel(closeBtn, t('win.close'));

  minBtn.addEventListener('click', () => api.windowMinimize());
  maxBtn.addEventListener('click', () => api.windowMaximize());
  closeBtn.addEventListener('click', () => api.windowClose());

  api.onWindowState(state => {
    if (state.maximized) {
      maxBtn.querySelector('span').innerHTML = '&#x2752;';
      setLabel(maxBtn, t('win.restore'));
    } else {
      maxBtn.querySelector('span').innerHTML = '&#x25A1;';
      setLabel(maxBtn, t('win.maximize'));
    }
  });

  switcherBar.addEventListener('dblclick', e => {
    if (e.target === switcherBar || e.target === envList) api.windowMaximize();
  });
}

// --- Toast (aria-live) ---

function toast(message, kind = 'info', timeout) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const glyph = kind === 'success' ? '✓' : kind === 'error' ? '✕' : 'ℹ';
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = glyph;
  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;
  el.append(icon, msg);
  toastRegion.appendChild(el);

  const ttl = timeout ?? (kind === 'error' ? 6000 : 3500);
  const remove = () => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // Fallback in case animations are disabled (reduced-motion).
    setTimeout(() => el.remove(), 240);
  };
  const timer = setTimeout(remove, ttl);
  el.addEventListener('click', () => { clearTimeout(timer); remove(); });
  return el;
}

// --- Confirm dialog (replaces window.confirm) ---

function confirmDialogAsync({ title, message, confirmLabel, danger = false }) {
  return new Promise(resolve => {
    const previouslyFocused = document.activeElement;
    confirmTitle.textContent = title || t('common.confirm');
    confirmMessage.textContent = message || '';
    confirmOkBtn.textContent = confirmLabel || t('common.confirm');
    confirmOkBtn.classList.toggle('danger', danger);
    confirmOkBtn.classList.toggle('primary', !danger);

    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      confirmOkBtn.removeEventListener('click', onOk);
      confirmCancelBtn.removeEventListener('click', onCancel);
      confirmDialog.removeEventListener('close', onClose);
      confirmDialog.removeEventListener('cancel', onCancelEvent);
      if (confirmDialog.open) confirmDialog.close();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false);
    const onCancelEvent = () => finish(false); // native Esc

    confirmOkBtn.addEventListener('click', onOk);
    confirmCancelBtn.addEventListener('click', onCancel);
    confirmDialog.addEventListener('close', onClose);
    confirmDialog.addEventListener('cancel', onCancelEvent);

    confirmDialog.showModal();
    // Default focus on cancel (safer for destructive actions).
    confirmCancelBtn.focus();
  });
}

// --- Busy / action wrapper ---

function updateBusyUI() {
  addEnvBtn.disabled = isBusy;
  moreBtn.disabled = isBusy;
}

async function runAction(fn, { successMsg, errorMsg } = {}) {
  if (isBusy) { toast(t('toast.busy'), 'info', 1500); return; }
  isBusy = true;
  updateBusyUI();
  try {
    const result = await fn();
    if (successMsg) {
      const text = typeof successMsg === 'function' ? successMsg(result) : successMsg;
      if (text) toast(text, 'success');
    }
    return result;
  } catch (err) {
    // errorMsg may be a string, or a function returning a string to toast or a
    // falsy value to suppress the toast (e.g. when the error is shown inline in a dialog).
    const text = typeof errorMsg === 'function' ? errorMsg(err) : (errorMsg || t('toast.failed', { msg: errMessage(err) }));
    if (text) toast(text, 'error');
    // Console kept for diagnostics; user-facing feedback above satisfies the "not only console.error" rule.
    console.error('[host-manager] action failed:', err);
    return undefined;
  } finally {
    isBusy = false;
    updateBusyUI();
  }
}

// --- Webview management ---

function getOrCreateWebview(hostId, endpoint) {
  let wv = webviews.get(hostId);
  if (wv) {
    if (wv.getAttribute('src') !== endpoint) wv.setAttribute('src', endpoint);
    return wv;
  }

  wv = document.createElement('webview');
  wv.id = `webview-${hostId}`;
  wv.setAttribute('src', endpoint);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('partition', `persist:dsh-${hostId}`);
  wv.style.cssText = 'display:none;';

  wv.addEventListener('dom-ready', () => {
    wv.insertCSS('html,body,#root{height:100%;margin:0;padding:0}');
    // A successful (re)load clears any recovery state.
    if (webviewFailures.delete(hostId) && hostId === selectedHostId) showWebview(selectedHostId);
  });

  wv.addEventListener('did-fail-load', e => {
    // -3 == ERR_ABORTED (navigation superseded); ignore. Only main-frame matters.
    if (e.errorCode === -3) return;
    if (e.isMainFrame === false) return;
    recordWebviewFailure(hostId, 'failed', `${e.errorDescription || ''} (${e.errorCode})`.trim());
  });
  wv.addEventListener('crashed', () => recordWebviewFailure(hostId, 'crashed', ''));
  wv.addEventListener('render-process-gone', e => {
    const reason = e?.details?.reason || e?.reason || '';
    recordWebviewFailure(hostId, 'crashed', reason);
  });
  wv.addEventListener('unresponsive', () => recordWebviewFailure(hostId, 'unresponsive', ''));
  wv.addEventListener('responsive', () => {
    const f = webviewFailures.get(hostId);
    if (f && f.type === 'unresponsive') {
      webviewFailures.delete(hostId);
      if (hostId === selectedHostId) showWebview(selectedHostId);
    }
  });

  webviewContainer.appendChild(wv);
  webviews.set(hostId, wv);
  return wv;
}

function recordWebviewFailure(hostId, type, detail) {
  webviewFailures.set(hostId, { type, detail });
  if (hostId === selectedHostId) showWebview(selectedHostId);
}

function destroyWebview(hostId) {
  const wv = webviews.get(hostId);
  if (wv) {
    wv.remove();
    webviews.delete(hostId);
  }
  webviewFailures.delete(hostId);
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

function reloadWebview(hostId) {
  const wv = webviews.get(hostId);
  if (!wv) return;
  webviewFailures.delete(hostId);
  showWebview(hostId);
  try {
    if (typeof wv.reloadIgnoringCache === 'function') wv.reloadIgnoringCache();
    else if (typeof wv.reload === 'function') wv.reload();
  } catch (err) {
    console.error('[host-manager] reload failed:', err);
    toast(t('toast.failed', { msg: errMessage(err) }), 'error');
  }
}

function showWebview(hostId) {
  const failure = hostId ? webviewFailures.get(hostId) : null;
  let shown = false;
  for (const [id, wv] of webviews) {
    const show = id === hostId && !failure;
    wv.style.display = show ? 'flex' : 'none';
    shown ||= show;
  }
  if (shown) { webviewPlaceholder.hidden = true; return; }
  webviewPlaceholder.hidden = false;
  renderPlaceholder(hostId, failure);
}

// --- Placeholder / recovery rendering ---

function makeActionButton(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderPlaceholder(hostId, failure) {
  placeholderActions.innerHTML = '';
  placeholderError.hidden = true;
  placeholderErrorText.textContent = '';

  const host = hostFor(hostId);
  const snap = host ? snapFor(hostId) : null;

  if (!host) {
    placeholderTitle.textContent = t('placeholder.selectTitle');
    placeholderDesc.textContent = t('placeholder.selectDesc');
    return;
  }

  // Webview recovery states take precedence (host is connected but page broke).
  if (failure) {
    const titleKey = failure.type === 'crashed' ? 'webview.crashedTitle'
      : failure.type === 'unresponsive' ? 'webview.unresponsiveTitle'
        : 'webview.failedTitle';
    placeholderTitle.textContent = t(titleKey);
    placeholderDesc.textContent = t('webview.recoverDesc');
    if (failure.detail) {
      placeholderError.hidden = false;
      placeholderErrorText.textContent = failure.detail;
    }
    placeholderActions.append(
      makeActionButton(t('action.reload'), 'primary', () => reloadWebview(hostId)),
      makeActionButton(t('action.reconnect'), '', () => reconnectHost(hostId)),
    );
    return;
  }

  placeholderTitle.textContent = host.name;

  if (snap.state === 'error') {
    placeholderDesc.textContent = t('status.error');
    placeholderError.hidden = false;
    placeholderErrorText.textContent = snap.error || (i18n.lang === 'zh' ? '未知错误' : 'Unknown error');
    placeholderActions.append(
      makeActionButton(t('action.retry'), 'primary', () => connectHost(hostId)),
      makeActionButton(t('action.edit'), '', () => openEditDialog(hostId)),
    );
  } else if (snap.state === 'connecting') {
    placeholderDesc.textContent = phaseText(snap.progress) || t('placeholder.connectingDesc');
  } else {
    placeholderDesc.textContent = t('placeholder.idleDesc');
    placeholderActions.append(
      makeActionButton(t('action.connect'), 'primary', () => connectHost(hostId)),
      makeActionButton(t('action.edit'), '', () => openEditDialog(hostId)),
    );
  }
}

function phaseText(progress) {
  if (!progress) return '';
  const key = `phase.${progress.phase}`;
  const label = t(key);
  if (label && label !== key) return label;
  return progress.message || '';
}

// --- Switcher rendering (tablist, roving tabindex) ---

function renderSwitcher() {
  envList.innerHTML = '';
  for (const host of hosts) {
    const snap = snapFor(host.id);
    const isActive = selectedHostId === host.id;
    const state = snap.state || 'idle';
    const showSpinner = state === 'connecting' && snap.progress?.phase !== 'connected';
    const needsUpdate = snap.needsUpdate && state === 'connected';

    const tab = document.createElement('div');
    tab.className = `env-tab${isActive ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(isActive));
    tab.setAttribute('tabindex', isActive ? '0' : '-1');
    tab.dataset.hostId = host.id;
    tab.setAttribute('aria-label', t('a11y.tab', { name: host.name, type: typeLabel(host), status: statusLabel(state) }));

    const icon = document.createElement('span');
    icon.className = 'env-tab-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = host.icon || '🖥️';

    const body = document.createElement('span');
    body.className = 'env-tab-body';
    const label = document.createElement('span');
    label.className = 'env-tab-label';
    label.textContent = host.name;
    const sub = document.createElement('span');
    sub.className = 'env-tab-sub';
    const statusDot = document.createElement('span');
    statusDot.className = `env-tab-status-dot ${state}`;
    statusDot.setAttribute('aria-hidden', 'true');
    const statusTxt = document.createElement('span');
    statusTxt.className = 'env-tab-status-text';
    statusTxt.textContent = `${typeLabel(host)} · ${statusLabel(state)}`;
    sub.append(statusDot, statusTxt);
    body.append(label, sub);

    tab.append(icon, body);

    if (showSpinner) {
      const sp = document.createElement('span');
      sp.className = 'env-tab-spinner';
      sp.setAttribute('aria-hidden', 'true');
      tab.appendChild(sp);
    }
    if (needsUpdate) {
      const badge = document.createElement('span');
      badge.className = 'env-tab-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.title = t('update.available');
      tab.appendChild(badge);
    }

    tab.addEventListener('click', () => selectHost(host.id));
    tab.addEventListener('contextmenu', e => {
      e.preventDefault();
      selectHost(host.id);
      openMenu(buildMenuItems(host.id), { x: e.clientX, y: e.clientY, trigger: tab });
    });

    envList.appendChild(tab);
  }

  applyCompactSwitcher();
}

// Drop the per-tab sub-line (type · status) when tabs get too narrow to read it.
function applyCompactSwitcher() {
  if (!hosts.length) return;
  const perTab = envList.clientWidth / hosts.length;
  envList.classList.toggle('compact', perTab < 132);
}

// --- Toolbar rendering ---

// --- Progress bar ---

function renderProgress() {
  const host = hostFor(selectedHostId);
  const snap = host ? snapFor(host.id) : { progress: null };
  const progress = snap.progress;
  if (progress && progress.phase !== 'connected') {
    progressBar.hidden = false;
    progressBarText.textContent = phaseText(progress) || t('toast.busy');
  } else {
    progressBar.hidden = true;
  }
}

// --- Umbrella render ---

function renderAll() {
  renderSwitcher();
  renderProgress();
  showWebview(selectedHostId);
}

// --- Selection ---

function selectHost(hostId) {
  selectedHostId = hostId;
  void api.setActiveHost(hostId).catch(err => console.error('[host-manager] setActiveHost failed:', err));
  renderAll();
}

function focusActiveTab() {
  if (!selectedHostId) return;
  const el = envList.querySelector(`.env-tab[data-host-id="${cssEscape(selectedHostId)}"]`);
  el?.focus();
}

// --- Connection actions ---

function connectHost(hostId) {
  const host = hostFor(hostId);
  const name = host?.name || '';
  return runAction(async () => {
    const snap = await api.connect(hostId);
    mergeSnapshot(hostId, snap);
    if (snap.state === 'connected' && snap.endpoint) {
      webviewFailures.delete(hostId);
      getOrCreateWebview(hostId, snap.endpoint);
    }
    await refresh();
    if (snap.state === 'error') throw new Error(snap.error || 'connect failed');
    return snap;
  }, {
    successMsg: snap => (snap && snap.state === 'connected') ? t('toast.connected', { name }) : null,
    errorMsg: err => t('toast.connectFailed', { msg: errMessage(err) }),
  });
}

function disconnectHost(hostId) {
  const host = hostFor(hostId);
  const name = host?.name || '';
  return runAction(async () => {
    await api.disconnect(hostId);
    destroyWebview(hostId);
    await refresh();
  }, { successMsg: t('toast.disconnected', { name }) });
}

function reconnectHost(hostId) {
  return runAction(async () => {
    await api.disconnect(hostId);
    destroyWebview(hostId);
    const snap = await api.connect(hostId);
    mergeSnapshot(hostId, snap);
    if (snap.state === 'connected' && snap.endpoint) getOrCreateWebview(hostId, snap.endpoint);
    await refresh();
    if (snap.state === 'error') throw new Error(snap.error || 'connect failed');
  }, { errorMsg: err => t('toast.connectFailed', { msg: errMessage(err) }) });
}

// --- Remote DSH actions ---

async function stopRemoteFlow(hostId) {
  const ok = await confirmDialogAsync({
    title: t('confirm.stopRemoteTitle'),
    message: t('confirm.stopRemoteMsg'),
    confirmLabel: t('action.stopRemote'),
    danger: true,
  });
  if (!ok) return;
  return runAction(async () => {
    await api.stopRemoteDsh(hostId);
    destroyWebview(hostId);
    await refresh();
  }, { successMsg: t('toast.remoteStopped') });
}

function restartRemoteFlow(hostId) {
  return runAction(async () => {
    const snap = await api.restartRemoteDsh(hostId);
    mergeSnapshot(hostId, snap);
    if (snap.state === 'connected' && snap.endpoint) {
      webviewFailures.delete(hostId);
      getOrCreateWebview(hostId, snap.endpoint);
    }
    await refresh();
  }, { successMsg: t('toast.remoteRestarted') });
}

async function updateRemoteFlow(hostId) {
  const ok = await confirmDialogAsync({
    title: t('confirm.updateRemoteTitle'),
    message: t('confirm.updateRemoteMsg'),
    confirmLabel: t('action.updateRemote'),
  });
  if (!ok) return;
  return runAction(async () => {
    await api.updateRemoteDsh(hostId);
    await refresh();
  }, { successMsg: t('toast.remoteUpdated') });
}

// --- Delete ---

async function deleteHostFlow(hostId) {
  const host = hostFor(hostId);
  if (!host) return;
  if (hosts.length <= 1) return;
  const ok = await confirmDialogAsync({
    title: t('confirm.deleteTitle'),
    message: t('confirm.deleteMsg', { name: host.name }),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  return runAction(async () => {
    await api.deleteHost(hostId);
    destroyWebview(hostId);
    hosts = hosts.filter(h => h.id !== hostId);
    if (selectedHostId === hostId) {
      selectedHostId = hosts.length > 0 ? hosts[0].id : null;
      if (selectedHostId) void api.setActiveHost(selectedHostId).catch(() => {});
    }
    await refresh();
  }, { successMsg: t('toast.deleted', { name: host.name }) });
}

// --- Refresh + snapshot merge ---

function mergeSnapshot(hostId, snap) {
  const current = snapshots[hostId];
  if (!current || (snap.revision ?? 0) >= (current.revision ?? 0)) snapshots[hostId] = snap;
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
    if ((!selectedHostId || !hostFor(selectedHostId)) && hosts.length > 0) {
      selectedHostId = hosts[0].id;
      void api.setActiveHost(selectedHostId).catch(err => console.error('[host-manager] setActiveHost failed:', err));
    }
    reconcileWebviews();
    renderAll();
    updateAddDialog();
    if (state.warning) toast(state.warning, 'error', 8000);
  } catch (err) {
    console.error('[host-manager] refresh failed:', err);
    toast(t('toast.refreshFailed', { msg: errMessage(err) }), 'error');
  }
}

// --- Accessible menu (role=menu) ---

let menuEl = null;
let menuTrigger = null;
let menuItemEls = [];

function ensureMenu() {
  if (menuEl) return;
  menuEl = document.createElement('div');
  menuEl.id = 'context-menu';
  menuEl.className = 'context-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-label', t('a11y.menu'));
  document.body.appendChild(menuEl);

  menuEl.addEventListener('keydown', onMenuKeydown);
}

function buildMenuItems(hostId) {
  const host = hostFor(hostId);
  const snap = snapFor(hostId);
  const state = snap.state || 'idle';
  const connected = state === 'connected';
  const errored = state === 'error';
  const idle = state === 'idle';
  const isRemote = host?.type === 'remote';
  const items = [];

  if (connected) items.push({ label: t('action.disconnect'), action: () => disconnectHost(hostId) });
  else if (idle) items.push({ label: t('action.connect'), action: () => connectHost(hostId) });
  else if (errored) items.push({ label: t('action.retry'), action: () => connectHost(hostId) });

  if (isRemote) {
    if (snap.remoteDsh?.running) items.push({ label: t('action.stopRemote'), action: () => stopRemoteFlow(hostId) });
    items.push({ label: t('action.restartRemote'), action: () => restartRemoteFlow(hostId) });
    if (connected && snap.needsUpdate) items.push({ label: t('action.updateRemote'), action: () => updateRemoteFlow(hostId) });
  }

  if (items.length) items.push({ separator: true });
  items.push({ label: t('action.edit'), action: () => openEditDialog(hostId) });
  items.push({ label: t('action.refresh'), action: () => refresh() });

  if (hosts.length > 1) {
    items.push({ separator: true });
    items.push({ label: t('action.delete'), danger: true, action: () => deleteHostFlow(hostId) });
  }
  return items;
}

function openMenu(items, { x, y, trigger }) {
  ensureMenu();
  menuTrigger = trigger || null;
  menuEl.innerHTML = '';
  menuItemEls = [];

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      sep.setAttribute('role', 'separator');
      menuEl.appendChild(sep);
      continue;
    }
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `context-menu-item${item.danger ? ' danger' : ''}`;
    el.setAttribute('role', 'menuitem');
    el.setAttribute('tabindex', '-1');
    el.textContent = item.label;
    if (item.disabled) el.setAttribute('aria-disabled', 'true');
    el.addEventListener('click', () => {
      closeMenu(false);
      if (!item.disabled && item.action) item.action();
    });
    el.addEventListener('mouseenter', () => el.focus());
    menuEl.appendChild(el);
    menuItemEls.push(el);
  }

  menuEl.classList.add('visible');
  if (menuTrigger) menuTrigger.setAttribute('aria-expanded', 'true');

  // Position: prefer explicit x/y (context menu), else anchor under trigger.
  const rect = menuEl.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left == null && trigger) {
    const tr = trigger.getBoundingClientRect();
    left = tr.right - rect.width;
    top = tr.bottom + 4;
  }
  const w = rect.width || 180;
  const h = rect.height || 200;
  if (left + w > window.innerWidth) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight) top = window.innerHeight - h - 8;
  menuEl.style.left = `${Math.max(8, left)}px`;
  menuEl.style.top = `${Math.max(8, top)}px`;

  menuItemEls[0]?.focus();
}

function closeMenu(returnFocus = true) {
  if (!menuEl || !menuEl.classList.contains('visible')) return;
  menuEl.classList.remove('visible');
  if (menuTrigger) {
    menuTrigger.setAttribute('aria-expanded', 'false');
    if (returnFocus && typeof menuTrigger.focus === 'function') menuTrigger.focus();
  }
  menuTrigger = null;
  menuItemEls = [];
}

function onMenuKeydown(e) {
  const idx = menuItemEls.indexOf(document.activeElement);
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); menuItemEls[(idx + 1) % menuItemEls.length]?.focus(); break;
    case 'ArrowUp': e.preventDefault(); menuItemEls[(idx - 1 + menuItemEls.length) % menuItemEls.length]?.focus(); break;
    case 'Home': e.preventDefault(); menuItemEls[0]?.focus(); break;
    case 'End': e.preventDefault(); menuItemEls[menuItemEls.length - 1]?.focus(); break;
    case 'Escape': e.preventDefault(); closeMenu(true); break;
    case 'Tab': e.preventDefault(); closeMenu(true); break;
    default: break;
  }
}

moreBtn.addEventListener('click', () => {
  if (menuEl && menuEl.classList.contains('visible')) { closeMenu(true); return; }
  if (!selectedHostId) return;
  openMenu(buildMenuItems(selectedHostId), { trigger: moreBtn });
});

document.addEventListener('mousedown', e => {
  if (menuEl && menuEl.classList.contains('visible') && !menuEl.contains(e.target) && e.target !== moreBtn) {
    closeMenu(false);
  }
});

// --- Config dialog (shared add + edit draft form) ---

function resetFieldErrors() {
  cfgFormErr.hidden = true;
  cfgFormErr.textContent = '';
  for (const id of ['cfg-name', 'cfg-host', 'cfg-username', 'cfg-ssh-port', 'cfg-identity-file']) {
    const input = document.getElementById(id);
    const errEl = document.getElementById(`${id}-err`);
    input.removeAttribute('aria-invalid');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  }
}

function setFieldError(inputId, message) {
  const input = document.getElementById(inputId);
  const errEl = document.getElementById(`${inputId}-err`);
  input.setAttribute('aria-invalid', 'true');
  if (errEl) { errEl.textContent = message; errEl.hidden = false; }
}

function applyDraftVisibility(type) {
  const isRemote = type === 'remote';
  cfgSsh.hidden = !isRemote;
  cfgSshPolicy.hidden = !isRemote;
  cfgStartup.hidden = !isRemote;
}

function openAddDialogForType(type) {
  configDraft = { mode: 'add', type, hostId: null };
  resetFieldErrors();
  configTitle.textContent = type === 'remote' ? t('config.addRemoteTitle') : t('config.addLocalTitle');
  cfgIcon.textContent = type === 'remote' ? '🌐' : '🖥️';
  cfgName.value = type === 'local' ? t('env.local') : '';
  cfgHost.value = '';
  cfgUsername.value = '';
  cfgSshPort.value = '22';
  cfgIdentityFile.value = '';
  cfgHostKeyPolicy.value = 'accept-new';
  cfgAutoStart.checked = true;
  cfgAutoStop.checked = true;
  cfgAutoInstall.checked = true;
  applyDraftVisibility(type);
  configDialog.showModal();
  (type === 'remote' ? cfgHost : cfgName).focus();
}

function openEditDialog(hostId) {
  const host = hostFor(hostId);
  if (!host) { toast(t('placeholder.selectDesc'), 'info'); return; }
  selectHost(hostId);
  const type = host.type;
  configDraft = { mode: 'edit', type, hostId };
  resetFieldErrors();
  configTitle.textContent = type === 'remote' ? t('config.editRemoteTitle') : t('config.editLocalTitle');
  cfgIcon.textContent = host.icon || (type === 'remote' ? '🌐' : '🖥️');
  cfgName.value = host.name || '';
  if (type === 'remote') {
    cfgHost.value = host.host || '';
    cfgUsername.value = host.username || '';
    cfgSshPort.value = host.sshPort || 22;
    cfgIdentityFile.value = host.identityFile || '';
    cfgHostKeyPolicy.value = host.hostKeyPolicy || 'accept-new';
    cfgAutoStart.checked = host.autoStartRemoteDsh ?? true;
    cfgAutoStop.checked = host.autoStopRemoteDsh ?? true;
    cfgAutoInstall.checked = host.autoInstallRemoteDsh ?? true;
  }
  applyDraftVisibility(type);
  configDialog.showModal();
  cfgName.focus();
}

// Local mirror of host-store validation (main is authoritative).
function isValidHostname(h) {
  if (!h || h.length > 253) return false;
  if (/[\s\x00-\x1f/@]/.test(h)) return false;
  if (h.startsWith('-')) return false;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(h)) return true;
  if (h.includes(':') && /^[0-9a-fA-F:]+$/.test(h)) return true; // IPv6-ish
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(h);
}

function isAbsolutePath(p) {
  if (api.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  return p.startsWith('/');
}

function validateDraft(type) {
  resetFieldErrors();
  let firstInvalid = null;
  const fail = (inputId, msg) => {
    setFieldError(inputId, msg);
    if (!firstInvalid) firstInvalid = document.getElementById(inputId);
  };

  const name = cfgName.value.trim();
  if (!name) fail('cfg-name', t('err.nameRequired'));

  if (type === 'remote') {
    const host = cfgHost.value.trim();
    const username = cfgUsername.value.trim();
    const port = Number(cfgSshPort.value);
    const identity = cfgIdentityFile.value.trim();

    if (!host) fail('cfg-host', t('err.hostRequired'));
    else if (!isValidHostname(host)) fail('cfg-host', t('err.hostInvalid'));

    if (!username) fail('cfg-username', t('err.usernameRequired'));
    else if (!/^[A-Za-z0-9._-]+$/.test(username) || username.length > 64) fail('cfg-username', t('err.usernameInvalid'));

    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('cfg-ssh-port', t('err.portInvalid'));

    if (identity && !isAbsolutePath(identity)) fail('cfg-identity-file', t('err.identityAbsolute'));
  }

  if (firstInvalid) { firstInvalid.focus(); return null; }

  // Build a clean object with ONLY the keys main accepts for the type.
  if (type === 'local') {
    return { type: 'local', name, icon: cfgIcon.textContent.trim() || '🖥️' };
  }
  const identity = cfgIdentityFile.value.trim();
  return {
    type: 'remote',
    name,
    icon: cfgIcon.textContent.trim() || '🌐',
    host: cfgHost.value.trim(),
    username: cfgUsername.value.trim(),
    sshPort: Number(cfgSshPort.value),
    identityFile: identity ? identity : null,
    hostKeyPolicy: cfgHostKeyPolicy.value,
    autoStartRemoteDsh: cfgAutoStart.checked,
    autoStopRemoteDsh: cfgAutoStop.checked,
    autoInstallRemoteDsh: cfgAutoInstall.checked,
  };
}

configForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!configDraft) return;
  const { mode, type, hostId } = configDraft;
  const draft = validateDraft(type);
  if (!draft) return; // inline errors shown

  const successMsg = mode === 'add' ? t('toast.added', { name: draft.name }) : t('toast.saved');

  runAction(async () => {
    if (mode === 'add') {
      const created = await api.addHost(draft); // main assigns id
      configDialog.close();
      configDraft = null;
      await refresh();
      if (created?.id) selectHost(created.id);
      return created;
    }
    // edit — spread only the clean draft plus the id main needs to locate the host
    const updated = { ...draft, id: hostId };
    await api.updateHost(updated);
    configDialog.close();
    configDraft = null;
    await refresh();
    return updated;
  }, {
    successMsg,
    errorMsg: err => {
      // Keep dialog open; surface the error inside the form (dialog is in the top
      // layer and covers the toast region). Return falsy to suppress a duplicate toast.
      cfgFormErr.textContent = t('toast.failed', { msg: errMessage(err) });
      cfgFormErr.hidden = false;
      return null;
    },
  });
});

$('#cancel-config-btn').addEventListener('click', () => { configDialog.close(); });
configDialog.addEventListener('close', () => { configDraft = null; });
configDialog.addEventListener('cancel', () => { configDraft = null; }); // native Esc: no data written

// Emoji picker inside config dialog
$('#cfg-icon-btn').addEventListener('click', () => {
  let picker = configDialog.querySelector('.emoji-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.className = 'emoji-picker';
    picker.setAttribute('role', 'listbox');
    picker.setAttribute('aria-label', t('a11y.iconPicker'));
    for (const emoji of EMOJI_LIST) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'emoji-option';
      opt.dataset.emoji = emoji;
      opt.textContent = emoji;
      opt.setAttribute('aria-label', emoji);
      picker.appendChild(opt);
    }
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
  if (picker.classList.contains('visible')) {
    setTimeout(() => {
      const close = ev => {
        if (!picker.contains(ev.target) && ev.target !== $('#cfg-icon-btn')) {
          picker.classList.remove('visible');
          document.removeEventListener('mousedown', close);
        }
      };
      document.addEventListener('mousedown', close);
    }, 0);
  }
});

// --- Add-type dialog ---

addEnvBtn.addEventListener('click', () => addDialog.showModal());
$('#cancel-add-btn').addEventListener('click', () => addDialog.close());

addDialog.querySelectorAll('.add-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    addDialog.close();
    openAddDialogForType(type);
  });
});

function updateAddDialog() {
  const hasLocal = hosts.some(h => h.type === 'local');
  const localBtn = addDialog.querySelector('[data-type="local"]');
  if (localBtn) localBtn.hidden = hasLocal;
}

// --- Keyboard: tablist roving + global accelerators ---

function anyModalOpen() {
  return !!document.querySelector('dialog[open]');
}

envList.addEventListener('keydown', e => {
  if (!hosts.length) return;
  const idx = hosts.findIndex(h => h.id === selectedHostId);
  let nextIdx = null;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': nextIdx = (idx + 1) % hosts.length; break;
    case 'ArrowLeft': case 'ArrowUp': nextIdx = (idx - 1 + hosts.length) % hosts.length; break;
    case 'Home': nextIdx = 0; break;
    case 'End': nextIdx = hosts.length - 1; break;
    case 'Enter': case ' ': e.preventDefault(); selectHost(selectedHostId); focusActiveTab(); return;
    default: return;
  }
  e.preventDefault();
  selectHost(hosts[nextIdx].id);
  focusActiveTab();
});

document.addEventListener('keydown', e => {
  if (anyModalOpen() || (menuEl && menuEl.classList.contains('visible'))) return;

  const accel = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
  if (accel && /^[1-9]$/.test(e.key)) {
    const n = parseInt(e.key, 10);
    if (hosts[n - 1]) {
      e.preventDefault();
      selectHost(hosts[n - 1].id);
      focusActiveTab();
    }
    return;
  }

  // Ctrl+Tab / Ctrl+Shift+Tab: cycle
  if (e.ctrlKey && e.key === 'Tab' && hosts.length > 0) {
    e.preventDefault();
    const idx = hosts.findIndex(h => h.id === selectedHostId);
    const next = e.shiftKey
      ? (idx <= 0 ? hosts.length - 1 : idx - 1)
      : (idx >= hosts.length - 1 ? 0 : idx + 1);
    selectHost(hosts[next].id);
    focusActiveTab();
  }
});

// --- Status + refresh listeners ---

api.onStatus((hostId, snapshot) => {
  const current = snapshots[hostId];
  if (current && (snapshot.revision ?? 0) < (current.revision ?? 0)) return;
  snapshots[hostId] = snapshot;
  reconcileWebviews();
  renderAll();
  updateAddDialog();
});

api.onRefresh(() => refresh());

// --- Application menu commands (main process dispatches over host:command) ---

function cycleEnvironment(delta) {
  if (!hosts.length) return;
  const idx = hosts.findIndex(h => h.id === selectedHostId);
  const base = idx < 0 ? 0 : idx;
  const next = (base + delta + hosts.length) % hosts.length;
  selectHost(hosts[next].id);
  focusActiveTab();
}

const MENU_COMMANDS = {
  'new-environment': () => { if (!isBusy) addDialog.showModal(); },
  'dsh-settings': () => { const wv = webviews.get(selectedHostId); if (wv) wv.focus?.(); else toast(t('toast.connectFirst'), 'info'); },
  'reconnect': () => { if (selectedHostId && hostFor(selectedHostId)) reconnectHost(selectedHostId); },
  'previous-environment': () => cycleEnvironment(-1),
  'next-environment': () => cycleEnvironment(1),
  'refresh-webview': () => { if (selectedHostId) reloadWebview(selectedHostId); },
  'inspect-webview': () => {
    const wv = selectedHostId ? webviews.get(selectedHostId) : null;
    if (!wv) { toast(t('toast.connectFirst'), 'info'); return; }
    if (wv.isDevToolsOpened?.()) wv.closeDevTools?.();
    else wv.openDevTools?.();
  },
  'select-host': payload => { const id = payload && payload.hostId; if (id && hostFor(id)) selectHost(id); },
};

if (typeof api.onCommand === 'function') {
  api.onCommand((command, payload) => {
    const handler = MENU_COMMANDS[command];
    if (handler) handler(payload);
  });
}

window.addEventListener('resize', applyCompactSwitcher);

// --- Init ---

applyStaticI18n();
refresh();
