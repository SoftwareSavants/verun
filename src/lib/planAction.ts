import type { ToolApprovalRequest } from '../types'

export type PlanAction =
  | { kind: 'noop' }
  | { kind: 'deny'; requestId: string; sessionId: string; message: string }
  | { kind: 'approve'; requestId: string; sessionId: string }
  | { kind: 'sendFeedback'; sessionId: string; message: string }
  | { kind: 'sendImplementation'; sessionId: string }

export interface PlanActionInput {
  sessionId: string | null
  feedback: string
  approval: ToolApprovalRequest | null
  pending: boolean
}

// Pure dispatcher behind the plan viewer's single approve/request-changes
// button. Issue #216 was a regression where the request-changes path ended
// up firing approve - keeping this decision pure makes it directly testable.
export function decidePlanAction(input: PlanActionInput): PlanAction {
  if (input.pending) return { kind: 'noop' }
  if (!input.sessionId) return { kind: 'noop' }

  const isExitPlanMode = input.approval?.toolName === 'ExitPlanMode'

  if (input.feedback) {
    if (input.approval && isExitPlanMode) {
      return {
        kind: 'deny',
        requestId: input.approval.requestId,
        sessionId: input.approval.sessionId,
        message: input.feedback,
      }
    }
    return { kind: 'sendFeedback', sessionId: input.sessionId, message: input.feedback }
  }

  if (input.approval && isExitPlanMode) {
    return {
      kind: 'approve',
      requestId: input.approval.requestId,
      sessionId: input.approval.sessionId,
    }
  }

  return { kind: 'sendImplementation', sessionId: input.sessionId }
}
