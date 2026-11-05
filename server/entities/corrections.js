import { entityId, entityKey, normalizeEntityLabel } from './model.js'

const MAX_MENTION_IDS = 500

export function applyEntityCommand({ command, mentions, userState, bundleId }) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('A correction command is required.')
  const entities = userState.entities.map((entity) => ({ ...entity, aliases: [...(entity.aliases || [])] }))
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  const updatedMentions = mentions.map((mention) => ({ ...mention }))
  const selectedMentions = (ids) => {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_MENTION_IDS) throw new Error('Select between 1 and 500 mentions.')
    const wanted = new Set(ids.map(String))
    const selected = updatedMentions.filter((mention) => wanted.has(mention.id))
    if (selected.length !== wanted.size) throw new Error('One or more mentions were not found in this bundle.')
    return selected
  }
  const entity = (id) => {
    const value = byId.get(String(id))
    if (!value) throw new Error('Entity not found.')
    return value
  }
  let inverse = null
  switch (command.type) {
    case 'rename': {
      const target = entity(command.entityId); const label = normalizeEntityLabel(command.label)
      if (!label || label.length > 160) throw new Error('Entity label must contain 1 to 160 characters.')
      inverse = { type: 'rename', entityId: target.id, label: target.label }
      if (entityKey(target.type, target.label) !== entityKey(target.type, label)
        && !target.aliases.some((alias) => entityKey(target.type, alias) === entityKey(target.type, target.label))) target.aliases.push(target.label)
      target.label = label; target.updatedAt = new Date().toISOString(); break
    }
    case 'retype': {
      const target = entity(command.entityId)
      if (!['person', 'organization', 'project', 'product', 'location'].includes(command.entityType)) throw new Error('Invalid entity type.')
      const assigned = updatedMentions.filter((mention) => mention.entityId === target.id)
      inverse = { type: 'restore-retype', entityId: target.id, entityType: target.type, assignments: assigned.map((mention) => ({ mentionId: mention.id, type: mention.type })) }
      target.type = command.entityType
      for (const mention of assigned) mention.type = command.entityType
      target.updatedAt = new Date().toISOString(); break
    }
    case 'add-alias': case 'remove-alias': {
      const target = entity(command.entityId); const alias = normalizeEntityLabel(command.alias)
      if (!alias || alias.length > 160) throw new Error('Alias must contain 1 to 160 characters.')
      const exists = target.aliases.some((value) => entityKey(target.type, value) === entityKey(target.type, alias))
      if (command.type === 'add-alias') {
        if (!exists && entityKey(target.type, alias) !== entityKey(target.type, target.label)) target.aliases.push(alias)
        inverse = { type: 'remove-alias', entityId: target.id, alias }
      } else {
        if (!exists) throw new Error('Alias not found.')
        const removed = target.aliases.find((value) => entityKey(target.type, value) === entityKey(target.type, alias))
        target.aliases = target.aliases.filter((value) => entityKey(target.type, value) !== entityKey(target.type, alias))
        inverse = { type: 'add-alias', entityId: target.id, alias: removed }
      }
      break
    }
    case 'merge': {
      const from = entity(command.entityId); const into = entity(command.targetEntityId)
      if (from.id === into.id || from.type !== into.type) throw new Error('Entities must be distinct and have the same type to merge.')
      const moved = updatedMentions.filter((mention) => mention.entityId === from.id)
      inverse = { type: 'restore-merge', entity: from, targetEntityId: into.id, mentionIds: moved.map((mention) => mention.id) }
      for (const mention of moved) { mention.entityId = into.id; mention.resolution = 'resolved'; mention.resolutionProvenance = 'user' }
      if (!into.aliases.some((alias) => entityKey(into.type, alias) === entityKey(from.type, from.label)) && entityKey(into.type, into.label) !== entityKey(from.type, from.label)) into.aliases.push(from.label)
      entities.splice(entities.indexOf(from), 1)
      userState = { ...userState, entities, doNotMerge: userState.doNotMerge.filter((pair) => pair.leftEntityId !== from.id && pair.rightEntityId !== from.id) }
      break
    }
    case 'split': case 'reassign': {
      const chosen = selectedMentions(command.mentionIds)
      if (command.type === 'split') {
        const source = command.entityId ? entity(command.entityId) : null
        const label = normalizeEntityLabel(command.label || chosen[0].text)
        const type = command.entityType || source?.type || chosen[0].type
        if (!label || label.length > 160 || !['person', 'organization', 'project', 'product', 'location'].includes(type)) throw new Error('A split needs a valid label and type.')
        const created = { id: entityId(), type, label, aliases: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), identitySource: 'user' }
        entities.push(created)
        inverse = { type: 'restore-split', mentionIds: chosen.map((mention) => mention.id), assignments: chosen.map((mention) => ({ mentionId: mention.id, entityId: mention.entityId, resolution: mention.resolution, resolutionProvenance: mention.resolutionProvenance })), entityId: created.id }
        for (const mention of chosen) { mention.entityId = created.id; mention.resolution = 'resolved'; mention.resolutionProvenance = 'user' }
      } else {
        const destination = command.entityId ? entity(command.entityId) : null
        inverse = { type: 'reassign', mentionIds: chosen.map((mention) => mention.id), assignments: chosen.map((mention) => ({ mentionId: mention.id, entityId: mention.entityId, resolution: mention.resolution, resolutionProvenance: mention.resolutionProvenance })) }
        for (const mention of chosen) {
          if (destination && destination.type !== mention.type) throw new Error('Mention and entity types must match.')
          mention.entityId = destination?.id || null; mention.resolution = destination ? 'resolved' : 'unresolved'; mention.resolutionProvenance = 'user'
        }
      }
      break
    }
    case 'dismiss': case 'restore': {
      const chosen = selectedMentions(command.mentionIds)
      inverse = { type: command.type === 'dismiss' ? 'restore' : 'dismiss', mentionIds: chosen.map((mention) => mention.id) }
      for (const mention of chosen) mention.status = command.type === 'dismiss' ? 'dismissed' : 'active'
      break
    }
    case 'do-not-merge': {
      const left = entity(command.leftEntityId); const right = entity(command.rightEntityId)
      if (left.id === right.id || left.type !== right.type) throw new Error('Choose two distinct entities of the same type.')
      const pair = { leftEntityId: left.id, rightEntityId: right.id, type: left.type, leftKey: entityKey(left.type, left.label), rightKey: entityKey(right.type, right.label) }
      const doNotMerge = [...userState.doNotMerge, pair]
      inverse = { type: 'allow-merge', leftEntityId: left.id, rightEntityId: right.id }
      userState = { ...userState, entities, doNotMerge }
      break
    }
    case 'link-note': case 'unlink-note': {
      const target = entity(command.entityId); const noteId = String(command.noteId || '')
      if (!noteId.startsWith('/') || noteId.includes('..') || noteId.includes('\\')) throw new Error('Invalid note ID.')
      const noteLinks = userState.noteLinks.filter((link) => !(link.entityId === target.id && link.noteId === noteId))
      if (command.type === 'link-note') noteLinks.push({ entityId: target.id, noteId })
      inverse = { type: command.type === 'link-note' ? 'unlink-note' : 'link-note', entityId: target.id, noteId }
      userState = { ...userState, entities, noteLinks }
      break
    }
    default: throw new Error(`Unknown entity correction command: ${String(command.type || '')}`)
  }
  void bundleId
  return { mentions: updatedMentions, userState: { ...userState, entities }, inverse }
}
