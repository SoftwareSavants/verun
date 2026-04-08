const ua = navigator.userAgent.toLowerCase()

export const isMac = ua.includes('macintosh') || ua.includes('mac os')
export const isWindows = ua.includes('windows')
export const isLinux = ua.includes('linux')

/** The modifier key name: Cmd on macOS, Ctrl elsewhere */
export const modKey = isMac ? 'Cmd' : 'Ctrl'

/** Check if the platform modifier key is pressed (metaKey on macOS, ctrlKey elsewhere) */
export const modPressed = (e: KeyboardEvent | MouseEvent) =>
  isMac ? e.metaKey : e.ctrlKey

/** Platform file manager name */
export const fileManagerName = isMac ? 'Finder' : isWindows ? 'Explorer' : 'Files'

/** Whether the app uses an overlay titlebar (macOS only) */
export const hasOverlayTitlebar = isMac
