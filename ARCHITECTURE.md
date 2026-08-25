# DeepSeek Harness Desktop 架构说明

> 本文基于 2026-08-25 的代码快照整理，聚焦桌面壳、环境（Host）管理、本地/远程连接、嵌入式 DSH Web、通知、数据升级保护与本地持久化。`@deepseek-ai/dsh` 内部插件实现属于外部依赖（当前 `0.1.1-rc.2`），不在本仓库的代码边界内。

## 1. 架构概览

DeepSeek Harness Desktop 是一个 **Electron 桌面控制面（control plane）+ DSH Web 数据面（data plane）** 的组合：

- Electron 主进程负责 环境配置、进程/SSH 生命周期、健康检查、系统通知、菜单与快捷键、自动更新、DSH 升级前数据备份与安全边界。
- 本仓库自带的 Host Manager Renderer 负责多环境切换、连接状态、配置、反馈与 WebView 容器。
- 真正的会话、Workspace、Agent、模型与插件体验由每个环境上的 `dsh web` 提供，并嵌入到隔离的 `<webview>` 中。
- 本地环境由桌面应用拉起随包分发的 DSH；远程环境通过系统 SSH 管理远端 DSH、建立本地转发后再加载 Web UI。

产品心智模型统一为三层：

1. **环境（Environment）**：Agent 在哪里运行（本机 / 远程），代码模型仍称 `Host`。
2. **工作区（Workspace）**：Agent 操作哪份代码，由嵌入式 DSH 管理。
3. **会话（Session）**：用户正在完成的任务，由嵌入式 DSH 管理。

### 1.1 C4 Container 图

```mermaid
C4Container
  title DeepSeek Harness Desktop 容器图

  Person(user, "开发者", "管理本机/远程环境，并运行 Agent 会话")

  System_Boundary(desktop, "DeepSeek Harness Desktop") {
    Container(renderer, "Host Manager Renderer", "HTML/CSS/JavaScript", "环境切换、连接/配置界面、反馈、WebView 容器")
    Container(preload, "Preload Bridge", "Electron contextBridge", "暴露最小化 Host API 与菜单命令订阅")
    Container(main, "Electron Main", "Node.js / Electron", "生命周期、环境状态机、IPC 鉴权、菜单、通知、数据保护、更新")
    ContainerDb(settings, "desktop-settings.json", "本地 JSON, 0600", "环境配置和 schemaVersion")
    ContainerDb(dshdata, ".dsh + .dsh-backups", "本地文件", "本地 DSH 数据与升级前版本化备份")
    Container(localDsh, "Bundled DSH Web", "@deepseek-ai/dsh 0.1.1-rc.2", "本地 Session/Workspace/Agent/插件与 Web UI")
  }

  System_Ext(ssh, "系统 SSH 客户端", "认证、Host Key 校验和端口转发")
  System_Ext(remoteDsh, "远程 DSH", "远程服务器上的 dsh web")
  System_Ext(os, "桌面操作系统", "窗口、菜单、原生通知、文件系统、更新安装")

  Rel(user, renderer, "管理环境、使用嵌入式 DSH")
  Rel(renderer, preload, "调用 window.desktopHosts")
  Rel(preload, main, "ipcRenderer.invoke / IPC 事件 / 菜单命令")
  Rel(main, settings, "校验、迁移、原子读写")
  Rel(main, dshdata, "版本变化时原子备份 .dsh")
  Rel(main, localDsh, "spawn / stop / health probe")
  Rel(renderer, localDsh, "隔离 WebView 加载 loopback URL")
  Rel(main, ssh, "参数数组启动并管理")
  Rel(ssh, remoteDsh, "SSH 命令与本地端口转发")
  Rel(renderer, remoteDsh, "经 127.0.0.1 隧道加载 Web UI")
  Rel(main, os, "BrowserWindow、菜单、原生通知、自动更新")
```

### 1.2 进程与信任边界

