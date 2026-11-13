/**
 * Types `text` at the selection of the focused field (textarea or
 * contenteditable) the way the browser does for typing and paste: one Cmd+Z
 * step, and an `input` event. `false` when the webview could not.
 */
export function typeText(text: string): boolean {
  return document.execCommand('insertText', false, text)
}
