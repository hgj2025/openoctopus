// Type-safe message passing helpers for cross-context communication

import type { ExtMessage, ExtMessagePayload, ExtMessageType } from './types'

/**
 * Send a message to the background service worker.
 * Returns the response (if any) from the handler.
 */
export async function sendToBackground<T extends ExtMessageType>(
  type: T,
  payload: ExtMessagePayload<T>,
): Promise<ExtMessage | null> {
  return chrome.runtime.sendMessage({ type, payload } as ExtMessage)
}

/**
 * Send a message to a specific tab's content script.
 */
export async function sendToTab<T extends ExtMessageType>(
  tabId: number,
  type: T,
  payload: ExtMessagePayload<T>,
): Promise<ExtMessage | null> {
  return chrome.tabs.sendMessage(tabId, { type, payload } as ExtMessage)
}

type MessageListener = (
  message: ExtMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: ExtMessage) => void,
) => boolean | void | Promise<void>

/**
 * Register a typed message listener. Returns an unsubscribe function.
 */
export function onMessage(listener: MessageListener): () => void {
  chrome.runtime.onMessage.addListener(listener)
  return () => chrome.runtime.onMessage.removeListener(listener)
}

/**
 * Register a one-shot handler for a specific message type.
 */
export function onMessageType<T extends ExtMessageType>(
  type: T,
  handler: (
    payload: ExtMessagePayload<T>,
    sender: chrome.runtime.MessageSender,
  ) => void | Promise<void>,
): () => void {
  const listener: MessageListener = (message, sender) => {
    if (message.type === type) {
      handler(message.payload as ExtMessagePayload<T>, sender)
    }
  }
  return onMessage(listener)
}

/**
 * Broadcast a message to all extension views (sidepanel, options page, etc.)
 */
export function broadcastToViews<T extends ExtMessageType>(
  type: T,
  payload: ExtMessagePayload<T>,
): void {
  const msg = { type, payload } as ExtMessage
  // Send to all extension views
  chrome.runtime.sendMessage(msg).catch(() => {
    // No listeners is fine (sidepanel may be closed)
  })
}
