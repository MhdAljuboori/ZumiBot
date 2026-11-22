import { describe, expect, it } from 'vitest'
import {
  LOG_TAIL_MAX,
  PR_TITLE_MAX,
  checkMessage,
  checksLine,
  commitSubjects,
  draftBody,
  draftTitle,
  foldRollup,
  jobIdOf,
  logTail,
  prLabel,
  prUnfinished,
  scrubToken,
  toolLine
} from '@zumibot/shared/pullRequest'

const run = (o: Record<string, unknown>) => ({ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', ...o })
const ctx = (o: Record<string, unknown>) => ({ __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', ...o })

describe('foldRollup', () => {
  it('reads a CheckRun and a StatusContext the same way', () => {
    expect(foldRollup([run({}), ctx({})])).toEqual({ status: 'passing', total: 2, pending: 0, failing: [] })
  })

  it('counts what is still running, and a skipped or neutral check is not a failure', () => {
    const got = foldRollup([
      run({ name: 'a', status: 'IN_PROGRESS', conclusion: null }),
      run({ name: 'b', conclusion: 'SKIPPED' }),
      run({ name: 'c', conclusion: 'NEUTRAL' })
    ])
    expect(got).toEqual({ status: 'pending', total: 3, pending: 1, failing: [] })
  })

  it('names every failing check, and a failure wins over anything still running', () => {
    const got = foldRollup([
      run({ name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/a/b/actions/runs/12/job/345' }),
      run({ name: 'slow', status: 'QUEUED', conclusion: null }),
      ctx({ context: 'legacy', state: 'ERROR', targetUrl: 'https://ci.example/9' })
    ])
    expect(got!.status).toBe('failing')
    expect(got!.pending).toBe(1)
    expect(got!.failing).toEqual([
      { name: 'unit', url: 'https://github.com/a/b/actions/runs/12/job/345', jobId: '345' },
      { name: 'legacy', url: 'https://ci.example/9' }
    ])
  })

  it('keeps a check link only when it is https', () => {
    const got = foldRollup([
      ctx({ context: 'js', state: 'ERROR', targetUrl: 'javascript:alert(1)' }),
      ctx({ context: 'plain', state: 'ERROR', targetUrl: 'http://ci.example/1' })
    ])
    expect(got!.failing.map((c) => c.url ?? '')).toEqual(['', ''])
  })

  it('reads a timed out, cancelled or action-required check as failing', () => {
    for (const conclusion of ['TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
      expect(foldRollup([run({ conclusion })])!.status).toBe('failing')
    }
  })

  it('is absent when nothing reported, and survives anything that is not a rollup', () => {
    expect(foldRollup([])).toBeUndefined()
    expect(foldRollup(undefined)).toBeUndefined()
    expect(foldRollup('nope')).toBeUndefined()
    expect(foldRollup([null, 7])).toBeUndefined()
    // Reported but not concluded yet: still running, not a pass.
    expect(foldRollup([run({ status: 'COMPLETED', conclusion: null })])).toEqual({ status: 'pending', total: 1, pending: 1, failing: [] })
  })
})

describe('jobIdOf', () => {
  it('finds an Actions job, and nothing in another CI link', () => {
    expect(jobIdOf('https://github.com/a/b/actions/runs/12/job/345')).toBe('345')
    expect(jobIdOf('https://github.com/a/b/actions/runs/12')).toBeUndefined()
    expect(jobIdOf('https://ci.example/build/9')).toBeUndefined()
  })
})

describe('checksLine and prLabel', () => {
  it('says what the checks are doing', () => {
    expect(checksLine(undefined)).toBeNull()
    expect(checksLine({ status: 'passing', total: 1, pending: 0, failing: [] })).toBe('1 check passing')
    expect(checksLine({ status: 'pending', total: 3, pending: 2, failing: [] })).toBe('2 checks running')
    expect(checksLine({ status: 'failing', total: 4, pending: 0, failing: [{ name: 'a' }] })).toBe('1 of 4 checks failing')
  })

  it('reads a draft as a draft only while it is open', () => {
    expect(prLabel({ number: 7, state: 'open' })).toBe('#7 · open')
    expect(prLabel({ number: 7, state: 'open', draft: true })).toBe('#7 · draft')
    expect(prLabel({ number: 7, state: 'merged', draft: true })).toBe('#7 · merged')
    expect(prLabel({ number: 7, state: 'open', checks: { status: 'passing', total: 2, pending: 0, failing: [] } })).toBe(
      '#7 · open · 2 checks passing'
    )
  })
})

describe('prUnfinished', () => {
  it('is true only while a PR is open with checks still running', () => {
    const pending = { status: 'pending' as const, total: 1, pending: 1, failing: [] }
    expect(prUnfinished({ state: 'open', checks: pending })).toBe(true)
    expect(prUnfinished({ state: 'merged', checks: pending })).toBe(false)
    expect(prUnfinished({ state: 'closed', checks: pending })).toBe(false)
    expect(prUnfinished({ state: 'open', checks: { status: 'passing', total: 1, pending: 0, failing: [] } })).toBe(false)
    expect(prUnfinished({ state: 'open' })).toBe(false)
  })
})

describe('scrubToken and toolLine', () => {
  it('replaces anything token-shaped before it is stored, logged or shown', () => {
    expect(scrubToken('using ghp_abcdefghijklmnopqrstuvwxyz0123456789 now')).toBe('using *** now')
    expect(scrubToken('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe('***')
    expect(scrubToken('github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz')).toBe('***')
    expect(scrubToken('nothing to hide')).toBe('nothing to hide')
  })

  it("takes the tool's own error line, drops gh's x marker and cuts the rest", () => {
    expect(toolLine('Preparing...\nerror: failed to run git: exit 1\nmore', 'x')).toBe('error: failed to run git: exit 1')
    expect(toolLine('X Request failed: 404 Not Found', 'x')).toBe('Request failed: 404 Not Found')
    expect(toolLine('just one line', 'x')).toBe('just one line')
    expect(toolLine('', 'gh exited with code 2')).toBe('gh exited with code 2')
    expect(toolLine('error: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected', 'x')).toBe('error: token *** rejected')
    expect(toolLine(`error: ${'y'.repeat(400)}`, 'x')).toHaveLength(300)
  })
})

describe('the dialog draft', () => {
  const commits = ['a1b2c3d Fix the sum', '9f8e7d6 Add a test']

  it('reads the subjects out of git log --oneline', () => {
    expect(commitSubjects(commits)).toEqual(['Fix the sum', 'Add a test'])
    expect(commitSubjects(['  '])).toEqual([])
  })

  it('titles from the card, else the one commit, else the branch', () => {
    expect(draftTitle('Make it configurable', commits, 'zumibot/coder-a1')).toBe('Make it configurable')
    expect(draftTitle(null, ['a1b2c3d Fix the sum'], 'zumibot/coder-a1')).toBe('Fix the sum')
    expect(draftTitle(null, commits, 'zumibot/coder-a1')).toBe('coder-a1')
    expect(draftTitle('x'.repeat(PR_TITLE_MAX + 20), [], 'b')).toHaveLength(PR_TITLE_MAX)
  })

  it("bodies from the card's notes and the commits, and holds nothing when there is neither", () => {
    expect(draftBody('It 500s on submit.', commits)).toBe('It 500s on submit.\n\n## Commits\n- Fix the sum\n- Add a test')
    expect(draftBody(null, commits)).toBe('## Commits\n- Fix the sum\n- Add a test')
    expect(draftBody('  ', [])).toBe('')
  })
})

describe('logTail and checkMessage', () => {
  it('keeps the end of a long log and says how much went, starting on a whole line', () => {
    expect(logTail('one\ntwo\n\n')).toBe('one\ntwo')
    const long = `${'x'.repeat(LOG_TAIL_MAX)}\nlast line`
    const tail = logTail(long)
    expect(tail.startsWith('… ')).toBe(true)
    expect(tail.endsWith('last line')).toBe(true)
    expect(tail.length).toBeLessThan(long.length)
  })

  it('names the check, links it and quotes the tail of its log', () => {
    const text = checkMessage({ number: 7 }, { name: 'unit', url: 'https://ci/9', jobId: '3' }, 'boom\nexpected 2, got 4')
    expect(text).toContain('The check **unit** is failing on pull request #7.')
    expect(text).toContain('https://ci/9')
    expect(text).toContain('```\nboom\nexpected 2, got 4\n```')
    expect(text).toContain('Please work out why it fails and fix it.')
  })

  it('says so plainly when a check has no log through gh, rather than pretending', () => {
    const text = checkMessage({ number: 7 }, { name: 'legacy', url: 'https://ci/9' }, null)
    expect(text).toContain('not available through the GitHub CLI')
    expect(text).not.toContain('```')
    expect(checkMessage({ number: 7 }, { name: 'legacy' }, '   ')).toContain('not available through the GitHub CLI')
  })

  it('scrubs a token out of a log before it becomes a message', () => {
    const text = checkMessage({ number: 7 }, { name: 'unit' }, 'auth failed for ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(text).toContain('auth failed for ***')
  })
})
