<div align="center">

<img src="docs/logo.png" width="120" alt="Service Settings logo">

# 服务设置

### 只为你真正关心的那几个 Windows 服务准备的开关面板

**添加一次，之后用一个开关启停，不必再去 `services.msc` 里翻列表 —— 而且每次打开都显示服务的真实状态。**

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://v2.tauri.app/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF.svg)](https://vite.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-orange.svg)](https://www.rust-lang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#环境要求)
[![License](https://img.shields.io/badge/license-not%20set-lightgrey.svg)](#许可)

[English](README.md) | 中文

**[快速开始](#快速开始) · [功能](#功能) · [常见问题](#常见问题)**

</div>

## 为什么做这个？

`services.msc` 是为系统管理员设计的，而不是为「一天重启那两三个服务几十次」的开发者设计的：要过 UAC、要在按字母排序的长列表里滚动、要右键 → 启动 / 停止 → 等 → 关窗口。这个应用把它简化成一张带开关的卡片。

- **一个服务一张卡片** —— 显示你起的名字，开关通过 Windows 服务控制管理器（SCM）启停服务
- **状态来自服务本身** —— 启动时刷新、之后每 5 秒再刷一次，在别处被停掉的服务不会一直显示成运行中
- **提权只处理一次** —— 启动时检查进程令牌，未提权则用 Windows 的 `runas` 动词重启自己；若拒绝 UAC，标题栏会保留「以管理员重启」按钮，无需重启应用即可重试
- **列表跨重启保留** —— 卡片存在 Rust 后端管理的 JSON 文件里
- **可备份、可搬迁** —— 配置能从标题栏按钮导出 / 导入为 JSON 文件
- **无边框窗口** —— 自绘标题栏为白底细分隔线，主体是白色圆角面板配蓝色强调色；拖动标题栏移动窗口，右侧是最小化 / 最大化 / 关闭按钮
- **编辑才显形** —— 加号卡片与删除叉号只在编辑模式（标题栏的「编辑 / 完成」按钮）出现，误点不会删掉服务

## 环境要求

- **Windows 10/11（x64）** —— 命令层使用 Win32 服务控制管理器，安装包也只出 NSIS
- **管理员权限**（启停服务需要）。读取状态是只读操作，不提权也能用
- **WebView2 Runtime** —— Windows 11 自带；Windows 10 上安装包会在缺失时下载引导程序
- **Node.js** `^20.19.0 || >=22.12.0`（Vite 7）与 **Rust stable** + **MSVC Build Tools / Windows SDK**（Tauri 的 Windows 目标只支持 MSVC）—— 仅构建时需要
- **服务名，而不是显示名** —— 应用把值传给 `OpenServiceW`，它要的是「服务名称」（如 `MySQL84`），不是 `services.msc` 里显示的「显示名称」

## 快速开始

```bash
npm install
npm run tauri dev
```

构建前端或生成安装包：

```bash
npm run build          # 把渲染层打包到 src/renderer/dist/
npm run tauri build    # NSIS 安装包（x64）
```

> 首次启动 Windows 会请求提权。如果拒绝，窗口仍会打开，但每条启停命令都会以权限错误结束 —— 点击标题栏「以管理员重启」即可重试。

## 使用流程

1. **添加** —— 先点标题栏「编辑」，再点 `+` 卡片（仅编辑模式可见），填写「节点名称」与「服务名称」，确认。
2. **启停** —— 点击开关，或先聚焦再按 <kbd>空格</kbd> / <kbd>回车</kbd>。命令失败时开关会弹回原位，执行期间对同一张卡片的重复点击会被忽略。
3. **删除** —— 编辑模式下点击卡片角上的纯净 `×` 并确认；点「完成」退出编辑模式。
4. **导出 / 导入** —— 标题栏的两个按钮。导出会下载 `service-settings.json`；导入会校验文件并重新加载页面。

还没有配置时列表为空并显示引导提示；点「编辑」再点 `+` 卡片添加第一个服务。

## 实现分层

| 层        | 文件                         | 职责                                                                                                                                                                                                            |
| --------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust 命令 | `src-tauri/src/lib.rs`       | 校验 `action` / `name`、调用 Win32 SCM（`OpenSCManagerW` / `OpenServiceW` / `QueryServiceStatusEx` / `StartServiceW` / `ControlService`）、映射 Win32 错误码、用 `TokenElevation` 判断提权并以 `runas` 自我重启 |
| Rust 存储 | `src-tauri/src/lib.rs`       | `load_services` / `save_services` 读取并原子写入 `app_data_dir()/services.json`                                                                                                                                 |
| 前端桥接  | `src/renderer/src/api.js`    | 服务命令与提权状态 / 重启的 `invoke` 封装                                                                                                                                                                       |
| 渲染进程  | `src/renderer/src/switch.js` | 渲染卡片、开关防抖（500 ms）、每 5 秒刷新状态（带并发守卫）                                                                                                                                                     |
| 渲染进程  | `src/renderer/src/config.js` | 配置的 JSON 导出 / 导入                                                                                                                                                                                         |
| 渲染进程  | `src/renderer/src/delete.js` | 编辑模式下显示的纯净叉号、确认后删除                                                                                                                                                                            |
| 渲染进程  | `src/renderer/src/store.js`  | 读 / 写列表，并一次性迁移旧的 IndexedDB 数据                                                                                                                                                                    |
| 渲染进程  | `src/renderer/src/notify.js` | 非阻塞提示条与页面内确认框                                                                                                                                                                                      |

服务名白名单**在 Rust 侧**执行，而不是在页面上：Tauri 的前端可以直接 `invoke`，所以渲染层的 `SERVICE_NAME_PATTERN` 只是输入提示。两边规则必须保持一致（见 `src/shared/services.js`）。

判断「运行中」直接读 SCM 返回的 `dwCurrentState == SERVICE_RUNNING`（4）。不再解析 `sc query` 文本，因此 `STOP_PENDING` / `START_PENDING` 不会被误判，也不再有控制台编码要解码。常见 Win32 错误码映射为可读中文，其余回退到系统本地化的 `FormatMessageW` 文案。

## 功能

### 服务卡片

- **每卡一开关** —— 自绘开关（checkbox + 样式化滑块的组合），它的 `checked` 跟随服务状态，而不是「上次点了什么」
- **键盘可用** —— 开关本身是可聚焦的 checkbox，<kbd>空格</kbd> 能翻转它（自绘滑块自己不会响应空格）
- **运行状态指示** —— 卡片顶部有一条短状态条，服务运行时拉长并变成鼠尾草青；滚动条为同色低对比墨灰、无边框，并常驻占位，卡片网格不会横向跳动
- **忙碌保护** —— 启停执行期间，同一卡片的再次点击被忽略，状态不会错乱
- **状态定时刷新** —— 每 5 秒逐张重读真实状态；正在操作或已删除的卡片跳过，同一时刻只跑一轮刷新，刷新不写盘

### 添加与删除

- **模态表单** —— 名称 + 服务名，空值会拦下；点击遮罩层可关闭
- **编辑模式才显示增删** —— 点「编辑」后加号卡片与 `×` 才出现，不再有悬停延时
- **删除要确认** —— 用页面内确认框（不是阻塞的原生 `confirm`）先报出节点名称，确认后移除卡片并持久化列表
- **非阻塞提示** —— 错误用会自动消失的提示条显示，不再用 `alert` 卡住 5 秒刷新定时器

### 存储

- **Rust 侧 JSON 文件** —— `app_data_dir()/services.json`，内容为 `{ domName, serviceName }` 数组；开关状态不落盘，始终从 SCM 读回
- **原子写入** —— 每次写盘用唯一临时文件、`sync_all` 后重命名，并发写不会互相踩，崩溃也不会留下写了一半的列表
- **一次性迁移** —— 若存在 v0.2.x 的 IndexedDB 列表，首次启动导入并删除旧库
- **损坏配置先备份** —— JSON 解析失败时 Rust 把原文件改名为 `services.json.bad-<时间戳>` 并报错，不会用占位数据覆盖
- **导出 / 导入** —— 下载 JSON 备份或上传；导入前校验结构、字段类型与长度、服务名合法性、重复项、条目数与文件大小

## 常见问题

<details>
<summary><strong>为什么每次启动都要提权？</strong></summary>

`StartServiceW` 和 `ControlService` 需要管理员权限。应用启动时读取自己的进程令牌，未提权就用 Windows 的 `runas` 动词重启自己。这个重启必然触发一次 UAC —— 普通进程无法「静默」提权。检测只做一次；若拒绝 UAC，标题栏「以管理员重启」按钮可以重试，无需重启应用。

</details>

<details>
<summary><strong>填了显示名称，开关点了却毫无反应。</strong></summary>

应用把字符串交给 `OpenServiceW`，它要的是**服务名称**。比如「MySQL 8.4」的服务名通常是 `MySQL84`。可在 `services.msc` 的服务属性里查看，或执行 `sc query state= all` 读 `SERVICE_NAME` 行。

</details>

<details>
<summary><strong>服务明明在运行，卡片却显示关闭。</strong></summary>

状态每 5 秒重读一次，在应用之外启动的服务一个刷新周期内就会跟上。正在切换的卡片会被跳过，避免覆盖执行中的命令。

</details>

<details>
<summary><strong>卡片数据存在哪里？</strong></summary>

应用数据目录下的 `services.json` —— 打包版是 `%APPDATA%\com.makabakax.service-settings\services.json`。用「导出配置」留一份备份；删掉该文件后列表为空并显示引导提示。

</details>

<details>
<summary><strong>配置文件损坏了怎么办？</strong></summary>

应用不会用占位数据覆盖它。Rust 会把损坏文件改名为同目录下的 `services.json.bad-<时间戳>`，并用提示条报出备份文件名。导入 JSON 备份（或重新添加服务）即可，原文件保留可供恢复。

</details>

<details>
<summary><strong>从 v0.1.x 升级后卡片不见了。</strong></summary>

v0.1.x 是 Electron 应用，它的 Chromium 配置目录与本版的 WebView2 配置目录不是同一个，列表也从未写进 `services.json`。请重新添加一次（或导入 JSON 备份）。从 **v0.2.x** 升级不同：它的 IndexedDB 列表会在首次启动时自动迁移到 `services.json`。

</details>

<details>
<summary><strong>怎么备份或搬迁列表？</strong></summary>

点击标题栏「导出配置」下载 `service-settings.json`；在目标机器点「导入配置」选中该文件，页面会重新加载并应用导入的列表。导入会拒绝格式错误、非法或超长服务名、空 / 超长节点名、重复条目与超大文件。

</details>

<details>
<summary><strong>macOS / Linux 上能用吗？</strong></summary>

不能。本版只提供 Windows 的 NSIS 安装包，命令层也是 Windows 专用。在其它平台上服务命令会返回明确的「不支持此平台」错误，而不是去调用 Win32 SCM。

</details>

## 参与开发

```bash
npm run format   # prettier --write .
npm run lint     # eslint --cache .
npm run build    # vite build
cargo test --manifest-path src-tauri/Cargo.toml
```

**技术栈**：Tauri 2 · Vite 7 · Rust（windows、serde）· 原生 ES 模块 + DOM（无框架）· JSON 配置 · prettier + eslint

## 许可

本仓库尚未包含许可文件 —— 版权归 © 2026 makabakax 所有，保留所有权利。如需明确授权，请开 issue 说明。
