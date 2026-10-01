#!/usr/bin/env node

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRuntime } from '../server/app.js'
import { createFilingEvaluationRecords, filingEvaluationCases } from '../test/fixtures/filing-evaluation-cases.js'

const requiredModels = ['gemma4', 'embeddinggemma']
const fixedNow = new Date('2026-10-01T12:00:00.000Z')
const requestedCase = argumentValue('--case')
const jsonOutput = process.argv.includes('--json')

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1] || null
}

function normalizedPath(value) {
  return Array.isArray(value) ? value.map((part) => String(part).toLocaleLowerCase()) : []
}

function pathMatches(actual, expected) {
  const left = normalizedPath(actual)
  const right = normalizedPath(expected)
  return left.length === right.length && left.every((part, index) => part === right[index])
}

function metadataText(concept) {
  return [concept.title, concept.type, concept.description, ...concept.tags].join(' ').toLocaleLowerCase()
}

function runCheck(check, concept, context) {
  switch (check.type) {
    case 'record-title-and-path': {
      const expected = context.records.find((record) => record.id === check.recordId)
      return {
        label: `reuses ${check.recordId}`,
        passed: Boolean(expected && concept.title === expected.title
          && pathMatches(concept.path, expected.id.split('/').slice(1, -1))),
        actual: { title: concept.title, path: concept.path },
      }
    }
    case 'path-equals':
      return { label: `path is ${check.path.join('/')}`, passed: pathMatches(concept.path, check.path), actual: concept.path }
    case 'path-not-equals':
      return { label: `path is not ${check.path.join('/')}`, passed: !pathMatches(concept.path, check.path), actual: concept.path }
    case 'path-includes':
      return {
        label: `path includes ${check.segment}`,
        passed: normalizedPath(concept.path).includes(check.segment.toLocaleLowerCase()),
        actual: concept.path,
      }
    case 'tag-includes':
      return {
        label: `tag includes ${check.tag}`,
        passed: concept.tags.map((tag) => tag.toLocaleLowerCase()).includes(check.tag.toLocaleLowerCase()),
        actual: concept.tags,
      }
    case 'heading-title':
      return {
        label: `title follows heading “${check.heading}”`,
        passed: concept.title.trim().toLocaleLowerCase() === check.heading.toLocaleLowerCase(),
        actual: concept.title,
      }
    case 'title-max-words': {
      const count = concept.title.trim().split(/\s+/).filter(Boolean).length
      return { label: `title has at most ${check.maxWords} words`, passed: count <= check.maxWords, actual: concept.title }
    }
    case 'metadata-includes':
      return {
        label: `metadata includes “${check.text}”`,
        passed: metadataText(concept).includes(check.text.toLocaleLowerCase()),
        actual: { title: concept.title, description: concept.description },
      }
    case 'metadata-one-of':
      return {
        label: `metadata includes one of: ${check.texts.join(', ')}`,
        passed: check.texts.some((text) => metadataText(concept).includes(text.toLocaleLowerCase())),
        actual: { title: concept.title, description: concept.description },
      }
    case 'related-link': {
      const expected = context.records.find((record) => record.id === check.recordId)
      const expectedLink = expected ? `[${expected.title}](${expected.id})` : null
      const present = Boolean(expectedLink && context.relatedSection.includes(expectedLink))
      return {
        label: check.present === false
          ? `does not link ${check.recordId}`
          : `generated related section links ${check.recordId}`,
        passed: check.present === false ? !present : present,
        actual: { expectedLinkPresent: present, relatedSection: context.relatedSection },
      }
    }
    default:
      throw new Error(`Unknown evaluation check type: ${check.type}`)
  }
}

function assertMetadataOnly(result) {
  const allowedTopLevel = ['concept']
  const allowedConcept = ['description', 'kind', 'path', 'tags', 'title', 'type']
  return Object.keys(result).length === 1
    && Object.keys(result).every((key) => allowedTopLevel.includes(key))
    && Object.keys(result.concept).length === allowedConcept.length
    && Object.keys(result.concept).every((key) => allowedConcept.includes(key))
}

function relationshipSimilarityDiagnostics(runtime, records, expectedId, queryEmbedding, noteEmbedding) {
  const scored = records.flatMap((record) => {
    if (!record.embedding) return []
    const chunkScores = (record.chunks || [])
      .filter((chunk) => chunk.embedding)
      .map((chunk) => runtime.cosineSimilarity(queryEmbedding, chunk.embedding))
    return [{
      id: record.id,
      title: record.title,
      noteDocumentCosine: runtime.cosineSimilarity(noteEmbedding, record.embedding),
      queryDocumentCosine: runtime.cosineSimilarity(queryEmbedding, record.embedding),
      queryBestChunkCosine: chunkScores.length ? Math.max(...chunkScores) : null,
    }]
  })
  return {
    expected: scored.find((item) => item.id === expectedId) || null,
    nearestUnrelated: scored
      .filter((item) => item.id !== expectedId)
      .sort((left, right) => right.noteDocumentCosine - left.noteDocumentCosine)
      .slice(0, 3),
  }
}

function printHuman(report) {
  for (const result of report.cases) {
    const marker = result.passed ? 'PASS' : 'FAIL'
    console.log(`${marker} ${result.id}: ${result.output.title} → ${result.output.path.join('/')}`)
    for (const check of result.checks.filter((item) => !item.passed)) {
      console.log(`  - ${check.label}; got ${JSON.stringify(check.actual)}`)
    }
  }
  console.log(`\n${report.summary.passed}/${report.summary.selected} selected cases passed; ${report.summary.checksPassed}/${report.summary.checksTotal} checks passed.`)
  if (report.summary.total !== report.summary.selected) console.log(`${report.summary.total} cases are available in the fixture.`)
}

