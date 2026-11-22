import { expect, test } from 'vitest'
import type { ChatItem, SessionCut, TurnEnd } from '@zumibot/shared/types'
import {
  droppedMembers,
  droppedTurn,
  memberStartsAfterMessage,
  memberStartsBefore,
  startAfterMessage,
  startBefore
} from '../../src/core/chat/sessionPoints'

let n = 0
const user = (): ChatItem => ({ type: 'user', id: `u${++n}`, text: 'hi', ts: n })
const asst = (agent?: string, extra: { end?: TurnEnd; cut?: SessionCut; sent?: SessionCut } = {}): ChatItem => ({
  type: 'assistant',
  id: `a${++n}`,
  text: 'yo',
  ts: n,
  ...(agent ? { agent } : {}),
  ...extra
})

test('startBefore at index 0 is a fresh start', () => {
  expect(startBefore([user(), asst()], 0)).toEqual({ sessionId: null, next: null })
})

test('startBefore with no end but an earlier user message seeds', () => {
  expect(startBefore([user(), asst(), user()], 2)).toEqual({ sessionId: null, next: { seed: true } })
})

test('startBefore with no end and no earlier user message is fresh', () => {
  const notice: ChatItem = { type: 'notice', id: 'n1', kind: 'stopped', text: 'x', ts: 1 }
  expect(startBefore([notice, user()], 1)).toEqual({ sessionId: null, next: null })
})

test('startBefore resumes at the last end before the message', () => {
  const items = [user(), asst(undefined, { end: { session: 's1', at: 'a1' } }), user()]
  expect(startBefore(items, 2)).toEqual({ sessionId: 's1', next: { at: 'a1' } })
})

test('startBefore with a user message after the last end seeds, that turn was never recorded', () => {
  const items = [user(), asst(undefined, { end: { session: 's1', at: 'a1' } }), user(), user()]
  expect(startBefore(items, 3)).toEqual({ sessionId: null, next: { seed: true } })
})

test('startBefore uses the latest end before the message, not one after it', () => {
  const items = [
    user(),
    asst(undefined, { end: { session: 's1', at: 'x1' } }),
    user(),
    asst(undefined, { end: { session: 's2', at: 'x2' } }),
    user(),
    asst(undefined, { end: { session: 's3', at: 'x3' } })
  ]
  expect(startBefore(items, 2)).toEqual({ sessionId: 's1', next: { at: 'x1' } })
  expect(startBefore(items, 4)).toEqual({ sessionId: 's2', next: { at: 'x2' } })
  expect(startBefore(items, 6)).toEqual({ sessionId: 's3', next: { at: 'x3' } })
})

test('startAfterMessage with a cut resumes at the cut', () => {
  const items = [user(), asst(undefined, { cut: { session: 's1', at: 'c1' } })]
  expect(startAfterMessage(items, 1)).toEqual({ sessionId: 's1', next: { at: 'c1' } })
})

test('startAfterMessage without a cut seeds', () => {
  expect(startAfterMessage([user(), asst()], 1)).toEqual({ sessionId: null, next: { seed: true } })
})

test('memberStartsBefore resumes each member at its own last end and keeps seen', () => {
  const items = [
    user(),
    asst('ann', { end: { session: 'sa', at: 'ea', agent: 'ann', seen: 'm1' } }),
    asst('bob', { end: { session: 'sb', at: 'eb', agent: 'bob' } }),
    user()
  ]
  expect(memberStartsBefore(items, 3, ['ann', 'bob'])).toEqual({
    ann: { sessionId: 'sa', next: { at: 'ea' }, seen: 'm1' },
    bob: { sessionId: 'sb', next: { at: 'eb' }, seen: null }
  })
})

test('memberStartsBefore ignores ends of other members', () => {
  const items = [user(), asst('bob', { end: { session: 'sb', at: 'eb', agent: 'bob' } }), user()]
  expect(memberStartsBefore(items, 2, ['ann'])).toEqual({ ann: { sessionId: null, next: null, seen: null } })
})

test('memberStartsBefore seeds a member that spoke but has no end', () => {
  const items = [user(), asst('ann'), user()]
  expect(memberStartsBefore(items, 2, ['ann'])).toEqual({ ann: { sessionId: null, next: { seed: true }, seen: null } })
})

test('members missing from the items are fresh', () => {
  expect(memberStartsBefore([user()], 1, ['ann', 'bob'])).toEqual({
    ann: { sessionId: null, next: null, seen: null },
    bob: { sessionId: null, next: null, seen: null }
  })
})

