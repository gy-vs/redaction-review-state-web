// Shared between server and client.

export type Span = {start:number; end:number};
export type DecisionKind = 'accepted' | 'rejected';
// new: not seen in the previous run
// carried: seen before AND a still-matching human decision was reused
// returning: seen before but with no reusable decision (never decided / stale)
// gone: fresh in the previous run, absent in the current run
export type Lifecycle = 'new' | 'carried' | 'returning' | 'gone';

export type DecisionDTO = {
  kind: DecisionKind;
  custom: boolean;
  range: Span | null;
  revision: number;
};

export type PriorDecisionDTO = {
  revision: number;
  reason: 'text_changed';
};

export type FindingDTO = {
  key: string;
  ruleId: string;
  label: string;
  occurrence: number;
  range: Span;
  text: string;
  gone: boolean;
  lifecycle: Lifecycle;
  decision: DecisionDTO | null;
  priorDecision: PriorDecisionDTO | null;
};

export type FrozenRef = {freezeId: string; at: string};

export type RunDTO = {
  id: string;
  docId: string;
  documentRevision: number;
  detectorVersion: string;
  content: string;
  createdAt: string;
  setRevision: number;
  frozen: FrozenRef | null;
  findings: FindingDTO[];
};

export type DecisionItemInput = {
  findingKey: string;
  // accepted | rejected | pending (pending removes the decision)
  decision: DecisionKind | 'pending';
  range?: Span | null;
  // expected decision revision; 0 / omitted means the decision must not exist yet
  baseRevision?: number;
};

export type AppliedItem = {
  findingKey: string;
  revision: number;
  decision: DecisionDTO | null;
};

export type ItemError = {
  findingKey: string;
  error: 'revision_conflict' | 'invalid_range' | 'unknown_finding';
  current?: {revision: number; decision: DecisionDTO | null} | null;
};

export type DecisionsResponse = {
  setRevision: number;
  applied: AppliedItem[];
  errors: ItemError[];
  run: RunDTO;
};

export type FreezeRecord = {
  id: string;
  docId: string;
  runId: string;
  documentRevision: number;
  detectorVersion: string;
  setRevision: number;
  createdAt: string;
  redactedContent: string;
  applied: {findingKey: string; ruleId: string; range: Span; revision: number}[];
  decisions: {findingKey: string; decision: DecisionDTO}[];
};

export type RunSummary = {
  id: string;
  documentRevision: number;
  detectorVersion: string;
  createdAt: string;
  setRevision: number;
  frozen: FrozenRef | null;
  total: number;
  fresh: number;
};
