/**
 * Host 半自测：在临时 DSH 家目录里跑一遍删除流程，不碰真实 ~/.dsh。
 * 运行：node tests/host.test.mjs
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { deleteSessions, normalizeConfig, scanSessionDirs, pruneWorkspaceRegistry, internals } from '../index.js'

const root = await fs.mkdtemp(path.join(tmpdir(), 'dba-host-'))
const home = path.join(root, 'dsh')
const project = path.join(home, 'sessions', '--project-a--')
const liveId = '11111111-1111-4111-8111-111111111111'
const deadId = '22222222-2222-4222-8222-222222222222'
const goneId = '33333333-3333-4333-8333-333333333333'

async function seed(id) {
  const dir = path.join(project, id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), 'x')
  await fs.writeFile(path.join(dir, 'session.lock'), '')
  return dir
}
const liveDir = await seed(liveId)
const deadDir = await seed(deadId)
// dead 会话应该是“早就不写了”的状态，把文件时间往前拨，避免被“刚写过”规则拦住
const old = new Date(Date.now() - 3600_000)
for (const name of ['session.v4.jsonl.zstd', 'session.lock']) {
  await fs.utimes(path.join(deadDir, name), old, old)
}

await fs.mkdir(path.join(home, 'storages'), { recursive: true })
const registry = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    defaultWorkspaceId: 'w1',
    workspaceIds: ['w1'],
    archivedSessionIds: [deadId, liveId],
    pinnedSessionIds: [deadId],
  },
  tables: {
    workspaces: {
      w1: { path: '/x', title: 'x', sessionIds: [deadId, liveId, goneId], createdAt: '', updatedAt: '' },
    },
  },
}
await fs.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify(registry))

const emitted = []
const ctx = {
  get(name) {
    if (name === 'sessions') return { get: (id) => (id === liveId ? { id } : undefined) }
    return undefined
  },
  emit(name, id) { emitted.push([name, id]) },
  logger: { warn() {} },
}

const config = normalizeConfig({ home })
assert.equal(config.home, home)
assert.equal(internals.resolveHome(config), home)

const index = await scanSessionDirs(path.join(home, 'sessions'))
assert.equal(index.size, 2)

const result = await deleteSessions(ctx, config, {
  sessionIds: [deadId, liveId, goneId, '../etc', 42],
  keepId: liveId,
})
assert.deepEqual(result.deleted, [deadId])
assert.deepEqual(result.skipped.map(item => item.id).sort(), [goneId, liveId].sort())
assert.deepEqual(result.failed.map(item => item.id), ['../etc'])
assert.equal(result.pruned, true)
assert.deepEqual(emitted, [['api-session/removed', deadId]])

await assert.rejects(fs.access(deadDir))
await fs.access(liveDir)

const after = JSON.parse(await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
assert.ok(!after.global.archivedSessionIds.includes(deadId))
assert.ok(after.global.archivedSessionIds.includes(liveId))
assert.ok(!after.global.pinnedSessionIds.includes(deadId))
assert.deepEqual(after.tables.workspaces.w1.sessionIds, [liveId, goneId])
await fs.access(path.join(home, 'storages', 'workspace.json.bak-bulk-actions'))

const noop = await pruneWorkspaceRegistry(path.join(home, 'storages', 'workspace.json'), new Set(['nothing']))
assert.equal(noop, false)

const empty = await deleteSessions(ctx, config, [])
assert.deepEqual(empty.deleted, [])

await fs.rm(root, { recursive: true, force: true })
console.log('host.test OK')
