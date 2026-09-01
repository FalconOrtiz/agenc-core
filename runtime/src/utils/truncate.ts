// Width-aware truncation/wrapping — needs ink/stringWidth (not leaf-safe).

import { stringWidth } from '../tui/ink/stringWidth.js'
import { getGraphemeSegmenter } from './intl.js'

/**
 * Truncates a file path in the middle to preserve both directory context and filename.
 * Width-aware: uses stringWidth() for correct CJK/emoji measurement.
 * For example: "src/components/deeply/nested/folder/MyComponent.tsx" becomes
 * "src/components/…/MyComponent.tsx" when maxLength is 30.
 *
 * @param path The file path to truncate
 * @param maxLength Maximum display width of the result in terminal columns (must be > 0)
 * @returns The truncated path, or original if it fits within maxLength
 */
export function truncatePathMiddle(path: string | undefined, maxLength: number): string {
  const safePath = path ?? ''
  // No truncation needed
  if (stringWidth(safePath) <= maxLength) {
    return safePath
  }

  // Handle edge case of very small or non-positive maxLength
  if (maxLength <= 0) {
    return '…'
  }

  // Need at least room for "…" + something meaningful
  if (maxLength < 5) {
    return truncateToWidth(safePath, maxLength)
  }

  // Find the filename (last path segment)
  const lastSlash = safePath.lastIndexOf('/')
  // Include the leading slash in filename for display
  const filename = lastSlash >= 0 ? safePath.slice(lastSlash) : safePath
  const directory = lastSlash >= 0 ? safePath.slice(0, lastSlash) : ''
  const filenameWidth = stringWidth(filename)

  // If filename alone is too long, truncate from start
  if (filenameWidth >= maxLength - 1) {
    return truncateStartToWidth(path, maxLength)
  }

  // Calculate space available for directory prefix
  // Result format: directory + "…" + filename
  const availableForDir = maxLength - 1 - filenameWidth // -1 for ellipsis

  if (availableForDir <= 0) {
    // No room for directory, just show filename (truncated if needed)
    return truncateStartToWidth(filename, maxLength)
  }

  // Truncate directory and combine
  const truncatedDir = truncateToWidthNoEllipsis(directory, availableForDir)
  return truncatedDir + '…' + filename
}

/**
 * Truncates a string to fit within a maximum display width, measured in terminal columns.
 * Splits on grapheme boundaries to avoid breaking emoji or surrogate pairs.
 * Appends '…' when truncation occurs.
 */
export function truncateToWidth(text: string | undefined, maxWidth: number): string {
  const safeText = text ?? ''
  if (stringWidth(safeText) <= maxWidth) return safeText
  if (maxWidth <= 1) return '…'
  let width = 0
  let result = ''
  for (const { segment } of getGraphemeSegmenter().segment(safeText)) {
    const segWidth = stringWidth(segment)
    if (width + segWidth > maxWidth - 1) break
    result += segment
    width += segWidth
  }
  return result + '…'
}

/**
 * Truncates the middle of a string to a terminal-column budget.
 * Keeps grapheme clusters intact and gives an unmatched column to the prefix.
 */
export function truncateMiddleToWidth(
  text: string | undefined,
  maxWidth: number,
): string {
  const safeText = text ?? ''
  const budget = maxWidth === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(maxWidth)
      ? Math.max(0, Math.trunc(maxWidth))
      : 0

  if (stringWidth(safeText) <= budget) return safeText
  if (budget <= 0) return ''

  const ellipsis = '…'
  const ellipsisWidth = stringWidth(ellipsis)
  if (ellipsisWidth > budget) return ''

  const segments = [...getGraphemeSegmenter().segment(safeText)].map(
    ({ segment }) => ({ segment, width: stringWidth(segment) }),
  )
  const remainingWidth = budget - ellipsisWidth
  const prefixBudget = Math.ceil(remainingWidth / 2)
  const suffixBudget = Math.floor(remainingWidth / 2)

  let prefixEnd = 0
  let prefixWidth = 0
  if (prefixBudget > 0) {
    while (prefixEnd < segments.length) {
      const next = segments[prefixEnd]!
      if (prefixWidth + next.width > prefixBudget) break
      prefixWidth += next.width
      prefixEnd++
    }
  }

  let suffixStart = segments.length
  let suffixWidth = 0
  if (suffixBudget > 0) {
    while (suffixStart > prefixEnd) {
      const next = segments[suffixStart - 1]!
      if (suffixWidth + next.width > suffixBudget) break
      suffixWidth += next.width
      suffixStart--
    }
  }

  const prefix = segments
    .slice(0, prefixEnd)
    .map(({ segment }) => segment)
    .join('')
  const suffix = segments
    .slice(suffixStart)
    .map(({ segment }) => segment)
    .join('')
  return `${prefix}${ellipsis}${suffix}`
}

