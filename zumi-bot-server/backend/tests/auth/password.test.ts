import { describe, expect, it } from 'vitest'
import { PASSWORD_MIN, hashPassword, verifyPassword } from '../../src/auth/password'

describe('password', () => {
  it('round-trips', async () => {
    const h = await hashPassword('correct horse battery')
    expect(await verifyPassword('correct horse battery', h)).toBe(true)
  })

  it('wrong password is false', async () => {
    const h = await hashPassword('correct horse battery')
    expect(await verifyPassword('correct horse batterx', h)).toBe(false)
  })

  it('stored format starts with scrypt$32768$8$1$', async () => {
    expect(await hashPassword('correct horse battery')).toMatch(/^scrypt\$32768\$8\$1\$[^$]+\$[^$]+$/)
    expect(PASSWORD_MIN).toBe(16)
  })

  it('two hashes of the same password differ', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'))
  })

  it('garbage stored string is false, not a throw', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false)
    expect(await verifyPassword('x', '')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$1$2$3$a$b')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$32768$8$1$AAAA$AAAA')).toBe(false)
  })
})
