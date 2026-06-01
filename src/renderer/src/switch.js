import { loadData, upData } from './store'
import { initDeleteIcons } from './delete'

document.addEventListener('DOMContentLoaded', async () => {
  /**
   *防抖
   */
  const debounce = (func, timeout = 500) => {
    let flag = null
    return (...args) => {
      if (flag) clearTimeout(flag)
      flag = setTimeout(() => {
        func(...args)
        flag = null
      }, timeout)
    }
  }
  // await upData({
  //   id: 1,
  //   data: [
  //     { domName: 'mysql', serviceName: 'MySQL94' },
  //     { domName: 'postgresql', serviceName: 'postgresql-x64-18' }
  //   ]
  // })
  const listDB = await loadData()
  let list
  if (listDB) list = listDB.data
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

  /**
   * 注册开关状态监听
   * 参数1为dom元素,参数2为服务名称,参数3为服务状态
   */
  function addEventListenerService(dom, serviceName, status) {
    // 初始化状态
    dom.checked = status
    const handleToggle = debounce(() => {
      changeSwitch(serviceName, dom)
    }, 500)
    // 键盘空格切换
    dom.addEventListener('keydown', (e) => {
      e.preventDefault()
      if (e.key === ' ') {
        dom.checked = !dom.checked
        handleToggle()
      }
    })
    // 点击切换
    dom.addEventListener('click', handleToggle)
  }

  /**
   * 查询服务状态
   */
  async function getStatus(serviceName) {
    let res = await window.api.run('sc query ' + serviceName)
    if (res.success === true) return res.result.indexOf('4  RUNNING') !== -1
    else return false
  }

  /**
   * 处理开关切换事件
   * 参数为服务名称
   */
  async function changeSwitch(serviceName, dom) {
    const obj = list.find((item) => item.serviceName === serviceName)
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
   * 插入dom元素
   */
  function initList(list) {
    const container = document.getElementById('container')
    container.innerHTML =
      list
        .map(
          (item) =>
            `<div class="card"><div class="title">${item.domName}服务</div><label class="toggle-switch"><input type="checkbox" class="toggle-input" id="${item.domName}"><span class="toggle-slider"><span class="toggle-thumb"></span></span></label></div>`
        )
        .join('') + container.innerHTML
    initDeleteIcons(list)
    showmodelJsAdd()
  }

  /*
   *新增服务处理
   */
  function showmodelJsAdd() {
    const add = document.getElementById('add')
    const myModal = document.getElementById('myModal')
    const cancelBtn = document.getElementById('cancelBtn')
    const confirmBtn = document.getElementById('confirmBtn')
    const nodeNameInput = document.getElementById('nodeName')
    const serviceNameInput = document.getElementById('serviceName')

    // 打开弹框
    add.addEventListener('click', function () {
      myModal.style.display = 'flex'
      nodeNameInput.value = ''
      serviceNameInput.value = ''
    })

    // 取消按钮
    cancelBtn.addEventListener('click', function () {
      myModal.style.display = 'none'
    })

    // 确认按钮
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
      upData({
        id: 1,
        data: list
      })
    })

    // 点击弹框外部关闭弹框
    myModal.addEventListener('click', function (e) {
      if (e.target === myModal) {
        myModal.style.display = 'none'
      }
    })

    // 更新dom
    function addDom(nodeName) {
      const parent = document.getElementById('container')
      // 保存原有节点
      const oldNodes = Array.from(parent.children)
      parent.innerHTML = ''
      // 新增节点
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
      oldNodes.splice(oldNodes.length - 2, 0, tempContainer.firstElementChild)
      // 插回节点
      oldNodes.forEach((node) => parent.appendChild(node))
    }
  }
})
