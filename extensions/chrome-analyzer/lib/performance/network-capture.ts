// Captures network timing via chrome.debugger (CDP Network domain).
// Runs in the Service Worker context only.

import type { NetworkEntry } from '../messaging/types'

type RequestMap = Map<
  string,
  {
    url: string
    method: string
    startTime: number
    timing?: chrome.debugger.RequestTiming
    response?: {
      status: number
      mimeType: string
      encodedDataLength: number
      headers: Record<string, string>
    }
    finished?: boolean
  }
>

const PROTOCOL_VERSION = '1.3'

// Active captures keyed by tabId
const captures = new Map<
  number,
  { requests: RequestMap; entries: NetworkEntry[] }
>()

export async function startNetworkCapture(tabId: number): Promise<void> {
  if (captures.has(tabId)) return // already capturing

  captures.set(tabId, { requests: new Map(), entries: [] })

  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
    maxResourceBufferSize: 10 * 1024 * 1024, // 10 MB
    maxTotalBufferSize: 50 * 1024 * 1024,
  })
}

export async function stopNetworkCapture(
  tabId: number,
): Promise<NetworkEntry[]> {
  const capture = captures.get(tabId)
  if (!capture) return []
  captures.delete(tabId)

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.disable', {})
    await chrome.debugger.detach({ tabId })
  } catch {
    // Tab may have been closed
  }

  return capture.entries
}

export function isCapturing(tabId: number): boolean {
  return captures.has(tabId)
}

/** Must be registered once in the Service Worker. */
export function setupDebuggerListener(): () => void {
  const onEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params: unknown,
  ) => {
    const tabId = source.tabId
    if (!tabId) return
    const capture = captures.get(tabId)
    if (!capture) return

    const p = params as Record<string, unknown>

    if (method === 'Network.requestWillBeSent') {
      const requestId = p['requestId'] as string
      const request = p['request'] as { url: string; method: string }
      capture.requests.set(requestId, {
        url: request.url,
        method: request.method,
        startTime: (p['timestamp'] as number) * 1000, // CDP timestamps in seconds
      })
    }

    if (method === 'Network.responseReceived') {
      const requestId = p['requestId'] as string
      const entry = capture.requests.get(requestId)
      if (!entry) return
      const response = p['response'] as {
        status: number
        mimeType: string
        encodedDataLength?: number
        timing?: chrome.debugger.RequestTiming
        headers: Record<string, string>
      }
      entry.timing = response.timing
      entry.response = {
        status: response.status,
        mimeType: response.mimeType,
        encodedDataLength: response.encodedDataLength ?? 0,
        headers: response.headers,
      }
    }

    if (method === 'Network.loadingFinished') {
      const requestId = p['requestId'] as string
      const entry = capture.requests.get(requestId)
      if (!entry || !entry.response) return
      entry.finished = true

      const t = entry.timing
      const networkEntry: NetworkEntry = {
        requestId,
        url: entry.url,
        method: entry.method,
        status: entry.response.status,
        mimeType: entry.response.mimeType,
        startTime: entry.startTime,
        dnsMs: t ? Math.max(0, t.dnsEnd - t.dnsStart) : 0,
        connectMs: t ? Math.max(0, t.connectEnd - t.connectStart) : 0,
        sslMs: t ? Math.max(0, t.sslEnd - t.sslStart) : 0,
        sendMs: t ? Math.max(0, t.sendEnd - t.sendStart) : 0,
        waitMs: t ? Math.max(0, t.receiveHeadersEnd - t.sendEnd) : 0,
        receiveMs: t
          ? Math.max(
              0,
              ((p['timestamp'] as number) * 1000 - entry.startTime) -
                t.receiveHeadersEnd,
            )
          : 0,
        totalMs: (p['timestamp'] as number) * 1000 - entry.startTime,
        transferSize: (p['encodedDataLength'] as number) ?? 0,
        encodedSize: entry.response.encodedDataLength,
      }
      capture.entries.push(networkEntry)
    }
  }

  chrome.debugger.onEvent.addListener(onEvent)
  return () => chrome.debugger.onEvent.removeListener(onEvent)
}

// Extend chrome types for timing (not in @types/chrome by default)
declare namespace chrome.debugger {
  interface RequestTiming {
    requestTime: number
    proxyStart: number
    proxyEnd: number
    dnsStart: number
    dnsEnd: number
    connectStart: number
    connectEnd: number
    sslStart: number
    sslEnd: number
    sendStart: number
    sendEnd: number
    receiveHeadersEnd: number
  }
}
