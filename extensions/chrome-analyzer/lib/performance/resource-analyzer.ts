// Collects PerformanceResourceTiming entries from the page.
// Runs in the content script context (injected into the page).

import type { ResourceEntry } from '../messaging/types'

/** Snapshot all resource timing entries from performance.getEntriesByType('resource'). */
export function collectResourceEntries(): ResourceEntry[] {
  const entries = performance.getEntriesByType(
    'resource',
  ) as PerformanceResourceTiming[]

  return entries.map((e) => ({
    name: e.name,
    initiatorType: e.initiatorType,
    duration: Math.round(e.duration),
    transferSize: e.transferSize,
    encodedBodySize: e.encodedBodySize,
    startTime: Math.round(e.startTime),
    // transferSize === 0 means served from cache
    cached: e.transferSize === 0 && e.decodedBodySize > 0,
  }))
}

/** Group resources by initiatorType for summary. */
export function groupByType(
  resources: ResourceEntry[],
): Record<string, ResourceEntry[]> {
  const groups: Record<string, ResourceEntry[]> = {}
  for (const r of resources) {
    const key = r.initiatorType || 'other'
    ;(groups[key] ??= []).push(r)
  }
  return groups
}

/** Return the N slowest resources by duration. */
export function slowestResources(
  resources: ResourceEntry[],
  n = 10,
): ResourceEntry[] {
  return [...resources].sort((a, b) => b.duration - a.duration).slice(0, n)
}

/** Return the N largest resources by transferSize. */
export function largestResources(
  resources: ResourceEntry[],
  n = 10,
): ResourceEntry[] {
  return [...resources].sort((a, b) => b.transferSize - a.transferSize).slice(0, n)
}

/** Format bytes to human readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}
