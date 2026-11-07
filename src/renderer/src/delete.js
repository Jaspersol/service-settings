import { saveData } from './store'
import { findServiceIndex, removeService } from '../../shared/services.js'

// 鼠标悬停多久后才显示删除图标（毫秒）。
// 留出延迟是为了避免鼠标划过卡片时误触删除。
const HOVER_DELAY_MS = 5000

let hoverTimer = null

/**
 * 从列表中删除指定服务名的条目并持久化。
 * 找不到条目时不做任何修改（返回 'not-found'），绝不会让 -1 变成删除下标。
 * @param {Array} list 服务列表（原地修改）
 * @param {string} serviceName 服务名称
 * @param {(list: Array) => Promise<unknown>} [persist] 持久化函数
 * @returns {Promise<'removed'|'not-found'|'persist-failed'>} 处理结果
 */
export async function removeEntry(list, serviceName, persist = saveData) {
  const removed = removeService(list, serviceName)
  if (!removed) return 'not-found'
  try {
    await persist(list)
  } catch {
    // 写库失败则回滚列表，调用方据此保留卡片
    list.splice(removed.index, 0, removed.item)
    return 'persist-failed'
  }
  return 'removed'
}

/**
 * 为每张卡片挂上删除图标（重复调用不会重复添加）
 * @param {Array} list 服务列表，删除卡片时同步修改并持久化
 */
export function initDeleteIcons(list) {
  const cards = document.querySelectorAll('.card')
  cards.forEach((card) => {
    // 避免重复添加图标
    if (!card.querySelector('.delete-icon')) {
      const deleteIcon = document.createElement('div')
      deleteIcon.className = 'delete-icon'
      deleteIcon.textContent = '×'
      deleteIcon.title = '点击删除'
      card.appendChild(deleteIcon)
      bindHoverShow(card, list)
    }
  })
}

/**
 * 绑定悬停显示与点击删除事件
 * @param {HTMLElement} card 卡片元素
 * @param {Array} list 服务列表
 */
function bindHoverShow(card, list) {
  const deleteIcon = card.querySelector('.delete-icon')
  // 鼠标移入：启动 HOVER_DELAY_MS 计时器
  card.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(() => {
      deleteIcon.classList.add('active')
    }, HOVER_DELAY_MS)
  })

  // 鼠标移出：清除计时器，避免离开后图标仍弹出
  card.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer)
    deleteIcon.classList.remove('active')
  })

  // 点击图标删除元素
  deleteIcon.addEventListener('click', async (e) => {
    e.stopPropagation()
    // 卡片与列表条目通过 data 属性上的服务名对应，不解析卡片上的显示文字
    const serviceName = card.dataset.serviceName
    const index = findServiceIndex(list, serviceName)
    if (index === -1) return

    if (!confirm(`确定要删除 ${list[index].domName} 服务吗？`)) return

    // 只删除查到的这一条，持久化成功后才移除卡片，避免界面与存储不一致
    const result = await removeEntry(list, serviceName)
    if (result === 'removed') card.remove()
    else if (result === 'persist-failed') alert('删除失败：无法保存设置')
  })
}
