interface ContentBounds { x: number; y: number; width: number; height: number }

/** The app keeps its chat-region geometry while body portals use the full native window. */
export function chatDialogViewportScript(bounds: ContentBounds | undefined): string {
  const css = bounds ? `
    html[data-dsh-window-dialog] { --dsh-chat-viewport-width: ${bounds.width}px; --dsh-chat-viewport-height: ${bounds.height}px; }
    html[data-dsh-window-dialog], html[data-dsh-window-dialog] body { background: transparent !important; }
    html[data-dsh-window-dialog] #root {
      position: fixed; left: ${bounds.x}px; top: ${bounds.y}px;
      width: ${bounds.width}px; height: ${bounds.height}px; overflow: hidden;
    }
  ` : ''
  return `(() => {
    const root = document.documentElement;
    const css = ${JSON.stringify(css)};
    let style = document.getElementById('dsh-window-dialog-viewport');
    if (css) {
      if (!style) { style = document.createElement('style'); style.id = 'dsh-window-dialog-viewport'; document.head.appendChild(style); }
      if (style.textContent !== css) style.textContent = css;
      root.dataset.dshWindowDialog = 'open';
    } else {
      delete root.dataset.dshWindowDialog;
      style?.remove();
    }
  })()`
}
