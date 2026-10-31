// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { CHAT_LAYOUT_CSS } from '../src/main/enterprise/chat-layout'

afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren() })

it('removes the desktop Chat section row and its reserved height without changing Work tabs', () => {
  const style = document.createElement('style')
  style.textContent = `.dsh-chat-surface .dsh-chat-header { display:grid; height:76px; grid-template-rows:30px 25.5px; row-gap:10px }
    .dsh-chat-surface .dsh-chat-section-row { display:flex }
    ${CHAT_LAYOUT_CSS}`
  document.head.append(style)
  document.body.innerHTML = `<main class="dsh-chat-surface"><header class="dsh-chat-header"><div class="dsh-chat-header-row">Title</div><div class="dsh-chat-section-row">Conversation</div></header><article>Messages</article></main><section id="work"><div role="tablist">Conversation / Trace</div></section>`
  const header = document.querySelector('.dsh-chat-header')!
  const row = document.querySelector('.dsh-chat-section-row')!
  expect(getComputedStyle(row).display).toBe('none')
  expect(getComputedStyle(header).height).toBe('48px')
  expect(getComputedStyle(header).userSelect).toBe('none')
  expect(getComputedStyle(header).gridTemplateRows).toBe('30px')
  expect(getComputedStyle(document.querySelector('#work [role=tablist]')!).display).not.toBe('none')
  expect(getComputedStyle(document.querySelector('article')!).display).not.toBe('none')
})
