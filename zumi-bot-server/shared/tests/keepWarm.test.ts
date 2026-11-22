import { expect, test } from 'vitest'
import { KEEP_WARM_DEFAULT, keepWarmOf } from '../src/keepWarm'

test('keepWarmOf keeps offered hours and falls back to the default per field', () => {
  expect(keepWarmOf(undefined)).toEqual(KEEP_WARM_DEFAULT)
  expect(KEEP_WARM_DEFAULT).toEqual({ roomHours: 12, chatHours: 2 })
  expect(keepWarmOf({ roomHours: 4, chatHours: 0 })).toEqual({ roomHours: 4, chatHours: 0 })
  expect(keepWarmOf({ roomHours: 5, chatHours: 'x' })).toEqual(KEEP_WARM_DEFAULT)
  expect(keepWarmOf({ roomHours: 0 })).toEqual({ roomHours: 0, chatHours: 2 })
})
