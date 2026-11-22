import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ProcessIdentity = { pid: number; start: string }
type ProcessInfo = ProcessIdentity & { group: number; parent: number; state: string }
export type BrowserProcessOwner = {
  version: 2
  token: string
  profile: string
  state: 'launching' | 'ready' | 'unconfirmed' | 'stopped'
  worker: ProcessIdentity
  parent: ProcessIdentity
  processes: ProcessIdentity[]
}
const ownerFile = '.zumibot-browser-owner.json'
export const ownershipVariable = 'ZUMIBOT_BROWSER_PROCESS_OWNER'
export const ownershipMarker = (owner: Pick<BrowserProcessOwner, 'token' | 'profile'>) =>
  JSON.stringify({ token: owner.token, profile: owner.profile })
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function processInfo(pid: number): Promise<ProcessInfo | null> {
  if (process.platform !== 'linux') throw new Error('Browser process ownership requires Linux')
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8'),
      fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] }
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw new Error('Browser process identity unavailable')
  }
}
export async function identity(pid: number): Promise<ProcessIdentity> {
  const info = await processInfo(pid)
  if (!info) throw new Error('Browser process unavailable')
  return { pid, start: info.start }
}
export async function isRunning(expected: ProcessIdentity): Promise<boolean> {
  const info = await processInfo(expected.pid)
  return Boolean(info && info.state !== 'Z' && info.start === expected.start)
}
export async function canonicalProfile(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  return realpath(path)
}
export async function readOwner(profile: string): Promise<BrowserProcessOwner | null> {
  try {
    const value = JSON.parse(await readFile(join(profile, ownerFile), 'utf8')) as BrowserProcessOwner
    const validIdentity = (p: ProcessIdentity) => p && Number.isSafeInteger(p.pid) && p.pid > 1 && /^\d+$/.test(p.start)
    if (
      value.version !== 2 ||
      !/^[a-f0-9-]{36}$/.test(value.token) ||
      !['launching', 'ready', 'unconfirmed', 'stopped'].includes(value.state) ||
      value.profile !== (await realpath(profile)) ||
      !validIdentity(value.worker) ||
      !validIdentity(value.parent) ||
      !Array.isArray(value.processes) ||
      value.processes.length > 4096 ||
      !value.processes.every(validIdentity)
    )
      return null
    return value
  } catch {
    return null
  }
}
export async function writeOwner(owner: BrowserProcessOwner): Promise<void> {
  const temporary = join(owner.profile, `${ownerFile}.${owner.token}.tmp`)
  await writeFile(temporary, JSON.stringify(owner), { mode: 0o600 })
  await rename(temporary, join(owner.profile, ownerFile))
}
export async function markOwnerState(owner: BrowserProcessOwner, state: BrowserProcessOwner['state']): Promise<void> {
  const current = await readOwner(owner.profile)
  if (!current || current.token !== owner.token || current.worker.pid !== owner.worker.pid || current.worker.start !== owner.worker.start)
    throw new Error('Browser ownership proof unavailable')
  await writeOwner({ ...current, state })
}
export async function markWorkerState(profile: string, state: BrowserProcessOwner['state']): Promise<void> {
  if (!process.env[ownershipVariable]) return
  const owner = await readOwner(profile)
  if (!owner || owner.worker.pid !== process.pid || process.env[ownershipVariable] !== ownershipMarker(owner))
    throw new Error('Browser ownership proof unavailable')
  await markOwnerState(owner, state)
}
async function ownedWorker(owner: BrowserProcessOwner): Promise<boolean> {
  if (!(await isRunning(owner.worker))) return false
  try {
    return (await readFile(`/proc/${owner.worker.pid}/environ`, 'utf8'))
      .split('\0')
      .includes(`${ownershipVariable}=${ownershipMarker(owner)}`)
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw new Error('Browser ownership proof unavailable')
  }
}
async function ownedProcesses(owner: BrowserProcessOwner): Promise<ProcessInfo[]> {
  const infos = await Promise.all((await readdir('/proc')).filter((s) => /^\d+$/.test(s)).map((s) => processInfo(Number(s))))
  const selected = new Map<number, ProcessInfo>()
  for (const expected of owner.processes) {
    const info = infos.find((p) => p?.pid === expected.pid && p.start === expected.start && p.state !== 'Z')
    if (info) selected.set(info.pid, info)
  }
  // The CDP-reported browser roots launch in their own groups. Include their
  // verified group members/descendants before a dead parent can reparent them.
  for (let changed = true; changed;) {
    changed = false
    for (const info of infos) {
      if (!info || info.state === 'Z' || selected.has(info.pid)) continue
      const parent = selected.get(info.parent)
      const leader = selected.get(info.group)
      if (
        (parent && BigInt(info.start) >= BigInt(parent.start)) ||
        (leader && leader.group === leader.pid && BigInt(info.start) >= BigInt(leader.start))
      ) {
        selected.set(info.pid, info)
        changed = true
      }
    }
  }
  return [...selected.values()]
}
/** CDP process IDs belong to this persistent context's controlled launch channel. */
export async function recordBrowserProcesses(profile: string, pids: number[]): Promise<void> {
  if (!process.env[ownershipVariable]) return
  const owner = await readOwner(profile)
  if (
    !owner ||
    owner.worker.pid !== process.pid ||
    process.env[ownershipVariable] !== ownershipMarker(owner) ||
    !(await ownedWorker(owner))
  )
    throw new Error('Browser ownership proof unavailable')
  owner.processes = await Promise.all(pids.map(identity))
  if (!owner.processes.length || owner.processes.some((p) => BigInt(p.start) < BigInt(owner.worker.start)))
    throw new Error('Browser ownership proof unavailable')
  owner.processes = (await ownedProcesses(owner)).map(({ pid, start }) => ({ pid, start }))
  owner.state = 'ready'
  await writeOwner(owner)
}
/** Never signal a PID/group without rechecking its birth identity and exact owned profile. */
export async function cleanupOwned(owner: BrowserProcessOwner, killWorker: boolean): Promise<void> {
  if ((await realpath(owner.profile)) !== owner.profile) throw new Error('Browser cleanup unavailable')
  if (process.platform !== 'linux') throw new Error('Browser process ownership requires Linux')
  const currentOwner = await readOwner(owner.profile)
  if (
    currentOwner &&
    (currentOwner.token !== owner.token || currentOwner.worker.pid !== owner.worker.pid || currentOwner.worker.start !== owner.worker.start)
  )
    throw new Error('Browser ownership proof changed')
  if (currentOwner) owner = currentOwner
  if ((await isRunning(owner.worker)) && !(await ownedWorker(owner))) throw new Error('Browser ownership proof unavailable')
  let processes = await ownedProcesses(owner)
  if (!currentOwner && processes.length) throw new Error('Browser ownership proof unavailable')
  if (!owner.processes.length && owner.state !== 'stopped') {
    if (killWorker && (await ownedWorker(owner))) process.kill(owner.worker.pid, 'SIGKILL')
    if (currentOwner) await markOwnerState(owner, 'unconfirmed')
    throw new Error('Browser cleanup could not be confirmed')
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const browser of processes) {
      const current = await processInfo(browser.pid)
      if (!current || current.state === 'Z' || current.start !== browser.start || (await realpath(owner.profile)) !== owner.profile)
        continue
      const proof = await readOwner(owner.profile)
      if (!proof || proof.token !== owner.token || proof.worker.pid !== owner.worker.pid || proof.worker.start !== owner.worker.start)
        throw new Error('Browser ownership proof unavailable')
      try {
        process.kill(current.group === current.pid ? -current.pid : current.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    if (killWorker && (await isRunning(owner.worker))) {
      if (!(await ownedWorker(owner)) || (await realpath(owner.profile)) !== owner.profile)
        throw new Error('Browser ownership proof unavailable')
      try {
        process.kill(owner.worker.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    processes = await ownedProcesses({ ...owner, processes })
    if (!processes.length && (!killWorker || !(await isRunning(owner.worker)))) return
    await pause(50)
  }
  throw new Error('Browser cleanup did not complete')
}
export async function removeOwner(owner: BrowserProcessOwner): Promise<void> {
  const current = await readOwner(owner.profile)
  if (current?.token === owner.token && current.worker.pid === owner.worker.pid && current.worker.start === owner.worker.start)
    await rm(join(owner.profile, ownerFile), { force: true })
}
export async function recoverProfile(profile: string): Promise<void> {
  const owner = await readOwner(profile)
  if (!owner) {
    try {
      await access(join(profile, ownerFile))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    }
    throw new Error('Browser cleanup could not be confirmed')
  }
  if ((await isRunning(owner.worker)) && (await isRunning(owner.parent))) throw new Error('Browser profile is busy')
  await cleanupOwned(owner, true)
  await removeOwner(owner)
}

/** Run lazily once, before any launch: orphan profiles also count toward process capacity. */
export async function recoverBrowserProfiles(root: string): Promise<void> {
  try {
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Browser cleanup could not be confirmed')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('Browser cleanup could not be confirmed')
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Browser cleanup could not be confirmed')
    if (entry.isDirectory()) {
      const profile = join(root, entry.name)
      await recoverProfile(profile)
      await clearBrowserDownloadScratch(profile)
    }
  }
}

/** Only after ownership recovery: never traverse a symlink or an unrelated directory. */
export async function clearBrowserDownloadScratch(profile: string): Promise<void> {
  for (const entry of await readdir(profile, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.downloads-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.name))
      await rm(join(profile, entry.name), { recursive: true, force: true })
  }
}
