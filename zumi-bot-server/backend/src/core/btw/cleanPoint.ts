/** Entry precedes its tool events, so keep the prior clean entry until all calls finish. */
export class CleanPoint {
  private tip: string | null = null
  private clean: string | null = null
  private open = new Set<string>()

  entry(uuid: string): void {
    if (this.tip !== null && this.open.size === 0) this.clean = this.tip
    this.tip = uuid
  }

  toolUse(id: string): void {
    this.open.add(id)
  }

  toolResult(id: string): void {
    this.open.delete(id)
  }

  get(): string | null {
    return this.open.size === 0 ? this.tip : this.clean
  }
}
