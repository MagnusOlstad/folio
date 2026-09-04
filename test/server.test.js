import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve)
    server.once('error', reject)
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function jsonRequest(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  assert.equal(response.status, 201, JSON.stringify(result))
  return result
}

test('files whole notes hierarchically and appends todo and daily captures', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-test-'))
  let classificationRequests = 0
  const classificationPrompts = []
  let invalidEmbeddingResponse = false
  const embeddingInputs = []
  const installedModels = new Set(['llama3.2:3b'])
  const pulledModels = []
  const ollama = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    response.setHeader('content-type', 'application/json')

    if (request.url === '/api/tags') {
      response.end(JSON.stringify({ models: [...installedModels].map((name) => ({ name })) }))
      return
    }

    if (request.url === '/api/ps') {
      response.end(JSON.stringify({ models: [] }))
      return
    }

    if (request.url === '/api/pull') {
      pulledModels.push(body.model)
      installedModels.add(body.model.includes(':') ? body.model : `${body.model}:latest`)
      response.end(JSON.stringify({ status: 'success' }))
      return
    }

    if (request.url === '/api/chat') {
      classificationRequests += 1
      const note = body.messages?.at(-1)?.content || ''
      classificationPrompts.push(note)
      const concept = note.includes('Project Aurora details')
        ? {
            kind: 'note',
            path: ['projects'],
            title: 'Project Aurora',
            type: 'Project',
            description: 'Details about Project Aurora.',
            tags: ['prosjekt', 'nordisk'],
          }
        : note.includes('Planning note')
          ? {
              kind: 'note',
              path: ['planning'],
              title: 'Planning Note',
              type: 'Plan',
              description: 'Planning details that reference a future project.',
              tags: ['planlegging', 'økonomi'],
            }
          : note.includes('Long archive')
            ? {
                kind: 'note',
                path: ['research'],
                title: 'Long Archive',
                type: 'Research',
                description: 'A long note used to verify complete chunk retrieval.',
                tags: ['arkiv', 'langtekst'],
              }
          : note.includes('Semantic neighbor')
            ? {
                kind: 'note',
                path: ['ideas'],
                title: 'Semantic Neighbor',
                type: 'Idea',
                description: 'A separate concept with similar meaning.',
                tags: ['idé', 'søk'],
              }
            : {
                kind: 'note',
                path: ['meeting-notes', 'morning-meeting'],
                title: 'Morning<br>launch meeting',
                type: 'Meeting Note',
                description: 'The morning meeting covered the launch<br />and its follow-up.',
                tags: ['launch', 'morning'],
              }
      response.end(JSON.stringify({
        message: {
          content: JSON.stringify({ concept }),
        },
      }))
      return
    }

    if (request.url === '/api/embed') {
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      embeddingInputs.push(...inputs)
      response.end(JSON.stringify({
        embeddings: invalidEmbeddingResponse
          ? []
          : inputs.map((input) => input.includes('hidden constellation') ? [0, 1, 0] : [1, 0, 0]),
      }))
      return
    }

    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })

  await listen(ollama)
  const ollamaPort = ollama.address().port
  process.env.FOLIO_DATA_ROOT = dataRoot
  process.env.FOLIO_DIST_ROOT = path.join(dataRoot, 'dist')
  process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaPort}`

  const {
    existingClassificationGuide,
    existingTagGuide,
    reuseExistingClassificationPath,
    startServer,
  } = await import(`../server/index.js?test=${Date.now()}`)
  const tagGuideRecords = [
    {
      id: '/projects/roadmap.md',
      title: 'Project Roadmap',
      type: 'Plan',
      description: 'Budget and milestones for the project.',
      tags: ['project-planning'],
      content: 'Budget review and milestone schedule.',
      status: 'stable',
      embedding: [1, 0, 0],
      chunks: [],
    },
    {
      id: '/garden/orchard.md',
      title: 'Orchard Notes',
      type: 'Reference',
      description: 'Seasonal care notes.',
      tags: ['orchard-care'],
      content: 'Pruning and watering observations.',
      status: 'stable',
      embedding: [0, 1, 0],
      chunks: [],
    },
  ]
  const lexicalTagGuide = existingTagGuide('Review the project budget and milestone schedule.', tagGuideRecords)
  assert.match(lexicalTagGuide, /- project-planning /)
  assert.doesNotMatch(lexicalTagGuide, /orchard-care/)
  const semanticTagGuide = existingTagGuide('A thought expressed with unrelated vocabulary.', tagGuideRecords, [0, 1, 0])
  assert.match(semanticTagGuide, /- orchard-care /)
  assert.doesNotMatch(semanticTagGuide, /project-planning/)
  const lexicalFilingGuide = existingClassificationGuide(
    'Project planning\nReview the project budget and milestone schedule.',
    tagGuideRecords,
    null,
    1,
  )
  assert.match(lexicalFilingGuide, /path: \["projects"\]; types: \["Plan"\]/)
  assert.match(lexicalFilingGuide, /matching existing concepts: \[\{"title":"Project Roadmap","tags":\["project-planning"\]\}\]/)
  const semanticFilingGuide = existingClassificationGuide(
    'A thought expressed with unrelated vocabulary.',
    tagGuideRecords,
    [0, 1, 0],
    1,
  )
  assert.match(semanticFilingGuide, /path: \["garden"\]; types: \["Reference"\]/)
  assert.doesNotMatch(semanticFilingGuide, /path: \["projects"\]/)
  const pathRecords = [
    { ...tagGuideRecords[0], id: '/ai/dei/presentasjon/first.md' },
    { ...tagGuideRecords[0], id: '/ai/dei/presentasjon/second.md' },
    { ...tagGuideRecords[1], id: '/presentasjon/dei/ai/duplicate.md' },
  ]
  assert.deepEqual(
    reuseExistingClassificationPath(['presentasjon', 'dei', 'ai'], pathRecords.slice(0, 2)),
    ['ai', 'dei', 'presentasjon'],
  )
  assert.deepEqual(
    reuseExistingClassificationPath(['presentasjon', 'dei', 'ai'], pathRecords),
    ['ai', 'dei', 'presentasjon'],
  )

  const api = await startServer(0)
  const apiPort = api.address().port
  const baseUrl = `http://127.0.0.1:${apiPort}`
  context.after(async () => {
    await close(api)
    await close(ollama)
    await fs.rm(dataRoot, { recursive: true, force: true })
  })

  const initialStatusResponse = await fetch(`${baseUrl}/api/status`)
  const initialStatus = await initialStatusResponse.json()
  assert.deepEqual(initialStatus.missingModels, ['embeddinggemma'])
  const installResponse = await fetch(`${baseUrl}/api/ollama/install`, { method: 'POST' })
  const installedStatus = await installResponse.json()
  assert.equal(installResponse.status, 200, JSON.stringify(installedStatus))
  assert.deepEqual(pulledModels, ['embeddinggemma'])
  assert.deepEqual(installedStatus.missingModels, [])

  const draftId = 'untitled:server-persistence-test'
  const draftCreatedAt = '2026-09-03T06:00:00.000Z'
  const draftUpdatedAt = '2026-09-03T06:01:00.000Z'
  const savedDraftResponse = await fetch(`${baseUrl}/api/draft?id=${encodeURIComponent(draftId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: 'A durable unfinished thought.',
      createdAt: draftCreatedAt,
      updatedAt: draftUpdatedAt,
    }),
  })
  assert.equal(savedDraftResponse.status, 200)
  const savedDraft = await savedDraftResponse.json()
  assert.equal(savedDraft.content, 'A durable unfinished thought.')
  const draftsResponse = await fetch(`${baseUrl}/api/drafts`)
  const drafts = await draftsResponse.json()
  assert.deepEqual(drafts, [{
    id: draftId,
    content: 'A durable unfinished thought.',
    createdAt: draftCreatedAt,
    updatedAt: draftUpdatedAt,
  }])
  const staleDraftResponse = await fetch(`${baseUrl}/api/draft?id=${encodeURIComponent(draftId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: 'Older content must not win.',
      createdAt: draftCreatedAt,
      updatedAt: '2026-09-03T06:00:30.000Z',
    }),
  })
  assert.equal((await staleDraftResponse.json()).content, 'A durable unfinished thought.')
  assert.equal((await fs.readdir(path.join(dataRoot, 'drafts'))).length, 1)

  const deletedDraftId = 'untitled:delete-test'
  await fetch(`${baseUrl}/api/draft?id=${encodeURIComponent(deletedDraftId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'Discard this thought.', createdAt: draftCreatedAt, updatedAt: draftUpdatedAt }),
  })
  const deleteDraftResponse = await fetch(`${baseUrl}/api/draft?id=${encodeURIComponent(deletedDraftId)}`, { method: 'DELETE' })
  assert.equal(deleteDraftResponse.status, 200)
  assert.deepEqual(await deleteDraftResponse.json(), { deletedId: deletedDraftId })
  assert.deepEqual((await (await fetch(`${baseUrl}/api/drafts`)).json()).map((draft) => draft.id), [draftId])
  assert.equal((await fetch(`${baseUrl}/api/draft?id=${encodeURIComponent(deletedDraftId)}`, { method: 'DELETE' })).status, 200)

  const meeting = [
    'Morning meeting',
    'Discussed the launch plan.<br>Decision: ship Friday.',
    'Todo: call Sam.',
  ].join('\n')
  const meetingSteering = 'meeting-notes/morning-meeting - classify this capture'
  const meetingCapture = `${meetingSteering}\n${meeting}`
  const meetingDraftId = 'untitled:meeting-draft'
  await fetch(`${baseUrl}/api/draft?id=${encodeURIComponent(meetingDraftId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: meetingCapture, createdAt: draftCreatedAt, updatedAt: draftUpdatedAt }),
  })
  const meetingResult = await jsonRequest(`${baseUrl}/api/notes`, {
    content: meetingCapture,
    filedContent: meeting,
    draftId: meetingDraftId,
    timeZone: 'America/New_York',
  })
  assert.equal(meetingResult.notes.length, 1)
  assert.equal(meetingResult.note.title, 'Morning launch meeting')
  assert.equal(meetingResult.note.description, 'The morning meeting covered the launch and its follow-up.')
  assert.match(meetingResult.note.id, /^\/meeting-notes\/morning-meeting\/morning-launch-meeting-\d{4}-\d{2}-\d{2}\.md$/)
  assert.equal('embeddingModel' in meetingResult.note, false)
  assert.equal('chunks' in meetingResult.note, false)
  const meetingDetailResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(meetingResult.note.id)}`)
  const meetingDetail = await meetingDetailResponse.json()
  assert.equal(meetingDetail.content, 'Morning meeting\nDiscussed the launch plan.  \nDecision: ship Friday.\nTodo: call Sam.')
  const meetingFile = await fs.readFile(path.join(dataRoot, 'bundle', meetingResult.note.id.slice(1)), 'utf8')
  assert.match(meetingFile, /Morning meeting\nDiscussed the launch plan\.  \nDecision: ship Friday\.\nTodo: call Sam\./)
  const rawMeetingFile = await fs.readFile(path.join(dataRoot, 'bundle', meetingResult.note.rawId.slice(1)), 'utf8')
  assert.match(rawMeetingFile, /classify this capture/)
  assert.doesNotMatch(meetingFile, /classify this capture/)
  const remainingDrafts = await (await fetch(`${baseUrl}/api/drafts`)).json()
  assert.deepEqual(remainingDrafts.map((draft) => draft.id), [draftId])
  const archivedDrafts = await Promise.all((await fs.readdir(path.join(dataRoot, 'drafts')))
    .map(async (filename) => JSON.parse(await fs.readFile(path.join(dataRoot, 'drafts', filename), 'utf8'))))
  const archivedMeetingDraft = archivedDrafts.find((draft) => draft.id === meetingDraftId)
  assert.equal(archivedMeetingDraft.content, meetingCapture)
  assert.equal(archivedMeetingDraft.filedId, meetingResult.note.id)
  const repeatedFilingResponse = await fetch(`${baseUrl}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: meetingCapture, filedContent: meeting, draftId: meetingDraftId, timeZone: 'America/New_York' }),
  })
  const repeatedFiling = await repeatedFilingResponse.json()
  assert.equal(repeatedFilingResponse.status, 200)
  assert.equal(repeatedFiling.note.id, meetingResult.note.id)
  assert.match(rawMeetingFile, /Discussed the launch plan\.<br>Decision: ship Friday\./)

  const editedInput = 'Morning meeting\nDiscussed the revised launch plan.<br/>Decision: ship Monday.'
  const editedContent = 'Morning meeting\nDiscussed the revised launch plan.  \nDecision: ship Monday.'
  const editResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(meetingResult.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: editedInput }),
  })
  const editedMeeting = await editResponse.json()
  assert.equal(editResponse.status, 200, JSON.stringify(editedMeeting))
  assert.equal(editedMeeting.content, editedContent)
  assert.deepEqual(editedMeeting.tags, ['launch', 'morning'])
  assert.equal(classificationRequests, 1)
  assert.match(classificationPrompts[0], /No existing filing options yet/)
  assert.match(classificationPrompts[0], /No relevant existing tag candidates found/)
  assert.ok(embeddingInputs.includes(`title: Morning launch meeting | text: The morning meeting covered the launch and its follow-up.\n${editedContent}`))
  assert.ok(embeddingInputs.some((input) => input.startsWith('title: Morning launch meeting | text: ')))
  const editedMeetingFile = await fs.readFile(path.join(dataRoot, 'bundle', meetingResult.note.id.slice(1)), 'utf8')
  assert.match(editedMeetingFile, /# Captured note\n\nMorning meeting\nDiscussed the revised launch plan\.  \nDecision: ship Monday\./)
  assert.match(editedMeetingFile, /generated:\n  by: human:local\n  at: /)
  assert.ok(editedMeeting.createdAt >= meetingResult.note.createdAt)
  const explorerResponse = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(meetingResult.note.id)}`)
  const explorerMeeting = await explorerResponse.json()
  assert.equal(explorerMeeting.content, editedContent)

  const tagEditResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(meetingResult.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tags: ['Møte', 'økonomi', 'Møte', 'cafe\u0301', 'café'] }),
  })
  const tagEditedMeeting = await tagEditResponse.json()
  assert.equal(tagEditResponse.status, 200, JSON.stringify(tagEditedMeeting))
  assert.deepEqual(tagEditedMeeting.tags, ['møte', 'økonomi', 'café'])
  assert.equal(tagEditedMeeting.movable, true)
  const tagSearchResponse = await fetch(`${baseUrl}/api/search?tag=${encodeURIComponent('økonomi')}`)
  const tagSearch = await tagSearchResponse.json()
  assert.deepEqual(tagSearch.map((note) => note.id), [meetingResult.note.id])
  const normalizedTagSearchResponse = await fetch(`${baseUrl}/api/search?tag=${encodeURIComponent('cafe\u0301')}`)
  const normalizedTagSearch = await normalizedTagSearchResponse.json()
  assert.deepEqual(normalizedTagSearch.map((note) => note.id), [meetingResult.note.id])

  const planning = await jsonRequest(`${baseUrl}/api/notes`, {
    content: 'Planning note\nWe depend on Project Aurora.',
    timeZone: 'America/New_York',
  })
  assert.match(classificationPrompts[1], /path: \["meeting-notes","morning-meeting"\]; types: \["Meeting Note"\]/)
  assert.match(classificationPrompts[1], /matching existing concepts: \[\{"title":"Morning launch meeting","tags":\["møte","økonomi","café"\]\}\]/)
  assert.match(classificationPrompts[1], /- økonomi \(used 1 time; similar note: "Morning launch meeting"\)/)
  assert.ok(embeddingInputs.includes('task: search result | query: Planning note\nWe depend on Project Aurora.'))
  const aurora = await jsonRequest(`${baseUrl}/api/notes`, {
    content: 'projects/project-aurora - first steering line\nProject Aurora details\nThe launch remains confidential.',
    filedContent: 'Project Aurora details\nThe launch remains confidential.',
    timeZone: 'America/New_York',
  })
  const auroraId = '/projects/project-aurora-2020-01-01.md'
  await fs.rename(
    path.join(dataRoot, 'bundle', aurora.note.id.slice(1)),
    path.join(dataRoot, 'bundle', auroraId.slice(1)),
  )
  await fetch(`${baseUrl}/api/reindex`, { method: 'POST' })
  const mergedAurora = await jsonRequest(`${baseUrl}/api/notes`, {
    content: 'projects/project-aurora - second steering line\nProject Aurora details\nThe launch budget was approved.',
    filedContent: 'Project Aurora details\nThe launch budget was approved.',
    timeZone: 'America/New_York',
  })
  assert.equal(mergedAurora.note.id, auroraId)
  assert.equal(mergedAurora.appended, true)
  const mergedAuroraFile = await fs.readFile(path.join(dataRoot, 'bundle', auroraId.slice(1)), 'utf8')
  assert.match(mergedAuroraFile, /The launch remains confidential\./)
  assert.match(mergedAuroraFile, /The launch budget was approved\./)
  assert.doesNotMatch(mergedAuroraFile, /first steering line|second steering line/)
  const auroraRawCaptures = await Promise.all((await fs.readdir(path.join(dataRoot, 'bundle', 'references', 'inbox')))
    .map((filename) => fs.readFile(path.join(dataRoot, 'bundle', 'references', 'inbox', filename), 'utf8')))
  assert.ok(auroraRawCaptures.some((rawCapture) => /second steering line/.test(rawCapture)))
  const planningFilePath = path.join(dataRoot, 'bundle', planning.note.id.slice(1))
  const planningFile = await fs.readFile(planningFilePath, 'utf8')
  assert.match(planningFile, /<!-- folio:generated-related:start -->/)
  assert.match(planningFile, new RegExp(`\\[Project Aurora\\]\\(${auroraId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\) - Mentions`))

  const authoredRelated = `${planningFile.replace(/\n?<!-- folio:generated-related:start -->[\s\S]*?<!-- folio:generated-related:end -->\n?/g, '\n').trim()}\n\n# Related\n\nManual context that must remain searchable.[^manual]\n\n[^manual]: Authored footnote that must survive metadata edits.\n`
  await fs.writeFile(planningFilePath, authoredRelated)
  const reindexResponse = await fetch(`${baseUrl}/api/reindex`, { method: 'POST' })
  assert.equal(reindexResponse.status, 200)
  const preservedPlanning = await fs.readFile(planningFilePath, 'utf8')
  assert.match(preservedPlanning, /# Related\n\nManual context that must remain searchable\./)
  assert.match(preservedPlanning, /\[\^manual\]: Authored footnote that must survive metadata edits\./)
  assert.match(preservedPlanning, /<!-- folio:generated-related:start -->/)
  const planningTagResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(planning.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tags: ['planlegging', 'bevart'] }),
  })
  assert.equal(planningTagResponse.status, 200)
  const planningAfterTagEdit = await fs.readFile(planningFilePath, 'utf8')
  assert.match(planningAfterTagEdit, /\[\^manual\]: Authored footnote that must survive metadata edits\./)

  const semantic = await jsonRequest(`${baseUrl}/api/notes`, {
    content: 'Semantic neighbor\nA distinct thought without another concept title.',
    timeZone: 'America/New_York',
  })
  const semanticDetailResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(semantic.note.id)}`)
  const semanticDetail = await semanticDetailResponse.json()
  const suggestion = semanticDetail.suggestions.find((item) => item.id === meetingResult.note.id)
  assert.ok(suggestion)
  const confirmResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(semantic.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmRelatedId: suggestion.id }),
  })
  const confirmedSemantic = await confirmResponse.json()
  assert.equal(confirmResponse.status, 200, JSON.stringify(confirmedSemantic))
  const confirmedMeetingLink = confirmedSemantic.links.find((item) => item.id === meetingResult.note.id && item.relation === 'Confirmed related')
  assert.ok(confirmedMeetingLink)
  assert.equal(confirmedMeetingLink.origin, 'frontmatter')
  assert.ok(confirmedMeetingLink.createdAt)
  assert.ok(!confirmedSemantic.suggestions.some((item) => item.id === meetingResult.note.id))

  const manualDirectory = path.join(dataRoot, 'bundle', 'manual')
  const spacedId = '/manual/Odd (File).md'
  const olderTieId = '/manual/tie-a-older.md'
  const newerTieId = '/manual/tie-z-newer.md'
  const semanticRelativeLink = path.posix.relative('/manual', semantic.note.id)
  await fs.mkdir(manualDirectory, { recursive: true })
  await fs.writeFile(path.join(manualDirectory, 'Odd (File).md'), [
    '---',
    'type: Reference',
    'title: "Odd File" # preserve this comment',
    'tags: [manual]',
    'shared_label: &label "Keep this"',
    'copied_label: *label',
    'computation: ../scripts/query.sql',
    '---',
    '',
    '# Odd File',
    '',
    `A manually named concept linked to [Semantic Neighbor](${semanticRelativeLink}).`,
    '',
    'Reference-style [neighbor][semantic].',
    '',
    `[semantic]: ${semanticRelativeLink}`,
    '',
    '```md',
    `[example](${semanticRelativeLink})`,
    '```',
    '',
    `Inline code stays literal: \`[example](${semanticRelativeLink})\`.`,
    '',
  ].join('\n'))
  const tieDocument = (generatedAt) => [
    '---',
    'type: Reference',
    'title: Tie result',
    'description: Identical search ordering test.',
    'status: stable',
    `generated: { by: human:test, at: "${generatedAt}" }`,
    '---',
    '',
    '# Tie ordering',
    '',
    'Unique tiephrase content.',
    '',
  ].join('\n')
  await fs.writeFile(path.join(dataRoot, 'bundle', olderTieId.slice(1)), tieDocument('2026-08-01T12:00:00Z'))
  await fs.writeFile(path.join(dataRoot, 'bundle', newerTieId.slice(1)), tieDocument('2026-09-01T12:00:00Z'))
  const rawSemanticPath = path.join(dataRoot, 'bundle', semantic.note.rawId.slice(1))
  const rawSemanticWithLink = `${await fs.readFile(rawSemanticPath, 'utf8')}\nRaw example [Odd File](/manual/Odd%20%28File%29.md).\n`
  await fs.writeFile(rawSemanticPath, rawSemanticWithLink)
  await fs.appendFile(
    path.join(dataRoot, 'bundle', semantic.note.id.slice(1)),
    '\nEscaped [Odd File](/manual/Odd%20\\(File\\).md).\n',
  )
  await fetch(`${baseUrl}/api/reindex`, { method: 'POST' })
  const tieSearch = await (await fetch(`${baseUrl}/api/search?q=tiephrase`)).json()
  assert.deepEqual(tieSearch.slice(0, 2).map((record) => record.id), [newerTieId, olderTieId])
  const explorerFiles = await (await fetch(`${baseUrl}/api/files`)).json()
  const tieFiles = explorerFiles.filter((file) => file.title === 'Tie result')
  assert.deepEqual(tieFiles.map((file) => file.createdAt).sort().reverse(), ['2026-09-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z'])
  await Promise.all([
    fs.unlink(path.join(dataRoot, 'bundle', olderTieId.slice(1))),
    fs.unlink(path.join(dataRoot, 'bundle', newerTieId.slice(1))),
  ])
  await fetch(`${baseUrl}/api/reindex`, { method: 'POST' })
  const spacedConfirmResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(semantic.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmRelatedId: spacedId }),
  })
  const spacedConfirmed = await spacedConfirmResponse.json()
  assert.equal(spacedConfirmResponse.status, 200, JSON.stringify(spacedConfirmed))
  assert.ok(spacedConfirmed.links.some((item) => item.id === spacedId))
  const semanticFile = await fs.readFile(path.join(dataRoot, 'bundle', semantic.note.id.slice(1)), 'utf8')
  assert.match(semanticFile, /\/manual\/Odd%20%28File%29\.md/)

  const indexBeforeMove = JSON.parse(await fs.readFile(path.join(dataRoot, 'search-index.json'), 'utf8'))
  const embeddingBeforeMove = indexBeforeMove.find((record) => record.id === spacedId)
  const embeddingRequestsBeforeMove = embeddingInputs.length
  const movedId = '/manual/curated/Odd (File).md'
  const conflictMarkdown = '---\ntype: Reference\ntitle: Existing destination\n---\n\nDo not overwrite.\n'
  const moveResponse = await fetch(`${baseUrl}/api/file/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: spacedId, directory: '/manual/curated' }),
  })
  const moved = await moveResponse.json()
  assert.equal(moveResponse.status, 200, JSON.stringify(moved))
  assert.equal(moved.newId, movedId)
  assert.equal(moved.note.id, movedId)
  assert.equal(moved.note.filedBy, 'human:local')
  assert.equal(moved.note.movable, true)
  await assert.rejects(fs.access(path.join(dataRoot, 'bundle', spacedId.slice(1))))
  const movedFile = await fs.readFile(path.join(dataRoot, 'bundle', movedId.slice(1)), 'utf8')
  assert.match(movedFile, /filing:\n  by: human:local/)
  assert.match(movedFile, /previous_path: \/manual\/Odd \(File\)\.md/)
  assert.match(movedFile, /previous_paths:\n    - \/manual\/Odd \(File\)\.md/)
  assert.match(movedFile, /computation: \/scripts\/query\.sql/)
  assert.match(movedFile, /title: "Odd File" # preserve this comment/)
  assert.match(movedFile, /shared_label: &label "Keep this"/)
  assert.match(movedFile, /copied_label: \*label/)
  assert.ok(movedFile.includes(`[Semantic Neighbor](${semantic.note.id})`))
  assert.ok(movedFile.includes(`[semantic]: ${semantic.note.id}`))
  assert.ok(movedFile.includes(`[example](${semanticRelativeLink})`))
  assert.equal(await fs.readFile(rawSemanticPath, 'utf8'), rawSemanticWithLink)
  const oldPathResponse = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(spacedId)}`)
  const oldPathDocument = await oldPathResponse.json()
  assert.equal(oldPathResponse.status, 200, JSON.stringify(oldPathDocument))
  assert.equal(oldPathDocument.id, movedId)
  const rawSemanticResponse = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(semantic.note.rawId)}`)
  const rawSemanticDocument = await rawSemanticResponse.json()
  assert.ok(rawSemanticDocument.links.some((link) => link.id === movedId))
  await fs.mkdir(path.dirname(path.join(dataRoot, 'bundle', spacedId.slice(1))), { recursive: true })
  await fs.writeFile(path.join(dataRoot, 'bundle', spacedId.slice(1)), conflictMarkdown)
  const rawWithReusedPathResponse = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(semantic.note.rawId)}`)
  const rawWithReusedPath = await rawWithReusedPathResponse.json()
  assert.ok(rawWithReusedPath.links.some((link) => link.id === spacedId))
  assert.ok(!rawWithReusedPath.links.some((link) => link.id === movedId))
  await fs.unlink(path.join(dataRoot, 'bundle', spacedId.slice(1)))
  const semanticAfterMove = await fs.readFile(path.join(dataRoot, 'bundle', semantic.note.id.slice(1)), 'utf8')
  assert.match(semanticAfterMove, /  - \/manual\/curated\/Odd \(File\)\.md/)
  assert.match(semanticAfterMove, /\/manual\/curated\/Odd%20%28File%29\.md/)
  assert.match(semanticAfterMove, /Escaped \[Odd File\]\(\/manual\/curated\/Odd%20%28File%29\.md\)/)
  assert.doesNotMatch(semanticAfterMove, /\/manual\/Odd%20%28File%29\.md/)
  const indexAfterMove = JSON.parse(await fs.readFile(path.join(dataRoot, 'search-index.json'), 'utf8'))
  const embeddingAfterMove = indexAfterMove.find((record) => record.id === movedId)
  assert.deepEqual(embeddingAfterMove.embedding, embeddingBeforeMove.embedding)
  assert.notEqual(embeddingAfterMove.embeddingInputHash, embeddingBeforeMove.embeddingInputHash)
  assert.ok(embeddingAfterMove.chunks.every((chunk) => chunk.embedding))
  assert.equal(embeddingInputs.length, embeddingRequestsBeforeMove)
  const movedFileResponse = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(movedId)}`)
  const movedFileDetail = await movedFileResponse.json()
  assert.equal(movedFileDetail.filedBy, 'human:local')
  assert.ok(movedFileDetail.filedAt)

  const conflictDirectory = path.join(dataRoot, 'bundle', 'manual', 'archive')
  const conflictPath = path.join(conflictDirectory, 'Odd (File).md')
  await fs.mkdir(conflictDirectory, { recursive: true })
  await fs.writeFile(conflictPath, conflictMarkdown)
  const conflictMoveResponse = await fetch(`${baseUrl}/api/file/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: movedId, directory: '/manual/archive' }),
  })
  assert.equal(conflictMoveResponse.status, 409)
  assert.equal(await fs.readFile(conflictPath, 'utf8'), conflictMarkdown)
  await fs.access(path.join(dataRoot, 'bundle', movedId.slice(1)))
  await fs.unlink(conflictPath)
  await fs.rmdir(conflictDirectory)

  const searchResponse = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('launch decision')}`)
  assert.equal(searchResponse.status, 200)
  assert.ok(embeddingInputs.includes('task: search result | query: launch decision'))

  const longContent = `Long archive\n${Array.from({ length: 1600 }, (_, index) => `filler-${index}`).join(' ')} hidden constellation`
  const longNote = await jsonRequest(`${baseUrl}/api/notes`, { content: longContent, timeZone: 'America/New_York' })
  assert.match(classificationPrompts.at(-1), /path: \["manual","curated"\]; types: \["Reference"\]/)
  const longSearchResponse = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('hidden constellation')}`)
  const longSearch = await longSearchResponse.json()
  assert.equal(longSearchResponse.status, 200)
  assert.equal(longSearch[0].id, longNote.note.id)
  assert.match(longSearch[0].snippet, /hidden constellation/)
  assert.equal('embeddingModel' in longSearch[0], false)
  assert.equal('suggestedRelatedIds' in longSearch[0], false)
  const index = JSON.parse(await fs.readFile(path.join(dataRoot, 'search-index.json'), 'utf8'))
  assert.ok(index.every((record) => record.embedding))
  assert.ok(index.every((record) => record.chunks.length > 0 && record.chunks.every((chunk) => chunk.embedding)))
  assert.ok(index.find((record) => record.id === longNote.note.id).chunks.length > 6)

  const longNoteDate = longNote.note.id.match(/-(\d{4}-\d{2}-\d{2})\.md$/)?.[1]
  const renamedLongResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(longNote.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Deep Archive', description: 'Updated archive description.' }),
  })
  const renamedLong = await renamedLongResponse.json()
  assert.equal(renamedLongResponse.status, 200, JSON.stringify(renamedLong))
  assert.equal(renamedLong.oldId, longNote.note.id)
  assert.equal(renamedLong.newId, `/research/deep-archive-${longNoteDate}.md`)
  assert.equal(renamedLong.id, renamedLong.newId)
  assert.equal(renamedLong.title, 'Deep Archive')
  assert.equal(renamedLong.description, 'Updated archive description.')
  await assert.rejects(fs.access(path.join(dataRoot, 'bundle', longNote.note.id.slice(1))))
  const renamedLongFile = await fs.readFile(path.join(dataRoot, 'bundle', renamedLong.newId.slice(1)), 'utf8')
  assert.match(renamedLongFile, /title: Deep Archive/)
  assert.match(renamedLongFile, /description: Updated archive description\./)
  const oldLongPathResponse = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(longNote.note.id)}`)
  assert.equal((await oldLongPathResponse.json()).id, renamedLong.newId)
  const renamedIndex = JSON.parse(await fs.readFile(path.join(dataRoot, 'search-index.json'), 'utf8'))
  assert.ok(renamedIndex.some((record) => record.id === renamedLong.newId && record.title === 'Deep Archive'))
  assert.ok(embeddingInputs.some((input) => input.startsWith('title: Deep Archive | text: Updated archive description.\nLong archive')))

  invalidEmbeddingResponse = true
  const invalidEmbeddingResponseResult = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(semantic.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: `${semanticDetail.content}\nUpdated while embeddings are invalid.` }),
  })
  const invalidEmbeddingUpdate = await invalidEmbeddingResponseResult.json()
  assert.equal(invalidEmbeddingResponseResult.status, 200, JSON.stringify(invalidEmbeddingUpdate))
  assert.equal(invalidEmbeddingUpdate.warning, 'The note was updated, but its semantic index could not be refreshed.')
  invalidEmbeddingResponse = false

  const rootMoveResponse = await fetch(`${baseUrl}/api/file/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: movedId, directory: '/' }),
  })
  const rootMoved = await rootMoveResponse.json()
  assert.equal(rootMoveResponse.status, 200, JSON.stringify(rootMoved))
  assert.equal(rootMoved.newId, '/Odd (File).md')
  await fs.access(path.join(dataRoot, 'bundle', 'Odd (File).md'))

  const [firstTodo, secondTodo] = await Promise.all([
    jsonRequest(`${baseUrl}/api/notes`, { content: 'todo: Buy milk', timeZone: 'America/New_York' }),
    jsonRequest(`${baseUrl}/api/notes`, { content: 'TODO - chores route only\nCall Sam', filedContent: 'Call Sam', timeZone: 'America/New_York' }),
  ])
  assert.equal(firstTodo.note.id, '/todo-list.md')
  assert.equal(firstTodo.appended, false)
  assert.equal(secondTodo.note.id, '/todo-list.md')
  assert.equal(secondTodo.appended, true)
  const todoFile = await fs.readFile(path.join(dataRoot, 'bundle', 'todo-list.md'), 'utf8')
  assert.match(todoFile, /- \[ \] Buy milk/)
  assert.match(todoFile, /- \[ \] Call Sam/)
  assert.doesNotMatch(todoFile, /chores route only/)
  const todoRawCaptures = await Promise.all((await fs.readdir(path.join(dataRoot, 'bundle', 'references', 'inbox')))
    .map((filename) => fs.readFile(path.join(dataRoot, 'bundle', 'references', 'inbox', filename), 'utf8')))
  assert.ok(todoRawCaptures.some((rawCapture) => /chores route only/.test(rawCapture)))
  const protectedMoveResponse = await fetch(`${baseUrl}/api/file/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '/todo-list.md', directory: '/tasks' }),
  })
  assert.equal(protectedMoveResponse.status, 400)

  const todoResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent('/todo-list.md')}`)
  const todoNote = await todoResponse.json()
  const checkedTodoContent = todoNote.content.replace('- [ ] Buy milk', '- [x] Buy milk')
  const checkResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent('/todo-list.md')}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: checkedTodoContent }),
  })
  const checkedTodo = await checkResponse.json()
  assert.equal(checkResponse.status, 200, JSON.stringify(checkedTodo))
  assert.match(checkedTodo.content, /- \[x\] Buy milk/)

  const uncheckResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent('/todo-list.md')}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: checkedTodo.content.replace('- [x] Buy milk', '- [ ] Buy milk') }),
  })
  const uncheckedTodo = await uncheckResponse.json()
  assert.equal(uncheckResponse.status, 200, JSON.stringify(uncheckedTodo))
  assert.match(uncheckedTodo.content, /- \[ \] Buy milk/)

  const firstDaily = await jsonRequest(`${baseUrl}/api/notes`, { content: 'daily: Felt focused today.', timeZone: 'America/New_York' })
  const secondDaily = await jsonRequest(`${baseUrl}/api/notes`, { content: 'Daily - release route only\nFinished the release.', filedContent: 'Finished the release.', timeZone: 'America/New_York' })
  assert.match(firstDaily.note.id, /^\/daily\/\d{4}-\d{2}-\d{2}\.md$/)
  assert.equal(secondDaily.note.id, firstDaily.note.id)
  assert.equal(secondDaily.appended, true)
  const dailyFile = await fs.readFile(path.join(dataRoot, 'bundle', firstDaily.note.id.slice(1)), 'utf8')
  assert.match(dailyFile, /Felt focused today\./)
  assert.match(dailyFile, /Finished the release\./)
  assert.doesNotMatch(dailyFile, /release route only/)
  const dailyRawCaptures = await Promise.all((await fs.readdir(path.join(dataRoot, 'bundle', 'references', 'inbox')))
    .map((filename) => fs.readFile(path.join(dataRoot, 'bundle', 'references', 'inbox', filename), 'utf8')))
  assert.ok(dailyRawCaptures.some((rawCapture) => /release route only/.test(rawCapture)))

  const notesResponse = await fetch(`${baseUrl}/api/notes`)
  const notes = await notesResponse.json()
  assert.equal(notes.length, 8)
})
