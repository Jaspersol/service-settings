import { saveData } from './store'
import { findServiceIndex, removeService } from '../../shared/services.js'
import { confirmAction, notify } from './notify'

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
    // 写盘失败则回滚列表，调用方据此保留卡片
    list.splice(removed.index, 0, removed.item)
    return 'persist-failed'
  }
  return 'removed'
}

/**
 * 为每张卡片挂上删除叉号（重复调用不会重复添加）。
 * 叉号只在编辑模式下显示（body.editing），不再有悬停延迟。
 * @param {Array} list 服务列表，删除卡片时同步修改并持久化
 */
export function initDeleteIcons(list) {
  const cards = document.querySelectorAll('.card')
  cards.forEach((card) => {
    if (card.querySelector('.delete-icon')) return

    const deleteIcon = document.createElement('button')
    deleteIcon.type = 'button'
    deleteIcon.className = 'delete-icon'
    deleteIcon.textContent = '×'
    deleteIcon.title = '删除此服务'
    deleteIcon.setAttribute('aria-label', '删除此服务')
    card.appendChild(deleteIcon)

    deleteIcon.addEventListener('click', async (e) => {
      e.stopPropagation()
      // 卡片与列表条目通过 data 属性上的服务名对应，不解析卡片上的显示文字
      const serviceName = card.dataset.serviceName
      const index = findServiceIndex(list, serviceName)
      if (index === -1) return

      if (!(await confirmAction(`确定要删除 ${list[index].domName} 服务吗？`))) return

      // 持久化成功后才移除卡片，避免界面与存储不一致
      const result = await removeEntry(list, serviceName)
      if (result === 'removed') card.remove()
      else if (result === 'persist-failed') notify('删除失败：无法保存设置', 'error')
    })
  })
}
