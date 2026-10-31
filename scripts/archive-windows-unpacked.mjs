import { lstat, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { c as createTar } from 'tar'

export async function archiveWindowsUnpacked(
  source = path.resolve('dist', 'win-unpacked'),
  archive = path.resolve('dist', 'win-unpacked.tar.gz')
) {
  const sourcePath = path.resolve(source)
  const archivePath = path.resolve(archive)
  let sourceInfo
  try {
    sourceInfo = await lstat(sourcePath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Windows unpacked source is missing: ${sourcePath}`, { cause: error })
    }
    throw error
  }
  if (!sourceInfo.isDirectory()) throw new Error(`Windows unpacked source is not a directory: ${sourcePath}`)

  await mkdir(path.dirname(archivePath), { recursive: true })
  await rm(archivePath, { force: true })
  await createTar({
    cwd: path.dirname(sourcePath),
    file: archivePath,
    gzip: true
  }, [path.basename(sourcePath)])

  const archiveInfo = await stat(archivePath)
  if (!archiveInfo.isFile() || archiveInfo.size === 0) {
    throw new Error(`Windows unpacked archive is empty: ${archivePath}`)
  }
  console.log(`Archived Windows unpacked application: ${archivePath} (${archiveInfo.size} bytes)`)
  return { archivePath, size: archiveInfo.size }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, archive] = process.argv.slice(2)
  await archiveWindowsUnpacked(source, archive)
}
