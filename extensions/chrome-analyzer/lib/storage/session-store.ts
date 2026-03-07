// Session state stored in chrome.storage.session (cleared on browser restart)
// Used to share transient state between SW, content scripts, and sidepanel.

import type { PerformanceReport } from '../messaging/types'

export interface SessionState {
  activeTabId: number | null
  isCapturing: boolean
  lastReport: PerformanceReport | null
  chatHistory: ChatMessage[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const KEY = 'session_state'

const DEFAULT_STATE: SessionState = {
  activeTabId: null,
  isCapturing: false,
  lastReport: null,
  chatHistory: [],
}

export async function getSession(): Promise<SessionState> {
  const result = await chrome.storage.session.get(KEY)
  return (result[KEY] as SessionState) ?? DEFAULT_STATE
}

export async function updateSession(
  partial: Partial<SessionState>,
): Promise<void> {
  const current = await getSession()
  await chrome.storage.session.set({ [KEY]: { ...current, ...partial } })
}

export async function appendChatMessage(msg: ChatMessage): Promise<void> {
  const current = await getSession()
  const history = [...current.chatHistory, msg].slice(-100) // keep last 100
  await updateSession({ chatHistory: history })
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.set({ [KEY]: DEFAULT_STATE })
}

/** Subscribe to session changes. Returns unsubscribe fn. */
export function onSessionChange(
  cb: (state: SessionState) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'session' || !(KEY in changes)) return
    cb((changes[KEY].newValue as SessionState) ?? DEFAULT_STATE)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
