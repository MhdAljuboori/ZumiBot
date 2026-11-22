import { describe, expect, it } from 'vitest'
import { isLoginUrl, quietStep } from '../src/main/quietStart'

describe('quietStep', () => {
  it('retries while another retry still fits the window', () => {
    expect(quietStep(1_000, 1_000)).toBe('retry')
    expect(quietStep(1_000 + 100_000, 1_000)).toBe('retry')
  })
  it('shows the window once the window would be passed', () => {
    expect(quietStep(1_000 + 115_000, 1_000)).toBe('show')
    expect(quietStep(1_000 + 500_000, 1_000)).toBe('show')
  })
})

describe('isLoginUrl', () => {
  const origin = 'https://h.example'
  it('matches /login and what is under it on the same origin', () => {
    expect(isLoginUrl('https://h.example/login?next=/', origin)).toBe(true)
    expect(isLoginUrl('https://h.example/login', origin)).toBe(true)
    expect(isLoginUrl('https://h.example/login/totp', origin)).toBe(true)
  })
  it('refuses other paths, other origins and junk', () => {
    expect(isLoginUrl('https://h.example/chat/x', origin)).toBe(false)
    expect(isLoginUrl('https://h.example/loginx', origin)).toBe(false)
    expect(isLoginUrl('https://other.example/login', origin)).toBe(false)
    expect(isLoginUrl('http://h.example/login', origin)).toBe(false)
    expect(isLoginUrl('not a url', origin)).toBe(false)
  })
})
