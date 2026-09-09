export function createTextHelpers() {
  function slugify(value, fallback = 'note') {
    const slug = value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
    return slug || fallback
  }

  function normalizeMarkdownBreaks(value) {
    return String(value).replace(/[ \t]*<br\s*\/?>[ \t]*(?:\r?\n)?/gi, '  \n')
  }

  function normalizeInlineText(value) {
    return normalizeMarkdownBreaks(value).replace(/\s+/g, ' ').trim()
  }

  function normalizeTag(value) {
    const normalized = normalizeInlineText(value).normalize('NFC').toLocaleLowerCase()
      .replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]+/gu, '')
      .replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
    return Array.from(normalized).slice(0, 64).join('')
  }

  function markdownText(value) {
    return normalizeInlineText(value).replaceAll('[', '').replaceAll(']', '')
  }

  function markdownLinkTarget(value) {
    return encodeURI(String(value)).replaceAll('(', '%28').replaceAll(')', '%29')
  }

  function normalizeAnswerCitations(value) {
    return value.replace(/\]\(ID:\s*(\/[^)]+)\)/gi, ']($1)')
  }

  function ensureAnswerCitations(value, matches) {
    const answer = normalizeMarkdownBreaks(normalizeAnswerCitations(value)).trim()
    if (/\]\(\/[^)]+\.md\)/.test(answer) || !matches.length) return answer
    const citations = matches.map((note) => `[${markdownText(note.title)}](${note.id})`).join(', ')
    return `${answer}\n\nSources: ${citations}`
  }

  return { slugify, normalizeTag, normalizeMarkdownBreaks, normalizeInlineText, markdownText, markdownLinkTarget,
    normalizeAnswerCitations, ensureAnswerCitations }
}
