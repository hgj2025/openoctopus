// Catalogs interactable DOM elements for the AI agent.
// Runs in the content script context.

export interface ElementDescriptor {
  index: number
  tagName: string
  type?: string           // input type
  id?: string
  name?: string
  placeholder?: string
  ariaLabel?: string
  text: string            // visible text / value
  role?: string
  href?: string
  disabled: boolean
  visible: boolean
  rect: { x: number; y: number; width: number; height: number }
  /** Stable selector the executor can use to find this element. */
  selector: string
}

const INTERACTIVE_SELECTORS = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[contenteditable="true"]',
].join(',')

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  const style = window.getComputedStyle(el)
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  )
}

/** Build a robust CSS selector for an element (prefers id > data-testid > aria > nth). */
function buildSelector(el: Element): string {
  // Prefer id
  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
    return `#${el.id}`
  }
  // data-testid
  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id')
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`

  // aria-label
  const aria = el.getAttribute('aria-label')
  if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`

  // name attribute (inputs)
  const name = el.getAttribute('name')
  if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`

  // nth-of-type fallback
  const tag = el.tagName.toLowerCase()
  const parent = el.parentElement
  if (!parent) return tag
  const siblings = Array.from(parent.children).filter(
    (c) => c.tagName === el.tagName,
  )
  const idx = siblings.indexOf(el) + 1
  const parentSel = buildSelector(parent)
  return `${parentSel} > ${tag}:nth-of-type(${idx})`
}

function getElementText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value || el.placeholder || ''
  }
  if (el instanceof HTMLSelectElement) {
    return el.options[el.selectedIndex]?.text ?? ''
  }
  // Trim and collapse whitespace
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** Collect all visible, interactable elements on the page (capped at 80). */
export function collectElements(): ElementDescriptor[] {
  const nodes = document.querySelectorAll(INTERACTIVE_SELECTORS)
  const results: ElementDescriptor[] = []

  nodes.forEach((el, rawIdx) => {
    if (results.length >= 80) return
    if (!isVisible(el)) return

    const rect = el.getBoundingClientRect()
    const descriptor: ElementDescriptor = {
      index: results.length,
      tagName: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type,
      id: el.id || undefined,
      name: (el as HTMLInputElement).name || undefined,
      placeholder: (el as HTMLInputElement).placeholder || undefined,
      ariaLabel: el.getAttribute('aria-label') ?? undefined,
      text: getElementText(el),
      role: el.getAttribute('role') ?? undefined,
      href: (el as HTMLAnchorElement).href || undefined,
      disabled: (el as HTMLInputElement).disabled ?? false,
      visible: true,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      selector: buildSelector(el),
    }
    void rawIdx // used implicitly via results.length
    results.push(descriptor)
  })

  return results
}

/** Format elements as a compact text list for the AI prompt. */
export function elementsToText(elements: ElementDescriptor[]): string {
  return elements
    .map((e) => {
      const parts: string[] = [`[${e.index}] ${e.tagName}`]
      if (e.type && e.type !== e.tagName) parts.push(`type=${e.type}`)
      if (e.ariaLabel) parts.push(`aria="${e.ariaLabel}"`)
      if (e.placeholder) parts.push(`placeholder="${e.placeholder}"`)
      if (e.text) parts.push(`text="${e.text}"`)
      if (e.href) parts.push(`href="${e.href.slice(0, 60)}"`)
      if (e.disabled) parts.push('(disabled)')
      return parts.join(' ')
    })
    .join('\n')
}
