function lines(value) {
  const normalized = String(value || '').replaceAll('\r\n', '\n')
  return normalized === '' ? [] : normalized.split('\n')
}

function operations(oldLines, newLines) {
  const maximumEdits = 2_000
  const totalLines = oldLines.length + newLines.length
  if (totalLines > 100_000) throw new Error('Note diff is too large to compute safely.')
  const limit = Math.min(totalLines, maximumEdits)
  const offset = limit + 1
  const frontier = new Int32Array(2 * limit + 3)
  frontier.fill(-1)
  frontier[offset + 1] = 0
  const trace = []
  for (let edits = 0; edits <= limit; edits += 1) {
    trace.push(frontier.slice())
    for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
      const slot = offset + diagonal
      let oldIndex = diagonal === -edits
        || (diagonal !== edits && frontier[slot - 1] < frontier[slot + 1])
        ? frontier[slot + 1]
        : frontier[slot - 1] + 1
      let newIndex = oldIndex - diagonal
      while (oldIndex < oldLines.length && newIndex < newLines.length
        && oldLines[oldIndex] === newLines[newIndex]) {
        oldIndex += 1
        newIndex += 1
      }
      frontier[slot] = oldIndex
      if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
        return backtrack(trace, oldLines, newLines, edits, offset)
      }
    }
  }
  throw new Error('Note diff exceeds the comparison limit.')
}

function backtrack(trace, oldLines, newLines, edits, offset) {
  const reversed = []
  let oldIndex = oldLines.length
  let newIndex = newLines.length
  for (let depth = edits; depth >= 0; depth -= 1) {
    const frontier = trace[depth]
    const diagonal = oldIndex - newIndex
    const previousDiagonal = diagonal === -depth
      || (diagonal !== depth && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1])
      ? diagonal + 1
      : diagonal - 1
    const previousOld = frontier[offset + previousDiagonal]
    const previousNew = previousOld - previousDiagonal
    while (oldIndex > previousOld && newIndex > previousNew) {
      reversed.push({ type: ' ', text: oldLines[--oldIndex] })
      newIndex -= 1
    }
    if (depth === 0) break
    if (oldIndex === previousOld) reversed.push({ type: '+', text: newLines[--newIndex] })
    else reversed.push({ type: '-', text: oldLines[--oldIndex] })
  }
  return reversed.reverse()
}

function formatHunk(allOperations, from, to, oldPrefix, newPrefix) {
  const oldStart = oldPrefix[from]
  const newStart = newPrefix[from]
  const hunk = allOperations.slice(from, to)
  const oldCount = hunk.filter((item) => item.type !== '+').length
  const newCount = hunk.filter((item) => item.type !== '-').length
  const start = (index, count) => count === 0 ? index : index + 1
  return [
    `@@ -${start(oldStart, oldCount)},${oldCount} +${start(newStart, newCount)},${newCount} @@`,
    ...hunk.map((item) => `${item.type}${item.text}`),
  ]
}

export function unifiedDiff(current, selected, filename) {
  if (current === selected) return ''
  const oldLines = lines(current)
  const newLines = lines(selected)
  const allOperations = operations(oldLines, newLines)
  const oldPrefix = new Uint32Array(allOperations.length + 1)
  const newPrefix = new Uint32Array(allOperations.length + 1)
  for (let index = 0; index < allOperations.length; index += 1) {
    const type = allOperations[index].type
    oldPrefix[index + 1] = oldPrefix[index] + (type === '+' ? 0 : 1)
    newPrefix[index + 1] = newPrefix[index] + (type === '-' ? 0 : 1)
  }
  const changed = allOperations.flatMap((item, index) => item.type === ' ' ? [] : [index])
  const hunks = []
  for (const index of changed) {
    const from = Math.max(0, index - 3)
    const to = Math.min(allOperations.length, index + 4)
    const previous = hunks.at(-1)
    if (previous && from <= previous[1]) previous[1] = to
    else hunks.push([from, to])
  }
  return [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    ...hunks.flatMap(([from, to]) => formatHunk(allOperations, from, to, oldPrefix, newPrefix)),
  ].join('\n')
}

export function userFacingMarkdown(parsed) {
  return [
    `title: ${parsed.title || ''}`,
    `description: ${parsed.description || ''}`,
    `tags: ${(parsed.tags || []).join(', ')}`,
    `status: ${parsed.status || ''}`,
    `stale_after: ${parsed.staleAfter || ''}`,
    '',
    parsed.content || '',
  ].join('\n')
}
