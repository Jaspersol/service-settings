// 脚手架示例，暂未接入实际界面：index.html 仍以 <script type="module"> 引入本文件，
// 其中 .electron-version / .chrome-version / .node-version / #ipcHandler 在当前页面均不存在，
// 因此 doAThing() 实际上什么也不做。保留原因：作为调用 preload 暴露 API 的参考示例。
// 若确认不再需要，可删除本文件并同时移除 index.html 中的引入。

function init() {
  window.addEventListener('DOMContentLoaded', () => {
    doAThing()
  })
}

function doAThing() {
  const versions = window.electron.process.versions
  replaceText('.electron-version', `Electron v${versions.electron}`)
  replaceText('.chrome-version', `Chromium v${versions.chrome}`)
  replaceText('.node-version', `Node v${versions.node}`)

  const ipcHandlerBtn = document.getElementById('ipcHandler')
  ipcHandlerBtn?.addEventListener('click', () => {
    window.electron.ipcRenderer.send('ping')
  })
}

function replaceText(selector, text) {
  const element = document.querySelector(selector)
  if (element) {
    element.innerText = text
  }
}

init()
