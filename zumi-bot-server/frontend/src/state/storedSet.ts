export function loadSet(key: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveSet(key: string, values: Iterable<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...values]))
  } catch {
    // storage unavailable: expansion simply isn't remembered
  }
}