```mermaid
flowchart LR
  subgraph Trusted[受信任桌面层]
    Main[Electron Main]
    Preload[Sandboxed Preload Bridge]
    Renderer[Host Manager Renderer]
    Store[(desktop-settings.json)]
    Guard[DSH Data Guard]
  end

  subgraph Isolated[隔离内容层]
    WV1[WebView: 本机环境\npersist:dsh-local]
    WV2[WebView: 远程环境\npersist:dsh-hostId]
  end

  subgraph Runtime[运行时服务]
    Local[dsh web --port 0]
    Tunnel[SSH Tunnel]
    Remote[Remote dsh web]
  end

  Renderer --> Preload -->|白名单 IPC + 菜单命令| Main
  Main --> Store
  Main --> Guard --> Local
  Main --> Tunnel --> Remote
  Renderer --> WV1 -->|loopback HTTP| Local
  Renderer --> WV2 -->|loopback HTTP| Tunnel
```

安全特征：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；Preload 仅暴露 `desktopHosts` 白名单方法（含只读 `onCommand`）；IPC 校验发送窗口、主 frame 和 URL；每个环境独立持久化 partition；禁止外部窗口/主框架导航；SSH 认证委托系统 SSH，不保存密码或私钥口令；原生通知只在主进程创建。

## 2. 代码组织与模块职责

### 2.1 主进程

| 模块 | 职责 | 公开接口/事件 |
|---|---|---|
| `src/main.js` | Composition Root；初始化 Store、Window、HostManager、通知、语言、菜单、数据保护与退出清理 | `initialize()`、`buildMenu()`、`syncIntegrations()` |
| `src/main/windows.js` | Host Manager 主窗口、安全 WebPreferences、标题栏、菜单命令下发 `host:command`、通知设置窗口 | `createWindowManager()`、`showHostManager()`、`sendCommand()`、`showNotificationSettings()` |
| `src/main/host-manager.js` | 环境连接状态机；连接/断开、本地/远程、健康监测、版本检查与更新 | `connect()`、`disconnect()`、`getSnapshot()`、`updateRemoteDsh()`；`status` 事件 |
| `src/main/host-store.js` | 环境配置模型、校验、v2→v3 迁移与原子持久化 | `createHostStore()`、`validateHost()`、`validateSettings()` |
| `src/main/dsh-data-guard.js` | 本地 DSH 版本切换前对 `.dsh` 做一次性原子备份，失败阻止启动 | `guardDshData()` |
| `src/main/ipc.js` | Renderer→Main 的 IPC 白名单、鉴权与串行事务 | `registerHostIpc()` |
| `src/main/connection-actions.js` | 将修改连接/配置的异步操作串行化 | `run()`、`idle()` |
| `src/main/local-dsh.js` / `managed-ssh.js` / `remote-dsh.js` | 本地进程启动 / SSH 隧道 / 远端发现·安装·启动·停止·更新 | 各生命周期函数 |
| `src/main/dsh-health.js` / `dsh-api-client.js` | DSH loopback 健康探测 / API 调用 | `waitForDsh()`、`probeDsh()`、`callDsh()` |
| `src/main/completion-watcher.js` | 订阅 Host/Mux 事件，基线化并发完成通知 | `CompletionWatcher` |
| `src/main/notification-service.js` / `notification-settings-store.js` / `notification-ipc.js` | 原生任务完成通知、设置存储与 IPC | `NotificationService`、`createNotificationSettingsStore()`、`registerNotificationIpc()` |
| `src/main/locale-service.js` / `i18n.js` | 跟随 DSH/system 语言并刷新菜单与通知文案 | `LocaleService`、`translate()` |
| `src/main/auto-updater.js` | 打包版本 GitHub 自动更新 | `initAutoUpdater()` |

### 2.2 Renderer 与桥接

| 模块 | 职责 |
|---|---|
| `src/preload/host-manager.js` | 暴露 Host API、窗口控制、状态订阅、菜单命令订阅 `onCommand` |
| `src/preload/notification-settings.js` | 通知设置窗口的受限 API |
| `src/renderer/host-manager/index.html` / `index.css` / `index.js` | 环境切换栏、显式操作区、反馈 toast/banner、共用新增/编辑表单、ARIA 与键盘、视觉系统 |
| `src/renderer/host-manager/i18n.js` | Renderer 侧 zh/en 字典，按 `navigator.language` 回退 |
| `src/renderer/host-manager/webview-lifecycle.js` | 纯逻辑 WebView LRU 生命周期控制器（none/active/hidden/evicted/crashed） |
| `src/renderer/notification-settings/*` | 通知设置界面 |

### 2.3 Renderer → Main 接口