test('memberStartsBefore uses the latest end before the index', () => {
  const items = [
    user(),
    asst('ann', { end: { session: 's1', at: 'e1', agent: 'ann', seen: 'p' } }),
    user(),
    asst('ann', { end: { session: 's2', at: 'e2', agent: 'ann', seen: 'q' } })
  ]
  expect(memberStartsBefore(items, 2, ['ann']).ann).toEqual({ sessionId: 's1', next: { at: 'e1' }, seen: 'p' })
})

test('memberStartsAfterMessage with a cut resumes the author at the cut, seen from the first end at or after', () => {
  const items = [
    user(),
    asst('ann', { cut: { session: 'sa', at: 'c1' } }),
    asst('ann', { end: { session: 'sa2', at: 'e9', agent: 'ann', seen: 'm7' } })
  ]
  expect(memberStartsAfterMessage(items, 1, ['ann'])).toEqual({
    ann: { sessionId: 'sa', next: { at: 'c1' }, seen: 'm7' }
  })
})

test('memberStartsAfterMessage with a cut but no later end has seen null', () => {
  const items = [user(), asst('ann', { cut: { session: 'sa', at: 'c1' } })]
  expect(memberStartsAfterMessage(items, 1, ['ann']).ann).toEqual({ sessionId: 'sa', next: { at: 'c1' }, seen: null })
})

test('memberStartsAfterMessage without a cut seeds the author', () => {
  const items = [user(), asst('ann')]
  expect(memberStartsAfterMessage(items, 1, ['ann']).ann).toEqual({ sessionId: null, next: { seed: true }, seen: null })
})

test('memberStartsAfterMessage treats other members as memberStartsBefore at i + 1', () => {
  const items = [
    user(),
    asst('bob', { end: { session: 'sb', at: 'eb', agent: 'bob', seen: 'z' } }),
    asst('ann', { cut: { session: 'sa', at: 'c1' } }),
    asst('bob', { end: { session: 'sb2', at: 'eb2', agent: 'bob' } })
  ]
  const r = memberStartsAfterMessage(items, 2, ['ann', 'bob', 'cy'])
  expect(r.bob).toEqual({ sessionId: 'sb', next: { at: 'eb' }, seen: 'z' })
  expect(r.cy).toEqual({ sessionId: null, next: null, seen: null })
})

test('startBefore carries the engine of the stamp it resumes at', () => {
  const items = [user(), asst(undefined, { end: { session: 'th1', at: 'turn1', engine: 'codex' } }), user()]
  expect(startBefore(items, 2)).toEqual({ sessionId: 'th1', next: { at: 'turn1' }, engine: 'codex' })
})

test('a Claude stamp gives a start point with no engine key at all', () => {
  const items = [user(), asst(undefined, { end: { session: 's1', at: 'a1' } }), user()]
  expect(Object.keys(startBefore(items, 2))).toEqual(['sessionId', 'next'])
  expect(Object.keys(startAfterMessage([user(), asst(undefined, { cut: { session: 's1', at: 'c1' } })], 1))).toEqual(['sessionId', 'next'])
})

test('startAfterMessage carries the engine of the cut', () => {
  const items = [user(), asst(undefined, { cut: { session: 'th1', at: 'turn1', engine: 'codex' } })]
  expect(startAfterMessage(items, 1)).toEqual({ sessionId: 'th1', next: { at: 'turn1' }, engine: 'codex' })
})

test('a Codex reply that ends its turn forks at its end stamp; a mid-turn one, or a Claude end with no cut, still seeds', () => {
  // As a Codex turn writes them: no cut on any reply, the turn's end on its last item.
  const items = [user(), asst(undefined, {}), asst(undefined, { end: { session: 'th1', at: 'turn1', engine: 'codex' } })]
  expect(startAfterMessage(items, 2)).toEqual({ sessionId: 'th1', next: { at: 'turn1' }, engine: 'codex' })
  expect(startAfterMessage(items, 1)).toEqual({ sessionId: null, next: { seed: true } })
  const claude = [user(), asst(undefined, { end: { session: 's1', at: 'a1' } })]
  expect(startAfterMessage(claude, 1)).toEqual({ sessionId: null, next: { seed: true } })
})

