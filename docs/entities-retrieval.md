# Entity-scoped retrieval

`GET /api/search` accepts `entityIds` as a comma-separated list of 1–20 entity IDs. IDs are validated against the captured bundle’s durable entity catalog. Unknown IDs, including IDs that belong only to another bundle, return `400`; known entities with no current mentions return an empty result set and coverage metadata. Scoped calls retain the legacy array response unless `includeScope=true`, which returns `{ items, scope }`. `scope` contains the selected IDs and labels, entity coverage, `incomplete`, the number of returned notes, and the entity ledger/index revisions. Search text and tags are applied after the entity intersection. An empty query and tag can therefore enumerate notes within a valid scope.

`POST /api/ask` accepts the same optional ID list as a JSON array. When present, only notes that contain every selected entity can enter retrieval or answer context. Its response adds the same `scope` metadata. If entity state is damaged or unavailable, an explicit entity-scoped request returns `503`; unscoped search and Ask retain their existing behavior. Scope never broadens after validation or freshness failures.

Entity mentions route candidate selection; they do not provide evidence. Retrieval intersects IDs first, applies query/tag ranking to that candidate set, then hydrates at most the top 80 candidates from current Markdown. Ask uses the existing Ask ranker to shortlist and carries its query embedding forward, so temporal and semantic candidate behavior is preserved without computing the query embedding twice. Before a candidate can be returned, retrieval verifies each mention against the current projected-body hash and exact UTF-16 span. Changed bodies invalidate cached embeddings and chunks for that request; read or span mismatches are dropped and mark scope incomplete. The Ask prompt receives excerpts from those current bodies and explicitly warns that co-mention does not establish a relationship. Search and Ask do not run entity extraction; their existing embedding and Ask generation calls remain in place.

Full entity names and confirmed aliases can be resolved by the query helper. A one-word person name remains unresolved, including when it is a first name shared by multiple people. Entity-name query boosting is disabled: current fixtures establish safe intersection behavior, but do not establish a relevance gain that justifies changing ranking.

## Fixed retrieval evaluation

`test/entities-retrieval-evaluation.test.js` uses fictional English and Norwegian notes and exercises production scope preparation, search/Ask ranking, source projection, and current-file validation. The lexical search cases produce:

| Case | Unscoped relevant / returned | Entity-scoped relevant / returned |
| --- | ---: | ---: |
| English Acme + Atlas launch | 2 / 5 (P 0.40, R 1.00) | 2 / 2 (P 1.00, R 1.00) |
| Norwegian Fjord Labs + Nordlys launch | 1 / 2 (P 0.50, R 1.00) | 1 / 1 (P 1.00, R 1.00) |
| Norwegian “yesterday” Ask | 1 / 2 (P 0.50, R 1.00) | 1 / 1 (P 1.00, R 1.00) |

The test also verifies first-name ambiguity (`Priya` matches neither of two people), unique full-name matching, negated wording, exact current-source passages, and stale-source exclusion with `incomplete=true`. The metric is note-level relevance for this small fixed set. Entity filtering changes the eligible candidate pool; these results support the explicit intersection contract and do not establish a general retrieval gain or justify free-query boosting. The fixtures do not measure generated answer quality, semantic embedding quality, or broad English/Norwegian performance.
