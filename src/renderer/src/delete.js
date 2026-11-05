import { updateData } from './store'

// 鼠标悬停多久后才显示删除图标（毫秒）。
// 留出延迟是为了避免鼠标划过卡片时误触删除。
const HOVER_DELAY_MS = 5000

let hoverTimer = null

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
  deleteIcon.addEventListener('click', (e) => {
    e.stopPropagation()
    // 卡片标题形如「mysql服务」，取「服务」之前的部分作为节点名
    const domName = card.children[0].innerText.match(/.*?(?=服务)/)[0]
    if (confirm(`确定要删除 ${domName} 服务吗？`)) {
      card.remove()
      list.splice(
        list.findIndex((item) => item.domName === domName),
        1
      )
      updateData({
        id: 1,
        data: list
      })
    }
  })
}
