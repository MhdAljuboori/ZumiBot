// Plain, erasable-only TypeScript: scripts/fetchRelease.mjs imports this file as is (node strips the types).
export interface ReleaseInfo {
  version: string
  publishedAt: string
  notes: string
}

// Keep three fields and nothing else: the API answer also holds archive and asset links the public page must never carry.
export function toReleaseInfo(apiJson: unknown): ReleaseInfo | null {
  if (typeof apiJson !== 'object' || apiJson === null || Array.isArray(apiJson)) return null
  const o = apiJson as Record<string, unknown>
  if (typeof o.tag_name !== 'string' || o.tag_name === '') return null
  const version = o.tag_name.replace(/^v/, '')
  if (version === '') return null
  return {
    version,
    publishedAt: typeof o.published_at === 'string' ? o.published_at : '',
    notes: typeof o.body === 'string' ? o.body : ''
  }
}
