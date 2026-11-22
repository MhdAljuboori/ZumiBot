import { describe, expect, it } from 'vitest'
import { ALREADY_UPDATING, type UpdateStatus } from '@zumibot/shared/update'
import {
  DISMISS_KEY,
  aboutLine,
  busyPrompt,
  canCheck,
  callErrorText,
  canOfferRollBack,
  checkedLine,
  clearedText,
  dismissStep,
  installErrorText,
  reloadNotice,
  resultLine,
  rollBackPrompt,
  runOutcome,
  slowHint,
  toastVersion
} from '../src/state/update'

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: '0.1.0',
  availability: 'ok',
  local: false,
  latest: { version: '0.1.1', publishedAt: '2026-11-01T00:00:00Z', notes: 'Fixes' },
  newer: true,
  checkedAt: 1000,
  checking: false,
  error: null,
  installing: false,
  lastResult: null,
  canRollBack: false,
  ...over
})

describe('toastVersion', () => {
  it('names the version when one is newer and not dismissed', () => {
    expect(toastVersion(status(), null)).toBe('0.1.1')
    expect(toastVersion(status(), '0.1.0')).toBe('0.1.1')
  })
  it('is null before the first status', () => {
    expect(toastVersion(null, null)).toBeNull()
  })
  it('is null when nothing is newer', () => {
    expect(toastVersion(status({ newer: false }), null)).toBeNull()
    expect(toastVersion(status({ latest: null }), null)).toBeNull()
  })
  it('is null when this install cannot update itself', () => {
    for (const availability of ['local', 'container', 'notInstaller'] as const)
      expect(toastVersion(status({ availability }), null)).toBeNull()
  })
  it('is null while installing', () => {
    expect(toastVersion(status({ installing: true }), null)).toBeNull()
  })
  it('is null once that version was dismissed, but a newer one shows again', () => {
    expect(toastVersion(status(), '0.1.1')).toBeNull()
    expect(toastVersion(status({ latest: { version: '0.1.2', publishedAt: '', notes: '' } }), '0.1.1')).toBe('0.1.2')
  })
  it('keeps the storage key', () => {
    expect(DISMISS_KEY).toBe('zumibot.update.dismissed')
  })
})

describe('aboutLine', () => {
  it('says up to date', () => {
    expect(aboutLine(status({ newer: false }))).toBe('Up to date')
  })
  it('names the available version', () => {
    expect(aboutLine(status())).toBe('Version 0.1.1 is available')
  })
  it('says checking while a check runs', () => {
    expect(aboutLine(status({ checking: true }))).toBe('Checking…')
  })
  it('does not claim up to date before the first check', () => {
    expect(aboutLine(status({ newer: false, latest: null, checkedAt: null }))).toBe('Not checked yet')
  })
  it('says up to date once a check found nothing newer, even a 404 one', () => {
    expect(aboutLine(status({ newer: false, latest: null, checkedAt: 5 }))).toBe('Up to date')
  })
  it('explains why an install cannot update', () => {
    expect(aboutLine(status({ availability: 'local', local: true }))).toBe('Updates are off in a development run of the desktop app')
    expect(aboutLine(status({ availability: 'container' }))).toBe('Updates are not available in a container install: run the Docker installer again')
    expect(aboutLine(status({ availability: 'notInstaller' }))).toBe('Updates need the installer install')
  })
  it('says installing while an update runs', () => {
    expect(aboutLine(status({ installing: true }))).toBe('Updating…')
  })
})

describe('resultLine', () => {
  const at = Date.UTC(2026, 10, 2, 12, 0)
  it('describes each kind', () => {
    expect(resultLine({ kind: 'updated', from: '0.1.0', to: '0.1.1', at })).toMatch(/^Updated from 0\.1\.0 to 0\.1\.1/)
    expect(resultLine({ kind: 'failed', from: '0.1.0', to: '0.1.1', at })).toMatch(/^Update to 0\.1\.1 failed/)
    expect(resultLine({ kind: 'rolledBack', from: '0.1.1', to: '0.1.0', at })).toMatch(/^Rolled back from 0\.1\.1 to 0\.1\.0/)
  })
})

