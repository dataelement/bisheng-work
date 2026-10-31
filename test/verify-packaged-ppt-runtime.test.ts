import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const script = join(import.meta.dirname, '../scripts/verify-packaged-ppt-runtime.cjs')
const verifyPackagedPptRuntime = require('../scripts/verify-packaged-ppt-runtime.cjs') as (context: {
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}) => Promise<void>

const cleanups: string[] = []
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe.runIf(process.platform === 'darwin')('packaged PPT runtime verification', () => {
  it('runs the packaged PPT check outside the app bundle', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-ppt-packaged-cwd-'))
    cleanups.push(appOutDir)
    const product = 'BISHENG'
    const resources = join(appOutDir, `${product}.app`, 'Contents', 'Resources')
    const helper = join(appOutDir, `${product}.app`, 'Contents', 'Frameworks', `${product} Helper.app`, 'Contents', 'MacOS', `${product} Helper`)
    const report = join(appOutDir, 'helper-cwd.txt')
    await mkdir(resources, { recursive: true })
    await mkdir(dirname(helper), { recursive: true })
    await writeFile(join(resources, 'app.asar'), '')
    await writeFile(helper, `#!/bin/sh\nprintf '%s\\n' "$PWD" > '${report}'\n`)
    await chmod(helper, 0o755)

    await verifyPackagedPptRuntime({ appOutDir, packager: { appInfo: { productFilename: product } } })

    const cwd = (await readFile(report, 'utf8')).trim()
    expect(await realpath(cwd)).toBe(await realpath(appOutDir))
    expect(cwd.includes(`${product}.app`)).toBe(false)
  })
})

it('moves the Helper process out of the bundle before worker startup', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const { realpathSync } = require('node:fs')
    const { useStableHelperCwd } = require(${JSON.stringify(script)})
    useStableHelperCwd()
    process.stdout.write(realpathSync(process.cwd()))
  `], { encoding: 'utf8' })
  expect(child.status).toBe(0)
  expect(child.stdout).toBe(realpathSync(tmpdir()))
})
