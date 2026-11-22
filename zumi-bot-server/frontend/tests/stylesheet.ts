import { readFileSync } from 'node:fs'

const STYLES = new URL('../src/styles/', import.meta.url)

/** The files `src/styles/index.css` imports, in its order: the order the build lays them out in. */
export function styleFiles(): string[] {
  const index = readFileSync(new URL('index.css', STYLES), 'utf8')
  return [...index.matchAll(/^@import '\.\/([a-z0-9-]+\.css)';$/gm)].map((m) => m[1]!)
}

/** One area's file, such as `tokens.css`. */
export const styleFile = (name: string): string => readFileSync(new URL(name, STYLES), 'utf8')

/** The whole stylesheet as the build sees it: every imported file, in order. */
export const stylesheet = (): string => styleFiles().map(styleFile).join('\n')
