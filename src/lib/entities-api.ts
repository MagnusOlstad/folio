import { api, apiForBundle } from "./api.ts";
import type {
  Entity, EntityCorrectionCommand, EntityCorrectionResult, EntityListPage, EntityMention,
  EntityAnalysisSettings, EntityJob, EntityJobPage, EntityJobReason, EntityNoteMentions,
  EntityPage, EntityRelatedPage, EntityUndoState,
} from "../domain/entities.ts";

export type EntityListOptions = { q?: string; type?: Entity["type"]; activity?: "active" | "stale" | "all"; cursor?: string; limit?: number; signal?: AbortSignal };

function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") query.set(key, String(value));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

type RequestOptions = { signal?: AbortSignal };
type EntityApi = {
  list(options?: EntityListOptions): Promise<EntityListPage>;
  detail(entityId: string, options?: RequestOptions): Promise<Entity & { noteIds: string[]; revision: number }>;
  mentions(entityId: string, cursor?: string, limit?: number, options?: RequestOptions): Promise<EntityPage<EntityMention>>;
  noteMentions(noteId: string, options?: RequestOptions & { includeDismissed?: boolean }): Promise<EntityNoteMentions>;
  correct(expectedRevision: number, command: EntityCorrectionCommand, options?: RequestOptions): Promise<EntityCorrectionResult>;
  undo(expectedRevision: number, undoToken: string, options?: RequestOptions): Promise<EntityCorrectionResult>;
  latestUndo(options?: RequestOptions): Promise<EntityUndoState>;
  settings(options?: RequestOptions): Promise<EntityAnalysisSettings>;
  setEnabled(enabled: boolean, options?: RequestOptions): Promise<EntityAnalysisSettings>;
  related(noteId: string, cursor?: string, limit?: number, options?: RequestOptions): Promise<EntityRelatedPage>;
  requestJob(input: { noteIds?: string[]; force?: boolean; reason?: EntityJobReason }, options?: RequestOptions): Promise<EntityJob>;
  jobs(cursor?: string, limit?: number, options?: RequestOptions): Promise<EntityJobPage>;
  job(jobId: string, options?: RequestOptions): Promise<EntityJob>;
  jobAction(jobId: string, action: "pause" | "resume" | "cancel", options?: RequestOptions): Promise<EntityJob>;
};

function createApi(bundleId: string | null): EntityApi {
  const request = <T>(url: string, options?: RequestInit) => bundleId
    ? apiForBundle<T>(bundleId, url, options)
    : api<T>(url, options);
  return {
    list(options = {}) {
      return request<EntityListPage>(`/api/entities${queryString({ q: options.q, type: options.type, activity: options.activity, cursor: options.cursor, limit: options.limit })}`, { signal: options.signal });
    },
    detail(entityId, options = {}) {
      return request<Entity & { noteIds: string[]; revision: number }>(`/api/entities/${encodeURIComponent(entityId)}`, { signal: options.signal });
    },
    mentions(entityId, cursor, limit, options = {}) {
      return request<EntityPage<EntityMention>>(`/api/entities/${encodeURIComponent(entityId)}/mentions${queryString({ cursor, limit })}`, { signal: options.signal });
    },
    noteMentions(noteId, options = {}) {
      return request<EntityNoteMentions>(`/api/entities/mentions${queryString({ noteId, includeDismissed: options.includeDismissed ? "true" : undefined })}`, { signal: options.signal });
    },
    correct(expectedRevision, command, options = {}) {
      return request<EntityCorrectionResult>("/api/entities/corrections", {
        method: "POST", body: JSON.stringify({ expectedRevision, command }), signal: options.signal,
      });
    },
    undo(expectedRevision, undoToken, options = {}) {
      return request<EntityCorrectionResult>("/api/entities/corrections/undo", {
        method: "POST", body: JSON.stringify({ expectedRevision, undoToken }), signal: options.signal,
      });
    },
    latestUndo(options = {}) {
      return request<EntityUndoState>("/api/entities/corrections/latest", { signal: options.signal });
    },
    settings(options = {}) {
      return request<EntityAnalysisSettings>("/api/entities/settings", { signal: options.signal });
    },
    setEnabled(enabled, options = {}) {
      return request<EntityAnalysisSettings>("/api/entities/settings", { method: "PUT", body: JSON.stringify({ enabled }), signal: options.signal });
    },
    related(noteId, cursor, limit, options = {}) {
      return request<EntityRelatedPage>(`/api/entities/related${queryString({ noteId, cursor, limit })}`, { signal: options.signal });
    },
    requestJob(input, options = {}) {
      return request<EntityJob>("/api/entities/jobs", { method: "POST", body: JSON.stringify(input), signal: options.signal });
    },
    jobs(cursor, limit, options = {}) {
      return request<EntityJobPage>(`/api/entities/jobs${queryString({ cursor, limit })}`, { signal: options.signal });
    },
    job(jobId, options = {}) {
      return request<EntityJob>(`/api/entities/jobs/${encodeURIComponent(jobId)}`, { signal: options.signal });
    },
    jobAction(jobId, action, options = {}) {
      return request<EntityJob>(`/api/entities/jobs/${encodeURIComponent(jobId)}/${action}`, { method: "POST", signal: options.signal });
    },
  };
}

export const entitiesApi = createApi(null);
export function entityApiForBundle(bundleId: string) { return createApi(bundleId); }