describe('checkedLine', () => {
  it('says never before a check', () => {
    expect(checkedLine(null)).toBe('Never')
  })
  it('gives a time otherwise', () => {
    expect(checkedLine(1000)).not.toBe('Never')
  })
})

const failedAt5 = { kind: 'failed' as const, from: '0.1.0', to: '0.1.1', at: 5000 }

describe('runOutcome', () => {
  const run = { before: '0.1.0' }
  it('waits while the install runs, even at a new version', () => {
    expect(runOutcome(run, status({ installing: true }))).toBe('wait')
    expect(runOutcome(run, status({ current: '0.1.1', installing: true }))).toBe('wait')
  })
  it('reloads once the version changed', () => {
    expect(runOutcome(run, status({ current: '0.1.1' }))).toBe('reload')
    expect(runOutcome({ before: '0.1.1' }, status({ current: '0.1.0', lastResult: { ...failedAt5, kind: 'rolledBack' } }))).toBe('reload')
  })
  it('clears, not reloads, after a failed result at the same version', () => {
    expect(runOutcome(run, status({ lastResult: failedAt5 }))).toBe('clear')
  })
  it('clears a failed download: no restart, no new result, only an error', () => {
    const sequence = [status({ installing: true }), status({ installing: false, error: 'The download failed' })]
    expect(sequence.map((s) => runOutcome(run, s))).toEqual(['wait', 'clear'])
  })
  it('clears when replies turned busy after the download: installing ends, nothing changed', () => {
    const sequence = [status({ installing: true }), status({ installing: false })]
    expect(sequence.map((s) => runOutcome(run, s))).toEqual(['wait', 'clear'])
  })
})

describe('clearedText', () => {
  it('prefers the server error', () => {
    expect(clearedText(status({ error: 'The download failed', lastResult: failedAt5 }), null)).toBe('The download failed')
  })
  it('falls back to a result newer than the one seen at the click', () => {
    expect(clearedText(status({ lastResult: failedAt5 }), null)).toMatch(/^Update to 0\.1\.1 failed/)
    expect(clearedText(status({ lastResult: failedAt5 }), 5000)).toBe('The update stopped before it installed')
  })
  it('says something when there is nothing else', () => {
    expect(clearedText(status(), null)).toBe('The update stopped before it installed')
  })
})

describe('dismissStep', () => {
  it('clears a message first and never hides the version for it', () => {
    expect(dismissStep('0.1.1', 'boom')).toBe('message')
  })
  it('hides the version only when no message shows', () => {
    expect(dismissStep('0.1.1', null)).toBe('version')
  })
  it('does nothing without a toast', () => {
    expect(dismissStep(null, null)).toBe('none')
  })
})

describe('busyPrompt', () => {
  it('words the Update and Roll back confirms', () => {
    expect(busyPrompt('install', 2)).toBe('2 replies are running. Updating stops them. Update anyway?')
    expect(busyPrompt('install', 1)).toBe('1 reply is running. Updating stops it. Update anyway?')
    expect(busyPrompt('rollBack', 3)).toBe('3 replies are running. Rolling back stops them. Roll back anyway?')
  })
})

describe('installErrorText', () => {
  it('words a second install', () => {
    expect(installErrorText(new Error(ALREADY_UPDATING))).toBe('An update is already running')
  })
  it('passes other messages through', () => {
    expect(installErrorText(new Error('boom'))).toBe('boom')
    expect(installErrorText('x')).toBe('Could not start the update')
  })
})

