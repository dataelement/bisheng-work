/** Native Electron fixture using the shipped preload and recovery page with an isolated Profile. */
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const dir = await mkdtemp(join(tmpdir(), 'bisheng-safe-mode-locale-'))
try {
  const result = await build({ bundle: true, platform: 'node', format: 'cjs', write: false,
    stdin: { contents: "export * from './src/main/safe-mode'; export * from './src/main/safe-mode-frame'; export * from './src/main/native-locale'", resolveDir: root } })
  await writeFile(join(dir, 'model.cjs'), result.outputFiles[0].text)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [join(root, 'test/helpers/safe-mode-locale-electron.cjs'), dir, root], { env, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (code !== 0) process.exitCode = code ?? 1
} finally { await rm(dir, { recursive: true, force: true }) }
