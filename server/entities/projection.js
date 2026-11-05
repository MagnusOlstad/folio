import { contentHash } from './model.js'

export const PROJECTION_VERSION = 1

/** Keeps a stable raw-Markdown coordinate space. Block locators are 1-based line IDs. */
export function projectMarkdown(content) {
  const raw = String(content ?? '')
  const lines = raw.split('\n')
  const blocks = []
  const projectedToRaw = []
  const kept = []
  let offset = 0
  let projectedOffset = 0
  let frontmatter = lines[0]?.trim() === '---'
  let generatedRelated = false
  let activeCaptureId = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (index === 0 && frontmatter) { offset += line.length + 1; continue }
    if (frontmatter) {
      const close = line.trim() === '---' || line.trim() === '...'
      offset += line.length + 1
      if (close) frontmatter = false
      continue
    }
    if (line.includes('<!-- folio:generated-related:start -->')) generatedRelated = true
    if (line.includes('<!-- folio:generated-related:end -->')) { generatedRelated = false; offset += line.length + 1; continue }
    const captureStart = line.match(/^\s*<!-- folio:capture:(.+):start -->\s*$/u)
    const captureEnd = line.match(/^\s*<!-- folio:capture:(.+):end -->\s*$/u)
    if (captureStart) { activeCaptureId = captureStart[1]; offset += line.length + 1; continue }
    if (captureEnd) { activeCaptureId = null; offset += line.length + 1; continue }
    if (!generatedRelated) {
      const start = projectedOffset
      kept.push(line)
      projectedOffset += line.length
      for (let position = 0; position < line.length; position += 1) projectedToRaw.push(offset + position)
      if (line.trim()) blocks.push({ id: activeCaptureId ? `capture-${activeCaptureId}-line-${index + 1}` : `line-${index + 1}`, startUtf16: start, endUtf16: start + line.length, rawStartUtf16: offset })
      if (index < lines.length - 1) { kept.push('\n'); projectedToRaw.push(offset + line.length); projectedOffset += 1 }
    }
    offset += line.length + (index < lines.length - 1 ? 1 : 0)
  }
  const text = kept.join('')
  return { version: PROJECTION_VERSION, text, rawText: raw, contentHash: contentHash(raw), projectionHash: contentHash(text), projectedToRaw, blocks }
}

export function mapProjectedSpan(projection, startUtf16, endUtf16) {
  if (!projection || projection.version !== PROJECTION_VERSION || !Number.isInteger(startUtf16) || !Number.isInteger(endUtf16)
    || startUtf16 < 0 || endUtf16 <= startUtf16 || endUtf16 > projection.text.length) return null
  const text = projection.text.slice(startUtf16, endUtf16)
  if (!text) return null
  const block = projection.blocks.find((candidate) => startUtf16 >= candidate.startUtf16 && endUtf16 <= candidate.endUtf16)
  const rawStartUtf16 = projection.projectedToRaw[startUtf16]
  const rawEndUtf16 = projection.projectedToRaw[endUtf16 - 1] + 1
  if (projection.rawText.slice(rawStartUtf16, rawEndUtf16) !== text) return null
  return { startUtf16, endUtf16, rawStartUtf16, rawEndUtf16,
    displayStartUtf16: rawStartUtf16, displayEndUtf16: rawEndUtf16, text, blockId: block?.id ?? null }
}
