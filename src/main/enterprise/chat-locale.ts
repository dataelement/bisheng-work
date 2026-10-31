/** Deliver presentation state without writing the web app's saved language preference. */
export function chatLocaleScript(locale: 'zh' | 'en'): string {
  return `(() => {
    document.documentElement.dataset.dshHostLocale = ${JSON.stringify(locale)};
    window.dispatchEvent(new CustomEvent('dsh:locale', { detail: { locale: ${JSON.stringify(locale)} } }));
  })()`
}
