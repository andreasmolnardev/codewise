// Adapted from pi-subpolar's @subpolar-agent/server/core/security-redaction.ts.
const SENSITIVE_KEY = /(?:pass(word)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|credential|private[-_]?key)/i

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitive(item, depth + 1)]))
  }
  if (typeof value !== 'string') return value
  return redactSensitiveText(value)
}

export function redactSensitiveText(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(redactSensitive(JSON.parse(trimmed)))
    } catch {
      // Fall through to the text patterns for malformed JSON.
    }
  }
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:password|secret|token|api[-_]?key|authorization|cookie)\s*["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|pk|gh[pousr]|xox[baprs])[-_][a-zA-Z0-9_-]{12,}\b/g, '[REDACTED]')
}
