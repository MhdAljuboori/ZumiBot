// Electron wraps main-process rejections as "Error invoking remote method '<channel>': Error: <message>".
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}
