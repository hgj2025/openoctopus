// Service Worker — core dispatcher
// Handles: CDP network capture, AI proxy calls, message routing, SW keep-alive

import { defineBackground } from 'wxt/utils/define-background'
import {
  buildAnalysisPrompt,
  buildChatSystemPrompt,
  createAIClient,
} from '../lib/ai/client'
import { broadcastToViews, onMessage } from '../lib/messaging/bridge'
import type { ExtMessage, PerformanceReport, VitalMetric } from '../lib/messaging/types'
import {
  isCapturing,
  setupDebuggerListener,
  startNetworkCapture,
  stopNetworkCapture,
} from '../lib/performance/network-capture'
import { buildReportSummary, createReport } from '../lib/performance/reporter'
import {
  appendChatMessage,
  getSession,
  updateSession,
} from '../lib/storage/session-store'
import { loadSettings } from '../lib/storage/settings-store'
import {
  isTestRunning,
  requestStopTest,
  startTestRun,
} from '../lib/testing/react-loop'

export default defineBackground(() => {
  // Keep SW alive via chrome.alarms
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })
  chrome.alarms.onAlarm.addListener(() => {
    // No-op: just prevents SW termination
  })

  // Set up CDP event listener (must be registered once globally)
  setupDebuggerListener()

  // Per-tab vitals accumulator
  const tabVitals = new Map<number, Map<string, VitalMetric>>()

  // Automatically open side panel when the extension icon is clicked (Chrome 116+).
  // setPanelBehavior is more reliable than calling sidePanel.open() inside onClicked
  // because it doesn't depend on preserving the user-gesture context across async calls.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error)

  // Route messages from content scripts and sidepanel
  onMessage(async (message: ExtMessage, sender, sendResponse) => {
    const tabId = sender.tab?.id ?? null

    switch (message.type) {
      case 'VITALS_UPDATE': {
        if (!tabId) break
        let vitals = tabVitals.get(tabId)
        if (!vitals) {
          vitals = new Map()
          tabVitals.set(tabId, vitals)
        }
        // Keep only latest value per metric name
        vitals.set(message.payload.name, message.payload)
        // Forward to sidepanel
        broadcastToViews('VITALS_UPDATE', message.payload)
        break
      }

      case 'RESOURCES_UPDATE': {
        if (!tabId) break
        // Just forward to sidepanel
        broadcastToViews('RESOURCES_UPDATE', message.payload)
        break
      }

      case 'START_CAPTURE': {
        const { tabId: targetTabId } = message.payload
        if (!isCapturing(targetTabId)) {
          await startNetworkCapture(targetTabId).catch(console.error)
          await updateSession({ isCapturing: true, activeTabId: targetTabId })
        }
        break
      }

      case 'STOP_CAPTURE': {
        const { tabId: stopTabId } = message.payload
        const networkEntries = await stopNetworkCapture(stopTabId)
        await updateSession({ isCapturing: false })

        // Gather vitals collected for this tab
        const vitalsForTab = Array.from(
          tabVitals.get(stopTabId)?.values() ?? [],
        )

        // Get tab URL
        const tab = await chrome.tabs.get(stopTabId).catch(() => null)
        const url = tab?.url ?? 'unknown'

        const report = createReport(url, vitalsForTab, networkEntries, [])
        await updateSession({ lastReport: report })
        broadcastToViews('REPORT_READY', report)
        break
      }

      case 'GET_REPORT': {
        const session = await getSession()
        if (session.lastReport) {
          broadcastToViews('REPORT_READY', session.lastReport)
        }
        break
      }

      case 'ANALYZE_WITH_AI': {
        await runAIAnalysis(message.payload.report, message.payload.model)
        break
      }

      case 'CHAT_MESSAGE': {
        await runAIChat(message.payload.content, message.payload.model)
        break
      }

      case 'START_UI_TEST': {
        const { instruction, tabId: testTabId, model: testModel } = message.payload
        if (!isTestRunning(testTabId)) {
          // Fire and forget — loop broadcasts progress via broadcastToViews
          startTestRun(testTabId, instruction, testModel).catch((err) => {
            broadcastToViews('TEST_ERROR', { error: String(err) })
          })
        }
        break
      }

      case 'STOP_UI_TEST': {
        requestStopTest(message.payload.tabId)
        break
      }
    }

    sendResponse(undefined)
    return true // keep message channel open
  })

  // Clean up tab state when tab is closed
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    tabVitals.delete(tabId)
    if (isCapturing(tabId)) {
      await stopNetworkCapture(tabId).catch(() => {})
    }
  })

  async function runAIAnalysis(
    report: PerformanceReport,
    model: string,
  ): Promise<void> {
    const settings = await loadSettings()
    const client = createAIClient(settings.proxyUrl)
    const summary = buildReportSummary(report)

    try {
      const stream = client.streamChat({
        model,
        messages: [
          { role: 'system', content: buildAnalysisPrompt(report.url) },
          {
            role: 'user',
            content: `Here is the performance data:\n\n${summary}\n\nPlease analyze this and provide recommendations.`,
          },
        ],
      })

      for await (const chunk of stream) {
        broadcastToViews('AI_CHUNK', { text: chunk })
      }
      broadcastToViews('AI_DONE', {})

      await appendChatMessage({
        role: 'assistant',
        content: `[Performance Analysis for ${report.url}]`,
        timestamp: Date.now(),
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      broadcastToViews('AI_ERROR', { error })
    }
  }

  async function runAIChat(userMessage: string, model: string): Promise<void> {
    const settings = await loadSettings()
    const client = createAIClient(settings.proxyUrl)
    const session = await getSession()

    // Build context from chat history
    const history = session.chatHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

    // Get current tab URL for context
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url ?? 'unknown page'

    await appendChatMessage({
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    })

    try {
      const stream = client.streamChat({
        model,
        messages: [
          { role: 'system', content: buildChatSystemPrompt(url) },
          ...history,
          { role: 'user', content: userMessage },
        ],
      })

      let fullResponse = ''
      for await (const chunk of stream) {
        fullResponse += chunk
        broadcastToViews('AI_CHUNK', { text: chunk })
      }
      broadcastToViews('AI_DONE', {})

      await appendChatMessage({
        role: 'assistant',
        content: fullResponse,
        timestamp: Date.now(),
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      broadcastToViews('AI_ERROR', { error })
    }
  }
})
