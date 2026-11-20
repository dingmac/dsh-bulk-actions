/**
 * 真 DOM 自测（jsdom）：把 apply() 跑在模仿 DSH 侧栏的结构上，
 * 端到端验证「进多选 → 标题行出现三个按钮 → 点按钮有效 → 弹窗开合」。
 * 运行：node tests/client.dom.test.mjs
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM, VirtualConsole } from 'jsdom'

const file = path.join(import.meta.dirname, '..', 'client.js')

const html = `<!doctype html><html><head></head><body>
  <div class="Kjh-qa_row">
    <div class="Kjh-qa_searchSlot"><button aria-label="搜索"></button></div>
    <div class="Kjh-qa_headerActions">
      <button aria-label="搜索"></button>
      <button aria-label="排序"></button>
      <button aria-label="新建"></button>
    </div>
  </div>
  <div class="Kjh-qa_scroller">
    <div role="tree">
      <div class="Kjh-qa_sessionRow" data-row-key="session:aaa"><span class="t">会话 A</span></div>
      <div class="Kjh-qa_sessionRow" data-row-key="session:bbb"><span class="t">会话 B</span></div>
    </div>
  </div>
  <div class="JZLxKW_input" contenteditable="true"></div>
</body></html>`

const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (error) => console.error('[jsdom error]', error && error.stack ? error.stack : error))

const dom = new JSDOM(html, { url: 'http://127.0.0.1/', pretendToBeVisual: true, virtualConsole })
const { window } = dom
const doc = window.document

globalThis.window = window
globalThis.document = doc
window.innerWidth = 1440
window.innerHeight = 900
window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, deleted: ['session:aaa'], skipped: [], failed: [] }) })
globalThis.fetch = window.fetch

const log = []
window.fetch = async (url, init) => {
  log.push(['fetch', String(url), init && init.body])
  return { ok: true, json: async () => ({ ok: true, deleted: JSON.parse(init.body).sessionIds, skipped: [], failed: [] }) }
}
globalThis.fetch = window.fetch

let loaded = null
window.__ModuleLoader__ = { load(entry) { loaded = entry } }
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useSyncExternalStore: () => ({ mode: false, picked: [], busy: '', confirm: null, anchor: null }),
}
window.require = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}
globalThis.require = window.require

const notices = []
const removed = []
const menus = []
const slots = []
const ctx = {
  effect(fn) { return fn() },
  slots: {
    inject(_name, fn) { return fn() },
    register(descriptor, component) { slots.push({ descriptor, component }); return () => {} },
  },
  contextMenus: {
    register(definition) { menus.push(definition); return () => {} },
    notify(text, ok) { notices.push([text, ok]) },
  },
  get(name) {
    if (name === 'sessions') {
      return { handleSessionRemoved(id) { removed.push(id) }, async refresh() { removed.push('*refresh*') } }
    }
    if (name === 'workspaceService') {
      return {
        async archiveSession() {},
        async unarchiveSession() {},
      }
    }
    return undefined
  },
}

await import('file://' + file + '?t=' + Date.now())
assert.ok(loaded, 'client.js 应调用 __ModuleLoader__.load')
assert.equal(loaded.id, '@local/dsh-bulk-actions')
assert.equal(typeof loaded.factory, 'function')

// factory 里返回 { inject, apply }
const exported = loaded.factory(window.require)
assert.equal(typeof exported.apply, 'function')
exported.apply(ctx)

// 把插件内部的报错/日志打出来，便于定位
const origError = console.error
console.error = (...args) => { origError('[plugin error]', ...args.map(a => (a && a.stack) ? a.stack : a)) }

const headerRow = doc.querySelector('.Kjh-qa_row')
const toggle = doc.querySelector('[data-dba-toggle]')
assert.ok(toggle, '应挂出多选按钮')
assert.equal(toggle.parentElement, headerRow, '多选按钮应插在标题行')

// 未进多选时不应有动作按钮
assert.equal(doc.querySelectorAll('[data-dba-act]').length, 0)

// 进多选
toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
assert.ok(doc.documentElement.hasAttribute('data-dba-mode'), '应进入多选模式')

const acts = Array.from(doc.querySelectorAll('[data-dba-act]'))
assert.equal(acts.length, 3, '标题行应出现 3 个动作按钮：' + acts.map(a => a.textContent))
assert.deepEqual(acts.map(a => a.getAttribute('data-dba-act')), ['archive', 'unarchive', 'delete'])
for (const button of acts) {
  assert.equal(button.parentElement, headerRow, '动作按钮应在标题行（不是被裁掉的 60px 容器）')
  assert.ok(button.hasAttribute('data-dba-ui'), '动作按钮要带插件 UI 标记，避免被当成空白点击')
}

// 多选期间原生图标按钮组应隐藏，退出后恢复
const nativeActions = doc.querySelector('.Kjh-qa_headerActions')
assert.equal(nativeActions.style.display, 'none', '多选期间应隐藏原生图标按钮组')

// 复选框应出现在每一行
const rows = Array.from(doc.querySelectorAll('[data-row-key^="session:"]'))
assert.equal(rows.length, 2)
for (const row of rows) assert.ok(row.querySelector('[data-dba-check]'), '每行应有复选框')

// 未勾选点删除：给提示，不弹窗
acts[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
assert.equal(doc.querySelectorAll('.dba-backdrop').length, 0, '未勾选不应弹确认框')
assert.ok(notices.some(item => String(item[0]).includes('勾选')), '应提示先勾选：' + JSON.stringify(notices))

// 勾选一行
rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
assert.ok(rows[0].hasAttribute('data-dba-picked'), '点击行应被选中')

// 点删除 → 弹确认框
const deleteButton = doc.querySelector('[data-dba-act="delete"]')
deleteButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const backdrop = doc.querySelector('.dba-backdrop')
assert.ok(backdrop, '应弹出删除确认框')
assert.ok(backdrop.textContent.includes('删除'), '确认框应有标题')

// 点永久删除 → 调接口并关掉弹窗
const danger = backdrop.querySelector('.dba-danger')
assert.ok(danger, '确认框应有永久删除按钮')
danger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise(resolve => setTimeout(resolve, 50))
assert.equal(doc.querySelectorAll('.dba-backdrop').length, 0, '删除后确认框必须消失')
assert.ok(log.some(item => String(item[1]).includes('/delete')), '应调用删除接口')
assert.deepEqual(removed, ['aaa'], '删除后应把会话从客户端列表移除（否则 UI 里那行还在）')

// Esc 退出多选 → 动作按钮消失
doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await new Promise(resolve => setTimeout(resolve, 10))
assert.equal(doc.querySelectorAll('[data-dba-act]').length, 0, '退出多选后动作按钮应移除')
assert.notEqual(nativeActions.style.display, 'none', '退出多选后原生图标按钮组应恢复显示')

console.log('client.dom.test OK')
