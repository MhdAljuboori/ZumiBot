import { expect, it } from 'vitest'
import { BrowserCapabilities } from '../../src/core/browser/browserCapabilities'

it('binds immutable owners and revokes without accepting another profile', () => {
  const capabilities = new BrowserCapabilities()
  const owner = { profileId: 'profile-a', chatId: 'chat-a', turnId: 'turn-a' }
  const first = capabilities.issue(owner),
    second = capabilities.issue(owner)
  owner.profileId = 'profile-b'
  expect(capabilities.resolve(first.token)).toEqual({ profileId: 'profile-a', chatId: 'chat-a', turnId: 'turn-a' })
  const resolved = capabilities.resolve(first.token)!
  resolved.chatId = 'chat-b'
  expect(capabilities.resolve(first.token)?.chatId).toBe('chat-a')
  expect(first.token).not.toBe(second.token)
  expect(capabilities.resolve('unknown')).toBeNull()
  first.revoke()
  expect(capabilities.resolve(first.token)).toBeNull()
  expect(capabilities.resolve(second.token)?.profileId).toBe('profile-a')
})
