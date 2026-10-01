export function mergeAppendedContent(baseContent, incomingContent, currentContent) {
  const base = String(baseContent).trimEnd()
  const current = String(currentContent).trimEnd()
  const incoming = String(incomingContent).trimEnd()
  if (current === base) return incoming
  if (!current.startsWith(base) || !/^\r?\n/.test(current.slice(base.length))) return null
  const remoteTail = current.slice(base.length)
  if (!remoteTail.trim()) return incoming
  return `${incoming}${remoteTail}`
}

export function preservePendingCaptureMarkers(currentContent, nextContent, sources) {
  const current = String(currentContent)
  const markerComment = /<!-- folio:capture:[^>]+ -->/g
  const normalizeCheckboxState = (value) => value.replace(/\[[ xX]\]/g, '[ ]')
  const countOccurrences = (text, value) => {
    let count = 0
    let cursor = 0
    while ((cursor = text.indexOf(value, cursor)) !== -1) {
      count += 1
      cursor += value.length
    }
    return count
  }
  const normalizedCurrent = normalizeCheckboxState(current.replace(markerComment, ''))
  const pending = []
  for (const source of Array.isArray(sources) ? sources : []) {
    const captureId = String(source?.capture_id || '')
    if (!captureId || !source?.confirmation || source.confirmation.finalId) continue
    const escapedId = captureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`<!-- folio:capture:${escapedId}:start -->[\\s\\S]*?<!-- folio:capture:${escapedId}:end -->`)
    const match = pattern.exec(current)
    if (!match) continue
    const block = match[0]
    const visible = block
      .replace(`<!-- folio:capture:${captureId}:start -->`, '')
      .replace(`<!-- folio:capture:${captureId}:end -->`, '')
      .trim()
    if (!visible) continue
    const normalizedVisible = normalizeCheckboxState(visible)
    const prefix = normalizeCheckboxState(current.slice(0, match.index).replace(markerComment, ''))
    pending.push({
      captureId,
      visible,
      normalizedVisible,
      occurrence: countOccurrences(prefix, normalizedVisible),
      totalOccurrences: countOccurrences(normalizedCurrent, normalizedVisible),
      sourcePosition: match.index,
    })
  }

  pending.sort((left, right) => left.sourcePosition - right.sourcePosition)
  let result = nextContent
  for (const { captureId, visible, normalizedVisible, occurrence, totalOccurrences } of pending) {
    const normalizedResult = normalizeCheckboxState(result)
    if (countOccurrences(normalizedResult, normalizedVisible) !== totalOccurrences) return null
    let cursor = 0
    let position = -1
    for (let index = 0; index <= occurrence; index += 1) {
      position = normalizedResult.indexOf(normalizedVisible, cursor)
      if (position === -1) return null
      cursor = position + normalizedVisible.length
    }
    if (position === -1) return null
    const editedVisible = result.slice(position, position + visible.length)
    const marked = `<!-- folio:capture:${captureId}:start -->\n${editedVisible}\n<!-- folio:capture:${captureId}:end -->`
    result = `${result.slice(0, position)}${marked}${result.slice(position + visible.length)}`
  }
  return result
}

export function prepareAggregateContentForSave({ baseContent, content, parsed, indexedConceptContent }) {
  let mergedContent = mergeAppendedContent(
    baseContent,
    content,
    indexedConceptContent(parsed.content),
  )
  if (mergedContent === null) {
    return {
      status: 409,
      error: 'This aggregate note changed in another editor. Reload it before saving these changes.',
    }
  }
  mergedContent = preservePendingCaptureMarkers(parsed.content, mergedContent, parsed.frontmatter.sources)
  if (mergedContent === null) {
    return {
      status: 409,
      error: 'A capture is still awaiting filing. Finish its filing before editing or removing its content.',
    }
  }
  return { content: mergedContent }
}

export function normalizeAggregateBaseContent(value, normalizeMarkdownBreaks) {
  return typeof value === 'string' ? normalizeMarkdownBreaks(value).trim() : null
}
