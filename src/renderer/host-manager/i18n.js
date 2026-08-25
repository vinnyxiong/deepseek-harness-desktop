// Renderer-only i18n helper for the host manager window.
//
// The main process will eventually push a locale (see locale-service.js), but
// per the current task this renderer must NOT depend on it. We resolve the
// language purely from navigator.language and fall back to English for any
// non-Chinese locale. Exposed on window.HMI18n so the classic (non-module)
// index.js script can consume it without a bundler.
(() => {
  'use strict';

  const DICTS = {
    zh: {
      'app.title': 'DeepSeek Harness',

      // Environment types
      'env.local': '本机',
      'env.remote': '远程',
      'env.localFull': '本机环境',
      'env.remoteFull': '远程环境',

      // Status (text, never color-only)
      'status.idle': '未连接',
      'status.connecting': '连接中',
      'status.connected': '已连接',
      'status.error': '连接失败',

      // Progress phase labels (concise; detailed message comes from main)
      'phase.connecting': '正在连接',
      'phase.starting': '正在启动本机 DSH',
      'phase.health-check': '正在检查服务状态',
      'phase.remote-start': '正在启动远程 DSH',
      'phase.ssh-tunnel': '正在建立 SSH 隧道',
      'phase.remote-transferring': '正在传输远程 DSH',
      'phase.connected': '已连接',

      'update.available': '有可用更新',
      'update.tooltip': '远程 DSH 版本过旧，点击更新',

      // Actions
      'action.connect': '连接',
      'action.disconnect': '断开',
      'action.retry': '重试',
      'action.edit': '编辑',
      'action.more': '更多操作',
      'action.refresh': '刷新',
      'action.delete': '删除环境',
      'action.restartRemote': '重启远程 DSH',
      'action.stopRemote': '停止远程 DSH',
      'action.updateRemote': '更新远程 DSH',
      'action.reload': '重新加载',
      'action.reconnect': '重新连接',
      'action.viewLog': '查看远程日志',

      // Add dialog
      'add.title': '添加环境',
      'add.desc': '选择要添加的环境类型',
      'add.local.title': '本机',
      'add.local.desc': '在本地启动 DSH',
      'add.remote.title': '远程服务器',
      'add.remote.desc': '通过 SSH 连接远程 DSH',

      // Config dialog
      'config.addLocalTitle': '添加本机环境',
      'config.addRemoteTitle': '添加远程环境',
      'config.editLocalTitle': '编辑本机环境',
      'config.editRemoteTitle': '编辑远程环境',

      // Fields
      'field.icon': '图标',
      'field.iconChange': '更换图标',
      'field.name': '名称',
      'field.namePlaceholder': '我的服务器',
      'field.host': '主机',
      'field.hostPlaceholder': '10.0.0.1',
      'field.username': '用户',
      'field.usernamePlaceholder': 'root',
      'field.sshPort': 'SSH 端口',
      'field.identityFile': '私钥路径',
      'field.optional': '可选',
      'field.identityFilePlaceholder': '/home/name/.ssh/id_ed25519',
      'field.hostKeyPolicy': '主机密钥验证',
      'policy.acceptNew': '首次自动接受',
      'policy.strict': '仅已知主机',
      'opt.autoStart': '连接时自动启动远程 DSH',
      'opt.autoStop': '断开时自动停止远程 DSH',
      'opt.autoInstall': '自动传输远程 DSH',

      // Buttons
      'common.save': '保存',
      'common.cancel': '取消',
      'common.confirm': '确定',
      'common.close': '关闭',
      'common.delete': '删除',

      // Validation errors
      'err.nameRequired': '请输入名称',
      'err.hostRequired': '请输入主机地址',
      'err.hostInvalid': '主机地址无效（需为 IP、域名或 SSH 别名）',
      'err.usernameRequired': '请输入用户名',
      'err.usernameInvalid': '用户名只能包含字母、数字、点、下划线或连字符',
      'err.portInvalid': '端口需为 1–65535 之间的整数',
      'err.identityAbsolute': '私钥路径必须是绝对路径',

      // Confirm dialogs
      'confirm.deleteTitle': '删除环境',
      'confirm.deleteMsg': '确定要删除“{name}”吗？此操作无法撤销。',
      'confirm.stopRemoteTitle': '停止远程 DSH',
      'confirm.stopRemoteMsg': '确定要停止远程 DSH 吗？SSH 隧道也会一并断开。',
      'confirm.updateRemoteTitle': '更新远程 DSH',
      'confirm.updateRemoteMsg': '确定要更新远程 DSH 吗？更新过程中连接会暂时中断。',

      // Toasts
      'toast.connected': '已连接到 {name}',
      'toast.disconnected': '已断开 {name}',
      'toast.added': '已添加 {name}',
      'toast.saved': '配置已保存',
      'toast.deleted': '已删除 {name}',
      'toast.remoteStopped': '远程 DSH 已停止',
      'toast.remoteRestarted': '远程 DSH 已重启',
      'toast.remoteUpdated': '远程 DSH 已更新',
      'toast.failed': '操作失败：{msg}',
      'toast.connectFailed': '连接失败：{msg}',
      'toast.refreshFailed': '刷新失败：{msg}',
      'toast.busy': '正在处理，请稍候…',

      // Placeholder / recovery
      'placeholder.selectTitle': '选择一个环境',
      'placeholder.selectDesc': '在上方切换栏选择环境并连接',
      'placeholder.idleDesc': '点击连接开始使用',
      'placeholder.connectingDesc': '正在连接，请稍候…',
      'placeholder.errorTitle': '连接失败',
      'webview.failedTitle': '页面加载失败',
      'webview.crashedTitle': '页面已崩溃',
      'webview.unresponsiveTitle': '页面无响应',
      'webview.recoverDesc': '可尝试重新加载页面，或断开后重新连接。',

      // Window controls / a11y
      'win.minimize': '最小化',
      'win.maximize': '最大化',
      'win.restore': '还原',
      'win.close': '关闭',
      'a11y.switcher': '环境切换',
      'a11y.envActions': '当前环境操作',
      'a11y.menu': '环境操作菜单',
      'a11y.addEnv': '添加环境',
      'a11y.tab': '{name}（{type}，{status}）',
      'a11y.iconPicker': '选择图标',
    },

    en: {
      'app.title': 'DeepSeek Harness',

      'env.local': 'Local',
      'env.remote': 'Remote',
      'env.localFull': 'Local environment',
      'env.remoteFull': 'Remote environment',

      'status.idle': 'Not connected',
      'status.connecting': 'Connecting',
      'status.connected': 'Connected',
      'status.error': 'Connection failed',

      'phase.connecting': 'Connecting',
      'phase.starting': 'Starting local DSH',
      'phase.health-check': 'Checking service health',
      'phase.remote-start': 'Starting remote DSH',
      'phase.ssh-tunnel': 'Establishing SSH tunnel',
      'phase.remote-transferring': 'Transferring remote DSH',
      'phase.connected': 'Connected',

      'update.available': 'Update available',
      'update.tooltip': 'Remote DSH is outdated — click to update',

      'action.connect': 'Connect',
      'action.disconnect': 'Disconnect',
      'action.retry': 'Retry',
      'action.edit': 'Edit',
      'action.more': 'More actions',
      'action.refresh': 'Refresh',
      'action.delete': 'Delete environment',
      'action.restartRemote': 'Restart remote DSH',
      'action.stopRemote': 'Stop remote DSH',
      'action.updateRemote': 'Update remote DSH',
      'action.reload': 'Reload',
      'action.reconnect': 'Reconnect',
      'action.viewLog': 'View remote log',

      'add.title': 'Add environment',
      'add.desc': 'Choose the type of environment to add',
      'add.local.title': 'Local',
      'add.local.desc': 'Start DSH locally',
      'add.remote.title': 'Remote server',
      'add.remote.desc': 'Connect to remote DSH over SSH',

      'config.addLocalTitle': 'Add local environment',
      'config.addRemoteTitle': 'Add remote environment',
      'config.editLocalTitle': 'Edit local environment',
      'config.editRemoteTitle': 'Edit remote environment',

      'field.icon': 'Icon',
      'field.iconChange': 'Change icon',
      'field.name': 'Name',
      'field.namePlaceholder': 'My server',
      'field.host': 'Host',
      'field.hostPlaceholder': '10.0.0.1',
      'field.username': 'User',
      'field.usernamePlaceholder': 'root',
      'field.sshPort': 'SSH port',
      'field.identityFile': 'Private key path',
      'field.optional': 'optional',
      'field.identityFilePlaceholder': '/home/name/.ssh/id_ed25519',
      'field.hostKeyPolicy': 'Host key verification',
      'policy.acceptNew': 'Accept on first use',
      'policy.strict': 'Known hosts only',
      'opt.autoStart': 'Auto-start remote DSH on connect',
      'opt.autoStop': 'Auto-stop remote DSH on disconnect',
      'opt.autoInstall': 'Auto-transfer remote DSH',

      'common.save': 'Save',
      'common.cancel': 'Cancel',
      'common.confirm': 'Confirm',
      'common.close': 'Close',
      'common.delete': 'Delete',

      'err.nameRequired': 'Please enter a name',
      'err.hostRequired': 'Please enter a host',
      'err.hostInvalid': 'Invalid host (use an IP, DNS name, or SSH alias)',
      'err.usernameRequired': 'Please enter a username',
      'err.usernameInvalid': 'Username may only contain letters, digits, dot, underscore or hyphen',
      'err.portInvalid': 'Port must be an integer between 1 and 65535',
      'err.identityAbsolute': 'Private key path must be absolute',

      'confirm.deleteTitle': 'Delete environment',
      'confirm.deleteMsg': 'Delete “{name}”? This cannot be undone.',
      'confirm.stopRemoteTitle': 'Stop remote DSH',
      'confirm.stopRemoteMsg': 'Stop remote DSH? The SSH tunnel will also be closed.',
      'confirm.updateRemoteTitle': 'Update remote DSH',
      'confirm.updateRemoteMsg': 'Update remote DSH? The connection will briefly drop during the update.',

      'toast.connected': 'Connected to {name}',
      'toast.disconnected': 'Disconnected {name}',
      'toast.added': 'Added {name}',
      'toast.saved': 'Configuration saved',
      'toast.deleted': 'Deleted {name}',
      'toast.remoteStopped': 'Remote DSH stopped',
      'toast.remoteRestarted': 'Remote DSH restarted',
      'toast.remoteUpdated': 'Remote DSH updated',
      'toast.failed': 'Action failed: {msg}',
      'toast.connectFailed': 'Connection failed: {msg}',
      'toast.refreshFailed': 'Refresh failed: {msg}',
      'toast.busy': 'Working, please wait…',

      'placeholder.selectTitle': 'Select an environment',
      'placeholder.selectDesc': 'Pick an environment from the switcher above and connect',
      'placeholder.idleDesc': 'Click Connect to get started',
      'placeholder.connectingDesc': 'Connecting, please wait…',
      'placeholder.errorTitle': 'Connection failed',
      'webview.failedTitle': 'Page failed to load',
      'webview.crashedTitle': 'Page crashed',
      'webview.unresponsiveTitle': 'Page is not responding',
      'webview.recoverDesc': 'Try reloading the page, or disconnect and reconnect.',

      'win.minimize': 'Minimize',
      'win.maximize': 'Maximize',
      'win.restore': 'Restore',
      'win.close': 'Close',
      'a11y.switcher': 'Environment switcher',
      'a11y.envActions': 'Current environment actions',
      'a11y.menu': 'Environment actions menu',
      'a11y.addEnv': 'Add environment',
      'a11y.tab': '{name} ({type}, {status})',
      'a11y.iconPicker': 'Choose icon',
    },
  };

  function resolveLang() {
    const raw = (typeof navigator !== 'undefined' && navigator.language) || 'en';
    return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  const lang = resolveLang();
  const dict = DICTS[lang] || DICTS.en;

  function t(key, params) {
    let str = dict[key] ?? DICTS.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  }

  // Expose immutable handle for the classic index.js script.
  window.HMI18n = Object.freeze({ lang, t });
  // Reflect language on <html> for CSS / assistive tech.
  try { document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; } catch { /* noop */ }
})();
