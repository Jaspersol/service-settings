import { upData } from './store'

export // 添加删除图标
function initDeleteIcons(list) {
  const cards = document.querySelectorAll('.card') // 匹配你的已有元素选择器
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

let hoverTimer = null // 计时器
function bindHoverShow(card, list) {
  const deleteIcon = card.querySelector('.delete-icon')
  // 鼠标移入：启动10秒计时器
  card.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(() => {
      deleteIcon.classList.add('active') // 显示图标
    }, 5000) // 10秒后显示
  })

  // 鼠标移出：清除计时器，隐藏图标
  card.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer)
    deleteIcon.classList.remove('active') // 隐藏图标
  })

  // 点击图标删除元素
  deleteIcon.addEventListener('click', (e) => {
    e.stopPropagation() // 阻止事件冒泡
    // 获取服务名称
    const domName = card.children[0].innerText.match(/.*?(?=服务)/)[0]
    // 确认删除
    if (confirm(`确定要删除 ${domName} 服务吗？`)) {
      card.remove()
      list.splice(
        list.findIndex((item) => item.domName === domName),
        1
      )
      upData({
        id: 1,
        data: list
      })
    }
  })
}
