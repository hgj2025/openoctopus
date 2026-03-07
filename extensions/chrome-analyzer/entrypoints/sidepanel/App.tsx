import React, { useCallback, useEffect, useRef, useState } from 'react'
import { TestingPanel } from '../../components/testing/TestingPanel'
import { onMessage, sendToBackground } from '../../lib/messaging/bridge'
import type {
  ExtMessage,
  PerformanceReport,
  TestStep,
  VitalMetric,
} from '../../lib/messaging/types'
import { formatVitalValue } from '../../lib/performance/vitals-collector'
import { computeScore } from '../../lib/performance/reporter'
import { formatBytes } from '../../lib/performance/resource-analyzer'
import { loadSettings } from '../../lib/storage/settings-store'
import type { Settings } from '../../lib/storage/settings-store'

type Tab = 'performance' | 'chat' | 'testing'
type TestStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped'

interface ChatEntry {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

// --- Rating helpers ---
function ratingClass(rating: VitalMetric['rating']) {
  return {
    good: 'text-green-600',
    'needs-improvement': 'text-yellow-600',
    poor: 'text-red-600',
  }[rating]
}

function ScoreBadge({ score }: { score: number }) {
  if (score < 0) return null
  const color =
    score >= 75 ? 'bg-green-500' : score >= 50 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <span
      className={`${color} text-white text-xs font-bold px-2 py-0.5 rounded-full`}
    >
      {score}
    </span>
  )
}

