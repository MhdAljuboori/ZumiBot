/** Never accept page-supplied commands, paths, hosts, or other parameters. */
export function wantsSync(argv: string[]): boolean {
  return argv.some((arg) => arg === 'zumibot://sync' || arg === 'zumibot://sync/')
}