- 查询/选择：`host:get-state`、`host:set-active`
- 配置 CRUD：`host:add`、`host:update`、`host:delete`
- 连接：`host:connect`、`host:disconnect`
- 远程运维：`host:remote-dsh-restart|stop|version|log|process-details|config|update`
- 推送：`host:status`、`host:refresh`、`host:command`（菜单命令：`new-environment`/`environment-settings`/`dsh-settings`/`reconnect`/`previous-environment`/`next-environment`/`refresh-webview`/`select-host`）
- 窗口：`window:minimize|maximize|close`、`window:state`
- 通知：设置读写/测试/打开系统设置

## 3. 关键调用关系

### 3.1 启动、数据保护与本地环境自动连接

```mermaid
sequenceDiagram
  actor U as 用户
  participant A as Electron App
  participant S as HostStore
  participant G as DSH Data Guard
  participant H as HostManager
  participant D as Bundled DSH
  participant R as Host Renderer

  U->>A: 启动应用
  A->>S: load(desktop-settings.json)
  S-->>A: hosts + migration warning
  A->>H: setHosts(hosts)
  A->>R: showHostManager + loadFile(index.html)
  A->>H: connect(localHost)
  H->>G: guardDshData(userData, .dsh)
  alt DSH 版本变化且有旧数据
    G->>G: 原子备份 .dsh → .dsh-backups/<oldVer>-<ts>
    G-->>H: 备份成功，写 marker
  else 版本未变 / 首次
    G-->>H: 直接放行（仅记录版本）
  end
  H->>D: spawn dsh web --port 0
  D-->>H: loopback URL
  H->>D: health probe
  H-->>R: host:status(connected, endpoint)
  R->>R: 创建 per-env WebView
```

若备份失败，`guardDshData` 抛错并阻止本地 DSH 启动，marker 不写，下次启动重试，避免破坏旧数据。

### 3.2 远程环境连接

```mermaid
sequenceDiagram
  actor U as 用户
  participant R as Renderer
  participant H as HostManager
  participant RD as RemoteDsh
  participant SSH as System SSH
  participant D as Remote dsh web

  U->>R: 选择远程环境 / 连接
  R->>H: host:connect(hostId)
  H->>RD: discoverRemoteDsh(host)
  alt 未运行且允许自动启动
    H-->>R: status(remote-probing/transferring/start)
    RD->>SSH: 探测/传输/同步插件/启动 DSH
    SSH->>D: 启动远端 dsh web
    D-->>RD: pid + dynamic port
  end
  H-->>R: status(ssh-tunnel)
  H->>SSH: ssh -N -L local:127.0.0.1:remote
  SSH-->>H: local loopback endpoint
  H->>D: 经隧道健康检查
  H-->>R: status(connected, endpoint)
  R->>R: 创建独立 partition WebView
```

### 3.3 新增/编辑环境（修复后的流程）

```mermaid
sequenceDiagram
  actor U as 用户
  participant R as Renderer
  participant I as IPC
  participant Q as ConnectionActions
  participant S as HostStore
  participant H as HostManager

  U->>R: 添加环境 → 选择 本机/远程
  R->>R: 打开共用草稿表单
  U->>R: 填写并本地校验
  R->>I: host:add(完整对象, 无 id)
  I->>Q: run(transaction)
  Q->>S: validateHost + 原子 save
  S-->>Q: normalized host
  Q->>H: setHosts(hosts)
  R->>R: 选中并可连接
  Note over R: 取消/Esc 不写任何数据
```

### 3.4 完成通知与菜单命令

```mermaid
sequenceDiagram
  participant H as Active Env
  participant W as CompletionWatcher
  participant N as NotificationService
  participant M as Electron Main
  participant R as Renderer

  H-->>W: Host/Mux 完成事件
  W->>N: onCompletion(event + hostId)
  N->>M: 原生 Notification（分类/聚焦/声音过滤）
  M-->>R: 点击 → host:command select-host
  R->>R: 切换到对应环境
  Note over M,R: 菜单项也经 host:command 下发（新建/切换/刷新/设置）
```

## 4. 数据模型快照