describe('resultLine for a failed roll back', () => {
  const at = Date.UTC(2026, 10, 2, 12, 0)
  it('says roll back when the target is older than where it started', () => {
    expect(resultLine({ kind: 'failed', from: '0.1.1', to: '0.1.0', at })).toMatch(/^Roll back to 0\.1\.0 failed/)
  })
  it('says roll back without a version when the target is unknown', () => {
    expect(resultLine({ kind: 'failed', from: '0.1.1', to: 'the previous version', at })).toMatch(/^Roll back failed on/)
  })
  it('still says update for a failed update to a newer version', () => {
    expect(resultLine({ kind: 'failed', from: '0.1.0', to: '0.1.1', at })).toMatch(/^Update to 0\.1\.1 failed/)
  })
})

describe('canOfferRollBack', () => {
  const updated = { kind: 'updated' as const, from: '0.1.0', to: '0.1.1', at: 5000 }
  it('needs the previous pair and an update that swapped', () => {
    expect(canOfferRollBack(status({ canRollBack: true, lastResult: updated }))).toBe(true)
    expect(canOfferRollBack(status({ canRollBack: false, lastResult: updated }))).toBe(false)
  })
  it('is not offered after a failed update, a roll back, or with no result', () => {
    expect(canOfferRollBack(status({ canRollBack: true, lastResult: failedAt5 }))).toBe(false)
    expect(canOfferRollBack(status({ canRollBack: true, lastResult: { ...updated, kind: 'rolledBack' } }))).toBe(false)
    expect(canOfferRollBack(status({ canRollBack: true, lastResult: null }))).toBe(false)
  })
})

describe('rollBackPrompt', () => {
  it('names the version it goes back to and what is set aside', () => {
    const at = Date.UTC(2026, 10, 2, 12, 0)
    const text = rollBackPrompt({ kind: 'updated', from: '0.1.0', to: '0.1.1', at })
    expect(text).toMatch(
      /^Go back to v0\.1\.0\? Chats and settings changed since .+ are set aside \(kept in a \.failed folder on the server\)\.$/
    )
    expect(text).toContain(new Date(at).toLocaleDateString([], { dateStyle: 'medium' }))
  })
})

describe('local mode', () => {
  it('offers the toast like any install that can update itself', () => {
    expect(toastVersion(status({ local: true }), null)).toBe('0.1.1')
    expect(aboutLine(status({ local: true }))).toBe('Version 0.1.1 is available')
  })

  it('a slow update points at the server in VPS mode, and at quitting the app in Local mode', () => {
    expect(slowHint(false)).toContain('zumibot-rollback')
    expect(slowHint(true)).toContain('quit it and open it again')
    expect(slowHint(true)).not.toContain('zumibot-rollback')
  })
})

describe('reloadNotice', () => {
  it('offers a reload when the server runs another version than this tab', () => {
    expect(reloadNotice('0.1.1', '0.1.0')).toBe('ZumiBot was updated. Reload to use v0.1.1.')
  })
  it('is null for the same version or before the first status', () => {
    expect(reloadNotice('0.1.0', '0.1.0')).toBeNull()
    expect(reloadNotice(undefined, '0.1.0')).toBeNull()
  })
})

describe('callErrorText', () => {
  it('passes other messages through, with a fallback', () => {
    expect(callErrorText(new Error('boom'))).toBe('boom')
    expect(callErrorText('x')).toBe('The request failed')
  })
})

describe('canCheck', () => {
  it('is on when updates are available here and nothing runs', () => {
    expect(canCheck(status())).toBe(true)
    expect(canCheck(status({ checkedAt: null, latest: null, newer: false }))).toBe(true)
  })
  it('is off while a check or an install runs, or where updates are not available', () => {
    expect(canCheck(status({ checking: true }))).toBe(false)
    expect(canCheck(status({ installing: true }))).toBe(false)
    for (const availability of ['local', 'container', 'notInstaller'] as const) expect(canCheck(status({ availability }))).toBe(false)
  })
})
