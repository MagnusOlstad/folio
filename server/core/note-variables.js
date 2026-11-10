// Note variables: `key:: value` definition lines and `{{key}}` references, scoped to one note.
// Resolution is a view over the stored Markdown and never rewrites it. Keep in sync with
// src/lib/note-variables.ts (both are exercised by test/fixtures/note-variable-cases.json).
const DEFINITION = /^[ \t]*([A-Za-z][A-Za-z0-9_-]{0,63})::[ \t]+(\S.*?)[ \t]*$/
const REFERENCE = /\{\{[ \t]*([A-Za-z][A-Za-z0-9_-]{0,63})[ \t]*\}\}/g
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

function splitLines(text) {
  const lines = []
  let position = 0
  for (;;) {
    const newline = text.indexOf('\n', position)
    const end = newline === -1 ? text.length : newline
    const to = end > position && text[end - 1] === '\r' ? end - 1 : end
    lines.push({ text: text.slice(position, to), from: position, to })
    if (newline === -1) return lines
    position = newline + 1
  }
}

function frontmatterEnd(lines) {
  if (!lines.length || !/^---[ \t]*$/.test(lines[0].text)) return -1
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index].text)) return index
  }
  return -1
}

function inlineCodeRanges(line) {
  const ranges = []
  const opener = /`+/g
  let match
  while ((match = opener.exec(line))) {
    const size = match[0].length
    const closer = new RegExp('(?<!`)`{' + size + '}(?!`)', 'g')
    closer.lastIndex = opener.lastIndex
    const end = closer.exec(line)
    if (!end) continue
    ranges.push([match.index, end.index + size])
    opener.lastIndex = end.index + size
  }
  return ranges
}

/** Finds definitions and references. Offsets index into the original string. */
export function scanNoteVariables(markdown) {
  const text = String(markdown)
  const definitions = []
  const references = []
  if (!text.includes('::') && !text.includes('{{')) return { definitions, references, variables: new Map() }
  const variables = new Map()
  const lines = splitLines(text)
  const frontmatter = frontmatterEnd(lines)
  let fence = null
  lines.forEach((line, index) => {
    if (index <= frontmatter) return
    const marker = fence ? null : FENCE_OPEN.exec(line.text)?.[1]
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line.text)?.[1]
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = null
      return
    }
    if (marker) {
      fence = marker
      return
    }
    const definition = DEFINITION.exec(line.text)
    if (definition) {
      const key = definition[1].toLowerCase()
      definitions.push({ key, name: definition[1], value: definition[2], line: index, from: line.from, to: line.to })
      if (!variables.has(key)) variables.set(key, definition[2])
      return
    }
    if (!line.text.includes('{{')) return
    const code = inlineCodeRanges(line.text)
    for (const match of line.text.matchAll(REFERENCE)) {
      const start = match.index
      if (code.some(([from, to]) => start < to && start + match[0].length > from)) continue
      references.push({ key: match[1].toLowerCase(), name: match[1], from: line.from + start, to: line.from + start + match[0].length })
    }
  })
  return { definitions, references, variables }
}

export function parseNoteVariables(markdown) {
  return scanNoteVariables(markdown).variables
}

export function findVariableReferences(markdown) {
  const { references, variables } = scanNoteVariables(markdown)
  return references.map((reference) => ({ ...reference, value: variables.get(reference.key) }))
}

/**
 * Substitutes defined references. `definitions: 'display'` also rewrites `key:: value` lines as
 * `key: value`; the default keeps them untouched.
 */
export function resolveNoteVariables(markdown, options = {}) {
  const text = String(markdown)
  const { definitions, references, variables } = scanNoteVariables(text)
  const edits = []
  for (const reference of references) {
    const value = variables.get(reference.key)
    if (value !== undefined) edits.push({ from: reference.from, to: reference.to, text: value })
  }
  if (options.definitions === 'display') {
    for (const definition of definitions)
      edits.push({ from: definition.from, to: definition.to, text: `${definition.name}: ${definition.value}` })
  }
  if (!edits.length) return text
  edits.sort((a, b) => a.from - b.from)
  let result = ''
  let cursor = 0
  for (const edit of edits) {
    result += text.slice(cursor, edit.from) + edit.text
    cursor = edit.to
  }
  return result + text.slice(cursor)
}

/** Resolves references and removes definition lines (for indexing and Ask context). */
export function resolveNoteVariablesForIndex(markdown) {
  const text = String(markdown)
  const { definitions } = scanNoteVariables(text)
  const resolved = resolveNoteVariables(text)
  if (!definitions.length) return resolved
  const lines = resolved.split('\n')
  const drop = new Set(definitions.map((definition) => definition.line))
  return lines.filter((_line, index) => !drop.has(index)).join('\n')
}
