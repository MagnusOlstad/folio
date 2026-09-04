import assert from 'node:assert/strict'
import test from 'node:test'

import { applyFormatMarker } from '../src/markdown-format.ts'

test('wraps a selected range in bold markers', () => {
  const result = applyFormatMarker('hello world', 0, 5, 'bold')
  assert.equal(result.value, '**hello** world')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [2, 7])
})

test('wraps a selected range in italic markers', () => {
  const result = applyFormatMarker('hello world', 0, 5, 'italic')
  assert.equal(result.value, '*hello* world')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [1, 6])
})

test('inserts an empty bold pair with the caret inside at an empty selection', () => {
  const result = applyFormatMarker('hello world', 5, 5, 'bold')
  assert.equal(result.value, 'hello**** world')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [7, 7])
})

test('removes bold markers when the selection is already wrapped', () => {
  const result = applyFormatMarker('**hello** world', 2, 7, 'bold')
  assert.equal(result.value, 'hello world')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [0, 5])
})

test('removes italic markers when the selection is already wrapped', () => {
  const result = applyFormatMarker('*hello* world', 1, 6, 'italic')
  assert.equal(result.value, 'hello world')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [0, 5])
})

test('still wraps when only one marker side is present', () => {
  const result = applyFormatMarker('**hello world', 2, 7, 'bold')
  assert.equal(result.value, '****hello** world')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [4, 9])
})

test('unwraps the shared marker characters of an outer bold span when toggling italic', () => {
  const result = applyFormatMarker('**bold** rest', 2, 6, 'italic')
  assert.equal(result.value, '*bold* rest')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [1, 5])
})

test('wraps a selected range as a markdown link with the caret at the url', () => {
  const result = applyFormatMarker('hello world', 0, 5, 'link')
  assert.equal(result.value, '[hello]() world')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [8, 8])
})

test('inserts empty link syntax with the caret inside the brackets at an empty selection', () => {
  const result = applyFormatMarker('hello world', 5, 5, 'link')
  assert.equal(result.value, 'hello[]() world')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [6, 6])
})

test('wraps selections that span line breaks', () => {
  const result = applyFormatMarker('one\ntwo', 0, 7, 'bold')
  assert.equal(result.value, '**one\ntwo**')
  assert.deepEqual([result.selectionStart, result.selectionEnd], [2, 9])
})
