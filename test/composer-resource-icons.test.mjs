import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as zod from 'zod'
import { expect, it } from 'vitest'
import { ReferenceIconRegular } from './helpers/reference-icons.mjs'

const source = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url), 'utf8')
function region(name) {
  const start = source.indexOf(`//#region ${name}`)
  const end = source.indexOf('//#endregion', start)
  if (start < 0 || end < 0) throw new Error(`Missing runtime region: ${name}`)
  return source.slice(start, end)
}
const { ReferenceChip, parseStoredDraft, snapshotDraft } = vm.runInNewContext(`(() => {
  ${region('lib/types/client/draft.js')}
  ${region('lib/types/client/input/editor/ReferenceChip.js')}
  return { ReferenceChip, parseStoredDraft, snapshotDraft }
})()`, {
  zod, react_jsx_runtime: jsx,
  clsx: (...values) => values.filter(Boolean).join(' '),
  ReferenceChip_module_css_default: {}, composer_editor_module_css_default: {},
  _deepseek_ai_dsh_client_ui_primitives: { ReferenceIconRegular }
})

it.each(['skill', 'tool', 'folder'])('retains the %s icon through persisted draft restoration', appearance => {
  const reference = { source: 'resource', ref: 'stable-id', label: 'Readable name', appearance,
    offset: 0, length: 5, clipboardText: '/name' }
  const draft = snapshotDraft('/name prompt', [reference])
  const restored = parseStoredDraft(JSON.parse(JSON.stringify(draft)))
  expect(restored).toEqual(draft)
  const markup = renderToStaticMarkup(React.createElement(ReferenceChip, { ...restored.references[0], invalid: false }))
  expect(markup).toContain('<svg')
  expect(markup).toContain('Readable name')
  expect(markup).not.toContain('>@<')
  const expectedIcon = renderToStaticMarkup(React.createElement(ReferenceIconRegular, { kind: appearance, size: 14 }))
  expect(markup).toContain(expectedIcon)
})

it('preserves the legacy draft and file/session reference contracts', () => {
  expect(parseStoredDraft('plain draft')).toEqual({ text: 'plain draft', references: [] })
  for (const appearance of [undefined, 'file', 'session']) {
    const reference = { source: 'files', ref: 'one', label: 'one', appearance, offset: 0, length: 4, clipboardText: '@one' }
    expect(parseStoredDraft(snapshotDraft('@one', [reference])).references[0].ref).toBe('one')
  }
  expect(parseStoredDraft({ text: '/name', references: [{ source: 'resource', ref: 'one', label: 'one', appearance: 'unknown', offset: 0, length: 5, clipboardText: '/name' }] })).toBeUndefined()
})
