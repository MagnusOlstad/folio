const record = ({ id, title, type, description, tags = [], content, embedding = null }) => ({
  id,
  title,
  type,
  description,
  tags,
  content,
  status: 'active',
  chunks: [],
  embedding,
})

const atlasLaunchPlan = record({
  id: '/projects/atlas/launch-plan.md',
  title: 'Atlas launch plan',
  type: 'Project Plan',
  description: 'Milestones, owners, and launch criteria for the Atlas research workspace.',
  tags: ['atlas', 'launch', 'research'],
  content: 'Atlas is a research workspace for coordinating the field teams, data import, and public release. The launch plan tracks owners, milestones, and release decisions.',
})

const observabilityGuide = record({
  id: '/engineering/observability/alert-policy.md',
  title: 'Service alert policy',
  type: 'Engineering Guide',
  description: 'Alert thresholds and response practices for service reliability.',
  tags: ['observability', 'reliability', 'on-call'],
  content: 'The observability guide covers dashboards, latency budgets, service-level objectives, alert routing, and on-call response.',
})

const coastalArchive = record({
  id: '/zz-community/archive/coastal-map.md',
  title: 'Community map archive',
  type: 'Reference',
  description: 'An archive of maps contributed by local groups.',
  tags: ['community-maps'],
  content: 'The archive stores maps and notes contributed by community groups.',
})

const filingEvaluationRecords = [
  atlasLaunchPlan,
  observabilityGuide,
  coastalArchive,
  record({
    id: '/studio/ceramics/glaze-tests.md',
    title: 'Glaze test notebook',
    type: 'Studio Notebook',
    description: 'Test tiles and firing notes for the blue ash glaze.',
    tags: ['ceramics', 'glaze'],
    content: 'The blue ash glaze tests compare cone 6 firing, clay bodies, and surface finish on small test tiles.',
  }),
]

// Keep one valid but low-ranked existing destination beyond the classifier's
// default thirty-folder guide. The steering hint should still make it visible.
for (let index = 1; index <= 35; index += 1) {
  const suffix = String(index).padStart(2, '0')
  filingEvaluationRecords.push(record({
    id: `/catalog/group-${suffix}/reference.md`,
    title: `Catalog reference ${suffix}`,
    type: 'Reference',
    description: `A neutral catalog reference for group ${suffix}.`,
    content: `General catalog material for group ${suffix}.`,
  }))
}

const repeatedLongNote = Array.from({ length: 20 }, (_, index) => (
  `The field team reviewed sample batch ${index + 1}, confirmed the sensor clock was synchronized, and recorded the calibration conditions in the shared lab notebook. `
)).join('\n')

export const filingEvaluationCases = [
  {
    id: 'reuses-existing-concept-for-clear-continuation',
    content: 'Atlas launch plan update: the field import milestone moved to 14 October after the data review. Keep the existing owners and release checklist; this is an update to the same launch plan.',
    checks: [
      { type: 'record-title-and-path', recordId: atlasLaunchPlan.id },
    ],
  },
  {
    id: 'new-topic-finds-a-specific-path',
    content: '# Choir warm-up intervals\n\nThe community choir will use a five-minute warm-up that moves from unison scales into simple thirds. I wrote down a starting pitch, two breathing cues, and a slower alternative for new singers.',
    checks: [
      { type: 'path-includes', segment: 'music' },
      { type: 'path-not-equals', path: ['projects', 'atlas'] },
      { type: 'path-not-equals', path: ['engineering', 'observability'] },
      { type: 'heading-title', heading: 'Choir warm-up intervals' },
    ],
  },
  {
    id: 'reuses-an-existing-tag-and-concise-heading',
    content: '# Latency alert thresholds\n\nFor the service dashboard, alert when p95 latency stays above 450 ms for five minutes. Route the page to the reliability on-call rotation and include the observability dashboard link in the incident ticket.',
    checks: [
      { type: 'tag-includes', tag: 'observability' },
      { type: 'heading-title', heading: 'Latency alert thresholds' },
      { type: 'title-max-words', maxWords: 8 },
    ],
  },
  {
    id: 'matched-steering-surfaces-low-ranked-folder',
    content: 'Notes from the neighborhood shoreline walk: volunteers recorded three public access points, photographed the north inlet, and marked where the paper map needs a scale bar.',
    steering: 'path: zz-community/archive',
    checks: [
      { type: 'path-equals', path: ['zz-community', 'archive'] },
    ],
  },
  {
    id: 'unmatched-steering-yields-to-note-topic',
    content: '# Kiln cooling experiment\n\nThe ceramics studio will compare a slow kiln cool with the standard schedule for the blue ash glaze. Record the color and pinhole count on each test tile.',
    steering: 'Maybe put this under travel/mars if that fits.',
    checks: [
      { type: 'path-includes', segment: 'ceramics' },
      { type: 'path-not-equals', path: ['travel', 'mars'] },
    ],
  },
  {
    id: 'relative-date-is-resolved-in-metadata',
    content: '# Send permit revisions tomorrow\n\nTomorrow I will send the revised permit drawings to the review office and ask whether the access ramp detail is sufficient.',
    now: '2026-10-01T12:00:00.000Z',
    timeZone: 'Europe/Oslo',
    checks: [
      { type: 'metadata-includes', text: '2026-10-02' },
    ],
  },
  {
    id: 'relative-date-crosses-local-midnight',
    content: '# Office handoff tomorrow\n\nTomorrow I will send the revised access drawings to the review office and ask whether the ramp detail is sufficient.',
    now: '2026-10-01T22:30:00.000Z',
    timeZone: 'Europe/Oslo',
    checks: [
      { type: 'metadata-includes', text: '2026-10-03' },
    ],
  },
  {
    id: 'long-note-keeps-late-detail-in-metadata',
    content: `# Calibration review\n\n${repeatedLongNote}\nFinal decision: do not approve the instrument for release; the drift remains outside tolerance until a second calibration confirms the correction.`,
    checks: [
      { type: 'metadata-one-of', texts: ['do not approve', 'not approved', 'not to approve'] },
      { type: 'metadata-includes', text: 'outside tolerance' },
    ],
  },
  {
    id: 'mentions-create-a-deterministic-related-link',
    content: 'This note updates the Atlas launch plan after the field data review. The launch checklist still needs one owner for the import gate; see [the plan](/projects/atlas/launch-plan.md).',
    checks: [
      { type: 'related-link', recordId: atlasLaunchPlan.id },
    ],
  },
  {
    id: 'semantic-similarity-creates-a-related-link',
    content: 'The research workspace rollout must coordinate field teams, data imports, milestone owners, and release readiness before it becomes public. The current implementation plan is still waiting on one clear release gate.',
    checks: [
      { type: 'related-link', recordId: atlasLaunchPlan.id },
    ],
  },
  {
    id: 'unrelated-topic-does-not-create-an-atlas-link',
    content: '# Sourdough starter schedule\n\nRefresh the rye starter with equal weights of flour and water each morning. Keep the jar near the kitchen window and record how long it takes to double in volume.',
    checks: [
      { type: 'related-link', recordId: atlasLaunchPlan.id, present: false },
    ],
  },
]

export function createFilingEvaluationRecords(embedDocument) {
  const embeddableIds = new Set([
    atlasLaunchPlan.id,
    observabilityGuide.id,
    '/studio/ceramics/glaze-tests.md',
  ])
  return Promise.all(filingEvaluationRecords.map(async (item) => ({
    ...item,
    embedding: embeddableIds.has(item.id)
      ? await embedDocument(item.title, `${item.description}\n${item.content}`)
      : null,
  })))
}
