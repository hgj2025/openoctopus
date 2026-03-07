// AI client that routes through a backend proxy.
// The proxy holds API keys; the extension only needs the proxy URL.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIRequestOptions {
  model: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
}

export interface AIClient {
  chat(options: AIRequestOptions): Promise<string>
  streamChat(options: AIRequestOptions): AsyncIterable<string>
}

/** Factory: create an AI client pointing at the given proxy base URL. */
export function createAIClient(proxyBaseUrl: string): AIClient {
  const baseUrl = proxyBaseUrl.replace(/\/$/, '')

  return {
    async chat(options) {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...options, stream: false }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(`AI proxy error ${res.status}: ${text}`)
      }
      const data = (await res.json()) as { content: string }
      return data.content
    },

    async *streamChat(options) {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...options, stream: true }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(`AI proxy error ${res.status}: ${text}`)
      }
      if (!res.body) throw new Error('No response body from AI proxy')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // Parse SSE lines
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') return
            try {
              const parsed = JSON.parse(data) as { text?: string; content?: string }
              const text = parsed.text ?? parsed.content ?? ''
              if (text) yield text
            } catch {
              // skip malformed SSE lines
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
    },
  }
}

/** Build a system prompt for performance analysis. */
export function buildAnalysisPrompt(url: string): string {
  return `You are an expert web performance engineer analyzing a page for the user.
The user has provided Core Web Vitals, network timing, and resource data from "${url}".
Your job:
1. Summarize the overall performance health (good/needs-improvement/poor).
2. Identify the top 3 bottlenecks with specific evidence from the data.
3. Provide actionable, prioritized recommendations (Quick Wins first, then larger efforts).
4. Use markdown formatting. Be concise and specific — avoid generic advice.`
}

/** Build a system prompt for general page chat. */
export function buildChatSystemPrompt(url: string): string {
  return `You are an AI assistant embedded in a browser extension analyzing "${url}".
Help the user understand page performance, suggest optimizations, or answer questions about web vitals and network behavior.
Be concise. Use markdown when helpful.`
}
