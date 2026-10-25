<div align="center">

<img src="assets/logo.png" alt="MAA-END-DSH logo" width="220" />

# MAA-END-DSH

**把 MaaEnd（终末地小助手）接进 DeepSeek Harness：agent 直接跑日常、看板看进度，启动静音、跑完自动关游戏。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f46e5)](https://github.com/deepseek-ai)
[![MaaFramework](https://img.shields.io/badge/MaaFramework-v5-1f6feb)](https://github.com/MaaXYZ/MaaFramework)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d4?logo=windows&logoColor=white)](#环境要求)
[![GitHub stars](https://img.shields.io/github/stars/Aression/dsh-maend?style=flat&color=ffcc00)](https://github.com/Aression/dsh-maend/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/Aression/dsh-maend)](https://github.com/Aression/dsh-maend/commits)

</div>

---

## 简介

`dsh-maend` 是一个 **DeepSeek Harness（DSH）插件**。它不改动 MaaEnd 本体，只通过 MaaEnd 自带的
MXU Web 服务（`127.0.0.1:12701/api/*`）驱动本机的 MaaEnd：

- 给 agent 一组 `maend_*` 工具，可以查状态、跑任务链、停止、读日志、抓画面；
- 在 DSH Web UI 里加一个 MaaEnd 面板（侧边栏图标 → 中央面板），带实时画面、任务开关、hooks 开关、日志；
- 提供「启动后静音」「执行完毕后自动关闭游戏」两个 hook，**关游戏只在任务全部成功后触发**。

MaaEnd 是《明日方舟：终末地》的自动化助手（MaaFramework + MXU GUI）。上游：
[MaaEnd/MaaEnd](https://github.com/MaaEnd/MaaEnd)、[MaaXYZ/MaaFramework](https://github.com/MaaXYZ/MaaFramework)。

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 🤖 agent 工具 | 10 个 `maend_*` 工具：状态、跑链、停止、日志、截图、静音、关游戏、hooks、任务开关、拉起客户端 |
| 📊 看板面板 | 侧边栏 `MaaEnd` 面板：实例切换、运行状态、任务列表开关、hooks 开关、实时画面、日志 |
| 🔇 启动静音 | 链首注入 `MXU_POWER{mute}`（系统默认播放端点静音），结束后可自动 `unmute` |
| 🚪 自动关游戏 | 任务链全部成功后才执行 `MXU_KILLPROC{Endfield.exe}`，失败/中止一律跳过 |
| 🧩 选项保真 | 移植了 MXU 前端的选项编译器：`select`/`switch`/`checkbox`/`input` 的用户选择会真正进入 `pipeline_override` |
| 🛡 运行前自检 | 自动补 `agent_configs` + `PI_*`、窗口 `connect`、`resource/load`、清理残留 agent —— 这四步缺一步任务就会瞬间全失败 |
| 🔁 运行判定 | 订阅 MXU WebSocket 的 `Tasker.Task.Succeeded/Failed`，不依赖会残留的 `task_run_state` |
| 🧰 辅助脚本 | 把静音/取消静音（可选：无条件关游戏）写进 MXU 实例任务列表，MaaEnd 自己的界面里也能看到和排序 |

## 工作原理

```
┌────────────────────────── DSH (Electron / Node) ──────────────────────────┐
│  agent ── tools ──> index.js (host)                                       │
│                       │  ├─ lib/maend.js   MXU HTTP 客户端 + 选项编译器     │
│                       │  ├─ lib/install.js MaaEnd 安装目录探测              │
│                       │  └─ WS 订阅 Tasker.Task.*（成败判定）               │
│  Web UI ── fetch ──> /api/dsh-maend/{status,action,screenshot}            │
│                       client.js（侧边栏 + 中央面板）                        │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ http://127.0.0.1:12701/api  +  ws://…/api/ws
┌───────────────────────────────┴───────────────────────────────────────────┐
│  MaaEnd / MXU v2.35.x   ProjectInterface v2 + MaaFramework v5             │
│    tasks/start · tasks/stop · config · interface · state · logs · screenshot │
│    内置特殊任务：MXU_POWER / MXU_KILLPROC / MXU_WEBHOOK / MXU_SLEEP / …    │
└───────────────────────────────────────────────────────────────────────────┘
```

关键设计取舍：

1. **静音/关游戏用 MXU 内置特殊任务**，而不是另起 PowerShell 守护进程 —— 与任务链同一调度器、同一时序。
2. **关游戏放在链外**。MXU 任务链是 fail-forward（某步失败继续跑下一步），把
   `MXU_KILLPROC` 放在链尾会导致「全失败的运行也被当成跑完然后关游戏」。插件改为链跑完后单独执行，
   并且只认 WebSocket 回调里每个 `task_id` 的 `Succeeded`。
3. **成败不看 `task_run_state.statuses`**：MXU 会残留上一次运行的结果（停止时还可能清空），
   用它判断会把失败/中止当成功。
4. **本地耦合全部收敛到 `lib/install.js`**：不再硬编码任何机器路径。

## 环境要求

- Windows 10/11（MXU 的 Win32 控制器只有 Windows 版本；插件本身只依赖 Node 20+）
- [MaaEnd](https://github.com/MaaEnd/MaaEnd) v2.35.x（MXU），且 **Web 服务已开启**：
  MaaEnd → 设置 → 通用 → 本地 Web 服务（默认端口 `12701`）
- 本机的 [DeepSeek Harness](https://github.com/deepseek-ai) profile（`~/.dsh/profiles/<profile>/`）
- Node.js ≥ 20（DSH 自带运行时即可）

## 安装

插件以「本地 bundle」方式安装到当前 DSH profile：

```text
# 1) 克隆到任意目录
git clone https://github.com/Aression/dsh-maend.git D:\devspace\dsh-maend

# 2) 在 DSH 会话里让 agent 执行（或等价地调用 plugin_manager 工具）
plugin_manager { action: "install_bundle", target: "link:D:\\devspace\\dsh-maend" }
```

安装返回 `application: "applied"` 即生效；之后刷新页面即可看到侧边栏的 `MaaEnd` 图标。
无需 `pnpm install`、无需构建 —— client 半是免构建的 ESM 模块。

## 配置

### MaaEnd 安装位置

插件按以下顺序探测（命中即用，且会记住到 `~/.dsh/maend-install.json`）：

1. 环境变量 `MAAEND_HOME` / `MAAEND_INSTALL_DIR`
2. 插件配置 `installDir`
3. 上次成功探测的目录
4. MXU 运行中 `/api/interface` 返回的 `basePath`（最可靠）
5. 正在运行的 `MaaEnd.exe` 的镜像路径
6. 常见下载目录里名字匹配 `maend` 的文件夹

### 插件配置项（可选）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:12701` | MXU Web 服务地址，非默认端口时填 |
| `installDir` | 自动探测 | MaaEnd 安装目录（含 `MaaEnd.exe`） |
| `instance` | 第一个实例 | 默认实例 id |
| `cwd` | 安装目录 | `tasks/start` 的工作目录 |

### hooks

存在 `~/.dsh/maend-hooks.json`（与 MXU 配置无关）：

```json
{
  "muteOnStart": true,
  "unmuteOnFinish": true,
  "killGameOnFinish": true,
  "webhookUrl": "",
  "processName": "Endfield.exe"
}
```

面板里可以直接开关这几项，也可以用 `maend_hooks` 工具改。

## 使用

### agent 工具

| 工具 | 作用 |
| --- | --- |
| `maend_status` | 实例/运行状态/任务/定时策略/hooks/安装目录/日志（只读） |
| `maend_run` | 启动任务链（可按 `taskNames` 取子集，默认应用 hooks） |
| `maend_stop` | 停止当前任务链 |
| `maend_logs` | 读 MXU 日志 |
| `maend_screenshot` | 抓当前游戏画面 PNG |
| `maend_power` | `mute` / `unmute` / `screenoff`；关机/重启/休眠需 `confirm` |
| `maend_kill_game` | 关闭游戏进程（默认 `Endfield.exe`，其它进程名需 `confirm`） |
| `maend_task_toggle` | 开关某任务并回读校验 |
| `maend_hooks` | 读/改 hooks |
| `maend_launch` | 拉起 `MaaEnd.exe --autostart -i <实例名> [--quit-after-run]` |

### 看板

侧边栏 `MaaEnd` → 中央面板：

- 顶部：实例下拉、连接/运行状态、`开始任务` / `停止`
- 中部：任务列表（可开关，含 MXU 内置特殊任务）、hooks 开关（静音 / 结束取消静音 / 结束关游戏）
- 右侧：实时画面（`/api/dsh-maend/screenshot` 代理的 MXU 截图）、最近日志

> 面板路由受 DSH 的会话鉴权保护：浏览器同源 `fetch` 自动携带 HttpOnly cookie；
> 从外部 `curl` 直接访问 `/api/dsh-maend/status` 会得到 `401`，这是预期行为。

### 脚本

```bash
# 把「启动后静音 / 结束后取消静音」写进实例任务列表（MaaEnd 界面里可见、可排序）
node scripts/add-special-tasks.mjs --instance <id|name> --dry
node scripts/add-special-tasks.mjs --instance <id|name>

# 加/不加「结束后关闭游戏」（注意：链内任务是无条件执行，失败也会关游戏）
node scripts/add-special-tasks.mjs --instance <id|name> --kill

# 移除实例里的特殊任务（默认全部；--task 只删指定 entry）
node scripts/remove-special-tasks.mjs --instance <id|name> --task __MXU_KILLPROC__ --dry
node scripts/remove-special-tasks.mjs --instance <id|name> --task __MXU_KILLPROC__
```

## 踩过的坑（也是本插件的存在理由）

直接调 `tasks/start` 和「在 MaaEnd 界面点开始」不是同一条路径，界面会先替你做三件准备：

1. **`agent_configs`**：请求必须带 `interface.json` 里的 `agent`（`go-service` + `cpp-algo`）并注入
   `PI_*` 环境变量。不带的话 MXU 日志是 `[start_tasks] No agent configs, skipping agent setup`，
   MaaFramework 里所有 MaaEnd 自定义动作报 `Action is null`，**每个任务 20ms 内失败**。
2. **`connect`**：游戏重启后窗口句柄变了，实例 `connected=false`，`tasks/start` 直接 500
   `Tasker not properly initialized`。
3. **`resource/load`**：MaaEnd 进程重启后实例没有资源，`tasks/start` 报 `Resource not loaded`。

另外还有两个坑：

- 上一次运行残留的 `go-service` / `cpp-algo` 会让新 agent 起不来
  （`Agent start failed: MaaFramework internal error: status 0`），启动前 `agent/stop` 一次即可；
- MXU 的「成功」包含「按计划跳过」（日常已做完、定时策略没命中），这类任务会秒返 `succeeded`，
  判断「是否真的做了事」要看日志内容，不能只看状态。

插件在 `maend_run` 里会自动补齐以上准备（返回体 `connection.steps` 可见实际动作）。

## 开发

```bash
npm run check        # node --check 所有源文件（无需安装依赖）
```

目录结构：

```
index.js            # host 半：tools + /api/dsh-maend/* 路由
client.js           # client 半：侧边栏 + 面板（免构建 ESM）
lib/maend.js        # MXU HTTP 客户端、选项编译器、任务链构建、WS 成败监听
lib/install.js      # MaaEnd 安装目录探测
lib/schema.js       # ParameterSchemaSpec → JSON Schema
locale/{en,zh-CN}.json
scripts/*.mjs       # 配置辅助脚本
assets/logo.png     # 项目 logo
```

改完宿主文件后在 DSH 里重载：`plugin_manager { action: "set_bundle", target: "dsh-maend", enabled: false }`
再 `enabled: true`；只改 `client.js` 的话刷新页面即可。

## 技术栈

| 层 | 用了什么 |
| --- | --- |
| 插件框架 | DeepSeek Harness（Cordis）插件 API：`tools.register` / `connection.fetch.register` / `ctx.effect` |
| 前端 | 原生 ESM + React（由 DSH 提供），`window.__ModuleLoader__` 免构建加载，`--dsw-alias-*` 主题变量 |
| 运行时 | Node.js ≥ 20 ESM，无第三方依赖（零 `dependencies`） |
| 上游自动化 | MaaFramework v5 + MaaEnd ProjectInterface v2 + MXU 内置特殊任务 |
| 通信 | MXU 本地 HTTP（`/api/*`，无鉴权，仅 loopback）+ WebSocket（`/api/ws` 事件流） |
| 平台 | Windows（Win32 控制器 / ScreenDC 抓屏 / `taskkill`） |

## 已知限制

- **只支持 Windows**：MXU 的 Win32 控制器、`ScreenDC` 抓屏与 `taskkill` 都是 Windows 专有；
  插件的检测会明确报错而不是静默失败。
- **MXU 的 agent 服务偶尔会卡死**（连续 `Agent start failed ... status 0`）：重启一次 `MaaEnd.exe`。
- **预任务没有 HTTP 路由**（`__MXU_PRETASK__*`，例如「启动游戏」）：插件默认跳过，
  需要先手动/由 MaaEnd 界面启动游戏，插件再自动 `connect`。
- **MXU 自带的定时策略跑在前端 webview 里**：没有 API、不补跑，面板只读展示；真正的定时请交给 DSH 侧调度。
- 本项目与 MaaEnd / MaaFramework / Hypergryph 无隶属关系，仅调用其公开的本地接口。

## Star History

<a href="https://www.star-history.com/#Aression/dsh-maend&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Aression/dsh-maend&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Aression/dsh-maend&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Aression/dsh-maend&type=Date" width="640" />
  </picture>
</a>

## License

[MIT](LICENSE) © 2026 Aression
