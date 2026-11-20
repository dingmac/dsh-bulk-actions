/**
 * Client 半自测：用最小化的 window / document / react 桩跑一遍 apply()，
 * 确认右键菜单贡献、图标注册、两个 shell.overlay 注册都成立。
 * 运行：node tests/client.test.mjs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const file = path.join(import.meta.dirname, '..', 'client.js')
const source = await fs.readFile(file, 'utf8')
assert.ok(source.includes("id: '@local/dsh-bulk-actions'"), 'client.js 应注册正确的模块 id')

let loaded = null
const styleTags = []
const noop = () => {}
const element = (tag) => ({
  tag, textContent: '', id: '', className: '', style: {},
  firstChild: null,
  setAttribute: noop, removeAttribute: noop, hasAttribute: () => false,
  appendChild: noop, insertBefore: noop, removeChild: noop,
  addEventListener: noop, removeEventListener: noop, cloneNode: () => element(tag),
})
const doc = {
  documentElement: { setAttribute: noop, removeAttribute: noop },
  head: { appendChild(node) { styleTags.push(node) } },
  body: {},
  getElementById() { return null },
  createElement: element,
  createElementNS: (_ns, tag) => element(tag),
  querySelector() { return null },
  querySelectorAll() { return [] },
  addEventListener: noop,
  removeEventListener: noop,
}
globalThis.document = doc

const winListeners = []
globalThis.window = {
  innerWidth: 1440,
  addEventListener(type) { winListeners.push(type) },
  removeEventListener: noop,
  __ModuleLoader__: { load(entry) { loaded = entry } },
}
const React = {
  createElement(type, props, ...children) { return { type, props: props || {}, children } },
  useSyncExternalStore() { return { mode: false, picked: [], busy: '', confirm: null, anchor: null } },
}
globalThis.require = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, settings: { menu: { delete: { visible: true, order: 610 } } } }),
})

await import('file://' + file + '?t=' + Date.now())
assert.ok(loaded !== null, 'client.js 应调用 __ModuleLoader__.load')
assert.equal(loaded.id, '@local/dsh-bulk-actions')
assert.equal(typeof loaded.factory, 'function')

const plugin = loaded.factory(globalThis.require)
assert.deepEqual(plugin.inject, ['slots', 'contextMenus'])

const registered = { menus: [], slots: [] }
const ctx = {
  contextMenus: {
    register(input) { registered.menus.push(input); return () => {} },
    notify() {},
  },
  slots: {
    inject(name, fn) { fn() },
    register(descriptor, component) { registered.slots.push({ descriptor, component }) },
  },
  effect(fn) { fn(); return () => {} },
  get() { return null },
}
plugin.apply(ctx)

assert.equal(styleTags.length, 1, 'apply() 应注入一段样式')
assert.equal(registered.menus.length, 1, '现在只有「单条删除」一个菜单贡献')
const menu = registered.menus[0]
assert.equal(menu.id, 'bulk-actions')
assert.equal(menu.target, 'session')
assert.equal(menu.order, 610)

// 官方回调直接传 ContextMenuTargetMap['session']，不带 { kind, value } 包装。
const actions = menu.resolve({ sessionId: 'sid-1', displayTitle: '任务一' })
assert.deepEqual(actions.map(a => a.id), ['bulk.delete-one'])
assert.equal(actions[0].danger, true)
assert.deepEqual(actions[0].icon, { key: 'bulk.delete' })
assert.equal(typeof actions[0].run, 'function')

// 图标：keyed 注册在 contextMenu.icon 上
const iconSlot = registered.slots.find(s => s.descriptor.name === 'contextMenu.icon')
assert.ok(iconSlot, '应注册 contextMenu.icon')
assert.equal(iconSlot.descriptor.key, 'bulk.delete')
assert.equal(typeof iconSlot.component, 'function')

// 浮层：确认框已改成命令式 DOM，不再占用 shell.overlay
const overlays = registered.slots.filter(s => s.descriptor.name === 'shell.overlay')
assert.equal(overlays.length, 0)
for (const slot of overlays) assert.equal(typeof slot.component, 'function')

// 设置页暂时随右侧栏方案一起移除；如果恢复设置入口，这里再加回断言

// 窗口尺寸变化监听
assert.ok(winListeners.includes('resize'), '应监听窗口 resize 以重算操作条位置')

console.log('client.test OK')
