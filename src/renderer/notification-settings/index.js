const api = window.desktopNotifications;
const $ = selector => document.querySelector(selector);
let strings = {};

function readForm() {
  return {
    schemaVersion: 1,
    enabled: $('#enabled').checked,
    agentCompletions: $('#agent').checked,
    backgroundJobs: {
      completed: $('#completed').checked,
      failed: $('#failed').checked,
      killed: $('#killed').checked,
    },
    onlyWhenUnfocused: $('#unfocused').checked,
    playSound: $('#sound').checked,
    focusOnClick: $('#focus').checked,
  };
}

const LABEL_MAP = {
  title: 'title', description: 'description',
  'label-enabled': 'enabled', 'label-agent': 'agent', 'label-jobs': 'jobs',
  'label-completed': 'completed', 'label-failed': 'failed', 'label-killed': 'killed',
  'label-unfocused': 'unfocused', 'label-sound': 'sound', 'label-focus': 'focus',
  save: 'save', test: 'test', 'system-settings': 'systemSettings',
};

function localize(state) {
  strings = state.strings || strings;
  document.documentElement.lang = state.locale || 'zh';
  for (const [id, key] of Object.entries(LABEL_MAP)) if (strings[key]) $('#' + id).textContent = strings[key];
  document.title = strings.title || document.title;
}

function apply(state) {
  localize(state);
  const s = state.settings;
  $('#enabled').checked = s.enabled;
  $('#agent').checked = s.agentCompletions;
  $('#completed').checked = s.backgroundJobs.completed;
  $('#failed').checked = s.backgroundJobs.failed;
  $('#killed').checked = s.backgroundJobs.killed;
  $('#unfocused').checked = s.onlyWhenUnfocused;
  $('#sound').checked = s.playSound;
  $('#focus').checked = s.focusOnClick;
  $('#warning').hidden = !state.warning;
  $('#warning').textContent = state.warning || '';
}

async function refresh() {
  try { apply(await api.getSettings()); }
  catch (error) { $('#status').textContent = error.message; }
}

function diagnostic(result) {
  if (result.outcome === 'shown') return strings.diagShown || '';
  if (result.outcome === 'failed') return `${strings.diagFailed || ''} ${result.error || ''}`.trim();
  if (result.outcome === 'unconfirmed') return strings.diagUnconfirmed || '';
  if (result.outcome === 'unsupported') return strings.diagUnsupported || '';
  return result.suppressionReason || result.outcome || '';
}

$('#form').addEventListener('submit', async event => {
  event.preventDefault();
  try { apply(await api.saveSettings(readForm())); $('#status').textContent = strings.saved || 'Saved'; }
  catch (error) { $('#status').textContent = error.message; }
});

$('#test').addEventListener('click', async () => {
  try {
    $('#status').textContent = strings.testing || '';
    const result = await api.test(readForm());
    $('#status').textContent = diagnostic(result);
  } catch (error) { $('#status').textContent = error.message; }
});

$('#system-settings').addEventListener('click', () => void api.openSystemSettings());

api.onRefresh(refresh);
api.onLocaleChanged(localize);
void refresh();
