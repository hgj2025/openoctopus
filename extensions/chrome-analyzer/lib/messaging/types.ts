// Cross-context message types for the Chrome extension

export type VitalsRating = 'good' | 'needs-improvement' | 'poor'

export interface VitalMetric {
  name: 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB'
  value: number
  rating: VitalsRating
  delta: number
  navigationType: string
  attribution?: Record<string, unknown>
}

export interface NetworkEntry {
  requestId: string
  url: string
  method: string
  status: number
  mimeType: string
  startTime: number
  // CDP timing fields (ms)
  dnsMs: number
  connectMs: number
  sslMs: number
  sendMs: number
  waitMs: number // TTFB
  receiveMs: number
  totalMs: number
  transferSize: number
  encodedSize: number
}

export interface ResourceEntry {
  name: string
  initiatorType: string
  duration: number
  transferSize: number
  encodedBodySize: number
  startTime: number
  cached: boolean
}

export interface PerformanceReport {
  url: string
  timestamp: number
  vitals: VitalMetric[]
  network: NetworkEntry[]
  resources: ResourceEntry[]
  aiAnalysis?: string
}

// UI testing types
export type ActionType =
  | 'click'
  | 'fill'
  | 'select'
  | 'navigate'
  | 'scroll'
  | 'done'
  | 'fail'

export interface AgentAction {
  action: ActionType
  target?: string
  value?: string
  reasoning: string
}

export interface TestStep {
  index: number
  action: AgentAction
  success: boolean
  error?: string
  screenshot?: string
  url: string
  timestamp: number
}

// Message payloads typed per action
export type ExtMessage =
  | { type: 'VITALS_UPDATE'; payload: VitalMetric }
  | { type: 'RESOURCES_UPDATE'; payload: ResourceEntry[] }
  | { type: 'START_CAPTURE'; payload: { tabId: number } }
  | { type: 'STOP_CAPTURE'; payload: { tabId: number } }
  | { type: 'GET_REPORT'; payload: { tabId: number } }
  | { type: 'REPORT_READY'; payload: PerformanceReport }
  | { type: 'ANALYZE_WITH_AI'; payload: { report: PerformanceReport; model: string } }
  | { type: 'AI_CHUNK'; payload: { text: string } }
  | { type: 'AI_DONE'; payload: Record<string, never> }
  | { type: 'AI_ERROR'; payload: { error: string } }
  | { type: 'CHAT_MESSAGE'; payload: { content: string; model: string } }
  | { type: 'OPEN_SIDEPANEL'; payload: Record<string, never> }
  // UI testing messages
  | { type: 'START_UI_TEST'; payload: { instruction: string; tabId: number; model: string } }
  | { type: 'STOP_UI_TEST'; payload: { tabId: number } }
  | { type: 'TEST_STARTED'; payload: { instruction: string; tabId: number } }
  | { type: 'TEST_STEP'; payload: TestStep }
  | { type: 'TEST_COMPLETE'; payload: { success: boolean; steps: TestStep[]; summary: string } }
  | { type: 'TEST_ERROR'; payload: { error: string } }
  // Content script bidirectional (background ↔ content)
  | { type: 'GET_ELEMENTS'; payload: Record<string, never> }
  | { type: 'EXECUTE_ACTION'; payload: { action: AgentAction; catalog: Array<{ selector: string }> } }
  | { type: 'WAIT_STABILITY'; payload: Record<string, never> }

export type ExtMessageType = ExtMessage['type']
export type ExtMessagePayload<T extends ExtMessageType> = Extract<
  ExtMessage,
  { type: T }
>['payload']
