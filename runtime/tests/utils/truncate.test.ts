import { describe, expect, test } from 'vitest'
import { stringWidth } from '../../src/tui/ink/stringWidth.js'
import {
  truncate,
  truncateMiddleToWidth,
  truncatePathMiddle,
  truncateToWidth,
} from './truncate.js'

describe('truncate utilities', () => {
  test('truncate returns empty string for undefined input', () => {
    expect(truncate(undefined, 10)).toBe('')
  })

  test('truncateToWidth returns empty string for undefined input', () => {
    expect(truncateToWidth(undefined, 5)).toBe('')
  })

  test('truncatePathMiddle returns empty string for undefined path', () => {
    expect(truncatePathMiddle(undefined, 20)).toBe('')
  })

  test.each([
    [0, ''],
    [1, '…'],
    [2, 'a…'],
    [3, 'a…f'],
    [4, 'ab…f'],
    [5, 'ab…ef'],
  ])('defines middle truncation at a %i-column budget', (maxWidth, expected) => {
    const result = truncateMiddleToWidth('abcdef', maxWidth)

    expect(result).toBe(expected)
    expect(stringWidth(result)).toBe(maxWidth)
  })

  test('returns the original string when it fits the display-width budget', () => {
    expect(truncateMiddleToWidth('界a', 3)).toBe('界a')
    expect(truncateMiddleToWidth(undefined, 3)).toBe('')
  })

  test.each([
    ['combining marks', 'e\u0301abcdefe\u0301', 5, 'e\u0301a…fe\u0301'],
    ['joined and variation emoji', '👩‍💻abcdef✈️', 7, '👩‍💻a…f✈️'],
    ['wide CJK glyphs', '界abcde界', 6, '界a…界'],
  ])(
    'keeps %s intact within the exact terminal width',
    (_name, value, maxWidth, expected) => {
      const result = truncateMiddleToWidth(value, maxWidth)

      expect(result).toBe(expected)
      expect(stringWidth(result)).toBe(maxWidth)
    },
  )

  test.each([
    ['界abcdef界', 1],
    ['界abcdef界', 2],
    ['👩‍💻abcdef✈️', 3],
    ['e\u0301abcdefe\u0301', 4],
    ['abcdef', 5],
  ])('never exceeds a %i-column budget', (value, maxWidth) => {
    expect(stringWidth(truncateMiddleToWidth(value, maxWidth))).toBeLessThanOrEqual(
      maxWidth,
    )
  })
})
