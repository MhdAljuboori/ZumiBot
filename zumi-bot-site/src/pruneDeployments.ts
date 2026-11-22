// Pure part of scripts/pruneDeployments.mjs, so tests can check what it deletes. Each deploy holds the whole release
// (hundreds of MB), so only two are kept: the one serving production and the newest ready production deploy before
// it, which is what a rollback goes to.

export interface Deployment {
  uid: string
  created: number
  state: string // READY, ERROR, CANCELED, BUILDING, QUEUED, INITIALIZING
  target: string | null // 'production', or null for a preview
}

const IN_FLIGHT = new Set(['BUILDING', 'QUEUED', 'INITIALIZING'])
// Never served and never will be (a skipped build shows as CANCELED), whatever their age.
const DEAD = new Set(['ERROR', 'CANCELED'])

/** The deploys to delete. Throws when the production one is unknown, so nothing is deleted on a surprise. */
export function deploymentsToRemove(all: Deployment[], productionId: string | undefined): Deployment[] {
  const prod = all.find((d) => d.uid === productionId)
  if (!prod) throw new Error('the production deployment is not in the list; nothing deleted')
  const rollback = all
    .filter((d) => d.uid !== prod.uid && d.target === 'production' && d.state === 'READY' && d.created < prod.created)
    .sort((a, b) => b.created - a.created)[0]
  return all.filter(
    (d) =>
      d.uid !== prod.uid &&
      d.uid !== rollback?.uid &&
      // A newer ready one may be about to take production (waiting to be promoted): the next run decides.
      (d.created < prod.created || DEAD.has(d.state)) &&
      !IN_FLIGHT.has(d.state)
  )
}
