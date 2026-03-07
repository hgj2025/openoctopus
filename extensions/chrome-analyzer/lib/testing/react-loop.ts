// ReAct (Reason + Act) loop for AI-driven UI testing.
// Runs entirely in the Service Worker context.

import { createAIClient } from '../ai/client'
import { broadcastToViews } from '../messaging/bridge'
import { loadSettings } from '../storage/settings-store'
import { elementsToText } from './element-catalog'
import type { AgentAction } from './action-executor'
import {
  createTestRun,
  stepsToContext,
  summarizeRun,
  type TestRun,
  type TestStep,
} from './test-reporter'

const MAX_STEPS = 20

// Active test runs keyed by tabId. Null entry means "stop requested".
const activeRuns = new Map<number, TestRun | null>()

export function isTestRunning(tabId: number): boolean {
  return activeRuns.has(tabId)
}

export function requestStopTest(tabId: number): void {
  activeRuns.set(tabId, null) // signal abort
}

/**
 * Start a UI test ReAct loop.
 * Communicates with content script via chrome.tabs.sendMessage.
 */
export async function startTestRun(
  tabId: number,
  instruction: string,
  model: string,
): Promise<void> {
  if (activeRuns.has(tabId)) return // already running

  const settings = await loadSettings()
  const client = createAIClient(settings.proxyUrl)
  const run = createTestRun(instruction, tabId, model)
  activeRuns.set(tabId, run)

  broadcastToViews('TEST_STARTED', { instruction, tabId })

  try {
    for (let stepIdx = 0; stepIdx < MAX_STEPS; stepIdx++) {
      // Check stop signal
      if (activeRuns.get(tabId) === null) {
        run.status = 'stopped'
        break
      }

      // 1. Screenshot
      const screenshot = await captureScreenshot(tabId)

      // 2. Get elements from content script
      const elements = await getElements(tabId)

      // 3. Get current URL
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      const currentUrl = tab?.url ?? 'unknown'

      // 4. Ask AI what to do next
      const action = await decideAction(
        client,
        model,
        instruction,
        currentUrl,
        elements,
        run.steps,
        screenshot,
      )

      // Build step record
      const step: TestStep = {
        index: stepIdx,
        action,
        success: true,
        url: currentUrl,
        timestamp: Date.now(),
        screenshot: screenshot ?? undefined,
      }

      // 5. Broadcast step to sidepanel
      broadcastToViews('TEST_STEP', step)
      run.steps.push(step)

      // 6. Terminal conditions
      if (action.action === 'done') {
        run.status = 'done'
        break
      }
      if (action.action === 'fail') {
        run.status = 'failed'
        step.success = false
        step.error = action.reasoning
        break
      }

      // 7. Execute action in content script
      const result = await executeInTab(tabId, action, elements)
      step.success = result.success
      step.error = result.error

      if (!result.success) {
        // Non-fatal: let AI try again next step
        broadcastToViews('TEST_STEP', step) // re-broadcast with error
      }

      // 8. Wait for navigation (if navigate action) or DOM stability
      if (action.action === 'navigate') {
        await sleep(2000)
      } else {
        // Ask content script to wait for stability, with fallback timeout
        await waitForStabilityInTab(tabId)
      }
    }
  } catch (err) {
    run.status = 'failed'
    broadcastToViews('TEST_ERROR', {
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    run.finishedAt = Date.now()
    activeRuns.delete(tabId)
    run.summary = summarizeRun(run)
    broadcastToViews('TEST_COMPLETE', {
      success: run.status === 'done',
      steps: run.steps,
      summary: run.summary,
    })
  }
}

// --- Helpers ---

async function captureScreenshot(tabId: number): Promise<string | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(
      // Use the tab's window
      { format: 'jpeg', quality: 60 },
    )
    return dataUrl
  } catch {
    return null
  }
}

async function getElements(
  tabId: number,
): Promise<Array<{ selector: string; text: string }>> {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_ELEMENTS',
      payload: {},
    })
    return (resp?.payload ?? []) as Array<{ selector: string; text: string }>
  } catch {
    return []
  }
}

async function executeInTab(
  tabId: number,
  action: AgentAction,
  catalog: Array<{ selector: string }>,
): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'EXECUTE_ACTION',
      payload: { action, catalog },
    })
    return resp?.payload ?? { success: false, error: 'No response from content script' }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

async function waitForStabilityInTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'WAIT_STABILITY',
      payload: {},
    })
  } catch {
    // Content script may have navigated — just wait a beat
    await sleep(1200)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const ACTION_SCHEMA = `{
  "action": "click | fill | select | navigate | scroll | done | fail",
  "target": "<element index from list, or CSS selector>",
  "value": "<text to type / URL to navigate / option value>",
  "reasoning": "<one sentence explaining why>"
}`

function buildSystemPrompt(): string {
  return `You are an autonomous web UI testing agent. On each turn you receive:
- The current page URL
- A numbered list of visible, interactable elements
- Your overall task goal
- A log of previous steps

Decide the single best next action. Respond with ONLY valid JSON matching this schema:
${ACTION_SCHEMA}

Rules:
- Use "done" when the task is fully completed.
- Use "fail" when the task is impossible or you are stuck after multiple retries.
- Prefer elements by index (e.g. target="3") over selectors.
- For "fill", value is the text to type into the field.
- For "navigate", value is the full URL or path to navigate to.
- For "select", value is the option text or value.
- Never repeat the exact same action twice in a row if it failed.`
}

async function decideAction(
  client: ReturnType<typeof createAIClient>,
  model: string,
  instruction: string,
  currentUrl: string,
  elements: Array<{ selector: string; text: string }>,
  previousSteps: TestStep[],
  screenshot: string | null,
): Promise<AgentAction> {
  const elementText = elementsToText(
    elements.map((e, i) => ({
      index: i,
      tagName: 'el',
      text: e.text,
      selector: e.selector,
      disabled: false,
      visible: true,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    })),
  )

  const userContent = [
    `Task: ${instruction}`,
    `URL: ${currentUrl}`,
    '',
    'Interactable elements:',
    elementText || '(none found)',
    '',
    previousSteps.length > 0
      ? `Previous steps:\n${stepsToContext(previousSteps)}`
      : 'No previous steps.',
    '',
    'What is the next action?',
  ].join('\n')

  // Build messages — include screenshot if available
  const messages: Array<{
    role: 'system' | 'user' | 'assistant'
    content:
      | string
      | Array<{ type: string; text?: string; source?: unknown }>
  }> = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: screenshot
        ? ([
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot.split(',')[1] } },
            { type: 'text', text: userContent },
          ] as Array<{ type: string; text?: string; source?: unknown }>)
        : userContent,
    },
  ]

  try {
    // Use non-streaming call — we need the full JSON before parsing
    const raw = await client.chat({
      model,
      messages: messages as Parameters<typeof client.chat>[0]['messages'],
      maxTokens: 300,
      temperature: 0,
    })

    // Extract JSON from the response (model may wrap it in ```json ... ```)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('AI returned no JSON')
    return JSON.parse(jsonMatch[0]) as AgentAction
  } catch (err) {
    // Return a fail action so the run terminates gracefully
    return {
      action: 'fail',
      reasoning: `AI decision error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
