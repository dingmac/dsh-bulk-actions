## README.md
# 批量操作（@local/dsh-bulk-actions）

## 用法

1. 点「工作区」标题右侧的多选按钮（搜索与排序之间）进入多选，按钮高亮。
2. 点任务行加选/取消；Esc 退出。
3. **在任务行上右键**，菜单里会多出：
   - 归档已选 N 项（官方 archiveSession，可逆）
   - 取消归档已选 N 项（选中项里有归档任务时出现）
   - 删除已选 N 项…（红色，二次确认后永久删除）
   - 退出多选
   - 删除会话…（单个，带图标）

## 设置

设置 → 右键菜单：本插件菜单项的显隐与位置（靠前/默认/靠后），存 `bulk-actions/settings.json`。
官方项无法由第三方隐藏或重排。

## 为什么没有悬浮操作条

试过两种方案：

1. 浮层（shell.overlay）+ position:fixed：能渲染，但点在按钮上事件会穿透到下面的任务行，按钮点不动；
2. 直接插进侧栏 DOM：插进 sectionHeader 会被它的 overflow 裁掉，插到别处会被 React 重渲染冲掉。

结论：DSH 目前没有「侧栏区域级插槽」，第三方插件在侧栏里放可交互的独立操作条不可靠。
因此批量动作改放右键菜单——菜单是官方组件，点击可靠。

## 安全

删除只删 sessions 根目录内、id 白名单内、非运行中的会话；改 workspace.json 前备份；广播 api-session/removed 让行立刻消失。

## 自测

    node tests/host.test.mjs
    node tests/client.test.mjs
