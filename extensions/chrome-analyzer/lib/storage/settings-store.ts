// Persistent settings stored in chrome.storage.sync

export interface Settings {
  proxyUrl: string
  model: string
  captureOnLoad: boolean
  theme: 'light' | 'dark' | 'system'
}

const DEFAULTS: Settings = {
  proxyUrl: 'http://localhost:3000',
  model: 'claude-sonnet-4-6',
  captureOnLoad: false,
  theme: 'system',
}

export const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (default)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { id: 'custom', label: 'Custom (via proxy)' },
] as const

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULTS)
  return stored as Settings
}

export async function saveSettings(partial: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(partial)
}

export async function resetSettings(): Promise<void> {
  await chrome.storage.sync.set(DEFAULTS)
}

/** Subscribe to settings changes. Returns unsubscribe fn. */
export function onSettingsChange(
  cb: (changes: Partial<Settings>) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'sync') return
    const partial: Partial<Settings> = {}
    for (const [key, change] of Object.entries(changes)) {
      ;(partial as Record<string, unknown>)[key] = change.newValue
    }
    if (Object.keys(partial).length > 0) cb(partial)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
