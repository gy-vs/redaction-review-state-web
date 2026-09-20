import type {
  AuditEvent,
  Batch,
  BatchSubmissionResponse,
  DecisionSubmission,
  DetectorInfo,
  DocSummary,
  Scope,
} from '../shared/types';

export interface ApiError {
  status: number;
  error: string;
  detail: Record<string, unknown>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {'content-type': 'application/json'},
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw {
      status: response.status,
      error: body.error ?? 'request_failed',
      detail: body,
    } satisfies ApiError;
  }
  return body as T;
}

export interface DocRow extends DocSummary {
  content: string;
}

export const api = {
  listDocuments: () => request<DocSummary[]>('/api/documents'),
  getDocument: (id: string) => request<DocRow>(`/api/documents/${id}`),
  saveDocument: (id: string, content: string, revision: number) =>
    request<DocRow>(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({content, revision}),
    }),
  detectors: () => request<{versions: DetectorInfo[]}>('/api/detectors'),
  analyze: (id: string, detectorVersion: string, expectedRev: number) =>
    request<{batch: Batch}>(`/api/documents/${id}/analyze`, {
      method: 'POST',
      body: JSON.stringify({detectorVersion, expectedRev}),
    }),
  listBatches: (id: string) => request<{batches: Batch[]}>(`/api/documents/${id}/batches`),
  submitDecisions: (id: string, batchId: string, submissions: DecisionSubmission[]) =>
    request<BatchSubmissionResponse>(
      `/api/documents/${id}/batches/${encodeURIComponent(batchId)}/decisions`,
      {method: 'POST', body: JSON.stringify({submissions})},
    ),
  adjustScope: (id: string, batchId: string, findingId: string, scope: Scope, clientRev: number) =>
    request<{batch: Batch}>(
      `/api/documents/${id}/batches/${encodeURIComponent(batchId)}/findings/${findingId}/scope`,
      {method: 'POST', body: JSON.stringify({scope, clientRev})},
    ),
  generate: (id: string, batchId: string, expectedBatchRev: number, expectedDocRev: number) =>
    request<{batch: Batch; document: DocRow}>(
      `/api/documents/${id}/batches/${encodeURIComponent(batchId)}/generate`,
      {method: 'POST', body: JSON.stringify({expectedBatchRev, expectedDocRev})},
    ),
  audit: (id: string) =>
    request<{events: AuditEvent[]}>(`/api/audit?documentId=${encodeURIComponent(id)}`),
};
