import React, { useCallback, useRef, useState } from 'react'
import type { AgentAction, TestStep } from '../../lib/messaging/types'

const ACTION_ICONS: Record<AgentAction['action'], string> = {
  click: '👆',
  fill: '✏️',
  select: '📋',
  navigate: '🔗',
  scroll: '↕️',
  done: '✅',
  fail: '❌',
}

function StepRow({ step }: { step: TestStep }) {
  const [expanded, setExpanded] = useState(false)
  const icon = ACTION_ICONS[step.action.action] ?? '•'
  const statusColor = step.success
    ? 'text-green-600 bg-green-50 border-green-100'
    : 'text-red-600 bg-red-50 border-red-100'

  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs cursor-pointer ${statusColor}`}
      onClick={() => setExpanded((e) => !e)}
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-base leading-tight">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className="font-medium capitalize">{step.action.action}</span>
            {step.action.target && (
              <code className="text-gray-500 font-mono truncate max-w-[120px]">
                {step.action.target}
              </code>
            )}
          </div>
          <div className="text-gray-500 truncate">{step.action.reasoning}</div>
          {step.error && (
            <div className="text-red-500 mt-0.5 truncate">⚠ {step.error}</div>
          )}
        </div>
        <span className="shrink-0 text-gray-300">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="mt-2 space-y-1 border-t border-current/10 pt-2">
          {step.action.value && (
            <div>
              <span className="text-gray-400">value: </span>
              <code className="text-gray-700">"{step.action.value}"</code>
            </div>
          )}
          <div>
            <span className="text-gray-400">url: </span>
            <span className="text-gray-600 break-all">{step.url}</span>
          </div>
          {step.screenshot && (
            <img
              src={step.screenshot}
              alt={`Step ${step.index + 1} screenshot`}
              className="rounded border border-gray-200 w-full mt-1"
            />
          )}
        </div>
      )}
    </div>
  )
}

type RunStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped'

interface TestingPanelProps {
  model: string
  onStartTest: (instruction: string) => void
  onStopTest: () => void
  steps: TestStep[]
  status: RunStatus
  summary: string
  isRunning: boolean
}

export function TestingPanel({
  model,
  onStartTest,
  onStopTest,
  steps,
  status,
  summary,
  isRunning,
}: TestingPanelProps) {
  const [instruction, setInstruction] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const handleStart = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const text = instruction.trim()
      if (!text || isRunning) return
      onStartTest(text)
    },
    [instruction, isRunning, onStartTest],
  )

  const statusBadge = () => {
    if (status === 'running')
      return (
        <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full animate-pulse">
          Running… step {steps.length}
        </span>
      )
    if (status === 'done')
      return (
        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
          ✓ Done
        </span>
      )
    if (status === 'failed')
      return (
        <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
          ✗ Failed
        </span>
      )
    if (status === 'stopped')
      return (
        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
          Stopped
        </span>
      )
    return null
  }

  return (
    <div className="flex flex-col h-full">
      {/* Instruction input */}
      <form onSubmit={handleStart} className="p-3 border-b border-gray-100 space-y-2">
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={
            'Describe the UI task…\ne.g. "Search for laptops, filter by 16GB RAM, and open the first result"'
          }
          disabled={isRunning}
          rows={3}
          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400 transition-colors resize-none disabled:bg-gray-50"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 flex-1 truncate">
            Model: {model}
          </span>
          {isRunning ? (
            <button
              type="button"
              onClick={onStopTest}
              className="bg-red-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-red-600 transition-colors"
            >
              ⏹ Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!instruction.trim()}
              className="bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg disabled:opacity-40 hover:bg-blue-600 transition-colors"
            >
              ▶ Run Test
            </button>
          )}
        </div>
      </form>

      {/* Steps + status */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {steps.length === 0 && status === 'idle' && (
          <div className="text-center py-8 text-gray-400 text-sm">
            <div className="text-3xl mb-2">🤖</div>
            Describe a UI task above.
            <p className="text-xs mt-1">
              The AI will navigate and interact with the page step by step.
            </p>
          </div>
        )}

        {/* Status header */}
        {status !== 'idle' && (
          <div className="flex items-center justify-between">
            {statusBadge()}
            <span className="text-xs text-gray-400">{steps.length} steps</span>
          </div>
        )}

        {steps.map((step) => (
          <StepRow key={`${step.index}-${step.timestamp}`} step={step} />
        ))}

        {/* Summary */}
        {summary && status !== 'running' && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              status === 'done'
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            <div className="font-medium mb-0.5">Summary</div>
            {summary}
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  )
}
