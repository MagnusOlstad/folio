import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hashBlockText, protectText, renderItems, restoreText, splitBody, translatableBlocks,
} from '../server/translation/blocks.js'
import { buildTranslationMessages, parseTranslationOutput } from '../server/translation/prompt.js'

const SAMPLE = [
  '# Møtenotater',
  '',
  'Vi snakket om [[Prosjekt Alfa]] og `npm test` i dag.',
  'Se https://example.com/a?b=1 for mer.',
  '',
  '- [ ] Skriv rapport',
  '  - Nested point here',
  '1. Første punkt',
  '',
  '> Et sitat som går',
  '> over to linjer',
  '',
  '```js',
  'const hei = "ikke oversett"',
  '```',
  '',
  '| Navn | Verdi |',
  '| --- | --- |',
  '| Hei | Verden |',
  '',
  '---',
  '',
  '<div>rå html</div>',
  '',
  '![bilde](assets/x.png)',
  'Les [dokumentasjonen](https://docs.example.com/page) nå.  ',
  '',
].join('\n')

test('splitting and rendering without translations round-trips exactly', () => {
  assert.equal(renderItems(splitBody(SAMPLE)), SAMPLE)
  for (const body of ['', '\n\n', 'plain', '  indented text\n  more', '>quote\n>  spaced', '1) one\n2) two  ', '## Heading ##\n']) {
    assert.equal(renderItems(splitBody(body)), body)
  }
})

test('only prose is translatable; code, tables, rules, HTML and images are passthrough', () => {
  const blocks = translatableBlocks(splitBody(SAMPLE))
  const texts = blocks.map((block) => block.text)
  assert.ok(texts.includes('Møtenotater'))
  assert.ok(texts.includes('Skriv rapport'))
  assert.ok(texts.includes('Nested point here'))
  assert.ok(texts.includes('Første punkt'))
  assert.ok(texts.includes('Et sitat som går\nover to linjer'))
  assert.ok(!texts.some((text) => /ikke oversett|Verden|rå html/.test(text)))
  assert.ok(!blocks.some((block) => /bilde|docs\.example|Prosjekt/.test(block.protectedText)))
  const checkbox = blocks.find((block) => block.text === 'Skriv rapport')
  assert.equal(checkbox.prefix, '- [ ] ')
  assert.equal(blocks.find((block) => block.text.startsWith('Et sitat')).prefix, '> ')
})

test('translations replace only block text and keep markers, indentation and quote prefixes', () => {
  const output = renderItems(splitBody('- [x] Hei verden\n  - Barn\n\n> Linje en\n> Linje to'), (block) => `T(${block.text})`)
  assert.equal(output, '- [x] T(Hei verden)\n  - T(Barn)\n\n> T(Linje en\n> Linje to)')
})

test('hashes ignore whitespace differences and are stable', () => {
  assert.equal(hashBlockText('Hei   verden '), hashBlockText('Hei verden'))
  assert.notEqual(hashBlockText('Hei verden'), hashBlockText('Hei verden!'))
})

test('inline code, URLs, wikilinks, link targets and images are protected and restored', () => {
  const source = 'Se [[Notat|alias]] og `kode` på https://a.example/x og [lenke](https://b.example "t") ![bilde](x.png)'
  const { text, tokens } = protectText(source)
  assert.ok(!text.includes('https://') && !text.includes('`kode`') && !text.includes('[[Notat'))
  assert.match(text, /\[lenke\]\(<x\d+\/>\)/)
  assert.equal(restoreText(text, tokens), source)
  assert.equal(restoreText(text.replace(/<x1\/>/, ''), tokens), null)
  assert.equal(restoreText(`${text} <x99/>`, tokens), null)
})

test('output validation requires strict JSON and all placeholders', () => {
  const { text, tokens } = protectText('Se `kode` nå')
  const good = JSON.stringify({ source: 'no', translation: 'See <x1/> now' })
  assert.deepEqual(parseTranslationOutput(`<think>hmm</think>\n\`\`\`json\n${good}\n\`\`\``, tokens, text), { source: 'no', translation: 'See `kode` now' })
  assert.throws(() => parseTranslationOutput('not json', tokens, text))
  assert.throws(() => parseTranslationOutput('{"source":"no"}', tokens, text))
  assert.throws(() => parseTranslationOutput('{"source":"fr","translation":"x"}', tokens, text))
  assert.throws(() => parseTranslationOutput('{"source":"no","translation":"See now"}', tokens, text), /placeholder/)
  assert.deepEqual(parseTranslationOutput('{"source":"other","translation":null}', tokens, text), { source: 'other', translation: null })
  assert.equal(buildTranslationMessages('x').length, 2)
})

test('placeholder spacing is repaired in both directions only where the source had whitespace', () => {
  const source = protectText('Se også [[todo-list]] og bruk `npm run tur` for å logge.')
  assert.equal(restoreText('See also<x2/> and use<x1/> to log.', source.tokens, source.text), 'See also [[todo-list]] and use `npm run tur` to log.')
  assert.equal(restoreText('See <x2/>and <x1/>to log.', source.tokens, source.text), 'See [[todo-list]] and `npm run tur` to log.')
  const tight = protectText('**`kode`** og ([[lenke]]) [tekst](https://a.example)')
  assert.equal(tight.text, '**<x1/>** og (<x2/>) [tekst](<x3/>)')
  assert.equal(restoreText('**<x1/>** and (<x2/>) [text](<x3/>)', tight.tokens, tight.text), '**`kode`** and ([[lenke]]) [text](https://a.example)')
  assert.equal(restoreText('<x1/> and', protectText('`a` og').tokens, '<x1/> og'), '`a` and')
})