// --- Core Web Vitals grid ---
function VitalsSection({ vitals }: { vitals: Map<string, VitalMetric> }) {
  const metricOrder: VitalMetric['name'][] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB']

  if (vitals.size === 0) {
    return (
      <div className="text-center py-8 text-gray-400 text-sm">
        <div className="text-2xl mb-2">📊</div>
        Waiting for vitals data…
        <p className="mt-1 text-xs">Navigate or reload the page to capture metrics.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {metricOrder.map((name) => {
        const metric = vitals.get(name)
        if (!metric) {
          return (
            <div
              key={name}
              className="rounded-lg border border-gray-100 bg-gray-50 p-3"
            >
              <div className="text-xs text-gray-400 font-medium">{name}</div>
              <div className="text-gray-300 text-sm mt-1">—</div>
            </div>
          )
        }
        const cls = ratingClass(metric.rating)
        const borderColor =
          metric.rating === 'good'
            ? '#16a34a40'
            : metric.rating === 'needs-improvement'
              ? '#d9770640'
              : '#dc262640'
        return (
          <div
            key={name}
            className="rounded-lg border p-3"
            style={{ borderColor }}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 font-medium">{name}</span>
              <span className={`text-xs font-semibold ${cls}`}>
                {metric.rating === 'good'
                  ? 'Good'
                  : metric.rating === 'needs-improvement'
                    ? 'NI'
                    : 'Poor'}
              </span>
            </div>
            <div className="text-xl font-bold mt-1 text-gray-800">
              {formatVitalValue(name, metric.value)}
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {metric.navigationType}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// --- Network waterfall ---
function NetworkSection({ report }: { report: PerformanceReport | null }) {
  if (!report || report.network.length === 0) {
    return (
      <div className="text-center py-6 text-gray-400 text-sm">
        No network data.{' '}
        <span className="text-xs">Start capture before loading the page.</span>
      </div>
    )
  }

  const sorted = [...report.network].sort((a, b) => b.totalMs - a.totalMs)
  const maxTime = sorted[0]?.totalMs ?? 1

  return (
    <div className="space-y-1">
      {sorted.slice(0, 20).map((entry) => {
        const shortUrl =
          entry.url.length > 55 ? `…${entry.url.slice(-52)}` : entry.url
        const barWidth = Math.max(2, (entry.totalMs / maxTime) * 100)
        const statusColor =
          entry.status >= 400 ? 'text-red-500' : 'text-gray-500'
        return (
          <div key={entry.requestId} className="text-xs">
            <div className="flex items-center gap-1 text-gray-600 truncate">
              <span className={`font-mono ${statusColor} shrink-0`}>
                {entry.status}
              </span>
              <span className="truncate flex-1" title={entry.url}>
                {shortUrl}
              </span>
              <span className="shrink-0 text-gray-400 font-mono">
                {Math.round(entry.totalMs)}ms
              </span>
            </div>
            <div className="h-1 bg-gray-100 rounded mt-0.5 mb-1">
              <div
                className="h-full bg-blue-400 rounded"
                style={{ width: `${barWidth}%` }}
              />
            </div>
          </div>
        )
      })}
      {sorted.length > 20 && (
        <div className="text-xs text-gray-400 text-center pt-1">
          +{sorted.length - 20} more requests
        </div>
      )}
    </div>
  )
}

// --- Resources summary ---
function ResourcesSection({ report }: { report: PerformanceReport | null }) {
  if (!report || report.resources.length === 0) return null

  const byType: Record<string, { count: number; bytes: number }> = {}
  for (const r of report.resources) {
    const t = r.initiatorType || 'other'
    const g = (byType[t] ??= { count: 0, bytes: 0 })
    g.count++
    g.bytes += r.transferSize
  }
  const cached = report.resources.filter((r) => r.cached).length

  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-2">
        <span>{report.resources.length} resources</span>
        <span className="text-green-600">{cached} cached</span>
      </div>
      <div className="space-y-1">
        {Object.entries(byType).map(([type, g]) => (
          <div key={type} className="flex justify-between text-xs">
            <span className="text-gray-600 capitalize">{type}</span>
            <span className="text-gray-400">
              {g.count} · {formatBytes(g.bytes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// --- Chat panel ---
function ChatPanel({
  onSendMessage,
  messages,
  isAnalyzing,
}: {
  onSendMessage: (text: string) => void
  messages: ChatEntry[]
  isAnalyzing: boolean
}) {
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text) return
    setInput('')
    onSendMessage(text)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-8 text-gray-400 text-sm">
            <div className="text-2xl mb-2">🤖</div>
            Ask me about this page's performance,
            <br />
            or run an analysis first.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-100 text-gray-800'
              }`}
            >
              {msg.content}
              {msg.streaming && (
                <span className="inline-block w-1 h-4 bg-gray-400 ml-0.5 animate-pulse" />
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-gray-100 p-3 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isAnalyzing}
          placeholder="Ask about performance…"
          className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400 transition-colors disabled:bg-gray-50"
        />
        <button
          type="submit"
          disabled={!input.trim() || isAnalyzing}
          className="bg-blue-500 text-white text-sm px-3 py-2 rounded-lg disabled:opacity-40 hover:bg-blue-600 transition-colors"
        >
          Send
        </button>
      </form>
    </div>
  )
}

// --- Main App ---
export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('performance')
  const [settings, setSettings] = useState<Settings | null>(null)

  // Performance state
  const [vitals, setVitals] = useState<Map<string, VitalMetric>>(new Map())
  const [report, setReport] = useState<PerformanceReport | null>(null)
  const [isCapturing, setIsCapturing] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([])
  const streamBufferRef = useRef('')

  // Testing state
  const [testSteps, setTestSteps] = useState<TestStep[]>([])
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testSummary, setTestSummary] = useState('')

  useEffect(() => {
    loadSettings().then(setSettings)
  }, [])

  useEffect(() => {
    return onMessage((msg: ExtMessage) => {
      switch (msg.type) {
        // Performance
        case 'VITALS_UPDATE':
          setVitals((prev) => {
            const next = new Map(prev)
            next.set(msg.payload.name, msg.payload)
            return next
          })
          break

        case 'REPORT_READY':
          setReport(msg.payload)
          break

        case 'AI_CHUNK':
          streamBufferRef.current += msg.payload.text
          setChatMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last?.streaming) {
              return [
                ...prev.slice(0, -1),
                { ...last, content: streamBufferRef.current },
              ]
            }
            return [
              ...prev,
              {
                role: 'assistant' as const,
                content: streamBufferRef.current,
                streaming: true,
              },
            ]
          })
          setActiveTab('chat')
          break

        case 'AI_DONE':
          streamBufferRef.current = ''
          setChatMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last?.streaming) {
              return [...prev.slice(0, -1), { ...last, streaming: false }]
            }
            return prev
          })
          setIsAnalyzing(false)
          break

        case 'AI_ERROR':
          streamBufferRef.current = ''
          setChatMessages((prev) => [
            ...prev,
            { role: 'assistant' as const, content: `Error: ${msg.payload.error}` },
          ])
          setIsAnalyzing(false)
          break

        // Testing
        case 'TEST_STARTED':
          setTestSteps([])
          setTestSummary('')
          setTestStatus('running')
          setActiveTab('testing')
          break

        case 'TEST_STEP':
          setTestSteps((prev) => {
            // Update in place if same index, else append
            const existing = prev.findIndex((s) => s.index === msg.payload.index)
            if (existing >= 0) {
              const next = [...prev]
              next[existing] = msg.payload
              return next
            }
            return [...prev, msg.payload]
          })
          break

        case 'TEST_COMPLETE':
          setTestStatus(msg.payload.success ? 'done' : 'failed')
          setTestSummary(msg.payload.summary)
          setTestSteps(msg.payload.steps)
          break

        case 'TEST_ERROR':
          setTestStatus('failed')
          setTestSummary(`Error: ${msg.payload.error}`)
          break
      }
    })
  }, [])

  const getActiveTabId = useCallback(async (): Promise<number | null> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return tab?.id ?? null
  }, [])

  const handleToggleCapture = useCallback(async () => {
    const tabId = await getActiveTabId()
    if (!tabId) return
    if (isCapturing) {
      await sendToBackground('STOP_CAPTURE', { tabId })
      setIsCapturing(false)
    } else {
      await sendToBackground('START_CAPTURE', { tabId })
      setIsCapturing(true)
      setVitals(new Map())
      setReport(null)
    }
  }, [isCapturing, getActiveTabId])

  const handleAnalyze = useCallback(async () => {
    if (!report || !settings || isAnalyzing) return
    setIsAnalyzing(true)
    await sendToBackground('ANALYZE_WITH_AI', { report, model: settings.model })
  }, [report, settings, isAnalyzing])

  const handleSendChat = useCallback(
    async (text: string) => {
      if (!settings || isAnalyzing) return
      setChatMessages((prev) => [
        ...prev,
        { role: 'user' as const, content: text },
      ])
      setIsAnalyzing(true)
      await sendToBackground('CHAT_MESSAGE', { content: text, model: settings.model })
    },
    [settings, isAnalyzing],
  )

  const handleStartTest = useCallback(
    async (instruction: string) => {
      const tabId = await getActiveTabId()
      if (!tabId || !settings) return
      setTestSteps([])
      setTestSummary('')
      setTestStatus('running')
      await sendToBackground('START_UI_TEST', {
        instruction,
        tabId,
        model: settings.model,
      })
    },
    [getActiveTabId, settings],
  )

  const handleStopTest = useCallback(async () => {
    const tabId = await getActiveTabId()
    if (!tabId) return
    setTestStatus('stopped')
    await sendToBackground('STOP_UI_TEST', { tabId })
  }, [getActiveTabId])

  const score = computeScore(Array.from(vitals.values()))
  const isTestRunning = testStatus === 'running'

  const tabs: { id: Tab; label: string }[] = [
    { id: 'performance', label: 'Performance' },
    { id: 'chat', label: 'Chat' },
    { id: 'testing', label: 'Testing' },
  ]

  return (
    <div className="flex flex-col h-screen bg-white text-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between px-3 py-2 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-800">AI Analyzer</span>
          <ScoreBadge score={score} />
          {isTestRunning && (
            <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full animate-pulse">
              Testing
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isAnalyzing && (
            <span className="text-xs text-blue-500 animate-pulse">AI…</span>
          )}
          <button
            onClick={handleToggleCapture}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
              isCapturing
                ? 'bg-red-100 text-red-600 hover:bg-red-200'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {isCapturing ? '⏹ Stop' : '⏺ Capture'}
          </button>
          <a
            href="/options.html"
            target="_blank"
            className="text-xs text-gray-400 hover:text-gray-600 p-1"
            title="Settings"
          >
            ⚙
          </a>
        </div>
      </header>

      {/* Tab bar */}
      <div className="flex border-b border-gray-100 shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              activeTab === t.id
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'performance' && (
          <div className="h-full overflow-y-auto p-3 space-y-4">
            <section>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Core Web Vitals
              </h2>
              <VitalsSection vitals={vitals} />
            </section>

            {report && !isAnalyzing && (
              <button
                onClick={handleAnalyze}
                className="w-full bg-blue-500 text-white text-sm py-2 rounded-lg hover:bg-blue-600 transition-colors"
              >
                Analyze with AI →
              </button>
            )}

            {report && (
              <section>
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Network ({report.network.length} requests)
                </h2>
                <NetworkSection report={report} />
              </section>
            )}

            {report && report.resources.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Resources
                </h2>
                <ResourcesSection report={report} />
              </section>
            )}

            {!report && vitals.size === 0 && (
              <div className="text-center py-6 text-gray-400 text-xs">
                <p>
                  Click <strong>⏺ Capture</strong> before reloading the page
                </p>
                <p className="mt-1">to collect network timing data.</p>
                <p className="mt-2">Core Web Vitals are collected automatically.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'chat' && (
          <ChatPanel
            onSendMessage={handleSendChat}
            messages={chatMessages}
            isAnalyzing={isAnalyzing}
          />
        )}

        {activeTab === 'testing' && (
          <TestingPanel
            model={settings?.model ?? 'claude-sonnet-4-6'}
            onStartTest={handleStartTest}
            onStopTest={handleStopTest}
            steps={testSteps}
            status={testStatus}
            summary={testSummary}
            isRunning={isTestRunning}
          />
        )}
      </div>
    </div>
  )
}
