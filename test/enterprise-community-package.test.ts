import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { create } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { createMarketRuntime } from '../packages/dsh-desktop-enterprise/market-runtime.js'
import { isMarketVersionCompatible } from '../packages/dsh-desktop-enterprise/market.js'
import { installOfflineBundle, sha256, verifyInstalledBundle } from '../packages/dsh-desktop-enterprise/offline-bundle.js'
import { readCommunityPackage } from '../packages/dsh-desktop-enterprise/community-package.js'
import { isolatePackage } from './helpers/isolated-package-tree.mjs'
import { zipEntries } from '../scripts/pack-enterprise-plugin.mjs'

const paths: string[] = []
const target = `${process.platform}-${process.arch}`
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })

async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-community-'))
  paths.push(directory)
  await mkdir(join(directory, 'profiles/node_modules'), { recursive: true })
  return directory
}

function communityZip(files: Record<string, Buffer>, name = 'company-demo', version = '1.0.0') {
  const bytes = zipEntries(files)
  return { bytes, expected: { name, version, digest: sha256(bytes) } }
}

describe('community npm packages', () => {
  it('resolves pnpm, tar and host peers from an isolated enterprise plugin tree', async () => {
    const root = await home()
    const isolated = await isolatePackage(join(process.cwd(), 'packages/dsh-desktop-enterprise'), root)
    const canonical = await realpath(root)
    const require = createRequire(join(isolated.entry, 'package.json'))
    for (const name of ['pnpm', 'tar', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/cordis-plugin-group']) {
      expect(require.resolve(name).startsWith(canonical)).toBe(true)
    }
  })

  it('treats an empty desktop minimum as no version floor', () => {
    expect(isMarketVersionCompatible('0.9.2', '')).toBe(true)
    expect(isMarketVersionCompatible('0.9.2', '0.9.1')).toBe(true)
    expect(isMarketVersionCompatible('0.9.2', 'invalid')).toBe(false)
    expect(isMarketVersionCompatible('', '0.9.2')).toBe(false)
  })

  it('stops before installing a community package when the host entry is missing', async () => {
    const root = await home()
    const source = Buffer.from('export function apply() {}\n')
    const packed = communityZip({
      'package.json': Buffer.from(JSON.stringify({ name: 'company-demo', version: '1.0.0', type: 'module', main: 'index.js' })),
      'index.js': source
    })
    await expect(installOfflineBundle(root, packed.bytes, packed.expected, target, {
      dshEntryPath: join(root, 'missing-host.js')
    })).rejects.toThrow(/Enterprise host entry was not found/)
  })

  it('reads npm metadata and rejects the wrong platform', async () => {
    const source = Buffer.from('export function apply(ctx) { ctx.effect(() => () => {}, "community") }\n')
    const pkg = Buffer.from(JSON.stringify({ name: 'company-demo', version: '1.0.0', type: 'module', main: 'index.js', os: [process.platform === 'darwin' ? 'linux' : 'darwin'] }))
    const packed = communityZip({ 'package.json': pkg, 'index.js': source })
    await expect(readCommunityPackage(packed.bytes, packed.expected, target)).rejects.toThrow(/platform/)
    const compatible = communityZip({
      'package.json': Buffer.from(JSON.stringify({ name: 'company-demo', version: '1.0.0', type: 'module', exports: { '.': { import: './index.js' } } })),
      'index.js': source,
      'manifest.json': Buffer.from('{"schema_version":1}')
    })
    const parsed = await readCommunityPackage(compatible.bytes, compatible.expected, target)
    expect(parsed.manifest.format).toBe('npm')
    expect(parsed.manifest.schema_version).toBe(2)
    expect(parsed.files.has('manifest.json')).toBe(true)
  })

  it('installs a bundled dependency with pnpm and rejects later tampering', async () => {
    const root = await home()
    const stage = join(root, 'stage')
    await mkdir(join(stage, 'package/node_modules/company-helper'), { recursive: true })
    await writeFile(join(stage, 'package/package.json'), JSON.stringify({
      name: 'company-demo', version: '1.2.3', type: 'module', main: 'index.js',
      dependencies: { 'company-helper': '1.0.0' }, bundledDependencies: ['company-helper']
    }))
    await writeFile(join(stage, 'package/index.js'), 'export function apply(ctx) { ctx.effect(() => () => {}, "community") }\n')
    await writeFile(join(stage, 'package/node_modules/company-helper/package.json'), JSON.stringify({ name: 'company-helper', version: '1.0.0', main: 'index.js' }))
    await writeFile(join(stage, 'package/node_modules/company-helper/index.js'), 'module.exports = { ready: true }\n')
    const archive = join(stage, 'plugin.tgz')
    await create({ cwd: stage, file: archive, gzip: true, portable: true }, ['package'])
    const bytes = await readFile(archive)
    const expected = { name: 'company-demo', version: '1.2.3', digest: sha256(bytes) }
    const generation = await installOfflineBundle(root, bytes, expected, target, { dshEntryPath: join(process.cwd(), 'node_modules/@deepseek-ai/dsh/lib/bin.js') })
    expect(generation.directory).toContain('.enterprise-generations')
    expect(generation.integrity).toMatch(/^[a-f0-9]{64}$/)
    const installed = createRequire(join(generation.directory, 'node_modules/company-demo/package.json'))
    expect(installed.resolve('company-helper')).toContain('company-helper')
    await expect(verifyInstalledBundle({ ...generation, ...expected }, target)).resolves.toHaveProperty('manifest')
    await writeFile(join(generation.directory, 'node_modules/company-demo/index.js'), 'tampered')
    await expect(verifyInstalledBundle({ ...generation, ...expected }, target)).rejects.toThrow(/changed/)
  })

  it('loads a dsh.bundle entry and reports a child that fails to apply', async () => {
    const root = await home()
    const source = 'export function apply(ctx) { ctx.effect(() => () => {}, "bundle entry") }\n'
    const packed = communityZip({
      'package.json': Buffer.from(JSON.stringify({ name: 'company-demo', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } } })),
      'index.js': Buffer.from(source),
      'cordis.patch.yml': Buffer.from('- insert:\n    - id: community-entry\n      name: ./index.js\n')
    })
    const generation = await installOfflineBundle(root, packed.bytes, packed.expected, target, { dshEntryPath: join(process.cwd(), 'node_modules/@deepseek-ai/dsh/lib/bin.js') })
    const context = new Context()
    const loaderFiber = context.plugin(Loader, { baseUrl: pathToFileURL(`${root}/`).href })
    await loaderFiber
    await writeFile(join(root, 'cordis.yml'), '[]')
    await mountRootInclude(context, join(root, 'cordis.yml'))
    await context.loader.await()
    let runtime: ReturnType<typeof createMarketRuntime> | undefined
    context.loader.builtins.enterpriseTest = { apply(child: Context) { runtime = createMarketRuntime(child) } }
    const ownerId = await context.loader.create({ name: 'cordis:enterpriseTest' })
    await context.loader.await()
    try {
      const mounted = await runtime!({ ...generation, name: packed.expected.name, config: {} })
      expect(mounted.state).toBe(2)
      await mounted.dispose()
      const broken = communityZip({
        'package.json': Buffer.from(JSON.stringify({ name: 'company-demo', version: '1.0.1', type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } } })),
        'index.js': Buffer.from('export function apply() { throw new Error("bundle child failed") }\n'),
        'cordis.patch.yml': Buffer.from('- insert:\n    - id: community-entry\n      name: ./index.js\n')
      }, 'company-demo', '1.0.1')
      const failed = await installOfflineBundle(root, broken.bytes, broken.expected, target, { dshEntryPath: join(process.cwd(), 'node_modules/@deepseek-ai/dsh/lib/bin.js') })
      await expect(runtime!({ ...failed, name: broken.expected.name, config: {} })).rejects.toThrow(/bundle child failed|did not activate|not ready/)
    } finally { await context.loader.remove(ownerId); await loaderFiber.dispose() }
  })

  it('rejects a changed identity, an unsafe path and an unsupported Node range', async () => {
    const source = Buffer.from('export function apply() {}\n')
    const packed = communityZip({ 'package.json': Buffer.from(JSON.stringify({ name: 'company-demo', version: '1.0.0', type: 'module', main: 'index.js' })), 'index.js': source })
    await expect(readCommunityPackage(packed.bytes, { ...packed.expected, name: 'other-demo' }, target)).rejects.toThrow(/identity/)
    const escaped = communityZip({ 'package.json': Buffer.from(JSON.stringify({ name: 'company-demo', version: '1.0.0', main: 'index.js' })), '../index.js': source })
    await expect(readCommunityPackage(escaped.bytes, escaped.expected, target)).rejects.toThrow(/Unsafe/)
    const future = communityZip({
      'package.json': Buffer.from(JSON.stringify({ name: 'company-demo', version: '1.0.0', type: 'module', main: 'index.js', engines: { node: '>=999' } })),
      'index.js': source
    })
    await expect(readCommunityPackage(future.bytes, future.expected, target)).rejects.toThrow(/Node/)
  })
})