test('an AG-UI end stamp is no cut point: a fork after its reply seeds, an Edit before the next message carries its mark', () => {
  const items = [user(), asst(undefined, { end: { session: 'th1', at: 'run1', engine: 'ag-ui' } }), user()]
  expect(startAfterMessage(items, 1)).toEqual({ sessionId: null, next: { seed: true } })
  // The point still names the thread and its engine; without `rewind` the turn reseeds from it (agentTurn).
  expect(startBefore(items, 2)).toEqual({ sessionId: 'th1', next: { at: 'run1' }, engine: 'ag-ui' })
})

test('a seed or a fresh start carries no engine', () => {
  expect(startBefore([user(), asst(), user()], 2)).toEqual({ sessionId: null, next: { seed: true } })
  expect(startAfterMessage([user(), asst()], 1)).toEqual({ sessionId: null, next: { seed: true } })
})

test('member points carry the engine of the stamp too, and none for a Claude one', () => {
  const items = [
    user(),
    asst('ann', { end: { session: 'sa', at: 'ea', agent: 'ann', engine: 'codex' } }),
    asst('bob', { end: { session: 'sb', at: 'eb', agent: 'bob' } }),
    asst('cy', { cut: { session: 'sc', at: 'cc', engine: 'codex' } })
  ]
  const r = memberStartsBefore(items, 3, ['ann', 'bob'])
  expect(r.ann).toEqual({ sessionId: 'sa', next: { at: 'ea' }, seen: null, engine: 'codex' })
  expect(Object.keys(r.bob)).toEqual(['sessionId', 'next', 'seen'])
  expect(memberStartsAfterMessage(items, 3, ['cy']).cy).toEqual({ sessionId: 'sc', next: { at: 'cc' }, seen: null, engine: 'codex' })
})

test("a Codex member's reply that ends its turn forks that member at its end stamp; a mid-turn one, or another member's end, still seeds", () => {
  // As a room's Codex turn writes them: no cut on any reply, the member's end (with what it had seen) on its turn's last item.
  const items = [
    user(),
    asst('cx', {}),
    asst('cx', { end: { session: 'th1', at: 'turn1', agent: 'cx', seen: 'u1', engine: 'codex' } }),
    asst('ann', { end: { session: 'sa', at: 'ea', agent: 'ann', seen: 'u1' } })
  ]
  expect(memberStartsAfterMessage(items, 2, ['cx', 'ann']).cx).toEqual({
    sessionId: 'th1',
    next: { at: 'turn1' },
    seen: 'u1',
    engine: 'codex'
  })
  expect(memberStartsAfterMessage(items, 1, ['cx']).cx).toEqual({ sessionId: null, next: { seed: true }, seen: null })
  // A Claude member's reply with an end but no cut seeds, as before.
  expect(memberStartsAfterMessage(items, 3, ['ann']).ann).toEqual({ sessionId: null, next: { seed: true }, seen: null })
  // An end of another member on a reply never stands in for its author's cut.
  const odd = [user(), asst('cx', { end: { session: 'sa', at: 'ea', agent: 'ann', engine: 'codex' } })]
  expect(memberStartsAfterMessage(odd, 1, ['cx', 'ann']).cx).toEqual({ sessionId: null, next: { seed: true }, seen: null })
})

// --resume-drops-turn: a cut declares the turn it discards, but only when that turn is the only one it discards. The CLI
// validates the whole discarded range against the one declared turn and refuses a range holding anything else.
test('startBefore declares the turn the caller hands it, for a cut of the same session', () => {
  const items = [user(), asst(undefined, { end: { session: 's1', at: 'a1' } }), user()]
  expect(startBefore(items, 2, { session: 's1', at: 'p2' })).toEqual({ sessionId: 's1', next: { at: 'a1', drops: 'p2' } })
})

test('startBefore declares nothing for a stamp of another session, of Codex, or none at all', () => {
  const items = [user(), asst(undefined, { end: { session: 's1', at: 'a1' } }), user()]
  expect(startBefore(items, 2, { session: 'other', at: 'p2' })).toEqual({ sessionId: 's1', next: { at: 'a1' } })
  expect(startBefore(items, 2, { session: 's1', at: 'p2', engine: 'codex' })).toEqual({ sessionId: 's1', next: { at: 'a1' } })
  expect(startBefore(items, 2)).toEqual({ sessionId: 's1', next: { at: 'a1' } })
})

test("startAfterMessage declares nothing: a cut inside a turn never starts with that turn's prompt", () => {
  const items = [user(), asst(undefined, { cut: { session: 's1', at: 'a1' }, sent: { session: 's1', at: 'p1' } }), asst()]
  expect(startAfterMessage(items, 1)).toEqual({ sessionId: 's1', next: { at: 'a1' } })
})

