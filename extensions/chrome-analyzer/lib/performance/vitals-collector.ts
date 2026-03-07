// Collects Core Web Vitals via the web-vitals library.
// Runs inside the content script context.

import {
  onCLS,
  onFCP,
  onINP,
  onLCP,
  onTTFB,
} from 'web-vitals/attribution'
import type { MetricWithAttribution } from 'web-vitals/attribution'
import type { VitalMetric } from '../messaging/types'

function toVitalMetric(metric: MetricWithAttribution): VitalMetric {
  return {
    name: metric.name as VitalMetric['name'],
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    navigationType: metric.navigationType,
    attribution: metric.attribution as Record<string, unknown>,
  }
}

/**
 * Start collecting vitals. Calls `onVital` for each metric update.
 * Returns a cleanup function.
 */
export function collectVitals(onVital: (metric: VitalMetric) => void): () => void {
  const report = (metric: MetricWithAttribution) => {
    onVital(toVitalMetric(metric))
  }

  // reportAllChanges: true to get intermediate updates (especially for CLS/INP)
  onLCP(report, { reportAllChanges: true })
  onCLS(report, { reportAllChanges: true })
  onINP(report, { reportAllChanges: true })
  onFCP(report)
  onTTFB(report)

  // web-vitals doesn't support cleanup, so return no-op
  return () => {}
}

/** Rating thresholds for display purposes. */
export const VITAL_THRESHOLDS: Record<
  VitalMetric['name'],
  { good: number; poor: number; unit: string }
> = {
  LCP: { good: 2500, poor: 4000, unit: 'ms' },
  CLS: { good: 0.1, poor: 0.25, unit: '' },
  INP: { good: 200, poor: 500, unit: 'ms' },
  FCP: { good: 1800, poor: 3000, unit: 'ms' },
  TTFB: { good: 800, poor: 1800, unit: 'ms' },
}

export function formatVitalValue(name: VitalMetric['name'], value: number): string {
  const threshold = VITAL_THRESHOLDS[name]
  if (name === 'CLS') return value.toFixed(3)
  return `${Math.round(value)}${threshold.unit}`
}
