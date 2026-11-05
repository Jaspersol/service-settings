import { loadData, updateData } from './store'
import { initDeleteIcons } from './delete'

// 当前服务列表：启动流程从数据库读出后赋给这里，供各事件回调共享
let list

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

/**
 * 注册开关状态监听
 * @param {HTMLElement} dom 开关（checkbox）元素
 * @param {string} serviceName 服务名称
 * @param {boolean} status 服务当前是否运行
 */
function addEventListenerService(dom, serviceName, status) {
  dom.checked = status
  const handleToggle = debounce(() => {
    changeSwitch(serviceName, dom)
  }, 500)
  // 开关是自定义外观，空格键默认不会改变 checked，需手动切换
  dom.addEventListener('keydown', (e) => {
    e.preventDefault()
    if (e.key === ' ') {
      dom.checked = !dom.checked
      handleToggle()
    }
  })
  dom.addEventListener('click', handleToggle)
}

/**
 * 查询服务状态，依赖主进程以管理员权限执行 sc query
 * @param {string} serviceName 服务名称
 * @returns {Promise<boolean>} 是否处于运行状态
 */
async function getStatus(serviceName) {
  let res = await window.api.run('sc query ' + serviceName)
  if (res.success === true) return res.result.indexOf('4  RUNNING') !== -1
  else return false
}

/**
 * 处理开关切换：通过 net start / net stop 启停服务
 * @param {string} serviceName 服务名称
 * @param {HTMLElement} dom 开关元素
 */
async function changeSwitch(serviceName, dom) {
  const obj = list.find((item) => item.serviceName === serviceName)
  // isChanging 用于避免命令执行期间重复点击导致状态错乱
  if (!obj.isChanging) {
    obj.isChanging = true
    if (obj.status) await window.api.run('net stop ' + serviceName)
    else await window.api.run('net start ' + serviceName)
    obj.status = !obj.status
    dom.checked = obj.status
    obj.isChanging = false
  }
}

/**
 * 把服务列表渲染成卡片，并插入到容器最前面
 * @param {Array} list 服务列表
 */
function initList(list) {
  const container = document.getElementById('container')
  // 分行拼接而非整段模板字面量：插入换行会在 innerHTML 里产生空白文本节点
  container.innerHTML =
    list
      .map(
        (item) =>
          `<div class="card"><div class="title">${item.domName}服务</div>` +
          `<label class="toggle-switch">` +
          `<input type="checkbox" class="toggle-input" id="${item.domName}">` +
          `<span class="toggle-slider"><span class="toggle-thumb"></span></span>` +
          `</label></div>`
      )
      .join('') + container.innerHTML
  initDeleteIcons(list)
  showmodelJsAdd()
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
    addDom(nodeName)
    addEventListenerService(
      document.getElementById(nodeName),
      serviceName,
      await getStatus(serviceName)
    )

    list.push({
      domName: nodeName,
      serviceName: serviceName,
      status: false,
      isChanging: false
    })
    myModal.style.display = 'none'
    initDeleteIcons(list)
    updateData({
      id: 1,
      data: list
    })
  })

  // 点击遮罩层（而非弹框内容）时关闭
  myModal.addEventListener('click', function (e) {
    if (e.target === myModal) {
      myModal.style.display = 'none'
    }
  })

  /**
   * 在容器中插入新卡片，位置放在「新增」按钮之前
   * @param {string} nodeName 节点名称，同时用作 checkbox 的 id
   */
  function addDom(nodeName) {
    const parent = document.getElementById('container')
    const oldNodes = Array.from(parent.children)
    parent.innerHTML = ''
    const tempContainer = document.createElement('div')
    tempContainer.innerHTML = `
    <div class="card">
      <div class="title">${nodeName}服务</div>
      <label class="toggle-switch">
        <input type="checkbox" class="toggle-input" id="${nodeName}">
        <span class="toggle-slider">
          <span class="toggle-thumb"></span>
        </span>
      </label>
    </div>
  `
    // 末尾是「新增」卡片，插到它前面
    oldNodes.splice(oldNodes.length - 2, 0, tempContainer.firstElementChild)
    oldNodes.forEach((node) => parent.appendChild(node))
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const listDB = await loadData()
  if (listDB) list = listDB.data
  // 首次运行时数据库还没有约定好的 id 1 记录，给一个默认服务兜底
  else list = [{ domName: 'mysql', serviceName: 'MySQL84' }]
  initList(list)
  for (let i = 0; i < list.length; i++) {
    list[i].status = await getStatus(list[i].serviceName)
    list[i].isChanging = false
    addEventListenerService(
      document.getElementById(list[i].domName),
      list[i].serviceName,
      list[i].status
    )
  }
})