test('droppedTurn reads the stamp off the turn that answered the message', () => {
  const u = user()
  const items = [u, asst(undefined, { end: { session: 's1', at: 'a1' }, sent: { session: 's1', at: 'p1' } })]
  expect(droppedTurn(items, u.id)).toEqual({ session: 's1', at: 'p1' })
})

test('droppedTurn gives nothing when a later turn would be discarded too', () => {
  const first = user()
  const items = [
    first,
    asst(undefined, { end: { session: 's1', at: 'a1' }, sent: { session: 's1', at: 'p1' } }),
    user(),
    asst(undefined, { end: { session: 's1', at: 'a2' }, sent: { session: 's1', at: 'p2' } })
  ]
  expect(droppedTurn(items, first.id)).toBeUndefined()
})

test('droppedTurn gives nothing without a stamp, for a Codex one, for no end, or for an unknown message', () => {
  const u1 = user()
  expect(droppedTurn([u1, asst(undefined, { end: { session: 's1', at: 'a1' } })], u1.id)).toBeUndefined()
  const u2 = user()
  expect(
    droppedTurn([u2, asst(undefined, { end: { session: 's1', at: 'a1' }, sent: { session: 's1', at: 'p1', engine: 'codex' } })], u2.id)
  ).toBeUndefined()
  const u3 = user()
  expect(droppedTurn([u3, asst()], u3.id)).toBeUndefined()
  expect(droppedTurn([u1], 'nope')).toBeUndefined()
})

// Rooms: each member's turns are stamped on its own items, so one member can declare while another cannot.
test('droppedMembers declares the member whose session loses exactly one turn', () => {
  const items = [
    user(),
    asst('m1', { end: { session: 'm1-s', at: 'e0', agent: 'm1' }, sent: { session: 'm1-s', at: 'm1-p0' } }),
    asst('m2', { end: { session: 'm2-s', at: 'f0', agent: 'm2' }, sent: { session: 'm2-s', at: 'm2-p0' } }),
    user(),
    asst('m1', { end: { session: 'm1-s', at: 'e1', agent: 'm1' }, sent: { session: 'm1-s', at: 'm1-p1' } }),
    // m2 spoke twice for this message (a hop), so its range holds two of its turns.
    asst('m2', { end: { session: 'm2-s', at: 'f1', agent: 'm2' }, sent: { session: 'm2-s', at: 'm2-p1' } }),
    asst('m2', { end: { session: 'm2-s', at: 'f2', agent: 'm2' }, sent: { session: 'm2-s', at: 'm2-p2' } })
  ]
  expect(droppedMembers(items, 3, ['m1', 'm2'])).toEqual({ m1: { session: 'm1-s', at: 'm1-p1' } })
})

test('droppedMembers declares nothing for a member with no point, nothing discarded, or unended work after its turn', () => {
  const kept = asst('m1', { end: { session: 'm1-s', at: 'e0', agent: 'm1' }, sent: { session: 'm1-s', at: 'm1-p0' } })
  // No end of its own before the rewind: the point seeds, so there is nothing to declare.
  expect(droppedMembers([user(), kept, user()], 0, ['m1'])).toEqual({})
  // Nothing of this member's after the kept turn.
  expect(droppedMembers([user(), kept, user()], 2, ['m1'])).toEqual({})
  const items = [
    user(),
    kept,
    user(),
    asst('m1', { end: { session: 'm1-s', at: 'e1', agent: 'm1' }, sent: { session: 'm1-s', at: 'm1-p1' } }),
    asst('m1') // work it never ended, which the discarded range would hold too
  ]
  expect(droppedMembers(items, 2, ['m1'])).toEqual({})
})

test("memberStartsBefore carries each declaration it is given, for a cut of that member's own session", () => {
  const items = [user(), asst('m1', { end: { session: 'm1-s', at: 'e1', agent: 'm1' } }), user()]
  expect(memberStartsBefore(items, 2, ['m1'], { m1: { session: 'm1-s', at: 'p1' } })).toEqual({
    m1: { sessionId: 'm1-s', next: { at: 'e1', drops: 'p1' }, seen: null }
  })
  // A stamp from another of that member's sessions declares nothing.
  expect(memberStartsBefore(items, 2, ['m1'], { m1: { session: 'other', at: 'p1' } })).toEqual({
    m1: { sessionId: 'm1-s', next: { at: 'e1' }, seen: null }
  })
})
