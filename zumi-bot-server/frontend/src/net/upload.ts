import { stageErrors } from '@zumibot/shared/attachments'
import type { StageResult } from '@zumibot/shared/types'
import { redirectToLogin } from './signedOut'

/** Stages bytes through POST /api/attachments/stage; the body is raw so a proxy's HTML 413 needs no parsing. */
export async function uploadFile(
  fetchImpl: typeof fetch,
  name: string,
  bytes: Uint8Array,
  onSignedOut: () => void = redirectToLogin
): Promise<StageResult> {
  const unreadable: StageResult = { ok: false, name, error: stageErrors.unreadable(name) }
  let res: Response
  try {
    res = await fetchImpl('/api/attachments/stage', {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
      body: bytes as BodyInit
    })
  } catch {
    return unreadable
  }
  if (res.status === 401) {
    onSignedOut()
    return unreadable
  }
  if (res.status === 413) return { ok: false, name, error: stageErrors.tooBig(name) }
  if (!res.ok) return unreadable
  try {
    return (await res.json()) as StageResult
  } catch {
    return unreadable
  }
}
