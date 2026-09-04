export type FormatMarker = 'bold' | 'italic' | 'link'

export type FormatResult = {
  value: string
  selectionStart: number
  selectionEnd: number
}

const INLINE_WRAPPERS = {
  bold: ['**', '**'] as const,
  italic: ['*', '*'] as const,
}

export function applyFormatMarker(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  marker: FormatMarker,
): FormatResult {
  if (marker === 'link') {
    if (selectionStart === selectionEnd) {
      const insertion = '[]()'
      return {
        value: value.slice(0, selectionStart) + insertion + value.slice(selectionStart),
        selectionStart: selectionStart + 1,
        selectionEnd: selectionStart + 1,
      }
    }
    const selected = value.slice(selectionStart, selectionEnd)
    const wrapped = `[${selected}]()`
    const caret = selectionStart + 1 + selected.length + 2
    return {
      value: value.slice(0, selectionStart) + wrapped + value.slice(selectionEnd),
      selectionStart: caret,
      selectionEnd: caret,
    }
  }

  const [before, after] = INLINE_WRAPPERS[marker]
  if (selectionStart === selectionEnd) {
    return {
      value: value.slice(0, selectionStart) + before + after + value.slice(selectionStart),
      selectionStart: selectionStart + before.length,
      selectionEnd: selectionStart + before.length,
    }
  }

  const selected = value.slice(selectionStart, selectionEnd)
  const prefix = value.slice(Math.max(0, selectionStart - before.length), selectionStart)
  const suffix = value.slice(selectionEnd, Math.min(value.length, selectionEnd + after.length))
  // Require the run of marker characters to end exactly here, so italic doesn't
  // mistake the inner two characters of a "**bold**" span for its own "*" markers.
  const markerChar = before[before.length - 1]
  const prefixIsMarker = prefix === before && value[selectionStart - before.length - 1] !== markerChar
  const suffixIsMarker = suffix === after && value[selectionEnd + after.length] !== markerChar
  if (prefixIsMarker && suffixIsMarker) {
    const start = selectionStart - before.length
    return {
      value: value.slice(0, start) + selected + value.slice(selectionEnd + after.length),
      selectionStart: start,
      selectionEnd: start + selected.length,
    }
  }

  return {
    value: value.slice(0, selectionStart) + before + selected + after + value.slice(selectionEnd),
    selectionStart: selectionStart + before.length,
    selectionEnd: selectionEnd + before.length,
  }
}
