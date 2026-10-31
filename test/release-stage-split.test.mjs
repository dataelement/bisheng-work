import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import YAML from 'yaml'

const root = path.resolve(import.meta.dirname, '..')
const { jobs } = YAML.parse(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'))
const step = (job, name) => jobs[job].steps.find(item => item.name === name)

it('gates Windows builds on shared checks while retaining native coverage', async () => {
  expect(jobs['windows-preflight'].needs).toBe('validate-dispatch')
  expect(jobs['windows-x64'].needs).toBe('windows-preflight')
  expect(jobs['windows-preflight'].if).toBe(jobs['windows-x64'].if)
  expect(jobs['windows-preflight']['runs-on']).toEqual(['self-hosted', 'macOS', 'bisheng-windows'])
  expect(jobs['windows-preflight'].steps.some(item => item.run === 'npm run typecheck')).toBe(true)
  expect(jobs['windows-x64'].steps.some(item => item.run === 'npm run typecheck')).toBe(false)
  const checks = step('windows-preflight', 'Check Windows release tooling').run
  const config = await readFile(path.join(root, 'vitest.windows.config.ts'), 'utf8')
  for (const name of ['release.test.ts', 'formal-release-handoff.test.mjs', 'sign-windows-unpacked.test.ts', 'finalize-windows-release.test.ts']) {
    expect(checks).toContain(`test/${name}`)
    expect(config).not.toContain(`'test/${name}'`)
  }
  expect(step('windows-x64', 'Run focused Windows regressions').run).toBe('npx --no-install vitest run --config vitest.windows.config.ts')
  expect(step('windows-x64', 'Run complete Windows test suite').run).toBe('npx --no-install vitest run')
  expect(step('windows-x64', 'Smoke test packaged Windows Harness').run).toContain('GetCurrentProcessId')
})

it('prepares application inputs once before CI tests and reuses the build for packaging', () => {
  for (const job of ['macos', 'windows-x64']) {
    const steps = jobs[job].steps
    const builds = steps.filter(item => item.run?.includes('npm run build'))
    expect(builds).toHaveLength(1)
    const buildIndex = steps.indexOf(builds[0])
    const tests = steps.filter(item => item.run?.startsWith('npx --no-install vitest run'))
    expect(tests.length).toBeGreaterThan(0)
    for (const test of tests) expect(steps.indexOf(test)).toBeGreaterThan(buildIndex)
    const packages = steps.filter(item => item.run?.includes('--publish never'))
    expect(packages.length).toBeGreaterThan(0)
    for (const pack of packages) {
      expect(steps.indexOf(pack)).toBeGreaterThan(buildIndex)
      for (const test of tests) expect(steps.indexOf(pack)).toBeGreaterThan(steps.indexOf(test))
      expect(pack.run).not.toContain('npm run build')
    }
    // These commands would trigger npm pretest hooks and prepare Office again.
    expect(steps.some(item => /^npm (test|run test:windows)$/.test(item.run ?? ''))).toBe(false)
  }
})

it('reuses checkout history and installs formal release note tooling once', () => {
  const steps = jobs.publish.steps
  expect(steps.find(item => item.uses === 'actions/checkout@v4').with['fetch-depth']).toBe(0)
  const installs = steps.filter(item => item.run?.includes('npm install -g @github/copilot'))
  expect(installs).toHaveLength(1)
  const notes = steps.filter(item => item.name?.startsWith('Generate '))
  expect(notes).toHaveLength(2)
  for (const note of notes) {
    expect(steps.indexOf(note)).toBeGreaterThanOrEqual(steps.indexOf(installs[0]))
    expect(note.run).toContain('validate --tag')
    expect(note.run).toContain('generate-fallback')
  }
  expect(steps.some(item => item.run?.includes('git fetch --force --tags'))).toBe(false)
})

it('builds signed installers once on the signer and preserves development installers', async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  expect(scripts['package:win:unpacked']).toBe('node scripts/verify-target.mjs win32 x64 && npm run build && node scripts/electron-builder-windows.mjs --win --x64 --dir --publish never')
  const build = step('windows-x64', 'Build Windows application once').run
  expect(build).toBe('node scripts/verify-target.mjs win32 x64 && npm run build')
  expect(step('windows-x64', 'Build Windows release package').run).toBe('node scripts/electron-builder-windows.mjs --win --x64 --dir --publish never')
  expect(step('windows-x64', 'Build isolated Windows development package').run).toBe('node scripts/electron-builder-windows.mjs --win --x64 --publish never --config electron-builder.dev.cjs')
  expect(step('windows-x64', 'Archive unpacked Windows release for inner binary signing').run)
    .toBe('node scripts/archive-windows-unpacked.mjs')
  const upload = step('windows-x64', 'Stage unsigned Windows assets in draft release').run
  expect(upload).toContain('dist/win-unpacked.tar.gz')
  expect(upload).not.toContain('setup.exe')
  expect(upload).not.toContain('latest.yml')
  const sign = step('sign-windows', 'Sign Windows installer with SafeNet UKey').run
  expect(sign.indexOf('sign-windows-unpacked.mjs')).toBeLessThan(sign.indexOf('electron-builder-windows.mjs'))
  expect(sign).toContain('--prepackaged "$WINDOWS_SIGNING_WORK_DIR/release/win-unpacked"')
  expect(step('sign-windows', 'Rebuild Windows update metadata').run).toContain('finalize-windows-release.mjs')
})

it.skipIf(process.platform === 'win32')('downloads only the unpacked handoff and rejects corrupted content before signing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'windows-signing-handoff-'))
  try {
    await mkdir(path.join(directory, 'scripts'))
    await copyFile(path.join(root, 'scripts/verify-release-staging.mjs'), path.join(directory, 'scripts/verify-release-staging.mjs'))
    const bytes = Buffer.from('unsigned Windows payload')
    const digest = createHash('sha256').update(bytes).digest('hex')
    await writeFile(path.join(directory, 'payload'), bytes)
    await writeFile(path.join(directory, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
if (args[1] === 'download') {
  const patterns = args.flatMap((arg, i) => arg === '--pattern' ? [args[i + 1]] : [])
  if (JSON.stringify(patterns) !== JSON.stringify(['win-unpacked.tar.gz'])) process.exit(2)
  const directory = args[args.indexOf('--dir') + 1]
  fs.mkdirSync(directory, { recursive: true })
  fs.copyFileSync('payload', path.join(directory, 'win-unpacked.tar.gz'))
} else if (args[1] === 'view') {
  process.stdout.write(JSON.stringify({isDraft:true,assets:[{name:'win-unpacked.tar.gz',size:${bytes.length},digest:'sha256:${digest}'}]}))
} else process.exit(3)
`, { mode: 0o755 })
    const env = {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      RELEASE_TAG: '1.0.4-test.1', GITHUB_REPOSITORY: 'example/desktop',
      WINDOWS_SIGNING_WORK_DIR: path.join(directory, 'staging')
    }
    const script = step('sign-windows', 'Download unsigned Windows assets from draft release').run
    execFileSync('bash', ['-c', script], { cwd: directory, env, stdio: 'pipe' })
    await writeFile(path.join(directory, 'payload'), Buffer.alloc(bytes.length, 'x'))
    expect(() => execFileSync('bash', ['-c', script], { cwd: directory, env, stdio: 'pipe' })).toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
