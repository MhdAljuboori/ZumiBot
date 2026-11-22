export function browserSite(): Promise<{
  url: string
  hostUrl: string
  oversized: { bytes: number; finished: boolean; closed: boolean }
  close(): Promise<void>
}>
