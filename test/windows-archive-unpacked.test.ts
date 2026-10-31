import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { x as extractTar } from 'tar'
import { archiveWindowsUnpacked } from '../scripts/archive-windows-unpacked.mjs'

const cleanups: string[] = []

afterEach(async () => {
  for (const directory of cleanups.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('archives the unpacked Windows application without relying on the platform tar executable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-windows-archive-'))
  cleanups.push(root)
  const source = path.join(root, 'dist', 'win-unpacked')
  const archive = path.join(root, 'handoff', 'win-unpacked.tar.gz')
  const extracted = path.join(root, 'extracted')
  await mkdir(path.join(source, 'resources'), { recursive: true })
  await writeFile(path.join(source, 'BISHENG.exe'), 'executable')
  await writeFile(path.join(source, 'resources', 'app.asar'), 'archive')

  const result = await archiveWindowsUnpacked(source, archive)

  expect(result.archivePath).toBe(archive)
  expect(result.size).toBeGreaterThan(0)
  await mkdir(extracted)
  await extractTar({ cwd: extracted, file: archive })
  await expect(readFile(path.join(extracted, 'win-unpacked', 'BISHENG.exe'), 'utf8'))
    .resolves.toBe('executable')
  await expect(readFile(path.join(extracted, 'win-unpacked', 'resources', 'app.asar'), 'utf8'))
    .resolves.toBe('archive')
})

it('rejects a missing unpacked application before creating an archive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-windows-archive-missing-'))
  cleanups.push(root)
  const archive = path.join(root, 'win-unpacked.tar.gz')

  await expect(archiveWindowsUnpacked(path.join(root, 'missing'), archive))
    .rejects.toThrow('Windows unpacked source is missing')
})
