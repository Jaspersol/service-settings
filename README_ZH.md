<div align="center">

<img src="docs/logo.png" width="120" alt="Service Settings logo">

# 服务设置

### 只为你真正关心的那几个 Windows 服务准备的开关面板

**添加一次，之后用一个开关启停，不必再去 `services.msc` 里翻列表 —— 而且每次打开都显示服务的真实状态。**

[![Electron](https://img.shields.io/badge/Electron-38-47848F.svg)](https://www.electronjs.org/)
[![electron-vite](https://img.shields.io/badge/built%20with-electron--vite%204-orange.svg)](https://electron-vite.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#环境要求)
[![License](https://img.shields.io/badge/license-not%20set-lightgrey.svg)](#许可)

[English](README.md) | 中文

**[快速开始](#快速开始) · [功能](#功能) · [常见问题](#常见问题)**

</div>

## 为什么做这个？

`services.msc` 是为系统管理员设计的，而不是为「一天重启那两三个服务几十次」的开发者设计的：要过 UAC、要在按字母排序的长列表里滚动、要右键 → 启动 / 停止 → 等 → 关窗口。这个应用把它简化成一张带开关的卡片。

- **一个服务一张卡片** —— 显示你起的名字，开关直接执行 `net start` / `net stop`
- **状态来自服务本身** —— 启动时用 `sc query` 逐张刷新，在别处被停掉的服务不会显示成运行中
- **提权只处理一次** —— 启动时用 `fltmc` 检查管理员权限，没有就通过 UAC 自动重启自己
- **列表跨重启保留** —— 卡片存在 IndexedDB 里，下次启动原样读回
- **删除必须刻意** —— `×` 要悬停 5 秒才出现，划过卡片不会误删服务

## 环境要求

- **Node.js**：`^20.19.0 || >=22.12.0`（Vite 7 的要求）
- **Windows** 且具备管理员权限 —— `net start` / `net stop` / `sc query` 都是 Windows 命令
- **服务名，而不是显示名** —— 应用把值直接传给 `sc query`，它要的是「服务名称」（如 `MySQL84`），不是 `services.msc` 里显示的「显示名称」

## 快速开始

```bash
npm install
npm run dev
```

构建生产包或安装程序：

```bash
npm run build          # 把 main / preload / renderer 打進 out/
npm run build:win      # Windows 安装包
npm run build:mac      # macOS 应用包
npm run build:linux    # AppImage / snap / deb
```

> 首次启动 Windows 会请求提权。如果拒绝，窗口仍会打开，但每条命令都会以权限错误结束 —— 请重启应用并接受提权。

## 使用流程

1. **添加** —— 点击 `+` 卡片，填写「节点名称」（卡片上显示的文字）与「服务名称」（Windows 服务名），确认。
2. **启停** —— 点击开关，或先聚焦再按 <kbd>空格</kbd> / <kbd>回车</kbd>。命令失败时开关会弹回原位，执行期间对同一张卡片的重复点击会被忽略。
3. **删除** —— 光标在卡片上停留 5 秒，角上出现 `×`；点击并确认后删除。

数据库里还没有记录时，初始列表是一张 `mysql` 卡片、指向服务 `MySQL84` —— 随意编辑或删除即可。

## 实现分层

| 层       | 文件                         | 职责                                                                                   |
| -------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| 主进程   | `src/main/index.js`          | 缓存提权检查结果（`fltmc`）、最多一次 `Start-Process -Verb RunAs` 自我重启、用 `execFile` 以固定程序 + 参数数组执行 `sc` / `net` |
| Preload  | `src/preload/index.js`       | 只向页面暴露一个调用：`window.api.serviceCommand(action, name)` → IPC `service-command`（载荷 `{ action, name }`） |
| 渲染进程 | `src/renderer/src/switch.js` | 渲染卡片、开关防抖（500 ms）、通过 IPC 查询状态与启停                                    |
| 渲染进程 | `src/renderer/src/delete.js` | 悬停显示删除图标、确认后删除                                                           |
| 渲染进程 | `src/renderer/src/store.js`  | IndexedDB `TestDB` → `config`，id 为 `1` 的单条记录                                    |

主进程判断「运行中」时匹配 `sc query <name>` 输出里的 `4  RUNNING`，即匹配四位状态码而不只是那个单词 —— `STOP_PENDING`、`START_PENDING` 里也含字母，宽松匹配会误判。

## 功能

### 服务卡片

- **每卡一开关** —— 自绘开关（checkbox + 样式化滑块的组合），它的 `checked` 跟随服务状态，而不是「上次点了什么」
- **键盘可用** —— 开关本身是可聚焦的 checkbox，<kbd>空格</kbd> 能翻转它（自绘滑块自己不会响应空格）
- **忙碌保护** —— `net start` / `net stop` 执行期间，同一卡片的再次点击被忽略，状态不会错乱
- **启动即刷新** —— 列表渲染完成后逐张查询真实状态

### 添加与删除

- **模态表单** —— 名称 + 服务名，空值会拦下；点击遮罩层可关闭
- **删除前有悬停延时** —— 连续悬停 5000 ms 才显示 `×`，移开即隐藏
- **删除要确认** —— 弹窗前先报出节点名称，确认后移除卡片并持久化列表

### 存储

- **只用 IndexedDB** —— 库 `TestDB`、对象库 `config`、keyPath `id`，单条 id 为 `1` 的记录
- **用 `put` 而非 `add`** —— 首次之后的每次保存记录都已存在，`add` 会抛 `ConstraintError`
- **默认数据不落盘** —— 首跑那张 `mysql` 卡片只是占位，只有你增删过才会写入数据库

## 常见问题

<details>
<summary><strong>为什么每次启动都要提权？</strong></summary>

`net start` 和 `net stop` 需要管理员权限，所以应用启动时先用 `fltmc` 检查，失败就通过 PowerShell 的 `Start-Process -Verb RunAs` 重启自己。这个重启必然触发一次 UAC —— 普通进程无法「静默」提权。

</details>

<details>
<summary><strong>填了显示名称，开关点了却毫无反应。</strong></summary>

应用把字符串原样交给 `sc query` / `net start`，它们要的是**服务名称**。比如「MySQL 8.4」的服务名通常是 `MySQL84`。可在 `services.msc` 的服务属性里查看，或执行 `sc query state= all` 读 `SERVICE_NAME` 行。

</details>

<details>
<summary><strong>服务明明在运行，卡片却显示关闭。</strong></summary>

状态只在启动时读一次、之后仅在切换时更新，所以在应用之外启动的服务要等到重启应用才会反映。切换一次即可重新读取真实状态。

</details>

<details>
<summary><strong>卡片数据存在哪里？</strong></summary>

应用用户数据目录下的 IndexedDB —— 打包版是 `%APPDATA%\service-settings`，`npm run dev` 期间是那个 Electron 实例的 Chromium 配置目录。清掉站点数据或该目录，列表就会重置。

</details>

<details>
<summary><strong>macOS / Linux 上能用吗？</strong></summary>

能构建、能启动，但它执行的命令是 Windows 专用的：在 macOS / Linux 上每次启停都会返回权限错误，而 `net` / `sc` 并不存在。这是一个 Windows 工具。

</details>

## 参与开发

```bash
npm run format   # prettier --write .
npm run lint     # eslint --cache .
npm run build    # electron-vite build
```

**技术栈**：Electron 38 · electron-vite 4 · Vite 7 · 原生 ES 模块 + DOM（无框架）· IndexedDB · prettier + eslint

## 许可

本仓库尚未包含许可文件 —— 版权归 © 2026 makabakax 所有，保留所有权利。如需明确授权，请开 issue 说明。
