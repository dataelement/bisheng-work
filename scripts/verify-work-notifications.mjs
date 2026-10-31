/** Real Electron/contextIsolation/IPC smoke; the OS toast boundary is an explicit fixture. */
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const dir = await mkdtemp(join(tmpdir(), 'bisheng-notification-'))
const common = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false }
try {
  const main = await build({ ...common, entryPoints: [join(root, 'src/main/desktop-notification.ts')] })
  const preload = await build({ ...common, stdin: {
    contents: "import { setupDesktopNotificationBridge } from './src/preload/desktop-notification'; setupDesktopNotificationBridge()",
    resolveDir: root
  } })
  await writeFile(join(dir, 'preload.cjs'), preload.outputFiles[0].text)
  await writeFile(join(dir, 'bridge.cjs'), main.outputFiles[0].text)
  const runner = join(root, 'test/helpers/work-notification-electron.cjs')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [runner, dir, root], { env, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
  if (code !== 0) process.exitCode = code ?? 1
} finally {
  await rm(dir, { recursive: true, force: true })
}
