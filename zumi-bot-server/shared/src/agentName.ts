// Its own file, free of imports: the service worker bundles it through notify.ts, and frontmatter.ts would bring yaml.

/** How an agent's name reads in the UI: `workiom5-assistance` shows as `Workiom5 Assistance`. */
export function displayName(name: string): string {
  return name
    .split('-')
    .filter((w) => w !== '')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}
