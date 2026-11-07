import { getCurrentWindow } from '@tauri-apps/api/window'
import { elevationStatus, elevate } from './api'

/** 无边框窗口的标题栏控制；浏览器预览（非 Tauri 环境）时跳过 */
export function initTitlebar() {
  if (!window.__TAURI_INTERNALS__) return

  const win = getCurrentWindow()
  document.getElementById('titlebar-minimize')?.addEventListener('click', () => win.minimize())
  document
    .getElementById('titlebar-maximize')
    ?.addEventListener('click', () => win.toggleMaximize())
  document.getElementById('titlebar-close')?.addEventListener('click', () => win.close())

  // 未提权时常驻一个「以管理员重启」入口；拒绝 UAC 后仍可再次发起
  const elevateBtn = document.getElementById('titlebar-elevate')
  if (!elevateBtn) return
  elevationStatus()
    .then((elevated) => {
      elevateBtn.hidden = elevated === true
    })
    .catch(() => {
      elevateBtn.hidden = true
    })
  elevateBtn.addEventListener('click', () => {
    // 提权成功时 Rust 侧调用 app.exit(0)，本次 invoke 会以 reject 结束，忽略即可
    elevate().catch(() => {})
  })
}
