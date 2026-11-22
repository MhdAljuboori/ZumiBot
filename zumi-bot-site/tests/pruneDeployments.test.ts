import { describe, expect, it } from 'vitest'
import { deploymentsToRemove, type Deployment } from '../src/pruneDeployments.ts'

const d = (uid: string, created: number, state = 'READY', target: string | null = 'production'): Deployment => ({ uid, created, state, target })
const ids = (list: Deployment[]) => list.map((x) => x.uid).sort()

describe('deploymentsToRemove', () => {
  it('keeps production and the newest ready production deploy before it', () => {
    const all = [d('a', 1), d('b', 2), d('c', 3), d('prod', 4)]
    expect(ids(deploymentsToRemove(all, 'prod'))).toEqual(['a', 'b'])
  })

  it('removes previews, errored and canceled deploys, and never picks them as the rollback', () => {
    const all = [d('old', 1), d('preview', 2, 'READY', null), d('err', 3, 'ERROR'), d('cancel', 4, 'CANCELED'), d('prod', 5)]
    expect(ids(deploymentsToRemove(all, 'prod'))).toEqual(['cancel', 'err', 'preview'])
  })

  it('leaves newer and in-flight deploys alone', () => {
    const all = [d('old', 1), d('building', 2, 'BUILDING'), d('prod', 3), d('newer', 4), d('queued', 5, 'QUEUED')]
    expect(ids(deploymentsToRemove(all, 'prod'))).toEqual([])
  })

  it('removes newer canceled and errored deploys (a skipped build shows as canceled)', () => {
    const all = [d('old', 1), d('prod', 2), d('skipped', 3, 'CANCELED'), d('failed', 4, 'ERROR'), d('next', 5)]
    expect(ids(deploymentsToRemove(all, 'prod'))).toEqual(['failed', 'skipped'])
  })

  it('keeps production after a rollback, when newer deploys exist', () => {
    // Rolled back to b: c is newer and stays (it may be promoted again), a is the next rollback target.
    const all = [d('z', 0), d('a', 1), d('b', 2), d('c', 3)]
    expect(ids(deploymentsToRemove(all, 'b'))).toEqual(['z'])
  })

  it('refuses when the production deploy is unknown', () => {
    expect(() => deploymentsToRemove([d('a', 1)], undefined)).toThrow(/nothing deleted/)
    expect(() => deploymentsToRemove([d('a', 1)], 'gone')).toThrow(/nothing deleted/)
  })
})
