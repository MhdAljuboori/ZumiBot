import { describe, expect, it } from 'vitest'
import { loadoutFetches } from '../src/state/loadoutFetch'

describe('loadoutFetches', () => {
  it('shows an answer when nothing newer has been shown', () => {
    const f = loadoutFetches()
    const a = f.start()
    expect(f.busy()).toBe(true)
    expect(f.land(a)).toBe(true)
    expect(f.busy()).toBe(false)
  })

  it('drops an older answer that lands after a newer one was shown', () => {
    const f = loadoutFetches()
    const a = f.start()
    const b = f.start()
    expect(f.land(b)).toBe(true)
    expect(f.land(a)).toBe(false)
    expect(f.busy()).toBe(false)
  })

  it('still shows an older answer that lands first, then the newer one', () => {
    const f = loadoutFetches()
    const a = f.start()
    const b = f.start()
    expect(f.land(a)).toBe(true)
    expect(f.busy()).toBe(true)
    expect(f.land(b)).toBe(true)
    expect(f.busy()).toBe(false)
  })

  it('never lands the same request twice', () => {
    const f = loadoutFetches()
    const a = f.start()
    expect(f.land(a)).toBe(true)
    expect(f.land(a)).toBe(false)
  })

  it('reports a failure only while its request is the latest one started', () => {
    const f = loadoutFetches()
    const a = f.start()
    const b = f.start()
    // An older request failing says nothing about what the newer one will show.
    expect(f.fail(a)).toBe(false)
    expect(f.fail(b)).toBe(true)
    expect(f.busy()).toBe(false)
  })

  it('ignores the failure of a request whose newer one already landed', () => {
    const f = loadoutFetches()
    const a = f.start()
    const b = f.start()
    expect(f.land(b)).toBe(true)
    expect(f.fail(a)).toBe(false)
  })

  it('drops every answer still out after reset (another folder, an unmount)', () => {
    const f = loadoutFetches()
    const a = f.start()
    f.reset()
    expect(f.busy()).toBe(false)
    expect(f.land(a)).toBe(false)
    expect(f.fail(a)).toBe(false)
    const b = f.start()
    expect(f.land(b)).toBe(true)
  })

  it('gives a failure after a landed answer of its own request no effect', () => {
    const f = loadoutFetches()
    const a = f.start()
    expect(f.land(a)).toBe(true)
    expect(f.fail(a)).toBe(false)
  })

  describe('settle', () => {
    it('shows a lone answer and stops loading', () => {
      const f = loadoutFetches()
      const a = f.start()
      expect(f.settle(a, 'land')).toEqual({ show: true, loading: false })
    })

    it('keeps loading while an older request is out after a newer one landed, then stops when the older one lands dropped', () => {
      const f = loadoutFetches()
      const a = f.start()
      const b = f.start()
      expect(f.settle(b, 'land')).toEqual({ show: true, loading: true })
      // The dropped older answer must still clear the flag.
      expect(f.settle(a, 'land')).toEqual({ show: false, loading: false })
    })

    it('stops loading when the older request fails after the newer one landed', () => {
      const f = loadoutFetches()
      const a = f.start()
      const b = f.start()
      expect(f.settle(b, 'land')).toEqual({ show: true, loading: true })
      expect(f.settle(a, 'fail')).toEqual({ show: false, loading: false })
    })

    it('shows an error only for the latest request and keeps loading while another is out', () => {
      const f = loadoutFetches()
      const a = f.start()
      const b = f.start()
      expect(f.settle(a, 'fail')).toEqual({ show: false, loading: true })
      expect(f.settle(b, 'fail')).toEqual({ show: true, loading: false })
    })

    it('after reset (unmount, another folder) a late answer neither shows nor loads', () => {
      const f = loadoutFetches()
      const a = f.start()
      f.reset()
      expect(f.settle(a, 'land')).toEqual({ show: false, loading: false })
      const b = f.start()
      f.reset()
      const c = f.start()
      expect(f.settle(b, 'fail')).toEqual({ show: false, loading: true })
      expect(f.settle(c, 'land')).toEqual({ show: true, loading: false })
    })
  })
})
