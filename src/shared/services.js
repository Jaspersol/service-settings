// 主进程与渲染进程共用的服务名校验和列表查找逻辑，
// 两边必须用同一套规则，避免分歧。

// 服务名只允许字母、数字、下划线、点、美元符号和连字符
export const SERVICE_NAME_PATTERN = /^[\w.$-]+$/

// 允许的 IPC 操作：查询状态、启动、停止
export const SERVICE_ACTIONS = ['status', 'start', 'stop']

// sc query 的输出里，运行中状态为「STATE : 4  RUNNING」
export const RUNNING_PATTERN = /\b4\s+RUNNING\b/

/**
 * 校验服务名是否安全可执行
 * @param {unknown} name 服务名
 * @returns {boolean} 是否合法
 */
export function isValidServiceName(name) {
  return typeof name === 'string' && SERVICE_NAME_PATTERN.test(name)
}

/**
 * 比较用的规范化键：Windows 服务名不区分大小写
 * @param {unknown} value 节点名或服务名
 */
function key(value) {
  return String(value == null ? '' : value).toLowerCase()
}

/**
 * 在列表中查找服务名对应的条目下标
 * @param {Array} list 服务列表
 * @param {string} serviceName 服务名称
 * @returns {number} 下标，找不到时为 -1
 */
export function findServiceIndex(list, serviceName) {
  const target = key(serviceName)
  return list.findIndex((item) => key(item.serviceName) === target)
}

/**
 * 从列表中删除指定服务名的条目。
 * 找不到时不做任何修改并返回 null —— 绝不拿 -1 当删除下标（那会删掉最后一项）。
 * @param {Array} list 服务列表（原地修改）
 * @param {string} serviceName 服务名称
 * @returns {{index: number, item: object}|null} 被删除的条目及原下标
 */
export function removeService(list, serviceName) {
  const index = findServiceIndex(list, serviceName)
  if (index === -1) return null
  const [item] = list.splice(index, 1)
  return { index, item }
}

/**
 * 新增前检查重名：节点名或服务名与已有条目的任一项相同即视为重复
 * @param {Array} list 服务列表
 * @param {string} domName 节点名称
 * @param {string} serviceName 服务名称
 * @returns {boolean} 是否重复
 */
export function isDuplicateEntry(list, domName, serviceName) {
  const node = key(domName)
  const service = key(serviceName)
  return list.some((item) => key(item.domName) === node || key(item.serviceName) === service)
}
