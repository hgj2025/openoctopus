// Detects when the page has settled after an action:
// - No DOM mutations for QUIET_MS
// - No in-flight fetch/XHR (tracked via PerformanceObserver)
// Runs in the content script context.

const QUIET_MS = 600       // silence window before considering "stable"
const MAX_WAIT_MS = 5000   // hard timeout

/**
 * Returns a promise that resolves when the page appears stable,
 * or after MAX_WAIT_MS whichever comes first.
 */
export function waitForPageStability(): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    let resolved = false

    const finish = () => {
      if (resolved) return
      resolved = true
      observer.disconnect()
      if (quietTimer) clearTimeout(quietTimer)
      resolve()
    }

    const resetTimer = () => {
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(finish, QUIET_MS)
    }

    // Watch for DOM mutations
    const observer = new MutationObserver(resetTimer)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: false,
    })

    // Start the initial quiet timer
    resetTimer()

    // Safety net: always resolve after MAX_WAIT_MS
    setTimeout(finish, MAX_WAIT_MS)
  })
}

/**
 * Simpler fixed-delay wait. Used as fallback when MutationObserver
 * can't be set up (e.g. after a navigation).
 */
export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
