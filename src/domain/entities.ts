export type EntityType = "person" | "organization" | "project" | "product" | "location";
export type EntityResolutionStatus = "resolved" | "unresolved" | "ambiguous";
export type EntityResolutionProvenance = "model" | "rule" | "user";
export type EntityMentionStatus = "active" | "dismissed";

/** Durable assignment state; an API mention combines this view with extracted span fields. */
export type EntityResolution = {
  id: string;
  bundleId: string;
  mentionId: string;
  entityId: string | null;
  status: EntityResolutionStatus;
  provenance: EntityResolutionProvenance;
  correctedType?: EntityType;
  updatedAt: string;
};

export type ExtractionFingerprint = {
  projectionVersion: number;
  schemaVersion: string;
  model: string;
  modelRevision: string;
  preprocessingVersion: string;
  inputHash: string;
};

export type EntityMention = {
  id: string;
  bundleId: string;
  noteId: string;
  blockId: string | null;
  contentHash: string;
  projectionVersion: number;
  startUtf16: number;
  endUtf16: number;
  rawStartUtf16: number;
  rawEndUtf16: number;
  displayStartUtf16: number;
  displayEndUtf16: number;
  text: string;
  type: EntityType;
  score: number | null;
  extractionFingerprint: ExtractionFingerprint | null;
  provenance: Record<string, string | number | boolean | null>;
  entityId: string | null;
  resolution: EntityResolutionStatus;
  resolutionProvenance: EntityResolutionProvenance;
  status: EntityMentionStatus;
  correctedType?: EntityType;
};

export type Entity = {
  id: string;
  bundleId?: string;
  type: EntityType;
  label: string;
  aliases: string[];
  linkedNoteId?: string | null;
  mentionCount: number;
  noteCount: number;
  createdAt: string;
  updatedAt: string;
  identitySource?: "model" | "rule" | "user";
};

export type EntityCoverage = {
  eligible: number;
  processed: number;
  stale: number;
  failed: number;
  pending: number;
};

export type EntityJobReason = "save" | "capture" | "import" | "transcription" | "ocr" | "enablement" | "startup" | "rebuild" | "history-restore" | "manual" | "move";

export type EntityJobItem = {
  noteId: string;
  state: "queued" | "running" | "paused" | "complete" | "stale" | "failed" | "cancelled";
  attempts: number;
  error?: string;
  resultCount?: number;
  reused?: boolean;
  updatedAt: string;
};

export type EntityJob = {
  id: string;
  bundleId: string;
  noteIds: string[];
  reason: EntityJobReason;
  state: "queued" | "running" | "paused" | "complete" | "partial" | "failed" | "cancelled";
  completed: number;
  total: number;
  error: string | null;
  items: EntityJobItem[];
  createdAt: string;
  updatedAt: string;
};

export type EntityJobMode = "running" | "paused" | "disabled" | "model_missing" | "helper_unavailable" | "unsupported_platform" | "closed";
export type EntityJobSnapshot = { bundleId: string; mode: EntityJobMode; queued: number; running: number; paused: number; revision: number; closed: boolean };

export type EntityCorrectionCommand =
  | { type: "rename"; entityId: string; label: string }
  | { type: "retype"; entityId: string; entityType: EntityType }
  | { type: "add-alias" | "remove-alias"; entityId: string; alias: string }
  | { type: "merge"; entityId: string; targetEntityId: string }
  | { type: "split"; entityId?: string; mentionIds: string[]; label?: string; entityType?: EntityType }
  | { type: "reassign"; mentionIds: string[]; entityId: string | null }
  | { type: "dismiss" | "restore"; mentionIds: string[] }
  | { type: "do-not-merge"; leftEntityId: string; rightEntityId: string }
  | { type: "link-note" | "unlink-note"; entityId: string; noteId: string };

export type EntityCorrectionScope =
  | { kind: "bundle" }
  | { kind: "entity"; entityIds: string[] }
  | { kind: "mentions"; mentionIds: string[] };

export type EntityCorrectionInverse =
  | { type: "restore-merge"; entity: Entity; targetEntityId: string; mentionIds: string[] }
  | { type: "restore-split"; entityId: string; mentionIds: string[]; assignments: Array<{ mentionId: string; entityId: string | null; resolution: EntityResolutionStatus; resolutionProvenance: EntityResolutionProvenance }> }
  | { type: "allow-merge"; leftEntityId: string; rightEntityId: string }
  | { type: "restore-retype"; entityId: string; entityType: EntityType; assignments: Array<{ mentionId: string; type: EntityType }> }
  | { type: "reassign"; mentionIds: string[]; assignments: Array<{ mentionId: string; entityId: string | null; resolution: EntityResolutionStatus; resolutionProvenance: EntityResolutionProvenance }> };

export type EntityCorrection = {
  id: string;
  bundleId: string;
  expectedCorrectionRevision: number;
  revision: number;
  command: EntityCorrectionCommand;
  scope: EntityCorrectionScope;
  inverse: EntityCorrectionCommand | EntityCorrectionInverse;
  undoToken: string;
  authoredAt: string;
};

export type EntityPage<T> = {
  items: T[];
  nextCursor: string | null;
  revision?: number;
  indexRevision?: number;
  stale?: boolean;
  coverage?: EntityCoverage;
};
export type EntityListPage = EntityPage<Entity> & { coverage: EntityCoverage };

export type EntityNoteMentions = {
  items: EntityMention[];
  staleCount: number;
  freshness: "current" | "stale";
  coverage: { contentHash: string; extractionFingerprint: ExtractionFingerprint | null; status: string; updatedAt: string } | null;
};

export type EntityCorrectionResult = { revision: number; indexRevision: number; undoToken?: string };
