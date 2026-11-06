import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMentions } from '../server/entities/resolution.js';

test('identity scoring uses production resolution and keeps first names unresolved', () => {
  const state = { entities: [], mentionDecisions: [] };
  const first = resolveMentions([
    { id: 'note-a:0', text: 'Acme', type: 'organization' },
    { id: 'note-a:1', text: 'Priya', type: 'person' },
    { id: 'note-a:2', text: 'Priya Sharma', type: 'person' },
  ], state);
  state.entities = first.entities;
  const second = resolveMentions([
    { id: 'note-b:0', text: 'Acme', type: 'organization' },
    { id: 'note-b:1', text: 'Priya Sharma', type: 'person' },
  ], state);
  assert.equal(first.mentions[0].entityId, second.mentions[0].entityId);
  assert.equal(first.mentions[1].resolution, 'ambiguous');
  assert.equal(first.mentions[1].entityId, null);
  assert.notEqual(first.mentions[2].entityId, second.mentions[1].entityId);
});
