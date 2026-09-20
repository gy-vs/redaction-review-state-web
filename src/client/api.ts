import type {DecisionsResponse, FreezeRecord, RunDTO, Span} from '../shared/types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error ?? 'request_failed'));
  }
}

async function request<T>(...args: Parameters<typeof fetch>): Promise<T> {
  const response = await fetch(...args);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body as Record<string, unknown>);
  return body as T;
}

type DocSummary = {id: string; name: string; revision: number; updatedAt: string};
type DocRow = DocSummary & {content: string};
export type DecisionInput = {
  findingKey: string;
  decision: 'accepted' | 'rejected' | 'pending';
  range?: Span | null;
  baseRevision?: number;
};

export const api = {
  detectors: () => request<{versions: string[]; latest: string}>('/api/detectors'),
  documents: () => request<DocSummary[]>('/api/documents'),
  document: (id: string) => request<DocRow>(`/api/documents/${id}`),
  saveDocument: (id: string, content: string, revision: number) =>
    request<DocRow>(`/api/documents/${id}`, {
      method: 'PUT', headers: {'content-type': 'application/json'},
      body: JSON.stringify({content, revision}),
    }),
  analyze: (id: string, detectorVersion?: string) =>
    request<RunDTO>(`/api/documents/${id}/analyze`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify(detectorVersion ? {detectorVersion} : {}),
    }),
  run: (id: string, runId: string) => request<RunDTO>(`/api/documents/${id}/runs/${runId}`),
  decide: (id: string, runId: string, items: DecisionInput[]) =>
    request<DecisionsResponse>(`/api/documents/${id}/runs/${runId}/decisions`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({items}),
    }),
  freeze: (id: string, runId: string, setRevision: number) =>
    request<FreezeRecord>(`/api/documents/${id}/runs/${runId}/freeze`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({setRevision}),
    }),
};
