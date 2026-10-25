export type ApprovalKeyAction = 'allow' | 'deny' | 'noop'

export interface ApprovalKeyInput {
  key: string
  isInputFocused: boolean
  // The CLI flags some approvals as default-to-no (tools that need a person
  // to decide). Those must only be allowed by clicking, never by Enter/y.
  defaultToNo: boolean
}

// Pure dispatcher for the tool-approval card's global keyboard shortcuts.
export function decideApprovalKeyAction(input: ApprovalKeyInput): ApprovalKeyAction {
  if (input.key === 'Escape') return 'deny'
  if (input.isInputFocused) return 'noop'
  if (input.key === 'n') return 'deny'
  if (input.key === 'Enter') return input.defaultToNo ? 'deny' : 'allow'
  if (input.key === 'y') return input.defaultToNo ? 'noop' : 'allow'
  return 'noop'
}
