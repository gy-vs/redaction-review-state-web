// 共享领域模型：服务端与客户端共同引用。

/** 人工决策四阶段中的三个可流转状态；pending = 待审。 */
export type DecisionStatus = 'pending' | 'accepted' | 'rejected' | 'applied';

/** 建议在当前 revision 批次中的存续状态。 */
export type Presence = 'active' | 'new' | 'missing';

/** 建议来源：本轮新检出 / 沿用上一轮人工决策 / 与上一轮完全一致。 */
export type Origin = 'detected' | 'carried' | 'unchanged';

export interface Scope {
  /** 相对文档内容的半开区间 [start,end)。 */
  start: number;
  end: number;
}

export type RuleId = 'email' | 'phone' | 'id_card';

export interface Finding {
  /** 批次内稳定 ID（内容指纹派生），重复检测保持不变。 */
  id: string;
  batchId: string;
  rule: RuleId;
  ruleLabel: string;
  /** 本轮检测器给出的原始范围（检测器侧事实，不随人工调整改变）。 */
  detected: Scope;
  /** 当前生效范围；接受后人工可在 detected 邻域内调整。 */
  scope: Scope;
  /** 原始命中文本。 */
  match: string;
  /** 归一化文本，用于跨批次调和。 */
  normalized: string;
  /** 同一归一化键第几次出现（从 0 开始）。 */
  occurrence: number;
  decision: DecisionStatus;
  presence: Presence;
  origin: Origin;
  /** scope 是否为人工调整后的范围。 */
  scopeChanged: boolean;
  /** 沿用时来源批次 / 建议 ID，用于追溯。 */
  carriedFromBatch?: string;
  carriedFromFinding?: string;
  /** 该建议自身的乐观锁版本，每次修改 +1。 */
  rev: number;
  updatedAt: string;
}

export interface Batch {
  id: string;
  documentId: string;
  /** 检出时文档 revision。 */
  documentRev: number;
  /** 检出时内容指纹，重复检测据此复用。 */
  contentHash: string;
  detectorVersion: string;
  status: 'open' | 'frozen';
  findings: Finding[];
  /** 乐观锁：任何决策/范围修改 +1，冻结时 +1。 */
  rev: number;
  frozenAt?: string;
  /** 冻结后生成的最终脱敏文本（冻结即生成，二者原子完成）。 */
  generated?: GeneratedReport;
  createdAt: string;
  updatedAt: string;
}

export interface AppliedSpan extends Scope {
  rule: RuleId;
  findingId: string;
}

export interface GeneratedReport {
  content: string;
  /** 实际写入最终文本的完整冻结接受集（含 applied）。 */
  appliedFindingIds: string[];
  /** 快照：冻结时每个建议的 decision/scope/findingRev，保证可追溯。 */
  decisions: Array<{
    findingId: string;
    decision: DecisionStatus;
    scope: Scope;
    findingRev: number;
  }>;
  batchRev: number;
  generatedAt: string;
}

export type AuditAction =
  | 'document_edit'
  | 'analyze'
  | 'decide'
  | 'scope_adjust'
  | 'undo'
  | 'freeze_generate';

export interface AuditEvent {
  id: number;
  at: string;
  actor: string;
  action: AuditAction;
  documentId: string;
  batchId: string;
  findingId?: string;
  detail: Record<string, unknown>;
}

export interface DetectorInfo {
  version: string;
  rules: Array<{id: RuleId; label: string; description: string}>;
}

export interface DocSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  latestBatchId: string | null;
}

/** 决策提交条目；clientRev 为客户端持有的 finding.rev，用于冲突检测。 */
export interface DecisionSubmission {
  findingId: string;
  decision: Extract<DecisionStatus, 'accepted' | 'rejected' | 'pending'>;
  clientRev: number;
}

export interface ConflictDetail {
  findingId: string;
  clientRev: number;
  serverRev: number;
}

export interface BatchSubmissionResponse {
  batch: Batch;
  conflicts: ConflictDetail[];
  applied: number;
  /** 被拒绝（批次已冻结）时为 true，整批不写入。 */
  frozen: boolean;
}
