import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as jsx from 'react/jsx-runtime'

const source = readFileSync(new URL('../../node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js', import.meta.url), 'utf8')
const folderStart = source.indexOf('const FolderCloseArtwork =')
const folderEnd = source.indexOf('/** Regular', folderStart)
const start = source.indexOf('//#region lib/types/ReferenceIcon.js')
const end = source.indexOf('//#endregion', start)
if ([folderStart, folderEnd, start, end].some(index => index < 0)) throw new Error('Reference artwork runtime changed')
export const { ReferenceIconRegular } = vm.runInNewContext(`(() => {
  ${source.slice(folderStart, folderEnd)}
  ${source.slice(start, end)}
  return { ReferenceIconRegular }
})()`, { ...jsx, ICON_MEDIUM_STROKE: 1.3 })
