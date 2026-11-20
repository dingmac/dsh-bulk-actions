/**
 * dsh-bulk-actions —— Host 半。
 *
 * 职责只有一件事：把选中的会话从磁盘上真正删掉，并让侧栏立刻少掉那一行。
 *
 *   1. 在 <home>/sessions/<项目目录>/<会话 id>/ 里定位会话目录（只认目录名，不靠路径编码）；
 *   2. 拒绝删除仍在运行的会话（live），避免边跑边删日志；
 *   3. rm -rf 该目录；
 *   4. 从 <home>/storages/workspace.json 里修剪 archivedSessionIds / pinnedSessionIds /
 *      tables.workspaces[*].sessionIds 里残留的 id（写前留 .bak-bulk-actions 备份）；
 *   5. 广播 api-session/removed，Client 的会话列表随即移除该行（无需刷新页面）。
 *
 * 归档不在这里：Client 直接调用现有的 ctx.workspaces.archiveSession()。
 *
 * 路由（同源、仅环回）：
 *   POST /_dsh/bulk-actions/delete  { sessionIds: string[] }
 *        → 200 { ok, deleted, skipped, failed, pruned }
 *   GET  /_dsh/bulk-actions/info
 *        → 200 { ok, home, sessionsRoot, sessions, version }
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const ROUTE = '/_dsh/bulk-actions'
export const VERSION = '1.3.1'

/** 会话 id：目录名即可，限制字符集以防路径穿越。 */
const SESSION_ID = /^(?:session-)?[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/
const MAX_BATCH = 200
const MAX_BODY_BYTES = 256 * 1024
const REGISTRY_BACKUP = '.bak-bulk-actions'

/**
 * 归一化插件配置。
 * @param {unknown} raw - cordis.patch.yml 里的 config。
 * @returns {{ home: string, maxBatch: number, debug: boolean }}
 */
export function normalizeConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { home: '', maxBatch: MAX_BATCH, debug: false }
  if (typeof source.home === 'string' && source.home.trim() !== '') out.home = source.home.trim()
  if (Number.isInteger(source.maxBatch) && source.maxBatch > 0) {
    out.maxBatch = Math.min(source.maxBatch, 2000)
  }
  if (source.debug === true) out.debug = true
  return out
}

/** 右键菜单的默认配置：只描述本插件自己贡献的条目。 */
export const DEFAULT_SETTINGS = Object.freeze({
  menu: {
    delete: { visible: true, order: 610 },
  },
})

/** 允许的三档位置 → 实际 order 值。 */
export const MENU_ORDERS = Object.freeze({ first: 90, default: 610, last: 900 })

/**
 * 归一化菜单配置。
 * @param {unknown} raw - 磁盘或请求里的对象。
 * @returns {{ menu: { delete: { visible: boolean, order: number } } }}
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const menu = source.menu !== null && typeof source.menu === 'object' ? source.menu : {}
  const del = menu.delete !== null && typeof menu.delete === 'object' ? menu.delete : {}
  const order = Number.isInteger(del.order) && del.order > -1000 && del.order < 10000
    ? del.order
    : DEFAULT_SETTINGS.menu.delete.order
  return {
    menu: {
      delete: {
        visible: del.visible !== false,
        order,
      },
    },
  }
}

/**
 * 设置文件路径。
 * @param {string} home - DSH 家目录。
 * @returns {string}
 */
export function settingsFile(home) {
  return path.join(home, 'bulk-actions', 'settings.json')
}

/**
 * 读取设置，缺文件/坏文件时回落默认值。
 * @param {string} home - DSH 家目录。
 * @returns {Promise<ReturnType<typeof normalizeSettings>>}
 */
