// Types and utilities for tracking UI test execution steps.

import type { AgentAction } from './action-executor'

export interface TestStep {
  index: number
  action: AgentAction
  success: boolean
  error?: string
  /** Data URL of screenshot taken before this action */
  screenshot?: string
  /** Page URL when step was executed */
  url: string
  timestamp: number
}

export interface TestRun {
  instruction: string
  tabId: number
  model: string
  startedAt: number
  finishedAt?: number
  steps: TestStep[]
  status: 'running' | 'done' | 'failed' | 'stopped'
  summary?: string
}

export function createTestRun(
  instruction: string,
  tabId: number,
  model: string,
): TestRun {
  return {
    instruction,
    tabId,
    model,
    startedAt: Date.now(),
    steps: [],
    status: 'running',
  }
}

export function summarizeRun(run: TestRun): string {
  const total = run.steps.length
  const failed = run.steps.filter((s) => !s.success).length
  const elapsed = run.finishedAt
    ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
    : 'unknown'

  if (run.status === 'done') {
    return `Completed in ${elapsed}: ${total} steps, ${total - failed} succeeded, ${failed} failed.`
  }
  if (run.status === 'failed') {
    const lastErr = [...run.steps].reverse().find((s) => s.error)?.error ?? ''
    return `Failed after ${total} steps (${elapsed}): ${lastErr}`
  }
  if (run.status === 'stopped') {
    return `Stopped after ${total} steps (${elapsed}).`
  }
  return `Running... ${total} steps so far.`
}

/** Return a text summary of steps for the AI context window. */
export function stepsToContext(steps: TestStep[], maxSteps = 10): string {
  const recent = steps.slice(-maxSteps)
  return recent
    .map(
      (s) =>
        `Step ${s.index + 1}: ${s.action.action}` +
        (s.action.target ? ` target="${s.action.target}"` : '') +
        (s.action.value ? ` value="${s.action.value}"` : '') +
        ` — ${s.success ? 'OK' : `FAIL: ${s.error ?? ''}`}`,
    )
    .join('\n')
}
