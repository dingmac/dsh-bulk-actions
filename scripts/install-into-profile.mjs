/**
 * 把本插件装进 DSH profile（默认 desktop）：
 *   1. 备份 package.json / cordis.patch.yml；
 *   2. package.json 里加 link: 依赖，并把包名追加进 dsh.profile.bundles；
 *   3. node_modules/@local/<name> 建符号链接，指向本仓源码；
 *   4. cordis.patch.yml 的 hmr.root 里补上本仓目录（改代码即刻热重载）。
 *
 * 用法：node scripts/install-into-profile.mjs [profileDir]
 * 幂等：重复执行为空操作，只打印已有状态。
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SOURCE = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await fs.readFile(path.join(SOURCE, 'package.json'), 'utf8'))
const NAME = pkg.name
const profileDir = path.resolve(process.argv[2] || path.join(os.homedir(), '.dsh', 'profiles', 'desktop'))
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)

async function backup(file) {
  if (!existsSync(file)) return
  await fs.copyFile(file, file + '.bak-bulk-' + stamp)
}

const manifestPath = path.join(profileDir, 'package.json')
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
let changed = false

if (!manifest.dependencies || typeof manifest.dependencies !== 'object') manifest.dependencies = {}
const spec = 'link:' + SOURCE
if (manifest.dependencies[NAME] !== spec) {
  manifest.dependencies[NAME] = spec
  changed = true
}

manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!bundles.includes(NAME)) {
  bundles.push(NAME)
  changed = true
}
manifest.dsh.profile.bundles = bundles

if (changed) {
  await backup(manifestPath)
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log('package.json 已更新：' + NAME)
} else {
  console.log('package.json 已是目标状态')
}

const scopeDir = path.join(profileDir, 'node_modules', '@local')
await fs.mkdir(scopeDir, { recursive: true })
const linkPath = path.join(scopeDir, NAME.split('/').pop())
try {
  const current = await fs.readlink(linkPath)
  if (path.resolve(current) !== SOURCE) {
    await fs.rm(linkPath, { force: true })
    await fs.symlink(SOURCE, linkPath)
    console.log('符号链接已重建')
  } else {
    console.log('符号链接已存在')
  }
} catch {
  await fs.symlink(SOURCE, linkPath)
  console.log('符号链接已建立：' + linkPath + ' -> ' + SOURCE)
}

if (existsSync(patchPath)) {
  const yaml = await fs.readFile(patchPath, 'utf8')
  const block = '- id: hmr'
  const at = yaml.indexOf(block)
  if (at >= 0) {
    const quoted = '      - "' + SOURCE + '"'
    if (!yaml.includes(quoted)) {
      const rest = yaml.slice(at)
      const rootLine = rest.match(/\n(\s+)root:\n((?:\1\s+- .*\n)*)/)
      if (rootLine) {
        const insertAt = at + rootLine.index + rootLine[0].length
        const next = yaml.slice(0, insertAt)
          + (yaml[insertAt - 1] === '\n' ? '' : '\n')
          + quoted + '\n'
          + yaml.slice(insertAt)
        await backup(patchPath)
        await fs.writeFile(patchPath, next, 'utf8')
        console.log('hmr.root 已补上本插件目录')
      } else {
        console.log('警告：hmr 条目没有 root 列表，跳过 hmr 配置（不影响安装）')
      }
    } else {
      console.log('hmr.root 已包含本插件目录')
    }
  }
}

console.log('profile: ' + profileDir)
