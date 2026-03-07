// Aggregates vitals + network + resources into a PerformanceReport
// and builds an AI prompt string for analysis.

import type { NetworkEntry, PerformanceReport, ResourceEntry, VitalMetric } from '../messaging/types'
import { formatBytes } from './resource-analyzer'

/** Compute an overall score (0–100) based on vitals ratings. */
export function computeScore(vitals: VitalMetric[]): number {
  if (vitals.length === 0) return -1
  const weights: Record<VitalMetric['name'], number> = {
    LCP: 30,
    CLS: 25,
    INP: 25,
    FCP: 10,
    TTFB: 10,
  }
  const ratingScore = (r: VitalMetric['rating']) =>
    r === 'good' ? 100 : r === 'needs-improvement' ? 50 : 0

  let total = 0
  let totalWeight = 0
  for (const v of vitals) {
    const w = weights[v.name] ?? 0
    total += ratingScore(v.rating) * w
    totalWeight += w
  }
  return totalWeight > 0 ? Math.round(total / totalWeight) : -1
}

/** Build an AI-friendly text summary of the report. */
export function buildReportSummary(report: PerformanceReport): string {
  const { vitals, network, resources, url } = report
  const lines: string[] = []

  lines.push(`## Page: ${url}`)
  lines.push(`Captured at: ${new Date(report.timestamp).toISOString()}`)
  lines.push('')

  lines.push('### Core Web Vitals')
  if (vitals.length === 0) {
    lines.push('No vitals data collected (page may not have loaded fully).')
  } else {
    for (const v of vitals) {
      const val = v.name === 'CLS' ? v.value.toFixed(3) : `${Math.round(v.value)}ms`
      lines.push(`- **${v.name}**: ${val} (${v.rating})`)
    }
  }
  lines.push('')

  lines.push('### Network Summary')
  if (network.length === 0) {
    lines.push('No network data (CDP capture may not have been active).')
  } else {
    const totalBytes = network.reduce((s, n) => s + n.transferSize, 0)
    const slowest = [...network].sort((a, b) => b.totalMs - a.totalMs).slice(0, 5)
    lines.push(`- Total requests: ${network.length}`)
    lines.push(`- Total transferred: ${formatBytes(totalBytes)}`)
    lines.push(`- Slowest requests:`)
    for (const n of slowest) {
      const shortUrl = n.url.length > 80 ? `...${n.url.slice(-77)}` : n.url
      lines.push(`  - ${Math.round(n.totalMs)}ms | ${n.status} | ${shortUrl}`)
    }
  }
  lines.push('')

  lines.push('### Resource Breakdown')
  if (resources.length === 0) {
    lines.push('No resource timing data.')
  } else {
    const byType: Record<string, { count: number; bytes: number; ms: number }> = {}
    for (const r of resources) {
      const t = r.initiatorType || 'other'
      const g = (byType[t] ??= { count: 0, bytes: 0, ms: 0 })
      g.count++
      g.bytes += r.transferSize
      g.ms += r.duration
    }
    for (const [type, g] of Object.entries(byType)) {
      lines.push(`- **${type}**: ${g.count} files, ${formatBytes(g.bytes)}, avg ${Math.round(g.ms / g.count)}ms`)
    }
    const cached = resources.filter((r) => r.cached).length
    lines.push(`- Cached: ${cached}/${resources.length} resources`)
  }

  return lines.join('\n')
}

export function createReport(
  url: string,
  vitals: VitalMetric[],
  network: NetworkEntry[],
  resources: ResourceEntry[],
): PerformanceReport {
  return {
    url,
    timestamp: Date.now(),
    vitals,
    network,
    resources,
  }
}
