const p = navigator.platform?.toLowerCase() ?? ''
const ua = navigator.userAgent.toLowerCase()

export const isMac = p.startsWith('mac') || ua.includes('macintosh')
export const isWindows = p.startsWith('win') || ua.includes('windows')
export const isLinux = p.startsWith('linux') || ua.includes('linux')

/** The modifier key name: Cmd on macOS, Ctrl elsewhere */
export const modKey = isMac ? 'Cmd' : 'Ctrl'

/** Check if the platform modifier key is pressed (metaKey on macOS, ctrlKey elsewhere) */
export const modPressed = (e: KeyboardEvent | MouseEvent) =>
  isMac ? e.metaKey : e.ctrlKey

/** Platform file manager name */
export const fileManagerName = isMac ? 'Finder' : isWindows ? 'Explorer' : 'Files'

/** Whether the app uses an overlay titlebar (macOS only) */
export const hasOverlayTitlebar = isMac