/**
 * Truncates from the start of a string, keeping the tail end.
 * Prepends '…' when truncation occurs.
 * Width-aware and grapheme-safe.
 */
export function truncateStartToWidth(text: string | undefined, maxWidth: number): string {
  const safeText = text ?? ''
  if (stringWidth(safeText) <= maxWidth) return safeText
  if (maxWidth <= 1) return '…'
  const segments = [...getGraphemeSegmenter().segment(safeText)]
  let width = 0
  let startIdx = segments.length
  for (let i = segments.length - 1; i >= 0; i--) {
    const segWidth = stringWidth(segments[i]!.segment)
    if (width + segWidth > maxWidth - 1) break // -1 for '…'
    width += segWidth
    startIdx = i
  }
  return (
    '…' +
    segments
      .slice(startIdx)
      .map(s => s.segment)
      .join('')
  )
}

/**
 * Truncates a string to fit within a maximum display width, without appending an ellipsis.
 * Useful when the caller adds its own separator (e.g. middle-truncation with '…' between parts).
 * Width-aware and grapheme-safe.
 */
export function truncateToWidthNoEllipsis(
  text: string | undefined,
  maxWidth: number,
): string {
  const safeText = text ?? ''
  if (stringWidth(safeText) <= maxWidth) return safeText
  if (maxWidth <= 0) return ''
  let width = 0
  let result = ''
  for (const { segment } of getGraphemeSegmenter().segment(safeText)) {
    const segWidth = stringWidth(segment)
    if (width + segWidth > maxWidth) break
    result += segment
    width += segWidth
  }
  return result
}

/**
 * Truncates a string to fit within a maximum display width (terminal columns),
 * splitting on grapheme boundaries to avoid breaking emoji, CJK, or surrogate pairs.
 * Appends '…' when truncation occurs.
 * @param str The string to truncate
 * @param maxWidth Maximum display width in terminal columns
 * @param singleLine If true, also truncates at the first newline
 * @returns The truncated string with ellipsis if needed
 */

export function truncate(
  str: string | undefined,
  maxWidth: number,
  singleLine: boolean = false,
): string {
  const safeStr = str ?? ''
  if (safeStr === '') return ''
  let result = safeStr

  // If singleLine is true, truncate at first newline
  if (singleLine) {
    const firstNewline = safeStr.indexOf('\n')
    if (firstNewline !== -1) {
      result = safeStr.substring(0, firstNewline)
      // Ensure total width including ellipsis doesn't exceed maxWidth
      if (stringWidth(result) + 1 > maxWidth) {
        return truncateToWidth(result, maxWidth)
      }
      return `${result}…`
    }
  }

  if (stringWidth(result) <= maxWidth) {
    return result
  }
  return truncateToWidth(result, maxWidth)
}

export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let currentLine = ''
  let currentWidth = 0

  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segWidth = stringWidth(segment)
    if (currentWidth + segWidth <= width) {
      currentLine += segment
      currentWidth += segWidth
    } else {
      if (currentLine) lines.push(currentLine)
      currentLine = segment
      currentWidth = segWidth
    }
  }

  if (currentLine) lines.push(currentLine)
  return lines
}
