export interface WindowsUnpackedArchive {
  archivePath: string
  size: number
}

export function archiveWindowsUnpacked(
  source?: string,
  archive?: string
): Promise<WindowsUnpackedArchive>
