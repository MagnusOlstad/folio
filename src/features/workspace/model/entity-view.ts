import type { EntityMention, EntityType } from "../../../domain/entities.ts";

export const ENTITY_TYPE_ORDER: readonly EntityType[] = ["person", "organization", "project", "product", "location"];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  person: "People",
  organization: "Organizations",
  project: "Projects",
  product: "Products and tools",
  location: "Locations",
};

export function groupMentionsByType(mentions: readonly EntityMention[]) {
  return ENTITY_TYPE_ORDER.map((type) => ({
    type,
    label: ENTITY_TYPE_LABELS[type],
    mentions: mentions.filter((mention) => mention.type === type && mention.status === "active"),
  })).filter((group) => group.mentions.length > 0);
}

export function exactMentionRange(mention: EntityMention, content: string) {
  const { displayStartUtf16: from, displayEndUtf16: to } = mention;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > content.length) return null;
  return content.slice(from, to) === mention.text ? { from, to } : null;
}

export async function sourceMatchesHash(content: string, expectedHash: string) {
  if (!globalThis.crypto?.subtle || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  const bytes = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return actual === expectedHash.toLowerCase();
}

export function visibleResolution(mention: EntityMention) {
  if (mention.status === "dismissed") return "Dismissed";
  if (mention.resolution === "ambiguous") return "Ambiguous identity";
  if (mention.resolution === "unresolved") return "Unresolved identity";
  return "Resolved";
}
