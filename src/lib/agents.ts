import claudeIcon from '../assets/icons/claude.svg?raw'
import codexIcon from '../assets/icons/codex.svg?raw'
import cursorIcon from '../assets/icons/cursor.svg?raw'
import geminiIcon from '../assets/icons/gemini.svg?raw'
import opencodeIcon from '../assets/icons/opencode.svg?raw'

const AGENT_ICONS: Record<string, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  cursor: cursorIcon,
  gemini: geminiIcon,
  opencode: opencodeIcon,
}

const GENERIC_ICON = claudeIcon

export function agentIcon(agentType: string): string {
  return AGENT_ICONS[agentType] || GENERIC_ICON
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na - nb
  }
  return 0
}

export function meetsVersionReq(cliVersion: string | undefined, minVersion: string | undefined): boolean {
  if (!minVersion) return true
  if (!cliVersion) return false
  return compareVersions(cliVersion, minVersion) >= 0
}

export { claudeIcon, codexIcon, cursorIcon, geminiIcon, opencodeIcon }
