// Executes AI-decided actions on the live page DOM.
// Runs in the content script context.

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
  /** Element index from catalog OR a CSS selector string */
  target?: string
  /** Text for fill / URL for navigate / option value for select */
  value?: string
  reasoning: string
}

export interface ActionResult {
  success: boolean
  error?: string
  /** Page URL after action (may have changed) */
  url: string
}

/** Resolve an element by catalog index OR CSS selector. */
function resolveElement(
  target: string,
  catalog: Array<{ selector: string }>,
): Element | null {
  const idx = parseInt(target, 10)
  if (!isNaN(idx) && catalog[idx]) {
    return document.querySelector(catalog[idx].selector)
  }
  // Treat as CSS selector
  return document.querySelector(target)
}

export async function executeAction(
  action: AgentAction,
  catalog: Array<{ selector: string }>,
): Promise<ActionResult> {
  const url = location.href

  try {
    if (action.action === 'done' || action.action === 'fail') {
      return { success: true, url }
    }

    if (action.action === 'navigate') {
      const dest = action.value ?? action.target ?? ''
      if (!dest) throw new Error('navigate requires a value (URL or path)')
      location.href = dest
      return { success: true, url: dest }
    }

    if (action.action === 'scroll') {
      if (!action.target) {
        window.scrollBy({ top: 500, behavior: 'smooth' })
        return { success: true, url }
      }
      const el = resolveElement(action.target, catalog)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return { success: true, url }
    }

    if (!action.target) throw new Error(`${action.action} requires a target`)
    const el = resolveElement(action.target, catalog)
    if (!el) throw new Error(`Element not found: ${action.target}`)

    if (action.action === 'click') {
      ;(el as HTMLElement).focus?.()
      ;(el as HTMLElement).click()
      return { success: true, url }
    }

    if (action.action === 'fill') {
      const input = el as HTMLInputElement | HTMLTextAreaElement
      input.focus()
      // Clear + dispatch input events so React/Vue/Angular state updates
      const nativeInputSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      nativeInputSetter?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      nativeInputSetter?.call(input, action.value ?? '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return { success: true, url }
    }

    if (action.action === 'select') {
      const sel = el as HTMLSelectElement
      const opt = Array.from(sel.options).find(
        (o) =>
          o.value === action.value ||
          o.text.toLowerCase() === (action.value ?? '').toLowerCase(),
      )
      if (!opt) throw new Error(`Option "${action.value}" not found in select`)
      sel.value = opt.value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return { success: true, url }
    }

    throw new Error(`Unknown action: ${action.action}`)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      url,
    }
  }
}
