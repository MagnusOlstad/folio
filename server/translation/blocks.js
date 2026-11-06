import { createHash } from 'node:crypto'

// Pure helpers that split a Markdown note body into translatable blocks and
// reassemble it. Structure (markers, indentation, code, tables, HTML) is kept
// outside the translated text so the original layout is preserved exactly.

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const SETEXT = /^\s{0,3}=+\s*$/
const HTML_START = /^\s{0,3}<(?!https?:|mailto:)[A-Za-z/!?]/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/
const REFERENCE_DEFINITION = /^\s{0,3}\[\^?[^\]]+\]:\s/
const HEADING = /^(\s{0,3}#{1,6}\s+)(.*?)(\s+#+)?(\s*)$/
const LIST_ITEM = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)(.*)$/
const QUOTE = /^((?:\s{0,3}>[ \t]?)+)(.*)$/

export function normalizeBlockText(text) {
  return String(text).normalize('NFC').replace(/\r\n/g, '\n')
    .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').trim()
}

export function hashBlockText(text) {
  return createHash('sha256').update(normalizeBlockText(text)).digest('hex')
}

const PROTECTED_PATTERNS = [
  /(`+)[\s\S]*?\1/g, // inline code
  /!\[[^\]\n]*\]\([^)\n]*\)/g, // image references
  /\[\[[^\]\n]+\]\]/g, // wikilinks
  /\]\([^)\n]*\)/g, // link targets
  /https?:\/\/[^\s<>)\]]+/g, // bare URLs
]

export function placeholderToken(index) {
  return `<x${index}/>`
}

// Replaces protected spans with placeholder tokens: { text, tokens }.
export function protectText(text) {
  const tokens = []
  let result = String(text)
  for (const pattern of PROTECTED_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const isTarget = match.startsWith('](')
      const protectedValue = isTarget ? match.slice(2, -1) : match
      tokens.push(protectedValue)
      const token = placeholderToken(tokens.length)
      return isTarget ? `](${token})` : token
    })
  }
  return { text: result, tokens }
}

// Models often glue a placeholder to a neighbouring word. Where the source had
// whitespace next to a token and the translation has a word character (or, after
// a token, a word character) directly adjacent, insert one space.
export function repairPlaceholderSpacing(translated, protectedSource) {
  if (!protectedSource) return translated
  let result = translated
  for (const match of protectedSource.matchAll(/<x\d+\/>/g)) {
    const token = match[0]
    const spaceBefore = match.index > 0 && /\s/.test(protectedSource[match.index - 1])
    const end = match.index + token.length
    const spaceAfter = end < protectedSource.length && /\s/.test(protectedSource[end])
    if (spaceBefore) result = result.replace(new RegExp(`([\\p{L}\\p{N}.,;:!?)\\]])${token}`, 'gu'), `$1 ${token}`)
    if (spaceAfter) result = result.replace(new RegExp(`${token}([\\p{L}\\p{N}(\\[])`, 'gu'), `${token} $1`)
  }
  return result
}

// Restores placeholders. Returns null when a token is missing or unknown.
export function restoreText(translated, tokens, protectedSource = '') {
  const value = repairPlaceholderSpacing(String(translated), String(protectedSource))
  const found = value.match(/<x\d+\/>/g) || []
  for (let index = 1; index <= tokens.length; index += 1) {
    if (!value.includes(placeholderToken(index))) return null
  }
  if (found.some((token) => Number(token.slice(2, -2)) > tokens.length)) return null
  return value.replace(/<x(\d+)\/>/g, (_match, index) => tokens[Number(index) - 1])
}

function hasTranslatableLetters(protectedText) {
  return /\p{L}/u.test(protectedText.replace(/<x\d+\/>/g, ''))
}

export function createTextBlock(text, { prefix = '', suffix = '' } = {}) {
  const source = String(text)
  const normalized = source.trim()
  if (!normalized) return null
  const leading = source.match(/^\s*/)[0]
  const trailing = source.match(/\s*$/)[0]
  const protectedValue = protectText(normalized)
  if (!hasTranslatableLetters(protectedValue.text)) return null
  return {
    prefix: prefix + leading,
    text: normalized,
    suffix: trailing + suffix,
    protectedText: protectedValue.text,
    tokens: protectedValue.tokens,
    hash: hashBlockText(normalized),
  }
}

function splitIndent(line) {
  const indent = line.match(/^[ \t]*/)[0]
  return [indent, line.slice(indent.length)]
}

// Splits a body into items: { raw } passthrough lines or translatable blocks
// (see createTextBlock). Items are joined with "\n" to rebuild the body.
export function splitBody(body) {
  const lines = String(body).split('\n')
  const items = []
  let paragraph = null // { prefix, lines }
  let quote = null // { prefix, lines }

  function flushText() {
    for (const group of [paragraph, quote]) {
      if (!group) continue
      const block = createTextBlock(group.lines.join('\n'), { prefix: group.prefix })
      if (block) items.push(block)
      else items.push(...group.lines.map((line) => ({ raw: group.prefix + line })))
    }
    paragraph = null
    quote = null
  }

  function pushRaw(line) {
    flushText()
    items.push({ raw: line })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = line.match(FENCE)
    if (fence) {
      pushRaw(line)
      const marker = fence[1]
      for (index += 1; index < lines.length; index += 1) {
        items.push({ raw: lines[index] })
        const close = lines[index].match(FENCE)
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break
      }
      continue
    }
    if (!line.trim()) { pushRaw(line); continue }
    if (/^\s{0,3}<!--/.test(line)) {
      // CommonMark HTML block type 2 ends at the line containing the closing marker.
      pushRaw(line)
      let closed = line.includes('-->', line.indexOf('<!--') + 4)
      while (!closed && index + 1 < lines.length) { index += 1; items.push({ raw: lines[index] }); closed = lines[index].includes('-->') }
      continue
    }
    if (HTML_START.test(line)) {
      pushRaw(line)
      while (index + 1 < lines.length && lines[index + 1].trim()) { index += 1; items.push({ raw: lines[index] }) }
      continue
    }
    if ((line.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]) && lines[index + 1].includes('-'))) {
      pushRaw(line)
      while (index + 1 < lines.length && lines[index + 1].includes('|')) { index += 1; items.push({ raw: lines[index] }) }
      continue
    }
    if (HR.test(line) || SETEXT.test(line) || REFERENCE_DEFINITION.test(line)) { pushRaw(line); continue }

    const heading = line.match(HEADING)
    if (heading) {
      flushText()
      const block = createTextBlock(heading[2], { prefix: heading[1], suffix: `${heading[3] || ''}${heading[4] || ''}` })
      items.push(block || { raw: line })
      continue
    }
    const quoted = line.match(QUOTE)
    if (quoted) {
      const inner = quoted[2]
      const listItem = inner.match(LIST_ITEM)
      if (listItem || HEADING.test(inner) || !inner.trim()) {
        flushText()
        const listPrefix = listItem ? quoted[1] + listItem[1] : quoted[1]
        const text = listItem ? listItem[2] : inner
        const block = createTextBlock(text, { prefix: listPrefix })
        items.push(block || { raw: line })
        continue
      }
      if (paragraph) flushText()
      if (quote && quote.prefix !== quoted[1]) flushText()
      quote ||= { prefix: quoted[1], lines: [] }
      quote.lines.push(inner)
      continue
    }
    const listItem = line.match(LIST_ITEM)
    if (listItem) {
      flushText()
      const block = createTextBlock(listItem[2], { prefix: listItem[1] })
      items.push(block || { raw: line })
      continue
    }
    const [indent, rest] = splitIndent(line)
    if (quote) flushText()
    if (paragraph && paragraph.prefix !== indent) flushText()
    paragraph ||= { prefix: indent, lines: [] }
    paragraph.lines.push(rest)
  }
  flushText()
  return items
}

export function renderBlock(item, text = item.text) {
  return `${item.prefix}${String(text).replaceAll('\n', `\n${item.prefix}`)}${item.suffix}`
}

// Rebuilds the body; resolve(block) returns replacement text or null to keep the original.
export function renderItems(items, resolve = () => null) {
  return items.map((item) => {
    if (item.raw !== undefined) return item.raw
    const replacement = resolve(item)
    return replacement === null || replacement === undefined ? renderBlock(item) : renderBlock(item, replacement)
  }).join('\n')
}

export function translatableBlocks(items) {
  return items.filter((item) => item.raw === undefined)
}
