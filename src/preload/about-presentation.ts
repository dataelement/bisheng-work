/** About owns the foreground across the host DOM and native embedded views. */
export function createAboutPresentation(document: Document, window: Window) {
  const attribute = 'data-dsh-about-open'
  let open = false
  let previousFocus: HTMLElement | null = null
  let closeButton: HTMLButtonElement | undefined

  const keydown = (event: KeyboardEvent): void => {
    if (open && event.key === 'Tab') {
      // About has one interactive control; keep keyboard focus in the dialog.
      event.preventDefault()
      closeButton?.focus()
    }
  }
  window.addEventListener('keydown', keydown)

  const close = (): void => {
    document.documentElement.removeAttribute(attribute)
    if (open) {
      open = false
      if (previousFocus?.isConnected) previousFocus.focus()
    }
    previousFocus = null
    closeButton = undefined
  }

  return {
    show(button: HTMLButtonElement): void {
      if (!open) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      open = true
      closeButton = button
      document.documentElement.setAttribute(attribute, '')
      button.focus()
    },
    close,
    dispose(): void {
      close()
      window.removeEventListener('keydown', keydown)
    }
  }
}
