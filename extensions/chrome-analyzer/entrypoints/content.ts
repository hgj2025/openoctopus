// Content Script — injected into every page
// Collects Core Web Vitals + resource timing, and handles AI action execution.

import { defineContentScript } from 'wxt/utils/define-content-script'
import { sendToBackground } from '../lib/messaging/bridge'
import type { ExtMessage } from '../lib/messaging/types'
import { collectResourceEntries } from '../lib/performance/resource-analyzer'
import { collectVitals } from '../lib/performance/vitals-collector'
import { executeAction } from '../lib/testing/action-executor'
import { collectElements } from '../lib/testing/element-catalog'
import { waitForPageStability } from '../lib/testing/page-stability'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    // ── Performance: Core Web Vitals ──────────────────────────────────────
    collectVitals((metric) => {
      sendToBackground('VITALS_UPDATE', metric).catch(() => {})
    })

    const sendResources = () => {
      const resources = collectResourceEntries()
      if (resources.length > 0) {
        sendToBackground('RESOURCES_UPDATE', resources).catch(() => {})
      }
    }

    if (document.readyState === 'complete') {
      setTimeout(sendResources, 1500)
    } else {
      window.addEventListener('load', () => setTimeout(sendResources, 1500), {
        once: true,
      })
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        setTimeout(sendResources, 500)
      }
    })

    // ── Testing: bidirectional message handler ────────────────────────────
    // Background → content for UI testing commands.
    // Uses chrome.runtime.onMessage directly (WXT wraps this in the SW context,
    // but in content scripts we listen directly).
    chrome.runtime.onMessage.addListener(
      (
        message: ExtMessage,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (r: unknown) => void,
      ) => {
        if (message.type === 'GET_ELEMENTS') {
          const elements = collectElements()
          sendResponse({ payload: elements })
          return false // sync response
        }

        if (message.type === 'EXECUTE_ACTION') {
          const { action, catalog } = message.payload
          executeAction(action, catalog).then((result) => {
            sendResponse({ payload: result })
          })
          return true // async — keep channel open
        }

        if (message.type === 'WAIT_STABILITY') {
          waitForPageStability().then(() => {
            sendResponse({ payload: { done: true } })
          })
          return true // async
        }

        return false
      },
    )
  },
})
