import { loadData, saveData } from './store'
import { initDeleteIcons } from './delete'
import { SERVICE_NAME_PATTERN, isDuplicateEntry } from '../../shared/services.js'
import { serviceCommand } from './api'
import { initConfigTools } from './config'

// 当前服务列表：启动流程从配置文件读出后赋给这里，供各事件回调共享
let list
// 卡片开关与列表条目的对应关系，供定时刷新复用
let rows = []
// 状态刷新间隔（毫秒）
const REFRESH_INTERVAL_MS = 5000

/**
 * 防抖：间隔 timeout 毫秒内不再触发时才真正调用 func
 * @param {Function} func 要执行的函数
 * @param {number} timeout 静默等待时长（毫秒）
 */
function debounce(func, timeout = 500) {
  let flag = null
  return (...args) => {
    clearTimeout(flag)
    flag = setTimeout(() => {
      func(...args)
      flag = null
    }, timeout)
  }
}

/** 把整个列表写回 Rust 侧的 services.json */
function persistList() {
  return saveData(list)
}

/**
 * 查询服务真实状态，由 Rust 命令层通过 SCM 读取
 * @param {string} serviceName 服务名称
 * @returns {Promise<{ok: boolean, running: boolean, message?: string}>} 查询结果
 */
async function getStatus(serviceName) {
  try {
    const res = await serviceCommand('status', serviceName)
    if (!res || res.success !== true) {
      return { ok: false, running: false, message: (res && res.message) || '查询失败' }
    }
    return { ok: true, running: res.running === true }
  } catch (err) {
    return { ok: false, running: false, message: err.message }
  }
}

/** 定时刷新卡片显示状态；跳过正在操作或已从 DOM 移除的卡片，不写盘 */
async function refreshStatuses() {
  rows = rows.filter(({ input }) => input.isConnected)
  await Promise.all(
    rows.map(async ({ item, input }) => {
      if (!input.isConnected || item.isChanging) return
      const status = await getStatus(item.serviceName)
      if (!status.ok || item.isChanging || !input.isConnected) return
      item.status = status.running
      input.checked = status.running
    })
  )
}

/**
 * 生成一张服务卡片，节点名与服务名只通过 textContent / data 属性写入，不拼 HTML
 * @param {{domName: string, serviceName: string}} item 服务条目
 * @returns {HTMLElement} 卡片元素
 */
function createCard(item) {
  const card = document.createElement('div')
  card.className = 'card'
  // 删除时凭服务名回到列表条目，不再解析卡片上的文字
  card.dataset.serviceName = item.serviceName

  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = `${item.domName}服务`

  const label = document.createElement('label')
  label.className = 'toggle-switch'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'toggle-input'
  input.setAttribute('aria-label', `${item.domName}服务开关`)
  const slider = document.createElement('span')
  slider.className = 'toggle-slider'
  const thumb = document.createElement('span')
  thumb.className = 'toggle-thumb'
  slider.appendChild(thumb)
  label.append(input, slider)
  card.append(title, label)
  return card
}

/**
 * 注册开关状态监听
 * @param {HTMLElement} input 开关（checkbox）元素
 * @param {{serviceName: string, status: boolean, isChanging: boolean}} item 对应的列表条目
 */
function addEventListenerService(input, item) {
  input.checked = item.status
  const handleToggle = debounce(() => {
    changeSwitch(input, item)
  }, 500)
  // 开关是自绘外观：空格键默认不会改变 checked，需手动切换。
  // 只接管空格/回车，Tab 等其它按键保持浏览器默认行为（否则无法移出焦点）
  input.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return
    e.preventDefault()
    input.checked = !input.checked
    handleToggle()
  })
  input.addEventListener('click', handleToggle)
}

/**
 * 处理开关切换：通过 SCM 启停服务，命令成功后才改状态与持久化
 * @param {HTMLElement} input 开关元素
 * @param {{serviceName: string, status: boolean, isChanging: boolean}} item 对应的列表条目
 */
