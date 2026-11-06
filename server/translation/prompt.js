import { restoreText } from './blocks.js'

export class TranslationOutputError extends Error {}

// The source is wrapped in <text> tags (less echo-prone than bare delimiters); the sanitizer below
// also removes echoed <text>, </text>, <<< and >>> that the source itself did not have.
export const wrapText = (text) => `<text>\n${text}\n</text>`

const OPENERS = ['<text>', '<<<']
const CLOSERS = ['</text>', '>>>']

// Removes delimiter echoes and wrapping quotes/backticks the model added around the translation.
export function sanitizeModelText(value, source = '') {
  const original = String(source).trim()
  let text = String(value).trim()
  for (let changed = true; changed;) {
    changed = false
    for (const [list, atStart] of [[OPENERS, true], [CLOSERS, false]]) {
      for (const delimiter of list) {
        if (atStart ? original.startsWith(delimiter) : original.endsWith(delimiter)) continue
        if (atStart && text.startsWith(delimiter)) { text = text.slice(delimiter.length).trim(); changed = true }
        if (!atStart && text.endsWith(delimiter)) { text = text.slice(0, -delimiter.length).trim(); changed = true }
      }
    }
  }
  for (const [open, close] of [['"', '"'], ['`', '`'], ['“', '”'], ['«', '»']]) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)
      && !(original.startsWith(open) && original.endsWith(close))) { text = text.slice(1, -1).trim(); break }
  }
  return text
}

export function buildTranslationMessages(protectedText) {
  return [
    {
      role: 'system',
      content: [
        'You are a precise translation engine between Norwegian and English.',
        'Detect the language of the text. If it is Norwegian (Bokmål or Nynorsk), translate it to English and set "source" to "no".',
        'If it is English, translate it to Norwegian Bokmål and set "source" to "en".',
        'If it is any other language, or has nothing to translate, set "source" to "other" and "translation" to null.',
        'Keep placeholders such as <x1/> exactly as written, once each, in a natural position.',
        'Preserve Markdown inline formatting (**bold**, *italic*, ~~strike~~), names, numbers, dates and line breaks. Add nothing and explain nothing.',
        'Reply with ONLY one JSON object and no other text: {"source":"no"|"en"|"other","translation":"..."|null}.',
      ].join('\n'),
    },
    { role: 'user', content: `Text to translate:\n${wrapText(protectedText)}` },
  ]
}

export function maxTokensFor(text) {
  return Math.min(2048, Math.max(256, Math.ceil(String(text).length * 1.2) + 128))
}

function stripReasoning(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|channel>[\s\S]*?<channel\|>/g, '')
    .trim()
}

function extractJson(text) {
  const source = stripReasoning(text)
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = (fenced || source).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate
}

// Strictly validates model output; returns { source, translation } with placeholders restored.
export function parseTranslationOutput(text, tokens, original, protectedSource = '') {
  let result
  try { result = JSON.parse(extractJson(text)) } catch { throw new TranslationOutputError('Malformed translation JSON.') }
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join() !== 'source,translation') {
    throw new TranslationOutputError('Translation JSON does not match the schema.')
  }
  const { source } = result
  const translation = typeof result.translation === 'string' ? sanitizeModelText(result.translation, protectedSource || original) : result.translation
  if (!['no', 'en', 'other'].includes(source)) throw new TranslationOutputError('Unknown source language.')
  if (source === 'other') return { source, translation: null }
  if (typeof translation !== 'string' || !translation.trim()) throw new TranslationOutputError('Missing translation.')
  if (translation.length > original.length * 6 + 200) throw new TranslationOutputError('Translation is implausibly long.')
  const restored = restoreText(translation.trim(), tokens, protectedSource)
  if (restored === null) throw new TranslationOutputError('Translation dropped a placeholder.')
  return { source, translation: restored }
}

export function sameTranslationText(left, right) {
  const normalize = (value) => String(value).normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  return normalize(left) === normalize(right)
}

// Direction-specific prompt used when detection succeeded but the text came back unchanged.
export function buildDirectTranslationMessages(source, protectedText) {
  const [from, to] = source === 'en' ? ['English', 'Norwegian Bokmål'] : ['Norwegian', 'English']
  return [
    { role: 'system', content: `You are a precise translation engine. Translate the user's ${from} text into ${to}. Keep placeholders like <x1/> exactly as written, and preserve Markdown formatting, names and numbers. Reply with only the translation, no quotes or explanation.` },
    { role: 'user', content: `Translate the following ${from} text into ${to}:\n${wrapText(protectedText)}` },
  ]
}

export function parseDirectTranslation(text, tokens, original, protectedSource) {
  const cleaned = sanitizeModelText(stripReasoning(text).replace(/^```\w*\n?|\n?```$/g, ''), protectedSource || original).trim()
  if (!cleaned || cleaned.length > original.length * 6 + 200) throw new TranslationOutputError('Invalid direct translation.')
  const restored = restoreText(cleaned, tokens, protectedSource)
  if (restored === null) throw new TranslationOutputError('Translation dropped a placeholder.')
  return restored
}

export const EXPORT_LANGUAGES = Object.freeze({
  en: 'English', no: 'Norwegian Bokmål', de: 'German', es: 'Spanish', fr: 'French', fi: 'Finnish', sv: 'Swedish', da: 'Danish',
})

export function buildLanguageMessages(language, protectedText, sourceLanguage = null) {
  const subject = sourceLanguage ? `${sourceLanguage} text` : 'text'
  return [
    { role: 'system', content: `You are a precise translation engine. Translate the following text into ${language}. If it is already in ${language}, return it unchanged. Keep placeholders like <x1/> exactly as written, preserve inline Markdown formatting, names and numbers. Reply with only the translation, no quotes or explanation.` },
    { role: 'user', content: `Translate the following ${subject} into ${language}:\n${wrapText(protectedText)}` },
  ]
}
