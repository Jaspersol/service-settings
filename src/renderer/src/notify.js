/** 轻量非阻塞提示与确认框，替代会阻塞事件循环的原生 alert / confirm */

let toastEl = null
let toastTimer = null

/**
 * 在页面底部显示一条自动消失的提示
 * @param {string} message 提示文本
 * @param {'info'|'error'} [tone] 语气
 */
export function notify(message, tone = 'info') {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.className = 'toast'
    toastEl.setAttribute('role', 'status')
    toastEl.setAttribute('aria-live', 'polite')
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = message
  toastEl.dataset.tone = tone
  toastEl.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 4500)
}

/**
 * 自绘确认框，返回用户是否确认
 * @param {string} message 确认文案
 * @returns {Promise<boolean>} 用户是否确认
 */
export function confirmAction(message) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div')
    backdrop.className = 'modal'
    const box = document.createElement('div')
    box.className = 'modal-content'
    const heading = document.createElement('h3')
    heading.textContent = '请确认'
    const text = document.createElement('p')
    text.className = 'confirm-text'
    text.textContent = message
    const group = document.createElement('div')
    group.className = 'btn-group'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn-cancel'
    cancel.textContent = '取消'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'btn-confirm'
    ok.textContent = '确定'
    group.append(cancel, ok)
    box.append(heading, text, group)
    backdrop.appendChild(box)
    document.body.appendChild(backdrop)
    backdrop.style.display = 'flex'

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey)
      backdrop.remove()
      resolve(value)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false)
      else if (e.key === 'Enter') finish(true)
    }
    cancel.addEventListener('click', () => finish(false))
    ok.addEventListener('click', () => finish(true))
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false)
    })
    document.addEventListener('keydown', onKey)
    ok.focus()
  })
}