async function changeSwitch(input, item) {
  // isChanging 用于避免命令执行期间重复点击导致状态错乱
  if (item.isChanging) {
    input.checked = item.status
    return
  }

  const target = input.checked
  // 连点导致开关回到原位时无需执行命令
  if (target === item.status) return
  item.isChanging = true
  input.disabled = true

  const res = await serviceCommand(target ? 'start' : 'stop', item.serviceName).catch((err) => ({
    success: false,
    message: err.message
  }))
  if (!res || res.success !== true) {
    // 失败时把开关拨回持久化的状态，并把错误告诉用户
    input.checked = item.status
    item.isChanging = false
    input.disabled = false
    alert(`${target ? '启动' : '停止'}服务失败：${(res && res.message) || '未知错误'}`)
    return
  }

  item.status = target
  input.checked = target
  item.isChanging = false
  input.disabled = false
  try {
    await persistList()
  } catch (err) {
    alert(`保存状态失败：${err.message}`)
  }
}

/**
 * 把服务列表渲染成卡片，插在「新增」卡片之前，并返回卡片与条目的对应关系
 * @returns {Array<{item: object, input: HTMLElement}>} 卡片开关与其列表条目
 */
function initList() {
  const container = document.getElementById('container')
  const cardAdd = container.querySelector('.card-add')
  const cardRows = list.map((item) => {
    item.isChanging = false
    const card = createCard(item)
    container.insertBefore(card, cardAdd)
    return { item, input: card.querySelector('.toggle-input') }
  })
  initDeleteIcons(list)
  showmodelJsAdd()
  return cardRows
}

/** 为「新增服务」弹框的各按钮绑定事件 */
function showmodelJsAdd() {
  const add = document.getElementById('add')
  const myModal = document.getElementById('myModal')
  const cancelBtn = document.getElementById('cancelBtn')
  const confirmBtn = document.getElementById('confirmBtn')
  const nodeNameInput = document.getElementById('nodeName')
  const serviceNameInput = document.getElementById('serviceName')

  add.addEventListener('click', function () {
    myModal.style.display = 'flex'
    nodeNameInput.value = ''
    serviceNameInput.value = ''
  })

  cancelBtn.addEventListener('click', function () {
    myModal.style.display = 'none'
  })

  confirmBtn.addEventListener('click', async function () {
    const nodeName = nodeNameInput.value.trim()
    const serviceName = serviceNameInput.value.trim()

    if (!nodeName || !serviceName) {
      alert('节点名称和服务名称不能为空！')
      return
    }
    if (!SERVICE_NAME_PATTERN.test(serviceName)) {
      alert('服务名称只能包含字母、数字、下划线、点、$ 和连字符！')
      return
    }
    if (isDuplicateEntry(list, nodeName, serviceName)) {
      alert('该节点名称或服务名称已存在，请勿重复添加！')
      return
    }

    // 查询期间锁住确认按钮，避免连点插入两张重复卡片
    confirmBtn.disabled = true
    let status
    try {
      status = await getStatus(serviceName)
    } finally {
      confirmBtn.disabled = false
    }
    if (!status.ok) {
      alert(`无法查询服务 ${serviceName}：${status.message}`)
      return
    }

    const item = {
      domName: nodeName,
      serviceName: serviceName,
      status: status.running,
      isChanging: false
    }
    list.push(item)

    const container = document.getElementById('container')
    const card = createCard(item)
    container.insertBefore(card, container.querySelector('.card-add'))
    const input = card.querySelector('.toggle-input')
    addEventListenerService(input, item)
    rows.push({ item, input })
    initDeleteIcons(list)
    myModal.style.display = 'none'

    try {
      await persistList()
    } catch (err) {
      // 写盘失败则回滚，界面与存储保持一致
      list.pop()
      rows.pop()
      card.remove()
      alert(`保存失败：${err.message}`)
    }
  })

  // 点击遮罩层（而非弹框内容）时关闭
  myModal.addEventListener('click', function (e) {
    if (e.target === myModal) {
      myModal.style.display = 'none'
    }
  })
}

document.addEventListener('DOMContentLoaded', async () => {
  const fallback = [{ domName: 'mysql', serviceName: 'MySQL84' }]
  try {
    const stored = await loadData()
    // 配置文件不存在或为空时给一个默认服务兜底
    list = stored.length > 0 ? stored : fallback
  } catch (err) {
    alert(`读取配置失败：${err}`)
    list = fallback
  }

  rows = initList()
  // 逐张查询真实状态：新增的卡片与重启后的卡片都以服务真实状态为准
  for (const { item, input } of rows) {
    const status = await getStatus(item.serviceName)
    item.status = status.ok ? status.running : false
    addEventListenerService(input, item)
  }

  initConfigTools()
  // 定期刷新，反映在应用之外被启停的服务
  setInterval(refreshStatuses, REFRESH_INTERVAL_MS)
})
