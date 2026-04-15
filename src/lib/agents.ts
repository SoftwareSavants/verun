import claudeIcon from '../assets/icons/claude.svg?raw'
import codexIcon from '../assets/icons/codex.svg?raw'
import cursorIcon from '../assets/icons/cursor.svg?raw'
import opencodeIcon from '../assets/icons/opencode.svg?raw'

const AGENT_ICONS: Record<string, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  cursor: cursorIcon,
  opencode: opencodeIcon,
}

const GENERIC_ICON = claudeIcon

export function agentIcon(agentType: string): string {
  return AGENT_ICONS[agentType] || GENERIC_ICON
}

export { claudeIcon, codexIcon, cursorIcon, opencodeIcon }
