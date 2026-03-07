import React, { useEffect, useState } from 'react'
import {
  AVAILABLE_MODELS,
  loadSettings,
  resetSettings,
  saveSettings,
} from '../../lib/storage/settings-store'
import type { Settings } from '../../lib/storage/settings-store'

function Field({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      {description && <p className="text-xs text-gray-500">{description}</p>}
      {children}
    </div>
  )
}

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadSettings().then(setSettings)
  }, [])

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev))
    setSaved(false)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!settings) return
    setError('')
    try {
      await saveSettings(settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings')
    }
  }

  const handleReset = async () => {
    if (!confirm('Reset all settings to defaults?')) return
    await resetSettings()
    const fresh = await loadSettings()
    setSettings(fresh)
    setSaved(false)
  }

  if (!settings) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400">
        Loading…
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-lg mx-auto">
        <h1 className="text-xl font-bold text-gray-900 mb-1">AI Page Analyzer</h1>
        <p className="text-sm text-gray-500 mb-6">Settings</p>

        <form onSubmit={handleSave} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <Field
            label="AI Proxy URL"
            description="Base URL of your backend proxy server. The extension calls {proxyUrl}/api/ai/chat — no API keys are stored in the extension."
          >
            <input
              type="url"
              value={settings.proxyUrl}
              onChange={(e) => update('proxyUrl', e.target.value)}
              placeholder="http://localhost:3000"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400 transition-colors font-mono"
              required
            />
          </Field>

          <Field
            label="Default Model"
            description="Model identifier forwarded to your proxy. The proxy translates this to the actual API call."
          >
            <select
              value={settings.model}
              onChange={(e) => update('model', e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400 transition-colors bg-white"
            >
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Capture on Page Load"
            description="Automatically start CDP network capture when a new tab loads."
          >
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.captureOnLoad}
                onChange={(e) => update('captureOnLoad', e.target.checked)}
                className="rounded"
              />
              <span className="text-sm text-gray-700">Enable auto-capture</span>
            </label>
          </Field>

          <Field label="Theme">
            <div className="flex gap-3">
              {(['light', 'dark', 'system'] as const).map((t) => (
                <label key={t} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="theme"
                    value={t}
                    checked={settings.theme === t}
                    onChange={() => update('theme', t)}
                  />
                  <span className="text-sm capitalize text-gray-700">{t}</span>
                </label>
              ))}
            </div>
          </Field>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={handleReset}
              className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
            >
              Reset defaults
            </button>
            <button
              type="submit"
              className="bg-blue-500 text-white text-sm px-5 py-2 rounded-lg hover:bg-blue-600 transition-colors"
            >
              {saved ? '✓ Saved' : 'Save'}
            </button>
          </div>
        </form>

        <div className="mt-4 text-xs text-gray-400 text-center">
          AI Page Analyzer v0.1.0 — Performance analysis · AI-powered insights
        </div>
      </div>
    </div>
  )
}
