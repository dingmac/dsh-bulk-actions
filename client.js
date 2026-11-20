/**
 * dsh-bulk-actions —— 浏览器半。
 *
 * 一个 lazy-CJS 模块，只 require('react')。它做三件事：
 *   1. 在工作区标题右侧的操作栏里注入「多选」按钮（不是右键菜单）；
 *   2. 多选模式：点任务行即加选/取消，操作条悬浮在该操作栏右下方的格子里，
 *      提供批量归档 / 批量删除 / 取消归档 / 全选 / 取消；
 *   3. 任务右键菜单加入带图标的「删除会话…」，删除前弹确认框。
 *
 * 选中态不改 React 树，只给行加 data 属性并配一段样式，因此不受侧栏重渲染影响。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bulk-actions',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    const VERSION = '1.3.1'
    const ROUTE = '/_dsh/bulk-actions'
    const STYLE_ID = 'dba-style'
    const ROW = '[data-row-key^="session:"]'
    const UI = 'data-dba-ui'
    const TOGGLE = 'data-dba-toggle'
    const CHECK = 'data-dba-check'
    const MAX_LIST = 12
    const ADD_LABELS = ['新建工作区', '添加工作区', 'Add workspace', 'Add Workspace', 'New workspace']

    /* ------------------------------------------------------------------ */
    /* 状态                                                                */
    /* ------------------------------------------------------------------ */

    const initial = { mode: false, picked: [], busy: '', confirm: null, anchor: null }
    let snapshot = initial
    const subscribers = new Set()
    // 模式/选中集合放在 window 上：HMR 换实例后，旧闭包（含旧菜单贡献）读到的仍是同一份状态。
    const STATE = window.__dbaState || (window.__dbaState = { mode: false, picked: new Set() })
    const selected = STATE.picked
    let observer = null
    let frame = 0
    let appCtx = null
    let anchor = null
    let menuState = { visible: true, order: 610 }
    let disposeMenu = null
    let toggleButton = null
    let mountObserver = null
    let mountTimer = 0

    function publish(patch) {
      snapshot = Object.assign({}, snapshot, patch)
      for (const fn of Array.from(subscribers)) {
        try { fn() } catch (error) { console.error('[dsh-bulk-actions] 订阅回调失败', error) }
      }
      try { renderToolbar() } catch (error) { console.error('[dsh-bulk-actions] 操作条渲染失败', error) }
    }

    function subscribe(fn) {
      subscribers.add(fn)
      return () => { subscribers.delete(fn) }
    }

    function readSnapshot() { return snapshot }

    function useBulkState() {
      return React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot)
    }

    function publishPicked(extra) {
      publish(Object.assign({ mode: STATE.mode, picked: Array.from(selected), anchor }, extra || {}))
    }

    function dlog(message) {
      try {
        void fetch(ROUTE + '/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: String(message).slice(0, 1500) }),
        }).catch(() => {})
      } catch { /* 诊断日志失败不影响主流程 */ }
    }

    function notify(text, success) {
      const menus = appCtx && appCtx.contextMenus
      if (menus && typeof menus.notify === 'function') {
        try { menus.notify(text, success !== false) } catch (error) { console.warn('[dsh-bulk-actions] notify 失败', error) }
        return
      }
      console.info('[dsh-bulk-actions]', text)
    }

    /* ------------------------------------------------------------------ */
    /* 行的选中标记                                                        */
    /* ------------------------------------------------------------------ */

    function rowList() {
      if (typeof document === 'undefined') return []
      return Array.from(document.querySelectorAll(ROW))
    }

    function idOf(row) {
      const key = row.getAttribute('data-row-key')
      return key && key.length > 8 ? key.slice(8) : ''
    }

    /** 已归档行带 aria-description（官方「归档后不可打开」提示），用它区分归档态。 */
    function isArchivedRow(row) {
      return row !== null && row !== undefined && row.hasAttribute('aria-description')
    }

    /** HMR 会替换模块但留下旧实例画的 DOM：apply 时先清一遍，避免“看起来在多选、点了没反应”。 */
    function resetDomMode() {
      if (typeof document === 'undefined') return
      // 旧实例留下的操作条节点没有新监听（还可能一直 disabled），先全部清掉。
      for (const stale of document.querySelectorAll('.dba-bar')) {
        if (stale.parentElement !== null) stale.parentElement.removeChild(stale)
      }
      barEl = null
      document.documentElement.removeAttribute('data-dba-mode')
      for (const row of rowList()) {
        row.removeAttribute('data-dba-row')
        row.removeAttribute('data-dba-picked')
        const box = row.querySelector(':scope > [' + CHECK + ']')
        if (box !== null && box.parentElement !== null) box.parentElement.removeChild(box)
      }
      STATE.mode = false
      selected.clear()
    }

    /**
     * 每行右侧的勾选复选框：只在多选模式出现，勾选态跟随 selected。
     * React 重渲染可能冲掉，paint() 每次都会补回来。
     */
    function ensureCheckbox(row, checked) {
      let box = row.querySelector(':scope > [' + CHECK + ']')
      if (box === null) {
        box = document.createElement('span')
        box.setAttribute(CHECK, '')
        box.setAttribute('aria-hidden', 'true')
        // 放到行首（状态点左边），也就是标题左侧。
        row.insertBefore(box, row.firstChild)
      }
      if (checked) box.setAttribute('data-dba-checked', '')
      else box.removeAttribute('data-dba-checked')
    }

    function paint() {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      if (!STATE.mode) {
        root.removeAttribute('data-dba-mode')
        for (const row of rowList()) {
          row.removeAttribute('data-dba-row')
          row.removeAttribute('data-dba-picked')
          const box = row.querySelector(':scope > [' + CHECK + ']')
          if (box !== null) box.parentElement.removeChild(box)
        }
        removeToolbar()
        return
      }
      root.setAttribute('data-dba-mode', '')
      for (const row of rowList()) {
        const id = idOf(row)
        row.setAttribute('data-dba-row', '')
        const on = id !== '' && selected.has(id)
        if (on) row.setAttribute('data-dba-picked', '')
        else row.removeAttribute('data-dba-picked')
        ensureCheckbox(row, on)
      }
      if (toggleButton !== null) toggleButton.setAttribute('data-dba-toggle-active', '')
      renderToolbar()
    }

    function schedulePaint() {
      if (frame !== 0) return
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16)
      frame = raf(() => { frame = 0; paint() })
    }

    function startObserver() {
      if (observer !== null || typeof MutationObserver !== 'function' || typeof document === 'undefined') return
      observer = new MutationObserver(() => schedulePaint())
      observer.observe(document.body, { childList: true, subtree: true })
    }

    function stopObserver() {
      if (observer !== null) { observer.disconnect(); observer = null }
    }

    /* ------------------------------------------------------------------ */
    /* 手势                                                                */
    /* ------------------------------------------------------------------ */

    function onClickCapture(event) {
      if (!STATE.mode) return
      const target = event.target
      if (!target || typeof target.closest !== 'function') return
      if (target.closest('[' + UI + ']')) return
      if (target.closest('[' + TOGGLE + ']')) return
      const row = target.closest(ROW)
      if (row === null) {
        // 点到空白区域（不是任务行、也不是本插件的 UI）就退出多选
        exitMode()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
      toggle(idOf(row))
    }

    function onKeyDownCapture(event) {
      if (!STATE.mode) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        exitMode()
      }
    }

    function toggle(id) {
      if (id === '') return
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      paint()
      publishPicked()
    }

    function enterMode(seedId) {
      if (!STATE.mode) {
        STATE.mode = true
        document.addEventListener('click', onClickCapture, true)
        document.addEventListener('keydown', onKeyDownCapture, true)
        startObserver()
      }
      if (typeof seedId === 'string' && seedId !== '') selected.add(seedId)
      paint()
      publishPicked({ confirm: null })
      // 侧栏行是 React 渲染的，刚进入时可能还没挂全；补两次重绘把复选框贴上。
      setTimeout(paint, 250)
      setTimeout(paint, 900)
      dlog('enterMode rows=' + rowList().length + ' checks=' + document.querySelectorAll('[' + CHECK + ']').length)
    }

    function exitMode() {
      if (!STATE.mode) return
      STATE.mode = false
      selected.clear()
      anchor = null
      document.removeEventListener('click', onClickCapture, true)
      document.removeEventListener('keydown', onKeyDownCapture, true)
      stopObserver()
      paint()
      if (toggleButton !== null) toggleButton.removeAttribute('data-dba-toggle-active')
      publishPicked({ confirm: null, busy: '' })
    }

    function selectAllVisible() {
      for (const row of rowList()) {
        const id = idOf(row)
        if (id !== '') selected.add(id)
      }
      paint()
      publishPicked()
    }

    /* ------------------------------------------------------------------ */
    /* 工区操作栏里的「多选」按钮                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 找到工作区标题这一行的插入点。
     *
     * 官方结构是 [标题] [搜索槽] [headerActions(排序/新建)]；headerActions 在窄侧栏里是
     * 固定 60px + overflow:hidden，塞第三个图标会被裁掉，所以插到它前面的搜索槽位置，
     * 用整行的剩余空间（见 class 名里的 headerActions / searchSlot 片段，哈希前缀无关）。
     */
    function findHeaderActions() {
      const actions = document.querySelector('[class*="headerActions"]')
      if (actions !== null) {
        const row = actions.parentElement
        const search = row === null ? null : row.querySelector('[class*="searchSlot"]')
        const template = actions.querySelector('button')
        // 放在搜索之后、排序之前：既不挤进窄侧栏那个 60px 固定容器，也符合图标排的阅读顺序。
        if (row !== null && template !== null) return { container: row, before: actions, template }
      }
      for (const label of ADD_LABELS) {
        const button = document.querySelector('button[aria-label="' + label + '"]')
        if (button !== null && button.parentElement !== null) {
          return { container: button.parentElement, before: button.parentElement.firstChild, template: button }
        }
      }
      return null
    }

    /** 用官方按钮做模板复制一个同款按钮，再换成我们的图标与行为。 */
    function mountToggle() {
      if (typeof document === 'undefined') return
      // 总是重建：HMR 换模块后旧按钮还带着旧闭包的监听器，留着它点不动。
      const stale = document.querySelector('[' + TOGGLE + ']')
      if (stale !== null && stale.parentElement !== null) stale.parentElement.removeChild(stale)
      const found = findHeaderActions()
      if (found === null) return
      const button = found.template.cloneNode(false)
      while (button.firstChild) button.removeChild(button.firstChild)
      button.setAttribute(TOGGLE, '')
      button.setAttribute('aria-label', '多选')
      button.setAttribute('title', '多选（批量归档 / 批量删除）')
      button.removeAttribute('aria-keyshortcuts')
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        dlog('toggle click STATE.mode=' + STATE.mode)
        if (STATE.mode) exitMode()
        else enterMode()
      })
      button.__dbaBound = true
      button.appendChild(toggleIcon())
      found.container.insertBefore(button, found.before)
      toggleButton = button
      if (STATE.mode) button.setAttribute('data-dba-toggle-active', '')
    }

    function unmountToggle() {
      const existing = document.querySelector('[' + TOGGLE + ']')
      if (existing !== null && existing.parentElement !== null) existing.parentElement.removeChild(existing)
      toggleButton = null
    }

    /** React 重渲染会把注入的按钮冲掉，用观察器补回去。 */
    function startMountObserver() {
      if (mountObserver !== null || typeof MutationObserver !== 'function') return
      mountObserver = new MutationObserver(() => {
        if (document.querySelector('[' + TOGGLE + ']') !== null) return
        if (mountTimer !== 0) return
        mountTimer = setTimeout(() => {
          mountTimer = 0
          try { mountToggle() } catch (error) { console.warn('[dsh-bulk-actions] 重挂多选按钮失败', error) }
        }, 120)
      })
      mountObserver.observe(document.body, { childList: true, subtree: true })
    }

    function stopMountObserver() {
      if (mountObserver !== null) { mountObserver.disconnect(); mountObserver = null }
      if (mountTimer !== 0) { clearTimeout(mountTimer); mountTimer = 0 }
    }

    function toggleIcon() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', '2.2')
      rect.setAttribute('y', '2.2')
      rect.setAttribute('width', '11.6')
      rect.setAttribute('height', '11.6')
      rect.setAttribute('rx', '3')
      rect.setAttribute('stroke', 'currentColor')
      rect.setAttribute('stroke-width', '1.4')
      svg.appendChild(rect)
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M5.4 8.2l1.9 1.9 3.4-3.9')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.5')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.appendChild(path)
      return svg
    }

    /* ------------------------------------------------------------------ */
    /* 多选操作条（挂在 body 上，固定在工作区标题行下方，事件委托）          */
    /* ------------------------------------------------------------------ */

    let barEl = null

    /** 标题行按钮组默认 max-width:60px + overflow:hidden，塞进去会被裁掉，这里临时放开。 */
    let barHost = null

    function releaseHost() {
      if (barHost !== null) {
        try { barHost.style.maxWidth = '' } catch { /* 忽略 */ }
        barHost = null
      }
    }

    function removeToolbar() {
      if (barEl !== null && barEl.parentElement !== null) barEl.parentElement.removeChild(barEl)
      barEl = null
      releaseHost()
    }

    /**
     * 挂载点就在「工作区」标题行的按钮组里（headerActions）：
     * 那排按钮是被证明能点的（多选按钮就在其中），跟着它走就不会落到收不到事件的区域。
     */
    function toolbarMountPoint() {
      if (typeof document === 'undefined') return null
      const actions = document.querySelector('[class*="headerActions"]')
      if (actions === null) return null
      return { parent: actions, before: null }
    }

    /**
     * 用「多选按钮」的原生结构克隆出动作按钮：
     * 那个按钮的点击已被证明能进页面，克隆体带着同样的类名与层级，最稳。
     */
    function toolbarButton(label, action) {
      const proto = document.querySelector('[' + TOGGLE + ']')
      let button
      if (proto !== null) {
        button = proto.cloneNode(true)
        button.removeAttribute(TOGGLE)
        button.removeAttribute('data-dba-toggle-active')
        while (button.firstChild) button.removeChild(button.firstChild)
        const text = document.createElement('span')
        text.textContent = label
        text.style.cssText = 'font-size:11px;line-height:1;'
        button.appendChild(text)
      } else {
        button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
      }
      button.setAttribute('data-dba-act', action)
      // 让多选模式的“点空白退出”逻辑认得它们，别把按钮点击当成空白点击
      button.setAttribute(UI, '')
      button.title = label
      button.setAttribute('aria-label', label)
      button.style.webkitAppRegion = 'no-drag'
      // 克隆体默认是 28×28 的图标方块，这里放开宽度容纳文字
      button.style.width = 'auto'
      button.style.minWidth = 'auto'
      button.style.padding = '0 6px'
      button.style.marginLeft = '2px'
      return button
    }

    /** 按钮直接挂在标题行里，委托监听挂到 document 上，按钮重建也不会丢。 */
    function onToolbarClick(event) {
      const target = event.target
      if (!target || typeof target.closest !== 'function') return
      const button = target.closest('[data-dba-act]')
      if (button === null) return
      event.preventDefault()
      event.stopPropagation()
      const act = button.getAttribute('data-dba-act')
      dlog('toolbar act=' + act + ' n=' + selected.size)
      if (act === 'archive') {
        if (selected.size === 0) { notify('先在左侧勾选任务', false); return }
        void archiveSelected()
      } else if (act === 'unarchive') {
        if (archivedSelected().length === 0) { notify('选中项里没有归档中的任务', false); return }
        void unarchiveSelected()
      } else if (act === 'delete') {
        if (selected.size === 0) { notify('先在左侧勾选任务', false); return }
        askDelete(Array.from(selected))
      }
    }

    /**
     * 侧栏内自绘操作条在这个 Electron 窗口里收不到点击（诊断日志显示点击落在任务行上，
     * 说明它没有真正进入命中树）。因此不再渲染悬浮条，批量动作统一走任务右键菜单：
     * 归档已选 / 取消归档已选 / 删除已选 / 退出多选。
     */
    /** 多选期间被临时藏起来的原生按钮组，退出时原样还原。 */
    let hiddenActions = null

    function restoreActions() {
      if (hiddenActions !== null) {
        try { hiddenActions.style.display = '' } catch { /* 忽略 */ }
        hiddenActions = null
      }
    }

    function renderToolbar() {
      if (typeof document === 'undefined') return
      const existing = Array.from(document.querySelectorAll('[data-dba-act]'))

      if (!STATE.mode) {
        for (const node of existing) if (node.parentElement !== null) node.parentElement.removeChild(node)
        restoreActions()
        releaseHost()
        return
      }

      const found = findHeaderActions()
      if (found === null) return
      const host = found.container
      const actions = found.before
      if (barHost !== host) {
        releaseHost()
        barHost = host
      }
      // 多选期间把原来那排图标按钮藏起来，动作按钮占它的位置：
      // 「工作区」标题和搜索框宽度不变，视觉上不挤。
      if (hiddenActions !== actions) {
        restoreActions()
        hiddenActions = actions
        try { actions.style.display = 'none' } catch { /* 忽略 */ }
      }
      if (existing.length === 3 && existing.every(node => node.parentElement === host)) return
      for (const node of existing) if (node.parentElement !== null) node.parentElement.removeChild(node)
      host.insertBefore(toolbarButton('归档', 'archive'), actions)
      host.insertBefore(toolbarButton('取消归档', 'unarchive'), actions)
      host.insertBefore(toolbarButton('删除', 'delete'), actions)
    }

    /* ------------------------------------------------------------------ */
    /* 删除                                                                */
    /* ------------------------------------------------------------------ */

    /** 当前正被打开的会话（删除时会被服务端跳过）。 */
    function currentSessionId() {
      if (typeof document === 'undefined') return ''
      const row = document.querySelector('[data-row-key][aria-selected="true"]')
        || document.querySelector('[data-row-key][data-active="true"]')
      return row === null ? '' : idOf(row)
    }

    function titleOf(id) {
      for (const row of rowList()) {
        if (idOf(row) !== id) continue
        const text = (row.textContent || '').replace(/\s+/g, ' ').trim()
        return text === '' ? id : text.slice(0, 60)
      }
      return id
    }

    function askDelete(ids, titled) {
      const unique = Array.from(new Set(ids.filter(id => typeof id === 'string' && id !== '')))
      if (unique.length === 0) return
      const given = new Map((titled || []).map(item => [item.id, item.title]))
      openConfirm(unique, unique.map(id => ({ id, title: given.get(id) || titleOf(id) })))
    }

    async function runDelete() {
      const ids = pendingIds.slice()
      if (ids.length === 0) { closeConfirm(); return }
      try {
        publish({ busy: '删除中…' })
        const response = await fetch(ROUTE + '/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionIds: ids, keepId: currentSessionId() }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload === null || payload.ok !== true) {
          throw new Error((payload && payload.error) || ('HTTP ' + response.status))
        }
        const deleted = Array.isArray(payload.deleted) ? payload.deleted : []
        const skipped = Array.isArray(payload.skipped) ? payload.skipped : []
        const failed = Array.isArray(payload.failed) ? payload.failed : []
        dlog('delete result deleted=' + deleted.length + ' skipped=' + skipped.length + ' failed=' + failed.length
          + (skipped.length > 0 ? ' reason=' + skipped[0].reason : ''))
        for (const id of deleted) selected.delete(id)
        // 后台把目录删了，但前端会话列表是内存里的 store，不同步就会一直挂着这条行。
        // 直接把删除结果喂给 sessions 服务：有 handleSessionRemoved 就用它，否则整表 refresh。
        // 磁盘上已经没有的（上次删了但 UI 没同步）也要从列表里摘掉，否则永远挂着一条幽灵行。
        const goneIds = deleted.slice()
        for (const item of skipped) {
          if (typeof item.reason === 'string' && item.reason.includes('已经没有')) goneIds.push(item.id)
        }
        if (goneIds.length > 0) {
          try {
            const sessionsService = typeof appCtx.get === 'function' ? appCtx.get('sessions') : null
            const handled = sessionsService !== null && sessionsService !== undefined
              && typeof sessionsService.handleSessionRemoved === 'function'
            if (handled) {
              for (const id of goneIds) {
                try { sessionsService.handleSessionRemoved(id) } catch { /* 单条失败不影响其它 */ }
              }
            } else if (sessionsService !== null && sessionsService !== undefined && typeof sessionsService.refresh === 'function') {
              await sessionsService.refresh()
            }
            dlog('client sessions synced gone=' + goneIds.length + ' via=' + (handled ? 'handleSessionRemoved' : 'refresh'))
          } catch (error) {
            dlog('client sessions sync failed: ' + (error instanceof Error ? error.message : String(error)))
          }
        }
        const parts = []
        if (deleted.length > 0) parts.push('已删除 ' + deleted.length + ' 个会话')
        if (skipped.length > 0) {
          const name = titleOf(skipped[0].id)
          parts.push((name === '' ? '' : '「' + name + '」') + skipped[0].reason)
        }
        if (failed.length > 0) parts.push(failed.length + ' 个失败（' + failed[0].reason + '）')
        notify(parts.join('，') || '没有可删除的会话', deleted.length > 0 && failed.length === 0)
        if (STATE.mode && selected.size === 0) exitMode()
      } catch (error) {
        notify('删除失败：' + (error instanceof Error ? error.message : String(error)), false)
      } finally {
        // 无论成功、失败还是中途抛错，弹窗都必须关掉。
        closeConfirm()
        publishPicked()
        dlog('runDelete done ids=' + ids.length)
      }
    }

    /* ------------------------------------------------------------------ */
    /* 归档 / 取消归档                                                     */
    /* ------------------------------------------------------------------ */

    function workspaceService() {
      if (!appCtx) return null
      try {
        if (typeof appCtx.get === 'function') {
          const found = appCtx.get('workspaces')
          if (found !== null && found !== undefined) return found
        }
      } catch { /* 忽略：回落到属性访问 */ }
      return appCtx.workspaces || null
    }

    function archivedSelected() {
      const ids = []
      for (const row of rowList()) {
        const id = idOf(row)
        if (id !== '' && selected.has(id) && isArchivedRow(row)) ids.push(id)
      }
      return ids
    }

    async function archiveSelected() {
      const ids = Array.from(selected)
      if (ids.length === 0) return
      const service = workspaceService()
      if (service === null || typeof service.archiveSession !== 'function') {
        notify('归档不可用：找不到 workspaces 服务', false)
        return
      }
      publish({ busy: '归档中…' })
      const failed = []
      let done = 0
      for (const id of ids) {
        try {
          await service.archiveSession(id)
          done += 1
          selected.delete(id)
        } catch (error) {
          failed.push({ id, message: error instanceof Error ? error.message : String(error) })
        }
      }
      paint()
      publishPicked({ busy: '' })
      const text = failed.length === 0
        ? '已归档 ' + done + ' 个会话'
        : '已归档 ' + done + ' 个，' + failed.length + ' 个未归档（可能仍在运行）'
      notify(text, failed.length === 0)
      if (STATE.mode && selected.size === 0) exitMode()
    }

    async function unarchiveSelected() {
      const ids = archivedSelected()
      if (ids.length === 0) {
        notify('已选会话里没有归档中的任务', false)
        return
      }
      const service = workspaceService()
      if (service === null || typeof service.unarchiveSession !== 'function') {
        notify('取消归档不可用：找不到 workspaces 服务', false)
        return
      }
      publish({ busy: '取消归档…' })
      let done = 0
      for (const id of ids) {
        try {
          await service.unarchiveSession(id)
          done += 1
          selected.delete(id)
        } catch (error) {
          console.warn('[dsh-bulk-actions] 取消归档失败', error)
        }
      }
      paint()
      publishPicked({ busy: '' })
      notify('已取消归档 ' + done + ' 个会话', done > 0)
      if (STATE.mode && selected.size === 0) exitMode()
    }

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    function installStyle() {
      if (typeof document === 'undefined') return
      // 客户端 HMR 会换模块但不换 DOM：样式标签若沿用旧内容，新规则永远不生效。
      // 所以每次 apply 都覆盖写入，而不是“有就跳过”。
      let style = document.getElementById(STYLE_ID)
      if (style === null) {
        style = document.createElement('style')
        style.id = STYLE_ID
        document.head.appendChild(style)
      }
      style.textContent = [
        'html[data-dba-mode] [data-row-key^="session:"][data-dba-row]{cursor:pointer}',
        '[' + TOGGLE + '][data-dba-toggle-active]{background:color-mix(in srgb, #4d6bfe 24%, transparent)!important;color:#c9d4ff!important}',
        '.dba-bar{display:inline-flex;align-items:center;gap:2px;margin:0 2px;padding:0;background:transparent;border:none;font:500 11px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:inherit;white-space:nowrap}',


        '[data-dba-check]{width:15px;height:15px;flex:0 0 15px;margin-left:2px;margin-right:6px;border-radius:4px;border:1.5px solid color-mix(in srgb, #9aa0aa 70%, transparent);box-sizing:border-box;display:inline-block;background:transparent}',
        '[data-dba-check][data-dba-checked]{background:#4d6bfe;border-color:#4d6bfe;box-shadow:inset 0 0 0 2px color-mix(in srgb, #fff 85%, transparent)}',
        '.dba-bar,.dba-bar *{pointer-events:auto!important}',
        // 侧栏顶部那条是 Electron 的窗口拖拽区（-webkit-app-region:drag），
        // 在它里面的元素收不到任何鼠标事件；这里必须显式退出拖拽区，否则点了毫无反应。
        '.dba-bar,.dba-bar *{-webkit-app-region:no-drag!important}',
        '.dba-count{white-space:nowrap;color:inherit;opacity:.6;padding:0 6px 0 2px;font-size:12px}',
        '.dba-sep{width:1px;height:12px;background:currentColor;opacity:.18;margin:0 4px}',
        '.dba-busy{white-space:nowrap;color:#8aa0ff;padding-left:2px}',
        '.dba-btn{appearance:none;border:none;background:transparent;color:inherit;border-radius:6px;padding:2px 6px;min-height:20px;font-size:11px;font:inherit;cursor:pointer;white-space:nowrap;opacity:.92}',
        '.dba-btn:active:not(:disabled){transform:translateY(.5px)}',
        '.dba-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));opacity:1}',
        '.dba-btn:disabled{opacity:.45;cursor:not-allowed}',
        '.dba-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-text-secondary,#a9abb3)}',
        '.dba-danger{color:#e5484d}',
        '.dba-danger:hover:not(:disabled){background:color-mix(in srgb, #e5484d 12%, transparent)}',
        '.dba-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:2147483100;pointer-events:auto}',
        '.dba-dialog{width:min(440px,92vw);padding:18px 18px 14px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#ffffff));color:var(--dsw-alias-text-primary,#1f2329);border:1px solid var(--dsw-alias-separator,rgba(0,0,0,.12));box-shadow:0 24px 60px rgba(0,0,0,.35);font:400 13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
        '.dba-dialog h3{margin:0 0 8px;font-size:15px;font-weight:600;color:var(--dsw-alias-text-primary,#1f2329)}',
        '.dba-warn-soft{opacity:.85;font-size:12px}',
        '.dba-warn{margin:0 0 10px;color:var(--dsw-alias-danger,#d93025);font-weight:500}',
        '.dba-list{margin:0 0 14px;padding-left:18px;max-height:180px;overflow:auto;color:var(--dsw-alias-text-primary,#1f2329)}',
        '.dba-actions{display:flex;justify-content:flex-end;gap:8px}',
        '.dba-panel{display:flex;flex-direction:column;gap:10px;padding:12px;font:400 13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:inherit}',
        '.dba-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
        '.dba-panel-count{font-weight:600;font-size:13px}',
        '.dba-panel-actions{display:flex;flex-wrap:wrap;gap:6px}',
        '.dba-panel-actions .dba-btn{border:1px solid currentColor;padding:5px 12px;border-radius:8px;opacity:.9}',
        '.dba-panel-actions .dba-danger{border-color:#e5484d}',
        '.dba-panel-hint{font-size:12px;opacity:.7;line-height:1.6}',
        '.dba-settings{display:flex;flex-direction:column;gap:10px;font:400 13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--dsw-alias-text-primary,#ececf1)}',
        '.dba-setting-row{display:flex;align-items:center;gap:10px}',
        '.dba-setting-label{min-width:64px;color:var(--dsw-alias-text-secondary,#a9abb3)}',
        '.dba-check{display:flex;align-items:center;gap:8px;cursor:pointer}',
        '.dba-select{appearance:none;border:1px solid color-mix(in srgb, #fff 18%, transparent);background:color-mix(in srgb, #fff 7%, transparent);color:inherit;border-radius:8px;padding:4px 8px;font:inherit}',
        '.dba-note{margin:2px 0 0;font-size:12px;line-height:1.65;color:var(--dba-note,#8b8f9a)}',
      ].join('\n')
    }

    /* ------------------------------------------------------------------ */
    /* 组件                                                                */
    /* ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ */
    /* 删除确认框（命令式 DOM，挂在 body 上，保证可点）                    */
    /* ------------------------------------------------------------------ */

    let dialogEl = null
    let pendingIds = []

    function closeConfirm() {
      // 按类名兜底：HMR 换实例后 dialogEl 可能是 null，但节点还挂在 body 上。
      if (typeof document !== 'undefined') {
        for (const node of document.querySelectorAll('.dba-backdrop')) {
          if (node.parentElement !== null) node.parentElement.removeChild(node)
        }
      }
      dialogEl = null
      pendingIds = []
      publish({ confirm: null, busy: '' })
    }

    function dialogButton(label, className, onClick) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = className
      button.textContent = label
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      })
      return button
    }

    function openConfirm(ids, items) {
      closeConfirm()
      pendingIds = ids.slice()
      const backdrop = document.createElement('div')
      backdrop.className = 'dba-backdrop'
      backdrop.setAttribute(UI, '')
      backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop) closeConfirm()
      })

      const dialog = document.createElement('div')
      dialog.className = 'dba-dialog'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')

      const title = document.createElement('h3')
      title.textContent = items.length > 1 ? '删除 ' + items.length + ' 个会话' : '删除会话'
      dialog.appendChild(title)

      const warn = document.createElement('p')
      warn.className = 'dba-warn'
      warn.textContent = '会话日志会从磁盘永久删除，不可恢复；只有当前打开着的会话会被跳过。'
      dialog.appendChild(warn)

      // 如果勾选的正是当前打开的会话，先说清楚它删不掉，省得点完“没反应”。
      const current = currentSessionId()
      if (current !== '' && ids.includes(current)) {
        const tip = document.createElement('p')
        tip.className = 'dba-warn dba-warn-soft'
        tip.textContent = '其中「' + (titleOf(current) || current) + '」就是你当前打开的会话，会被跳过；请先切到其他会话再删。'
        dialog.appendChild(tip)
      }

      const list = document.createElement('ul')
      list.className = 'dba-list'
      for (const item of items.slice(0, MAX_LIST)) {
        const li = document.createElement('li')
        li.textContent = item.title || item.id
        list.appendChild(li)
      }
      if (items.length > MAX_LIST) {
        const more = document.createElement('li')
        more.textContent = '…以及另外 ' + (items.length - MAX_LIST) + ' 项'
        list.appendChild(more)
      }
      dialog.appendChild(list)

      const actions = document.createElement('div')
      actions.className = 'dba-actions'
      actions.appendChild(dialogButton('取消', 'dba-btn dba-ghost', closeConfirm))
      actions.appendChild(dialogButton('永久删除', 'dba-btn dba-danger', () => { void runDelete() }))
      dialog.appendChild(actions)

      backdrop.appendChild(dialog)
      backdrop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeConfirm()
        }
      })
      document.body.appendChild(backdrop)
      dialogEl = backdrop
      const first = dialog.querySelector('button')
      if (first !== null) first.focus()
      publish({ confirm: { ids, items } })
      dlog('openConfirm ids=' + ids.length + ' mounted=' + (dialogEl !== null))
    }

    /** 右键菜单项图标：与其他官方项同尺寸的 14px 线条图标。 */
    function DeleteIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M2.6 4.4h10.8' }),
        h('path', { d: 'M6.4 4.4V3.1c0-.5.4-.9.9-.9h1.4c.5 0 .9.4.9.9v1.3' }),
        h('path', { d: 'M4.2 4.4l.6 8.2c0 .6.5 1.1 1.1 1.1h4.2c.6 0 1.1-.5 1.1-1.1l.6-8.2' }),
        h('path', { d: 'M6.8 7.1v4.1M9.2 7.1v4.1' }))
    }

    function buildActions(target) {
      const value = target && target.value ? target.value : (target || {})
      const sessionId = value.sessionId
      const displayTitle = value.displayTitle
      return [{
        id: 'bulk.delete-one',
        label: '删除会话…',
        danger: true,
        icon: { key: 'bulk.delete' },
        run: () => askDelete([sessionId], [{ id: sessionId, title: displayTitle }]),
      }]
    }

    /* ------------------------------------------------------------------ */
    /* 注册                                                                */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'contextMenus'],
      apply(ctx) {
        appCtx = ctx
        try { resetDomMode() } catch { /* 清 DOM 失败不影响加载 */ }
        try {
          installStyle()
        } catch (error) {
          console.error('[dsh-bulk-actions] 样式注入失败', error)
        }

        try {
          mountToggle()
          startMountObserver()
        } catch (error) {
          console.error('[dsh-bulk-actions] 多选按钮挂载失败', error)
        }

        const syncMenuRegistration = () => {
          // HMR 后模块变量会重置，只有 window 上的句柄还认得上一个实例的注册；
          // 不撤掉它，新注册会因重复 id 失败，菜单里留下的就是旧闭包（看不到批量项）。
          const prior = window.__dbaMenuDispose
          if (typeof prior === 'function') {
            try { prior() } catch { /* 旧注册已清理 */ }
          }
          if (typeof disposeMenu === 'function') {
            try { disposeMenu() } catch { /* 旧注册已清理 */ }
          }
          disposeMenu = null
          window.__dbaMenuDispose = null
          if (!menuState.visible) {
            console.info('[dsh-bulk-actions] 菜单项已按设置隐藏')
            return
          }
          try {
            disposeMenu = ctx.contextMenus.register({
              id: 'bulk-actions',
              target: 'session',
              order: menuState.order,
              resolve: (target) => buildActions(target),
            })
            window.__dbaMenuDispose = typeof disposeMenu === 'function' ? disposeMenu : null
            console.info('[dsh-bulk-actions] menu registered (order ' + menuState.order + ')')
          } catch (error) {
            dlog('menu register failed: ' + (error instanceof Error ? error.message : String(error)))
            console.error('[dsh-bulk-actions] 右键菜单注册失败', error)
          }
        }

        syncMenuRegistration()

        try {
          ctx.slots.inject('contextMenu.icon', () => ctx.slots.register(
            { name: 'contextMenu.icon', key: 'bulk.delete' }, DeleteIcon))
        } catch (error) {
          console.error('[dsh-bulk-actions] 图标注册失败', error)
        }

        // 每次加载用独立后缀：客户端 HMR 会在旧实例清理前挂上新实例，
        // 固定 id 会撞「同一 slot 同一 id 只能有一个 owner」而整体抛错，连累后面的注册。
        const instance = Math.random().toString(36).slice(2, 7)

        // 删除确认框改为命令式 DOM（body 直挂），不再依赖浮层插槽。

        if (typeof window !== 'undefined') {
          window.addEventListener('resize', () => {
            if (!STATE.mode) return
            publishPicked()
          })
        }

        try { window.__dbaResyncMenu = syncMenuRegistration } catch { /* 忽略 */ }

        // 轻量自检入口：不暴露 ctx。
        try {
          window.__dba = {
            version: VERSION,
            mode: () => STATE.mode,
            picked: () => Array.from(selected),
            actions: (target) => {
              try { return buildActions(target).map(action => action.id) } catch (error) {
                return 'ERR:' + (error instanceof Error ? error.message : String(error))
              }
            },
          }
        } catch (error) {
          console.error('[dsh-bulk-actions] debug hook failed', error)
        }

        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            try {
              document.removeEventListener('click', onClickCapture, true)
              document.removeEventListener('keydown', onKeyDownCapture, true)
            } catch { /* 忽略 */ }
            stopObserver()
            stopMountObserver()
            unmountToggle()
            STATE.mode = false
            selected.clear()
          })
        }

        dlog('apply v' + VERSION + ' toggle=' + (document.querySelector('[' + TOGGLE + ']') !== null))
        setTimeout(() => {
          try {
            const b = document.querySelector('[' + TOGGLE + ']')
            if (b === null) { dlog('probe: no toggle'); return }
            const r = b.getBoundingClientRect()
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            dlog('probe bound=' + (b.__dbaBound === true)
              + ' rect=' + [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',')
              + ' top=' + (top === null ? 'null' : top.tagName + '.' + String(top.className).slice(0, 24))
              + ' isSelf=' + (top === b || b.contains(top)))
          } catch (error) { dlog('probe error ' + error.message) }
        }, 1500)
        // 标题行里的动作按钮是直接追加的，委托监听挂在 document 上最稳。
        // 热重载会多次 apply，先摘掉上一个实例的监听，避免一次点击触发多次动作。
        try {
          if (typeof window.__dbaToolbarClick === 'function') {
            document.removeEventListener('click', window.__dbaToolbarClick, true)
          }
          window.__dbaToolbarClick = onToolbarClick
          document.addEventListener('click', onToolbarClick, true)
        } catch (error) {
          dlog('toolbar delegate failed: ' + (error instanceof Error ? error.message : String(error)))
        }

        console.info('[dsh-bulk-actions] applied v' + VERSION)
      },
    }
  },
})