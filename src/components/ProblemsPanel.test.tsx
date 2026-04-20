import { describe, test, expect, beforeEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import { ProblemsPanel } from './ProblemsPanel'
import { clearProblemsForTask, seedDemoProblems } from '../store/problems'
import type { Problem } from '../types'

const TASK_ID = 'task-large-problems'

function makeProblem(index: number): Problem {
  return {
    file: 'src/many.ts',
    line: index + 1,
    column: 1,
    endLine: index + 1,
    endColumn: 2,
    severity: 'error',
    message: `problem ${index}`,
    code: 'TS9999',
    source: 'typescript',
  }
}

describe('<ProblemsPanel />', () => {
  beforeEach(() => {
    cleanup()
    clearProblemsForTask(TASK_ID)
  })

  test('does not mount every problem row for large diagnostic sets', () => {
    seedDemoProblems({
      [TASK_ID]: {
        'src/many.ts': Array.from({ length: 1000 }, (_, i) => makeProblem(i)),
      },
    })

    const { container } = render(() => <ProblemsPanel taskId={TASK_ID} />)

    expect(container.textContent).toContain('problem 0')
    expect(container.textContent).not.toContain('problem 999')
  })
})
