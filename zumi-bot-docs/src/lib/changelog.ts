/** The changelog from its first release heading on: the root file's title and intro are for GitHub, not for readers here. */
export function publicChangelog(markdown: string): string {
  const at = markdown.search(/^## /m)
  return at === -1 ? '' : markdown.slice(at)
}