export async function readSettings(home) {
  try {
    const raw = await fs.readFile(settingsFile(home), 'utf8')
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

/**
 * 写入设置（先写临时文件再改名）。
 * @param {string} home - DSH 家目录。
 * @param {unknown} value - 归一化后的设置。
 * @returns {Promise<ReturnType<typeof normalizeSettings>>}
 */
export async function writeSettings(home, value) {
  const normalized = normalizeSettings(value)
  const file = settingsFile(home)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid
  await fs.writeFile(temp, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
  await fs.rename(temp, file)
  return normalized
}

/**
 * DSH 家目录：配置 > $DSH_HOME > ~/.dsh。
 * @param {{ home: string }} config - 归一化配置。
 * @returns {string}
 */
export function resolveHome(config) {
  if (config.home !== '') return config.home
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (env !== '') return env
  return path.join(homedir(), '.dsh')
}

/**
 * 扫描 <home>/sessions 下每个项目目录里的会话目录，建立 id → 目录 的索引。
 * @param {string} root - sessions 根目录。
 * @returns {Promise<Map<string, string>>}
 */
export async function scanSessionDirs(root) {
  const found = new Map()
  let projects
  try {
    projects = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    let sessions
    try {
      sessions = await fs.readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      found.set(session.name, path.join(projectDir, session.name))
    }
  }
  return found
}

/**
 * 修剪 workspace.json 里被删会话的残留记账。
 * @param {string} file - workspace.json 绝对路径。
 * @param {ReadonlySet<string>} removed - 已删除的会话 id。
 * @returns {Promise<boolean>} 是否真的改写了文件。
 */
export async function pruneWorkspaceRegistry(file, removed) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  let changed = false
  const keep = id => {
    const drop = removed.has(id)
    if (drop) changed = true
    return !drop
  }

  const globalState = parsed?.global
  if (globalState !== null && typeof globalState === 'object') {
    if (Array.isArray(globalState.archivedSessionIds)) {
      globalState.archivedSessionIds = globalState.archivedSessionIds.filter(keep)
    }
    if (Array.isArray(globalState.pinnedSessionIds)) {
      globalState.pinnedSessionIds = globalState.pinnedSessionIds.filter(keep)
    }
  }
  const table = parsed?.tables?.workspaces
  if (table !== null && typeof table === 'object') {
    for (const record of Object.values(table)) {
      if (record !== null && typeof record === 'object' && Array.isArray(record.sessionIds)) {
        record.sessionIds = record.sessionIds.filter(keep)
      }
    }
  }
  if (!changed) return false

  const temp = file + '.tmp-' + process.pid
  await fs.copyFile(file, file + REGISTRY_BACKUP)
  await fs.writeFile(temp, JSON.stringify(parsed), 'utf8')
  await fs.rename(temp, file)
  return true
}

/**
 * 判断会话是否仍活在宿主进程里（打开中/运行中）。
 * @param {unknown} store - ctx.get('sessions')。
 * @param {string} id - 会话 id。
 * @returns {boolean}
 */
/** 会话目录里最近 120 秒是否有写入（session.lock / 日志文件的 mtime）。 */
async function isRecentlyWritten(dir) {
  const candidates = ['session.lock', 'session.v4.jsonl.zstd']
  for (const name of candidates) {
    try {
      const stat = await fs.stat(path.join(dir, name))
      if (Date.now() - stat.mtimeMs < 5000) return true
    } catch { /* 文件不存在就跳过 */ }
  }
  return false
}

function isLive(store, id) {
  if (store === null || store === undefined || typeof store.get !== 'function') return false
  try {
    return store.get(id) !== undefined && store.get(id) !== null
  } catch {
    return false
  }
}

/**
 * 删除一批会话。
 * @param {object} ctx - Cordis 上下文。
 * @param {{ home: string, maxBatch: number }} config - 归一化配置。
 * @param {unknown} input - 请求里的 sessionIds。
 * @returns {Promise<{ deleted: string[], skipped: { id: string, reason: string }[], failed: { id: string, reason: string }[], pruned: boolean }>}
 */
export async function deleteSessions(ctx, config, input) {
  const payload = Array.isArray(input) ? { sessionIds: input } : (input && typeof input === 'object' ? input : {})
  const list = Array.isArray(payload.sessionIds) ? payload.sessionIds : []
  const requested = list.filter(value => typeof value === 'string')
  const keepId = typeof payload.keepId === 'string' ? payload.keepId : ''
  const ids = [...new Set(requested)].slice(0, config.maxBatch)
  const deleted = []
  const skipped = []
  const failed = []
  if (ids.length === 0) return { deleted, skipped, failed, pruned: false }

  const home = resolveHome(config)
  const root = path.join(home, 'sessions')
  const resolvedRoot = path.resolve(root)
  const index = await scanSessionDirs(resolvedRoot)
  const store = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined

  for (const id of ids) {
    if (!SESSION_ID.test(id)) {
      failed.push({ id, reason: '会话 id 不合法' })
      continue
    }
    const sessionDir = index.get(id)
    if (sessionDir === undefined) {
      skipped.push({ id, reason: '磁盘上已经没有这个会话' })
      continue
    }
    const resolved = path.resolve(sessionDir)
    if (!resolved.startsWith(resolvedRoot + path.sep)) {
      failed.push({ id, reason: '会话目录不在 sessions 根目录内，已拒绝' })
      continue
    }
    // 只有「界面上正打开的那个」和「几秒内还在写盘的」才拦，其余一律放行。
    // 之前用 store.get(id) 判断，会话切走后条目仍留在 store 里，导致永远删不掉。
    if (keepId !== '' && id === keepId) {
      skipped.push({ id, reason: '这是你当前打开的会话，先切到别的会话再删' })
      continue
    }
    if (await isRecentlyWritten(resolved)) {
      skipped.push({ id, reason: '这个会话刚刚还在写入，等几秒再删' })
      continue
    }
    try {
      await fs.rm(resolved, { recursive: true, force: true })
      deleted.push(id)
      index.delete(id)
    } catch (error) {
      failed.push({ id, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    try {
      if (typeof ctx.emit === 'function') ctx.emit('api-session/removed', id)
    } catch {
      /* 广播失败不影响删除结果；页面刷新后会自然消失。 */
    }
  }

  let pruned = false
  if (deleted.length > 0) {
    try {
      pruned = await pruneWorkspaceRegistry(path.join(home, 'storages', 'workspace.json'), new Set(deleted))
    } catch (error) {
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn('dsh-bulk-actions: 修剪 workspace 记账失败：' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }
  return { deleted, skipped, failed, pruned }
}

/**
 * 读取请求体 JSON。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<unknown>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 回写 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 响应体。
 */
function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

/**
 * 诊断用：报告本包在 Web 客户端图里的登记情况。
 * @param {object} ctx - Cordis 上下文。
 * @returns {{ registered: boolean, clientPath: string | null, localEntries: string[] }}
 */
function describeClientGraph(ctx) {
  const registry = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
  let clientPath = null
  let localEntries = []
  try {
    if (registry !== null && registry !== undefined && typeof registry.clientPath === 'function') {
      clientPath = registry.clientPath('@local/dsh-bulk-actions') ?? null
    }
    if (registry !== null && registry !== undefined && typeof registry.graph === 'function') {
      const graph = registry.graph()
      localEntries = Array.isArray(graph?.entries)
        ? graph.entries.map(entry => entry.id).filter(id => typeof id === 'string' && id.startsWith('@local'))
        : []
    }
  } catch (error) {
    clientPath = 'error: ' + (error instanceof Error ? error.message : String(error))
  }
  return { registered: clientPath !== null, clientPath, localEntries }
}

/**
 * 构造路由处理器。
 * @param {object} ctx - Cordis 上下文。
 * @param {ReturnType<typeof normalizeConfig>} config - 归一化配置。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler(ctx, config) {
  return async function handler(req, res) {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection !== null && connection !== undefined && typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined && rejection !== null && rejection !== false) {
        send(res, typeof rejection === 'number' ? rejection : 403, { ok: false, error: '请求来源被拒绝' })
        return
      }
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(ROUTE + '/')) {
      send(res, 404, { ok: false, error: '没有这个接口' })
      return
    }
    const rest = url.pathname.slice(ROUTE.length + 1).replace(/[/]+$/, '')

    if (rest === 'info' && (req.method === 'GET' || req.method === 'POST')) {
      const home = resolveHome(config)
      const root = path.join(home, 'sessions')
      const index = await scanSessionDirs(root)
      const client = describeClientGraph(ctx)
      send(res, 200, { ok: true, version: VERSION, home, sessionsRoot: root, sessions: index.size, client })
      return
    }

    if (rest === 'settings') {
      const home = resolveHome(config)
      if (req.method === 'GET') {
        send(res, 200, { ok: true, settings: await readSettings(home) })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: '只接受 GET/POST' })
        return
      }
      const body = await readJsonBody(req)
      const saved = await writeSettings(home, body && typeof body === 'object' && body.settings !== undefined ? body.settings : body)
      send(res, 200, { ok: true, settings: saved })
      return
    }

    if (rest === 'log') {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(req)
      const message = body !== null && typeof body === 'object' ? String(body.message ?? '').slice(0, 2000) : ''
      const home = resolveHome(config)
      const file = path.join(home, 'bulk-actions', 'debug.log')
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.appendFile(file, new Date().toISOString() + ' ' + message + '\n', 'utf8')
      } catch { /* 诊断日志失败不影响主流程 */ }
      send(res, 200, { ok: true })
      return
    }

    if (rest === 'delete') {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(req)
      const input = body !== null && typeof body === 'object' ? body.sessionIds : undefined
      if (!Array.isArray(input) || input.length === 0) {
        send(res, 400, { ok: false, error: 'sessionIds 必须是非空数组' })
        return
      }
      const result = await deleteSessions(ctx, config, input)
      if (config.debug && typeof ctx.logger?.info === 'function') {
        ctx.logger.info('dsh-bulk-actions: delete ' + JSON.stringify({ deleted: result.deleted.length, skipped: result.skipped.length, failed: result.failed.length }))
      }
      send(res, 200, { ok: true, ...result })
      return
    }

    send(res, 404, { ok: false, error: '没有这个接口' })
  }
}

/**
 * 挂载路由。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - cordis.patch.yml 里的 config。
 * @returns {{ config: object, handler: Function }}
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const handler = createHandler(ctx, config)
  ctx.inject(['webServer'], scope => {
    scope.effect(
      () => scope.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      'dsh-bulk-actions: routes',
    )
  })
  return { config, handler }
}

/** 测试面：不参与 HTTP 契约。 */
export const internals = {
  normalizeConfig,
  resolveHome,
  scanSessionDirs,
  pruneWorkspaceRegistry,
  deleteSessions,
  createHandler,
}
