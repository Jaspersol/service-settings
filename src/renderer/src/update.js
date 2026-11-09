import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { notify } from './notify'

/** 更新入口：启动时静默检查，标题栏按钮手动检查并下载安装。 */

let button = null
let currentInfo = null
let checking = false
let installing = false
let dialog = null
let progressBar = null
let progressText = null
let installButton = null
let laterButton = null
let releaseButton = null

function isTauri() {
  return Boolean(window.__TAURI_INTERNALS__)
}

function messageOf(error) {
  return String(error?.message || error || '未知错误')
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function markUpdate(info) {
  currentInfo = info
  if (button) {
    button.classList.add('has-update')
    button.title = `发现新版本 v${info.latestVersion}`
  }
}

function clearUpdate() {
  currentInfo = null
  if (button) {
    button.classList.remove('has-update')
    button.removeAttribute('title')
  }
}

function setButtonBusy(busy) {
  if (!button) return
  button.disabled = busy
  button.textContent = busy ? '检查中…' : '检查更新'
}

async function autoCheck() {
  try {
    const info = await invoke('auto_check_update')
    if (info?.hasUpdate) markUpdate(info)
  } catch {
    // 启动自动检查失败不打扰用户，手动检查会显示具体错误。
  }
}

async function checkForUpdates() {
  if (checking || installing) return
  checking = true
  setButtonBusy(true)
  try {
    const info = await invoke('check_update')
    if (info.hasUpdate) {
      markUpdate(info)
      openDialog(info)
    } else {
      clearUpdate()
      notify(`当前已是最新版本 v${info.currentVersion}`)
    }
  } catch (error) {
    // 网络失败但磁盘里有上次结果时，仍让用户看到可安装的版本和发布页入口。
    const cached = await invoke('last_update_result').catch(() => null)
    if (cached?.hasUpdate) {
      markUpdate(cached)
      openDialog(cached)
      notify(`检查更新失败，显示上次结果：${messageOf(error)}`, 'error')
    } else {
      notify(`检查更新失败：${messageOf(error)}`, 'error')
    }
  } finally {
    checking = false
    setButtonBusy(false)
  }
}

function setProgress(downloaded, total) {
  if (!progressBar || !progressText) return
  const hasTotal = Number.isFinite(total) && total > 0
  const percent = hasTotal ? Math.min(100, Math.round((downloaded / total) * 100)) : null
  progressBar.classList.toggle('is-indeterminate', percent === null)
  progressBar.style.width = percent === null ? '' : `${percent}%`
  progressText.textContent =
    percent === null ? `正在下载更新包… ${formatBytes(downloaded)}` : `正在下载更新包… ${percent}%`
}

function closeDialog() {
  if (!dialog || installing) return
  document.removeEventListener('keydown', onDialogKey)
  dialog.remove()
  dialog = null
  progressBar = null
  progressText = null
  installButton = null
  laterButton = null
  releaseButton = null
}

function openDialog(info) {
  closeDialog()

  const backdrop = document.createElement('div')
  backdrop.className = 'modal update-modal'
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeDialog()
  })

  const box = document.createElement('div')
  box.className = 'modal-content update-content'

  const heading = document.createElement('h3')
  heading.textContent = `发现新版本 v${info.latestVersion}`

  const meta = document.createElement('p')
  meta.className = 'update-meta'
  const size = info.assetSize ? ` · ${formatBytes(info.assetSize)}` : ''
  meta.textContent = `当前版本 v${info.currentVersion} → 最新版本 v${info.latestVersion}${size}`

  const notesLabel = document.createElement('p')
  notesLabel.className = 'update-notes-label'
  notesLabel.textContent = '更新说明'

  const notes = document.createElement('div')
  notes.className = 'update-notes'
  notes.textContent = info.notes || '该版本没有提供更新说明。'

  const progress = document.createElement('div')
  progress.className = 'update-progress'
  progress.hidden = true
  const track = document.createElement('div')
  track.className = 'update-progress-track'
  progressBar = document.createElement('div')
  progressBar.className = 'update-progress-bar'
  track.appendChild(progressBar)
  progressText = document.createElement('p')
  progressText.className = 'update-progress-text'
  progressText.textContent = '正在下载更新包…'
  progress.append(track, progressText)

  const group = document.createElement('div')
  group.className = 'btn-group'

  laterButton = document.createElement('button')
  laterButton.type = 'button'
  laterButton.className = 'btn-cancel'
  laterButton.textContent = '稍后'
  laterButton.addEventListener('click', closeDialog)

  releaseButton = document.createElement('button')
  releaseButton.type = 'button'
  releaseButton.className = 'btn-cancel'
  releaseButton.textContent = '在 GitHub 查看'
  if (!info.releaseUrl) {
    releaseButton.disabled = true
  } else {
    releaseButton.addEventListener('click', async () => {
      try {
        await invoke('open_release_page', { url: info.releaseUrl })
      } catch (error) {
        notify(`打开发布页失败：${messageOf(error)}`, 'error')
      }
    })
  }

  installButton = document.createElement('button')
  installButton.type = 'button'
  installButton.className = 'btn-confirm'
  installButton.textContent = '下载并安装'
  installButton.addEventListener('click', () => installUpdate(box, progress))

  group.append(laterButton, releaseButton, installButton)
  box.append(heading, meta, notesLabel, notes, progress, group)
  backdrop.appendChild(box)
  document.body.appendChild(backdrop)
  backdrop.style.display = 'flex'

  dialog = backdrop
  document.addEventListener('keydown', onDialogKey)
  installButton.focus()
}

function onDialogKey(event) {
  if (event.key === 'Escape') closeDialog()
}

async function installUpdate(box, progress) {
  if (installing || !currentInfo) return
  installing = true
  if (installButton) installButton.disabled = true
  if (laterButton) laterButton.disabled = true
  if (releaseButton) releaseButton.disabled = true
  box.querySelector('.update-error')?.remove()
  progress.hidden = false
  progressBar.classList.remove('is-indeterminate')
  progressBar.style.width = '0%'
  progressText.textContent = '正在下载更新包… 0%'

  try {
    await invoke('install_update')
    notify('下载完成，正在安装…')
    if (progressText) progressText.textContent = '下载完成，正在安装…'
  } catch (error) {
    installing = false
    if (installButton) installButton.disabled = false
    if (laterButton) laterButton.disabled = false
    if (releaseButton && currentInfo?.releaseUrl) releaseButton.disabled = false
    progress.hidden = true
    const line = document.createElement('p')
    line.className = 'update-error'
    line.textContent = `安装失败：${messageOf(error)}`
    box.insertBefore(line, box.querySelector('.btn-group'))
    notify(`安装更新失败：${messageOf(error)}`, 'error')
  }
}

export function initUpdates() {
  if (!isTauri()) return
  button = document.getElementById('updateBtn')
  if (!button) return

  button.addEventListener('click', checkForUpdates)

  listen('update-progress', (event) => {
    const payload = event.payload || {}
    setProgress(Number(payload.downloaded) || 0, payload.total)
  }).catch(() => {})

  // 等首屏卡片状态查询结束后再检查，避免和启动时的 IPC 抢带宽。
  setTimeout(autoCheck, 1500)
}