```mermaid
classDiagram
  class DesktopSettings { +number schemaVersion=3; +Host[] hosts }
  class Host { <<abstract>> +string id; +string name; +local|remote type; +string icon }
  class LocalHost { +type=local }
  class RemoteHost {
    +type=remote; +string host; +string username; +number sshPort
    +string? identityFile; +accept-new|strict hostKeyPolicy
    +boolean autoStartRemoteDsh; +boolean autoStopRemoteDsh; +boolean autoInstallRemoteDsh
  }
  class HostSnapshot {
    +string hostId; +number revision
    +idle|connecting|connected|error state
    +local|managedSsh mode; +string? endpoint; +string? error
    +Progress? progress; +RemoteDshState? remoteDsh
    +boolean needsUpdate; +string? remoteVersion; +string? bundledVersion
  }
  class NotificationSettings {
    +number schemaVersion; +boolean agentCompletions
    +object backgroundJobs; +boolean onlyWhenUnfocused
    +boolean playSound; +boolean focusOnClick
  }
  class DshDataBackup { +string fromVersion; +string timestamp; +string path }

  DesktopSettings "1" o-- "1..*" Host
  Host <|-- LocalHost
  Host <|-- RemoteHost
  Host "1" --> "0..1" HostSnapshot
  HostSnapshot "1" o-- "0..1" Progress
```

### 存储位置

| 数据 | 位置 | 所有者/生命周期 |
|---|---|---|
| 环境配置 | `<userData>/desktop-settings.json` | HostStore；0600、临时文件+rename |
| 本地 DSH 数据 | `<userData>/.dsh` | 本地 DSH |
| DSH 升级备份 | `<userData>/.dsh-backups/<oldVer>-<ts>` | DSH Data Guard；版本变化时一次性 |
| 通知设置 | `<userData>` 下 JSON | NotificationSettingsStore |
| Web 会话/cookie | `persist:dsh-<hostId>` partition | Electron Session；环境间隔离 |
| 远程 DSH 数据 | 远程主机 | 远程 DSH |

## 5. 前端与交互约束

- 环境切换栏显示图标/名称/类型/状态文字（不只用颜色）与更新提示；当前环境提供显式 连接/断开/重试/编辑/更多 操作，右键菜单仅作加速。
- 所有操作有 busy/success/error 反馈（aria-live toast/banner），不再只 console.error；危险操作用应用内确认对话框。
- 完整键盘/ARIA：tablist roving tabindex + 方向键/Home/End、`Cmd/Ctrl+1~9`、`Ctrl(+Shift)+Tab`、`role=menu` 菜单、对话框焦点与 Esc；图标按钮均有可访问名称。
- 视觉：中性灰主体 + DeepSeek blue（信息/焦点），状态色专用；light/dark/system、`focus-visible`、`prefers-reduced-motion`、`forced-colors`。
- WebView：per-env persistent partition、did-fail-load/crashed/render-process-gone/unresponsive 的恢复态与重载；`webview-lifecycle.js` 提供 LRU 治理策略。

## 6. 构建与验证

- 本地 DSH 与远程 bundle 使用同一 DSH 版本（当前 `0.1.1-rc.2`）；远程 bundle 仅在 Linux x64 glibc 构建（`dsh-bundle.tar.gz` + `dsh-bundle.manifest.json` + `dsh-bundle.version`）。
- `npm run check` = 语法检查 + 打包文件清单校验（`scripts/verify-packaged-files.mjs`）+ `node:test`（含 host-store/host-manager/remote-dsh/notification/dsh-data-guard/webview-lifecycle/UI a11y）。
- CI（`.github/workflows/build-macos.yml`）：Linux 构建 bundle → macOS x64/arm64 打包、架构校验、packaged smoke、签名/公证（有凭据时）。

## 7. 关键源文件索引

- Composition Root：`src/main.js`
- 环境状态机：`src/main/host-manager.js`；配置模型：`src/main/host-store.js`
- 数据保护：`src/main/dsh-data-guard.js`
- IPC / Preload：`src/main/ipc.js`、`src/preload/host-manager.js`
- 连接：`src/main/local-dsh.js`、`managed-ssh.js`、`remote-dsh.js`
- 通知：`src/main/notification-*.js`、`src/renderer/notification-settings/*`
- 桌面壳界面：`src/renderer/host-manager/{index.html,index.css,index.js,i18n.js,webview-lifecycle.js}`
- 外部产品面：`@deepseek-ai/dsh`（npm 依赖，运行时 Web UI）
