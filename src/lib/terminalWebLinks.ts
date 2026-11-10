import { WebLinksAddon } from '@xterm/addon-web-links'
import { openUrl } from '@tauri-apps/plugin-opener'
import { modPressed } from './platform'

/** URLs in a terminal open in the browser on Cmd/Ctrl-click, like file paths. */
export function openWebLink(e: MouseEvent, uri: string) {
  if (modPressed(e)) void openUrl(uri)
}

export const createWebLinksAddon = () => new WebLinksAddon(openWebLink)
