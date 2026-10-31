import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import YAML from 'yaml'

it('uses local npm downloads and bounds Node setup on persistent release workers', async () => {
  const source = await readFile(path.resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8')
  const { jobs } = YAML.parse(source)
  const persistentJobs = Object.values(jobs).filter(job =>
    Array.isArray(job['runs-on']) && job['runs-on'].includes('self-hosted')
  )
  expect(persistentJobs).toHaveLength(3)
  for (const job of persistentJobs) {
    const setup = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'))
    expect(setup).toBeDefined()
    expect(setup.with?.cache).toBeUndefined()
    expect(setup['timeout-minutes']).toBe(5)
  }
  const macSetup = jobs.macos.steps.find(step => step.if === "matrix.arch == 'arm64'" && step.uses?.startsWith('actions/setup-node@'))
  expect(macSetup).toBeDefined()
  expect(macSetup.with?.cache).toBeUndefined()
  expect(macSetup['timeout-minutes']).toBe(5)
  const hostedSetup = jobs['windows-x64'].steps.find(step => step.uses?.startsWith('actions/setup-node@'))
  expect(hostedSetup.with.cache).toBe('npm')
  expect(hostedSetup.with['cache-dependency-path']).toBe('package-lock.json')
})

it('keeps portable preparation on Linux and macOS work on self-hosted runners', async () => {
  const source = await readFile(path.resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8')
  const { jobs } = YAML.parse(source)
  for (const name of ['validate-dispatch', 'publish', 'publish-prerelease', 'publish-signed']) {
    expect(jobs[name]['runs-on']).toBe('ubuntu-24.04')
  }
  expect(jobs['prepare-shared-runtime-assets']['runs-on']).toEqual(['self-hosted', 'macOS', 'ARM64'])
  expect(jobs.macos['runs-on']).toBe('${{ matrix.runner }}')
  for (const target of jobs.macos.strategy.matrix.include) {
    expect(target.runner).toContain('self-hosted')
    expect(target.runner).toContain('macOS')
  }
  for (const job of Object.values(jobs)) {
    if (typeof job['runs-on'] === 'string') expect(job['runs-on']).not.toMatch(/^macos-/i)
  }
})

it('restores Windows download caches before installing dependencies', async () => {
  const source = await readFile(path.resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8')
  const job = YAML.parse(source).jobs['windows-x64']
  const cacheIndex = job.steps.findIndex(step => step.uses === 'actions/cache@v4')
  const installIndex = job.steps.findIndex(step => step.run?.startsWith('npm ci'))
  expect(cacheIndex).toBeGreaterThan(-1)
  expect(cacheIndex).toBeLessThan(installIndex)
  const cache = job.steps[cacheIndex].with
  expect(cache.path.trim().split('\n')).toEqual([
    '${{ env.ELECTRON_CACHE }}',
    '${{ env.ELECTRON_BUILDER_CACHE }}',
    '.build/office-downloads'
  ])
  const configureIndex = job.steps.findIndex(step => step.name === 'Configure Windows packaging cache')
  expect(configureIndex).toBeGreaterThan(-1)
  expect(configureIndex).toBeLessThan(cacheIndex)
  expect(job.steps[configureIndex].shell).toBe('pwsh')
  expect(job.steps[configureIndex].run).toContain('"ELECTRON_CACHE=$env:RUNNER_TEMP/electron-cache" >> $env:GITHUB_ENV')
  expect(job.steps[configureIndex].run).toContain('"ELECTRON_BUILDER_CACHE=$env:RUNNER_TEMP/electron-builder-cache" >> $env:GITHUB_ENV')
  expect(cache.key).toBe("windows-x64-packaging-v1-${{ hashFiles('package-lock.json', 'scripts/office-runtime/lock.json') }}")
  expect(job.steps[installIndex].run).toBe('npm ci --prefer-offline')
})
