// Deletes a Vercel project's old deployments, keeping the production one and the one a rollback goes to
// (src/pruneDeployments.ts picks them). Run by .github/workflows/prune-site-deployments.yml, with no npm install, for
// the site and the docs. Env: VERCEL_TOKEN (secret), VERCEL_PROJECT_ID, VERCEL_TEAM_ID, LIVE_HOST (the production
// domain, which tells the live deploy). DRY_RUN=1 lists without deleting.
// Deleted deploys sit in Vercel's recovery period for 30 days, then go for good. The token is never printed.
import { deploymentsToRemove } from '../src/pruneDeployments.ts'

const API = 'https://api.vercel.com'
const { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: project, VERCEL_TEAM_ID: team, LIVE_HOST: host, DRY_RUN } = process.env
for (const [name, value] of Object.entries({ VERCEL_TOKEN: token, VERCEL_PROJECT_ID: project, VERCEL_TEAM_ID: team, LIVE_HOST: host })) {
  if (!value) {
    console.error(`pruneDeployments: ${name} is not set`)
    process.exit(1)
  }
}

const call = async (method, path, query = {}) => {
  const url = new URL(path, API)
  for (const [k, v] of Object.entries({ ...query, teamId: team })) url.searchParams.set(k, String(v))
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Vercel answered ${res.status} for ${method} ${url.pathname}`)
  return res.json()
}

try {
  // The deploy the domain serves, not the project's production target: that one is the newest production build,
  // even while it is still building or after a rollback moved the domain back. The alias record first; looking the
  // deploy up by host answered 403 for docs.zumibot.run, so it is only the fallback.
  let productionId
  try {
    const alias = await call('GET', `/v4/aliases/${encodeURIComponent(host)}`)
    productionId = alias?.deploymentId ?? alias?.alias?.deploymentId
  } catch (err) {
    console.warn(`pruneDeployments: alias lookup failed (${err instanceof Error ? err.message : 'error'}); trying the host`)
  }
  if (typeof productionId !== 'string') {
    const live = await call('GET', `/v13/deployments/${encodeURIComponent(host)}`)
    productionId = typeof live?.id === 'string' ? live.id : undefined
  }
  const all = []
  let until
  do {
    const page = await call('GET', '/v6/deployments', { projectId: project, limit: 100, ...(until ? { until } : {}) })
    for (const d of page.deployments ?? []) all.push({ uid: d.uid, created: d.created, state: d.state ?? d.readyState, target: d.target ?? null })
    until = page.pagination?.next
  } while (until)
  const remove = deploymentsToRemove(all, productionId)
  console.log(`pruneDeployments: ${all.length} deployment(s), keeping ${all.length - remove.length}, removing ${remove.length}`)
  for (const d of remove) {
    if (DRY_RUN === '1') {
      console.log(`pruneDeployments: would remove ${d.uid} (${d.state}, ${new Date(d.created).toISOString()})`)
      continue
    }
    await call('DELETE', `/v13/deployments/${encodeURIComponent(d.uid)}`)
    console.log(`pruneDeployments: removed ${d.uid}`)
  }
} catch (err) {
  console.error(`pruneDeployments: ${err instanceof Error ? err.message : 'failed'}`)
  process.exit(1)
}
