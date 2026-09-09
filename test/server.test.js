import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

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

function markdownFrontmatter(markdown) {
  const end = markdown.indexOf('\n---\n', 4)
  return YAML.parse(markdown.slice(4, end))
}

test('files whole notes hierarchically and appends todo and daily captures', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-test-'))
  let classificationRequests = 0
  let classificationOffline = false
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
      if (classificationOffline) {
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'offline' }))
        return
      }
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
            : note.includes('Attribution description')
              ? { kind: 'note', path: ['attribution'], title: 'Attribution Description', type: 'Note', description: 'Agent description.', tags: ['agent'] }
              : note.includes('Attribution title')
                ? { kind: 'note', path: ['attribution'], title: 'Attribution Title', type: 'Note', description: 'Agent title.', tags: ['agent'] }
                : note.includes('Attribution path')
                  ? { kind: 'note', path: ['attribution'], title: 'Attribution Path', type: 'Note', description: 'Agent path.', tags: ['agent'] }
                  : note.includes('Marker collision capture')
                    ? { kind: 'note', path: ['marker-tests'], title: 'Captured note', type: 'Note', description: 'Marker placement regression.', tags: [] }
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
  assert.equal(meetingResult.filing.draftId, meetingDraftId)
  assert.equal(meetingResult.filing.mode, 'new')
  assert.equal(meetingResult.filing.actor, 'okf-notetaker/llama3.2:3b')
  assert.equal(meetingResult.filing.proposal.filename, path.posix.basename(meetingResult.note.id))
  const forbiddenNewStandalone = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: meetingResult.filing.id, action: 'standalone' }),
  })
  assert.equal(forbiddenNewStandalone.status, 400)
  const quickConfirmation = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmationId: meetingResult.filing.id, action: 'accept', fields: meetingResult.filing.proposal }),
  })
  assert.equal(quickConfirmation.status, 200)
  const repeatedConfirmation = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmationId: meetingResult.filing.id, action: 'accept', fields: meetingResult.filing.proposal }),
  })
  assert.equal((await repeatedConfirmation.json()).idempotent, true)
  const invalidConfirmation = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmationId: meetingResult.filing.id, action: 'accept', fields: { ...meetingResult.filing.proposal, filename: '../bad.md' } }),
  })
  assert.equal(invalidConfirmation.status, 200, 'completed confirmations remain idempotent')
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
  const embeddingCountBeforeEdit = embeddingInputs.length
  const editResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(meetingResult.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: editedInput, refreshEmbeddings: false }),
  })
  const editedMeeting = await editResponse.json()
  assert.equal(editResponse.status, 200, JSON.stringify(editedMeeting))
  assert.equal(editedMeeting.content, editedContent)
  assert.deepEqual(editedMeeting.tags, ['launch', 'morning'])
  assert.equal(classificationRequests, 1)
  assert.match(classificationPrompts[0], /No existing filing options yet/)
  assert.match(classificationPrompts[0], /No relevant existing tag candidates found/)
  assert.equal(embeddingInputs.length, embeddingCountBeforeEdit)
  const editedMeetingPath = path.join(dataRoot, 'bundle', meetingResult.note.id.slice(1))
  const fileBeforeReembed = await fs.readFile(editedMeetingPath, 'utf8')
  const reembedResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(meetingResult.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshEmbeddings: true }),
  })
  const reembeddedMeeting = await reembedResponse.json()
  assert.equal(reembedResponse.status, 200, JSON.stringify(reembeddedMeeting))
  assert.equal(reembeddedMeeting.content, editedContent)
  assert.ok(embeddingInputs.includes(`title: Morning launch meeting | text: The morning meeting covered the launch and its follow-up.\n${editedContent}`))
  assert.ok(embeddingInputs.some((input) => input.startsWith('title: Morning launch meeting | text: ')))
  const editedMeetingFile = await fs.readFile(editedMeetingPath, 'utf8')
  assert.equal(editedMeetingFile, fileBeforeReembed)
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
  assert.equal((await conflictMoveResponse.json()).error, 'That path already contains a conflicting note. Choose another path.')
  assert.equal(await fs.readFile(conflictPath, 'utf8'), conflictMarkdown)
  await fs.access(path.join(dataRoot, 'bundle', movedId.slice(1)))
  const internalMoveResponse = await fetch(`${baseUrl}/api/file/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: movedId, directory: '/references/inbox' }),
  })
  assert.equal(internalMoveResponse.status, 400)
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

  const editedLongResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(longNote.note.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Deep Archive', description: 'Updated archive description.' }),
  })
  const editedLong = await editedLongResponse.json()
  assert.equal(editedLongResponse.status, 200, JSON.stringify(editedLong))
  assert.equal(editedLong.oldId, longNote.note.id)
  assert.equal(editedLong.newId, longNote.note.id)
  assert.equal(editedLong.id, longNote.note.id)
  assert.equal(editedLong.title, 'Deep Archive')
  assert.equal(editedLong.description, 'Updated archive description.')
  const editedLongFile = await fs.readFile(path.join(dataRoot, 'bundle', longNote.note.id.slice(1)), 'utf8')
  assert.match(editedLongFile, /title: Deep Archive/)
  assert.match(editedLongFile, /description: Updated archive description\./)
  const oldLongPathResponse = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(longNote.note.id)}`)
  assert.equal((await oldLongPathResponse.json()).id, longNote.note.id)
  const editedIndex = JSON.parse(await fs.readFile(path.join(dataRoot, 'search-index.json'), 'utf8'))
  assert.ok(editedIndex.some((record) => record.id === longNote.note.id && record.title === 'Deep Archive'))
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

  const soleTodo = await jsonRequest(`${baseUrl}/api/notes`, { content: 'todo: File separately', timeZone: 'America/New_York' })
  assert.equal(soleTodo.appended, false)
  const soleTodoConfirmation = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: soleTodo.filing.id, action: 'standalone', fields: soleTodo.filing.standaloneProposal }),
  })
  assert.equal(soleTodoConfirmation.status, 200)
  await assert.rejects(fs.access(path.join(dataRoot, 'bundle', 'todo-list.md')), { code: 'ENOENT' })

  const soleDaily = await jsonRequest(`${baseUrl}/api/notes`, { content: 'daily: File separately', timeZone: 'America/New_York' })
  assert.equal(soleDaily.appended, false)
  const soleDailyConfirmation = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: soleDaily.filing.id, action: 'standalone', fields: soleDaily.filing.standaloneProposal }),
  })
  assert.equal(soleDailyConfirmation.status, 200)
  await assert.rejects(fs.access(path.join(dataRoot, 'bundle', soleDaily.note.id.slice(1))), { code: 'ENOENT' })

  const [firstTodo, secondTodo] = await Promise.all([
    jsonRequest(`${baseUrl}/api/notes`, { content: 'todo: Buy milk', timeZone: 'America/New_York' }),
    jsonRequest(`${baseUrl}/api/notes`, { content: 'TODO - chores route only\nCall Sam', filedContent: 'Call Sam', timeZone: 'America/New_York' }),
  ])
  assert.equal(firstTodo.note.id, '/todo-list.md')
  assert.equal(secondTodo.note.id, '/todo-list.md')
  assert.deepEqual([firstTodo.appended, secondTodo.appended].sort(), [false, true])
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

  const todoMetadataBeforeAccept = (await fs.readFile(path.join(dataRoot, 'bundle', 'todo-list.md'), 'utf8')).match(/(?:generated|filing):\n(?:  .*\n){1,4}/g)
  const dailyMetadataBeforeAccept = (await fs.readFile(path.join(dataRoot, 'bundle', firstDaily.note.id.slice(1)), 'utf8')).match(/(?:generated|filing):\n(?:  .*\n){1,4}/g)
  for (const filing of [secondTodo.filing, secondDaily.filing]) {
    const accepted = await fetch(`${baseUrl}/api/filing/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filingId: filing.id, action: 'accept', fields: filing.proposal }),
    })
    const acceptedBody = await accepted.json()
    assert.equal(accepted.status, 200, JSON.stringify(acceptedBody))
    assert.equal(acceptedBody.newId, filing.destinationId)
    assert.ok(acceptedBody.notes.length >= 8)
  }
  assert.deepEqual((await fs.readFile(path.join(dataRoot, 'bundle', 'todo-list.md'), 'utf8')).match(/(?:generated|filing):\n(?:  .*\n){1,4}/g), todoMetadataBeforeAccept)
  assert.deepEqual((await fs.readFile(path.join(dataRoot, 'bundle', firstDaily.note.id.slice(1)), 'utf8')).match(/(?:generated|filing):\n(?:  .*\n){1,4}/g), dailyMetadataBeforeAccept)

  const existingAppend = await jsonRequest(`${baseUrl}/api/notes`, {
    content: 'Project Aurora details\nA third capture that must stay appended.',
    timeZone: 'America/New_York',
  })
  assert.equal(existingAppend.appended, true)
  const existingMetadataBeforeAccept = (await fs.readFile(path.join(dataRoot, 'bundle', auroraId.slice(1)), 'utf8')).match(/(?:generated|filing):\n(?:  .*\n){1,4}/g)
  const acceptedExisting = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: existingAppend.filing.id, action: 'accept', fields: existingAppend.filing.proposal }),
  })
  const acceptedExistingBody = await acceptedExisting.json()
  assert.equal(acceptedExisting.status, 200, JSON.stringify(acceptedExistingBody))
  assert.equal(acceptedExistingBody.newId, auroraId)
  assert.deepEqual((await fs.readFile(path.join(dataRoot, 'bundle', auroraId.slice(1)), 'utf8')).match(/(?:generated|filing):\n(?:  .*\n){1,4}/g), existingMetadataBeforeAccept)

  await fs.writeFile(path.join(dataRoot, 'bundle', 'linked.md'), `---\ntitle: Linked\ntype: Note\n---\n\n[Semantic](${semantic.note.id})\n`)
  await fetch(`${baseUrl}/api/reindex`, { method: 'POST' })
  const movedSemantic = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: semantic.filing.id, action: 'accept', fields: { ...semantic.filing.proposal, directory: '/ideas', filename: 'semantic-renamed.md' } }),
  })
  const movedSemanticBody = await movedSemantic.json()
  const semanticFilename = path.posix.basename(semantic.note.id)
  const movedSemanticId = `/ideas/${semanticFilename}`
  assert.equal(movedSemantic.status, 200, JSON.stringify(movedSemanticBody))
  assert.equal(movedSemanticBody.newId, movedSemanticId)
  assert.equal(movedSemanticBody.oldId, semantic.note.id)
  assert.ok((await fs.readFile(path.join(dataRoot, 'bundle', 'linked.md'), 'utf8')).includes(`](${movedSemanticId})`))
  const movedSemanticIndex = JSON.parse(await fs.readFile(path.join(dataRoot, 'search-index.json'), 'utf8'))
  const movedSemanticRecord = movedSemanticIndex.find((record) => record.id === movedSemanticBody.newId)
  assert.ok(movedSemanticRecord.embedding)
  assert.ok(movedSemanticRecord.chunks.length)
  assert.ok(movedSemanticRecord.chunks.every((chunk) => chunk.embedding))
  const retriedMovedSemantic = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: semantic.filing.id, action: 'accept', fields: semantic.filing.proposal }),
  })
  const retriedMovedSemanticBody = await retriedMovedSemantic.json()
  assert.equal(retriedMovedSemantic.status, 200, JSON.stringify(retriedMovedSemanticBody))
  assert.equal(retriedMovedSemanticBody.idempotent, true)
  assert.equal(retriedMovedSemanticBody.oldId, semantic.note.id)

  const [queuedMoveFirst, queuedMoveSecond] = await Promise.all([
    jsonRequest(`${baseUrl}/api/notes`, { content: 'Project Aurora details\nFirst queued move.', timeZone: 'America/New_York' }),
    jsonRequest(`${baseUrl}/api/notes`, { content: 'Project Aurora details\nSecond queued move.', timeZone: 'America/New_York' }),
  ])
  assert.equal(queuedMoveFirst.note.id, auroraId)
  assert.equal(queuedMoveSecond.note.id, auroraId)
  const queuedMoveDestination = { ...queuedMoveFirst.filing.proposal, directory: '/archive', filename: 'aurora-queued-move.md' }
  const queuedFirstConfirmation = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: queuedMoveFirst.filing.id, action: 'accept', fields: queuedMoveDestination }),
  })
  const queuedFirstConfirmationBody = await queuedFirstConfirmation.json()
  const queuedMoveId = `/archive/${path.posix.basename(auroraId)}`
  assert.equal(queuedFirstConfirmation.status, 200, JSON.stringify(queuedFirstConfirmationBody))
  assert.equal(queuedFirstConfirmationBody.newId, queuedMoveId)
  await assert.rejects(fs.access(path.join(dataRoot, 'bundle', auroraId.slice(1))), { code: 'ENOENT' })
  const queuedMovePath = path.join(dataRoot, 'bundle', queuedFirstConfirmationBody.newId.slice(1))
  const filingAfterHumanMove = markdownFrontmatter(await fs.readFile(queuedMovePath, 'utf8')).filing
  const queuedSecondConfirmation = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: queuedMoveSecond.filing.id, action: 'accept', fields: queuedMoveSecond.filing.proposal }),
  })
  const queuedSecondConfirmationBody = await queuedSecondConfirmation.json()
  assert.equal(queuedSecondConfirmation.status, 200, JSON.stringify(queuedSecondConfirmationBody))
  assert.equal(queuedSecondConfirmationBody.oldId, queuedMoveId)
  assert.equal(queuedSecondConfirmationBody.newId, auroraId)
  const filingAfterMechanicalMove = markdownFrontmatter(await fs.readFile(path.join(dataRoot, 'bundle', auroraId.slice(1)), 'utf8')).filing
  assert.equal(filingAfterMechanicalMove.by, filingAfterHumanMove.by)
  assert.equal(filingAfterMechanicalMove.at, filingAfterHumanMove.at)
  const retriedQueuedSecond = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: queuedMoveSecond.filing.id, action: 'accept', fields: queuedMoveSecond.filing.proposal }),
  })
  const retriedQueuedSecondBody = await retriedQueuedSecond.json()
  assert.equal(retriedQueuedSecond.status, 200, JSON.stringify(retriedQueuedSecondBody))
  assert.equal(retriedQueuedSecondBody.idempotent, true)
  assert.equal(retriedQueuedSecondBody.oldId, queuedFirstConfirmationBody.newId)
  assert.equal(retriedQueuedSecondBody.newId, auroraId)

  const internalStandalone = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmationId: mergedAurora.filing.id, action: 'standalone', fields: { ...mergedAurora.filing.standaloneProposal, directory: '/references/inbox' } }),
  })
  assert.equal(internalStandalone.status, 400)
  assert.match(await fs.readFile(path.join(dataRoot, 'bundle', auroraId.slice(1)), 'utf8'), /The launch budget was approved\./)
  const standaloneAuroraResponse = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmationId: mergedAurora.filing.id, action: 'standalone', fields: { ...mergedAurora.filing.standaloneProposal, filename: '../bad.md' } }),
  })
  assert.equal(standaloneAuroraResponse.status, 200)
  const standaloneAurora = await standaloneAuroraResponse.json()
  assert.equal(standaloneAurora.note.id, `${mergedAurora.filing.standaloneProposal.directory}/${mergedAurora.filing.standaloneProposal.filename}`)
  assert.equal(standaloneAurora.notes.length, 12)
  assert.equal(standaloneAurora.note.type, 'Project')
  assert.match(await fs.readFile(path.join(dataRoot, 'bundle', standaloneAurora.note.id.slice(1)), 'utf8'), /filing:\n  by: human:local/)
  assert.match(await fs.readFile(path.join(dataRoot, 'bundle', auroraId.slice(1)), 'utf8'), /The launch remains confidential\./)
  assert.doesNotMatch(await fs.readFile(path.join(dataRoot, 'bundle', auroraId.slice(1)), 'utf8'), /The launch budget was approved\./)
  assert.match(await fs.readFile(path.join(dataRoot, 'bundle', standaloneAurora.note.id.slice(1)), 'utf8'), /The launch budget was approved\./)

  const shortCapture = await jsonRequest(`${baseUrl}/api/notes`, {
    content: 'Marker collision capture\nCaptured note',
    filedContent: 'Captured note',
    timeZone: 'America/New_York',
  })
  const shortCaptureFile = await fs.readFile(path.join(dataRoot, 'bundle', shortCapture.note.id.slice(1)), 'utf8')
  assert.match(shortCaptureFile, /# Captured note\n\n<!-- folio:capture:confirmation:[a-f0-9]{24}:start -->\nCaptured note\n<!-- folio:capture:confirmation:[a-f0-9]{24}:end -->/)
  assert.doesNotMatch(shortCaptureFile, /# Captured <!-- folio:capture/)
  const shortCaptureDetail = await (await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(shortCapture.note.id)}`)).json()
  assert.equal(shortCaptureDetail.content, 'Captured note')

  const orderedTargetPath = path.join(dataRoot, 'bundle', auroraId.slice(1))
  const orderedBase = markdownFrontmatter(await fs.readFile(orderedTargetPath, 'utf8'))
  const orderedFirst = await jsonRequest(`${baseUrl}/api/notes`, {
    content: 'Project Aurora details\nOlder pending metadata contribution.',
    timeZone: 'America/New_York',
  })
  const orderedSecond = await jsonRequest(`${baseUrl}/api/notes`, {
    content: 'Project Aurora details\nNewer pending metadata contribution.',
    timeZone: 'America/New_York',
  })
  const newestGenerated = markdownFrontmatter(await fs.readFile(orderedTargetPath, 'utf8')).generated
  const separateOrderedFirst = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: orderedFirst.filing.id, action: 'standalone', fields: orderedFirst.filing.standaloneProposal }),
  })
  assert.equal(separateOrderedFirst.status, 200)
  const afterFirstRemoval = markdownFrontmatter(await fs.readFile(orderedTargetPath, 'utf8'))
  assert.deepEqual(afterFirstRemoval.tags, orderedBase.tags)
  assert.deepEqual(afterFirstRemoval.generated, newestGenerated)
  const separateOrderedSecond = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: orderedSecond.filing.id, action: 'standalone', fields: orderedSecond.filing.standaloneProposal }),
  })
  assert.equal(separateOrderedSecond.status, 200)
  const afterBothRemovals = markdownFrontmatter(await fs.readFile(orderedTargetPath, 'utf8'))
  assert.deepEqual(afterBothRemovals.tags, orderedBase.tags)
  assert.deepEqual(afterBothRemovals.generated, orderedBase.generated)

  let freshDaily
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Honolulu']) {
    const candidate = await jsonRequest(`${baseUrl}/api/notes`, {
      content: `daily: Temporary standalone entry for ${zone}.`,
      timeZone: zone,
    })
    if (!candidate.appended) {
      freshDaily = candidate
      break
    }
    await fetch(`${baseUrl}/api/filing/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filingId: candidate.filing.id, action: 'accept', fields: candidate.filing.proposal }),
    })
  }
  assert.ok(freshDaily, 'the extreme time zones must provide an unused daily date')
  const separatedFreshDailyResponse = await fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: freshDaily.filing.id, action: 'standalone', fields: freshDaily.filing.standaloneProposal }),
  })
  const separatedFreshDaily = await separatedFreshDailyResponse.json()
  assert.equal(separatedFreshDailyResponse.status, 200, JSON.stringify(separatedFreshDaily))
  assert.equal(separatedFreshDaily.sourceRemoved, true)
  await assert.rejects(fs.access(path.join(dataRoot, 'bundle', freshDaily.note.id.slice(1))))

  const attributionCases = [
    {
      content: 'Attribution description',
      fields: (filing) => ({ ...filing.proposal, description: 'Human description.' }),
      generated: 'human:local', filing: 'okf-notetaker/llama3.2:3b',
    },
    {
      content: 'Attribution title',
      fields: (filing) => ({ ...filing.proposal, title: 'Human title' }),
      generated: 'human:local', filing: 'human:local',
    },
    {
      content: 'Attribution path',
      fields: (filing) => ({ ...filing.proposal, directory: '/corrected', filename: 'ignored-name.md' }),
      generated: 'okf-notetaker/llama3.2:3b', filing: 'human:local',
    },
  ]
  for (const attribution of attributionCases) {
    const captured = await jsonRequest(`${baseUrl}/api/notes`, { content: attribution.content, timeZone: 'America/New_York' })
    const confirmed = await fetch(`${baseUrl}/api/filing/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filingId: captured.filing.id, action: 'accept', fields: attribution.fields(captured.filing) }),
    })
    const confirmedBody = await confirmed.json()
    assert.equal(confirmed.status, 200, JSON.stringify(confirmedBody))
    if (attribution.content === 'Attribution path')
      assert.equal(path.posix.basename(confirmedBody.newId), path.posix.basename(captured.note.id))
    const filed = await fs.readFile(path.join(dataRoot, 'bundle', confirmedBody.newId.slice(1)), 'utf8')
    assert.match(filed, new RegExp(`generated:\\n  by: ${attribution.generated}`))
    assert.match(filed, new RegExp(`filing:\\n  by: ${attribution.filing}`))
    const confirmedIndex = JSON.parse(await fs.readFile(path.join(dataRoot, 'search-index.json'), 'utf8'))
    const confirmedRecord = confirmedIndex.find((record) => record.id === confirmedBody.newId)
    assert.ok(confirmedRecord.embedding)
    assert.ok(confirmedRecord.chunks.every((chunk) => chunk.embedding))
  }

  const concurrentCapture = await jsonRequest(`${baseUrl}/api/notes`, { content: 'Concurrent confirmation capture', timeZone: 'America/New_York' })
  const concurrentResponses = await Promise.all([0, 1].map(() => fetch(`${baseUrl}/api/filing/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filingId: concurrentCapture.filing.id, action: 'accept', fields: concurrentCapture.filing.proposal }),
  }).then(async (result) => ({ status: result.status, body: await result.json() }))))
  assert.deepEqual(concurrentResponses.map((result) => result.status), [200, 200])
  assert.equal(concurrentResponses.filter((result) => result.body.idempotent).length, 1)

  classificationOffline = true
  const offline = await jsonRequest(`${baseUrl}/api/notes`, { content: 'Offline capture', timeZone: 'America/New_York' })
  assert.equal(offline.filing.actor, 'process:folio-fallback')
  assert.match(await fs.readFile(path.join(dataRoot, 'bundle', offline.note.id.slice(1)), 'utf8'), /filing:\n  by: process:folio-fallback/)

  const notesResponse = await fetch(`${baseUrl}/api/notes`)
  const notes = await notesResponse.json()
  assert.ok(notes.length >= 19)
})