async function main() {
  if (!process.env.FOLIO_MODEL_ROOT) {
    throw new Error('Set FOLIO_MODEL_ROOT to the directory containing the pinned Gemma 4 and EmbeddingGemma snapshots.')
  }
  const selectedCases = requestedCase
    ? filingEvaluationCases.filter((item) => item.id === requestedCase)
    : filingEvaluationCases
  if (!selectedCases.length) {
    throw new Error(`No filing evaluation case named “${requestedCase}”. Available: ${filingEvaluationCases.map((item) => item.id).join(', ')}`)
  }

  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-filing-evaluation-'))
  const runtime = createRuntime({ ...process.env, FOLIO_DATA_ROOT: scratchRoot })
  try {
    const status = await runtime.mlxService.status()
    const missing = requiredModels.filter((id) => !status.models.find((model) => model.id === id)?.installed)
    if (missing.length) {
      throw new Error(`Required pinned local model${missing.length === 1 ? '' : 's'} not installed under ${process.env.FOLIO_MODEL_ROOT}: ${missing.join(', ')}. This harness never downloads models.`)
    }
    if (!status.available || !status.helperAvailable) {
      throw new Error('The native MLX helper is unavailable. Run this evaluator on supported Apple Silicon macOS with the Folio MLX helper built.')
    }

    for (const model of requiredModels) await runtime.mlxService.load(model)
    const records = await createFilingEvaluationRecords((title, text) => runtime.embedDocument(title, text))
    const caseResults = []
    for (const [caseIndex, evaluationCase] of selectedCases.entries()) {
      console.error(`[${caseIndex + 1}/${selectedCases.length}] evaluating ${evaluationCase.id}`)
      const sourceContent = evaluationCase.content
      const classification = await runtime.classify(sourceContent, records, {
        steering: evaluationCase.steering || '',
        now: evaluationCase.now ? new Date(evaluationCase.now) : fixedNow,
        timeZone: evaluationCase.timeZone || 'UTC',
      })
      const effective = runtime.normalizeClassification(
        classification,
        sourceContent,
        records,
        true,
        evaluationCase.steering || '',
      )
      const conceptContent = runtime.normalizeMarkdownBreaks(sourceContent)
      let relatedSection = ''
      let relationshipDiagnostics = null
      if (evaluationCase.checks.some((check) => check.type === 'related-link')) {
        const noteEmbedding = await runtime.embedDocument(
          effective.title,
          runtime.boundedEmbeddingText(`${effective.description}\n${conceptContent}`),
          runtime.embeddingDimension(records),
        )
        const queryEmbedding = await runtime.embedQuery(
          runtime.boundedEmbeddingText(conceptContent),
          runtime.embeddingDimension(records),
        )
        relationshipDiagnostics = relationshipSimilarityDiagnostics(
          runtime,
          records,
          evaluationCase.checks.find((check) => check.type === 'related-link').recordId,
          queryEmbedding,
          noteEmbedding,
        )
        effective.relationships = runtime.creationRelationships(conceptContent, records, noteEmbedding)
        relatedSection = runtime.generatedRelatedSection(
          effective.relationships,
          new Map(records.map((record) => [record.id, record])),
        )
      }
      const captureId = `filing-evaluation-${evaluationCase.id}`
      const markdown = runtime.conceptDocument(
        effective,
        '/references/inbox/filing-evaluation.md',
        (evaluationCase.now ? new Date(evaluationCase.now) : fixedNow).toISOString(),
        new Map(records.map((record) => [record.id, record])),
        conceptContent,
        true,
        captureId,
        sourceContent,
      )
      const parsed = runtime.parseMarkdownFile(markdown, '/tmp/filing-evaluation.md')
      const expectedContribution = runtime.captureContribution(captureId, conceptContent)
      const checks = [
        {
          label: 'classifier returns metadata only; no body field is generated',
          passed: assertMetadataOnly(classification),
          actual: Object.keys(classification),
        },
        {
          label: 'original body is preserved in the generated capture and source receipt',
          passed: parsed.content.includes(expectedContribution)
            && parsed.frontmatter.sources?.[0]?.capture_content === sourceContent,
          actual: {
            contributionPreserved: parsed.content.includes(expectedContribution),
            sourceReceiptPreserved: parsed.frontmatter.sources?.[0]?.capture_content === sourceContent,
          },
        },
        ...evaluationCase.checks.map((check) => runCheck(check, effective, {
          content: sourceContent,
          records,
          relatedSection,
        })),
      ]
      caseResults.push({
        id: evaluationCase.id,
        passed: checks.every((check) => check.passed),
        output: effective,
        rawOutput: classification.concept,
        relationshipDiagnostics,
        checks,
      })
      console.error(`[${caseIndex + 1}/${selectedCases.length}] ${evaluationCase.id}: ${caseResults.at(-1).passed ? 'PASS' : 'FAIL'}`)
    }

    const allChecks = caseResults.flatMap((result) => result.checks)
    const report = {
      models: status.models.filter((model) => requiredModels.includes(model.id)).map(({ id, name }) => ({ id, name })),
      summary: {
        total: filingEvaluationCases.length,
        selected: selectedCases.length,
        passed: caseResults.filter((result) => result.passed).length,
        checksTotal: allChecks.length,
        checksPassed: allChecks.filter((check) => check.passed).length,
      },
      cases: caseResults,
    }
    if (jsonOutput) console.log(JSON.stringify(report, null, 2))
    else printHuman(report)
    if (report.summary.passed !== report.summary.selected) process.exitCode = 1
  } finally {
    await runtime.mlxService.close()
    await fs.rm(scratchRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`Filing evaluation failed: ${error.message}`)
  process.exitCode = 1
})
