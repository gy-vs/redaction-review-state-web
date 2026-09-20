import {createHash} from 'node:crypto';
import type {
  AppliedSpan,
  AuditAction,
  AuditEvent,
  Batch,
  ConflictDetail,
  DecisionStatus,
  DecisionSubmission,
  Finding,
  RuleId,
  Scope,
} from '../shared/types';
import {DEFAULT_DETECTOR_VERSION, detect, detectorInfo} from './detector';
import {reconcile} from './reconcile';

export interface DocRow {
  id: string;
  name: string;
  revision: number;
  content: string;
  updatedAt: string;
}

export class RevisionConflict extends Error {
  constructor(
    public code: string,
    public detail: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const sha8 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);

const RULE_LABEL: Record<RuleId, string> = {
  email: '邮箱地址',
  phone: '电话号码',
  id_card: '身份证号',
};

export class Store {
  readonly docs = new Map<string, DocRow>();
  readonly batches = new Map<string, Batch>();
  /** documentId → 时间序的批次 ID（旧 → 新）。 */
  readonly batchesByDoc = new Map<string, string[]>();
  readonly audit: AuditEvent[] = [];
  private auditSeq = 0;

  constructor() {
    this.seed();
  }

  private seed() {
    this.docs.set('alpha', {
      id: 'alpha',
      name: '客户联络单',
      revision: 3,
      content:
        '联系人：张伟\n邮箱：zhang.wei@example.com\n手机：138-1234-5678\n备注：旧版检测器未识别证件号 110105199003072318。',
      updatedAt: new Date(0).toISOString(),
    });
    this.docs.set('beta', {
      id: 'beta',
      name: '外发公告草稿',
      revision: 5,
      content: '公告联系：press@example.org，热线 +86 139-0000-1234 ext.88。',
      updatedAt: new Date(1000).toISOString(),
    });
    // alpha 预置一轮 1.0.0 检测结果，便于直接演示升级复用。
    this.analyze('alpha', {detectorVersion: '1.0.0', actor: 'system'});
  }

  listDocuments(): DocRow[] {
    return [...this.docs.values()];
  }

  getDocument(id: string): DocRow {
    const doc = this.docs.get(id);
    if (!doc) throw new RevisionConflict('not_found');
    return doc;
  }

  updateDocument(id: string, content: string, expectedRev: number, actor: string): DocRow {
    const doc = this.getDocument(id);
    if (expectedRev !== doc.revision) {
      throw new RevisionConflict('revision_conflict', {expectedRev, currentRev: doc.revision});
    }
    doc.content = content;
    doc.revision += 1;
    doc.updatedAt = new Date().toISOString();
    this.record(actor, 'document_edit', id, '', {newRevision: doc.revision});
    return doc;
  }

  listBatches(docId: string): Batch[] {
    const doc = this.getDocument(docId);
    return (this.batchesByDoc.get(doc.id) ?? []).map((id) => this.batches.get(id)!);
  }

  latestBatch(docId: string): Batch | undefined {
    const ids = this.batchesByDoc.get(docId);
    return ids?.length ? this.batches.get(ids[ids.length - 1]) : undefined;
  }

  getBatch(docId: string, batchId: string): Batch {
    this.getDocument(docId);
    const batch = this.batches.get(batchId);
    if (!batch || batch.documentId !== docId) throw new RevisionConflict('not_found');
    return batch;
  }

  private batchId(doc: DocRow, version: string, content: string) {
    return `b_${doc.id}_r${doc.revision}_v${version.replace(/\./g, '')}_${sha8(content)}`;
  }

  private findingId(batchId: string, rule: RuleId, normalized: string, occurrence: number) {
    return `f_${sha8(`${rule}|${normalized}|${occurrence}`)}`;
  }

  /**
   * 运行检测。同 revision + 同内容 + 同检测器版本为幂等重复检测，原样返回批次；
   * 否则新建批次，并从上一批复用仍匹配的人工决策。
   */
  analyze(
    docId: string,
    options: {detectorVersion?: string; expectedRev?: number; actor?: string} = {},
  ): Batch {
    const doc = this.getDocument(docId);
    const version = options.detectorVersion ?? DEFAULT_DETECTOR_VERSION;
    if (!detectorInfo(version)) throw new RevisionConflict('unknown_detector', {version});
    if (options.expectedRev !== undefined && options.expectedRev !== doc.revision) {
      throw new RevisionConflict('revision_conflict', {
        expectedRev: options.expectedRev,
        currentRev: doc.revision,
      });
    }

    const id = this.batchId(doc, version, doc.content);
    const existing = this.batches.get(id);
    if (existing && existing.documentId === docId) {
      // 重复检测：决策已随批次保留，无需重放。
      return existing;
    }

    const hits = detect(doc.content, version);
    const previous = this.latestBatch(docId);
    const priorFindings = previous
      ? previous.findings
          .filter((f) => f.presence !== 'missing')
          .map((finding) => ({finding}))
      : [];
    const {matched, missing} = reconcile(hits, priorFindings);
    const now = new Date().toISOString();

    const findings: Finding[] = matched.map((entry) => {
      const prior = entry.carriedFromFinding
        ? previous?.findings.find((f) => f.id === entry.carriedFromFinding)
        : undefined;
      const scope = entry.reuseScope ?? {start: entry.hit.start, end: entry.hit.end};
      const scopeChanged = !!entry.reuseScopeChanged;
      return {
        id: this.findingId(id, entry.hit.rule, entry.hit.normalized, entry.hit.occurrence),
        batchId: id,
        rule: entry.hit.rule,
        ruleLabel: RULE_LABEL[entry.hit.rule],
        detected: {start: entry.hit.start, end: entry.hit.end},
        scope,
        match: entry.hit.match,
        normalized: entry.hit.normalized,
        occurrence: entry.hit.occurrence,
        decision: prior?.decision === 'applied' ? 'accepted' : prior?.decision ?? 'pending',
        presence: entry.presence,
        origin: entry.origin,
        scopeChanged,
        carriedFromBatch: entry.carriedFromBatch,
        carriedFromFinding: entry.carriedFromFinding,
        rev: 1,
        updatedAt: now,
      };
    });

    // 消失建议：沿用上一批数据，标记 missing，继续留在批次里供追溯。
    for (const gone of missing) {
      findings.push({
        ...gone,
        id: this.findingId(id, gone.rule, gone.normalized, gone.occurrence),
        batchId: id,
        presence: 'missing',
        rev: 1,
        updatedAt: now,
      });
    }

    const batch: Batch = {
      id,
      documentId: docId,
      documentRev: doc.revision,
      contentHash: sha8(doc.content),
      detectorVersion: version,
      status: 'open',
      findings,
      rev: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.batches.set(id, batch);
    const list = this.batchesByDoc.get(docId) ?? [];
    list.push(id);
    this.batchesByDoc.set(docId, list);
    this.record(options.actor ?? 'reviewer', 'analyze', docId, id, {
      detectorVersion: version,
      documentRev: doc.revision,
      newCount: findings.filter((f) => f.presence === 'new').length,
      carriedCount: findings.filter((f) => f.origin === 'carried').length,
      missingCount: findings.filter((f) => f.presence === 'missing').length,
    });
    return batch;
  }

  /**
   * 部分批量提交：逐条按 finding.rev 乐观锁校验。
   * 不做最后写入覆盖 —— rev 不匹配的条目进入 conflicts，保持服务端原值。
   * 批次已冻结则整批拒绝、零写入。
   */
  submitDecisions(
    docId: string,
    batchId: string,
    submissions: DecisionSubmission[],
    options: {actor?: string} = {},
  ): {batch: Batch; conflicts: ConflictDetail[]; applied: number} {
    const batch = this.getBatch(docId, batchId);
    if (batch.status === 'frozen') throw new RevisionConflict('batch_frozen', {batchId});

    const conflicts: ConflictDetail[] = [];
    const now = new Date().toISOString();
    let applied = 0;

    for (const submission of submissions) {
      const finding = batch.findings.find((f) => f.id === submission.findingId);
      if (!finding || finding.presence === 'missing') {
        conflicts.push({
          findingId: submission.findingId,
          clientRev: submission.clientRev,
          serverRev: finding?.rev ?? -1,
        });
        continue;
      }
      if (submission.clientRev !== finding.rev) {
        conflicts.push({
          findingId: finding.id,
          clientRev: submission.clientRev,
          serverRev: finding.rev,
        });
        continue;
      }
      const previous = finding.decision;
      finding.decision = submission.decision;
      if (submission.decision === 'pending') {
        // 撤销未冻结决策：范围回到检测器原值。
        finding.scope = {...finding.detected};
        finding.scopeChanged = false;
      }
      finding.rev += 1;
      finding.updatedAt = now;
      applied += 1;
      this.record(
        options.actor ?? 'reviewer',
        submission.decision === 'pending' ? 'undo' : 'decide',
        docId,
        batchId,
        {
          findingId: finding.id,
          from: previous,
          to: finding.decision,
          findingRev: finding.rev,
        },
      );
    }

    if (applied > 0) {
      batch.rev += 1;
      batch.updatedAt = now;
    }
    return {batch, conflicts, applied};
  }

  /** 接受后调整范围；必须与检测器原始范围相交且不越出文档。 */
  adjustScope(
    docId: string,
    batchId: string,
    findingId: string,
    next: Scope,
    clientRev: number,
    actor = 'reviewer',
  ): Batch {
    const batch = this.getBatch(docId, batchId);
    if (batch.status === 'frozen') throw new RevisionConflict('batch_frozen', {batchId});
    const finding = batch.findings.find((f) => f.id === findingId);
    if (!finding) throw new RevisionConflict('not_found');
    if (finding.presence === 'missing') throw new RevisionConflict('finding_missing', {findingId});
    if (finding.decision !== 'accepted') {
      throw new RevisionConflict('only_accepted_scope_adjustable', {findingId});
    }
    if (clientRev !== finding.rev) {
      throw new RevisionConflict('finding_revision_conflict', {
        clientRev,
        serverRev: finding.rev,
      });
    }
    const doc = this.getDocument(docId);
    const start = Math.floor(next.start);
    const end = Math.floor(next.end);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > doc.content.length ||
      start >= end
    ) {
      throw new RevisionConflict('invalid_scope', {start, end});
    }
    if (finding.detected.start >= end || start >= finding.detected.end) {
      throw new RevisionConflict('scope_must_overlap_detected', {
        detected: finding.detected,
        requested: {start, end},
      });
    }
    const now = new Date().toISOString();
    finding.scope = {start, end};
    finding.scopeChanged = true;
    finding.rev += 1;
    finding.updatedAt = now;
    batch.rev += 1;
    batch.updatedAt = now;
    this.record(actor, 'scope_adjust', docId, batchId, {
      findingId,
      scope: finding.scope,
      detected: finding.detected,
      findingRev: finding.rev,
    });
    return batch;
  }

  /** 最终脱敏文本：完整冻结集原子通过，否则失败 —— 绝不混合新旧决策。 */
  freezeAndGenerate(
    docId: string,
    batchId: string,
    expectedBatchRev: number,
    options: {expectedDocRev?: number; actor?: string} = {},
  ): {batch: Batch; doc: DocRow} {
    const batch = this.getBatch(docId, batchId);
    const doc = this.getDocument(docId);

    // rev 校验先于幂等短路：陈旧的重复生成必须失败，不能重放为 200。
    if (expectedBatchRev !== batch.rev) {
      throw new RevisionConflict('batch_revision_conflict', {
        expectedBatchRev,
        currentBatchRev: batch.rev,
      });
    }
    if (batch.status === 'frozen') return {batch, doc}; // 持当前 rev 重放 → 幂等
    if (doc.revision !== batch.documentRev) {
      // 页面 A 已编辑文档、页面 B 仍在旧 revision 上生成 —— 拒绝混合。
      throw new RevisionConflict('document_revision_conflict', {
        batchDocumentRev: batch.documentRev,
        currentDocRev: doc.revision,
      });
    }
    if (options.expectedDocRev !== undefined && options.expectedDocRev !== doc.revision) {
      throw new RevisionConflict('document_revision_conflict', {
        expectedDocRev: options.expectedDocRev,
        currentDocRev: doc.revision,
      });
    }

    const active = batch.findings.filter((f) => f.presence !== 'missing');
    const pending = active.filter((f) => f.decision === 'pending');
    if (pending.length > 0) {
      throw new RevisionConflict('incomplete_decisions', {
        pendingFindingIds: pending.map((f) => f.id),
      });
    }

    // 以下全部为同步原子操作：要么完整冻结并生成，要么不发生任何变更。
    const accepted = active.filter((f) => f.decision === 'accepted');
    const spans = mergeSpans(
      accepted.map((f) => ({...f.scope, rule: f.rule, findingId: f.id}) satisfies AppliedSpan),
    );
    const parts: string[] = [];
    let cursor = 0;
    for (const span of spans) {
      parts.push(doc.content.slice(cursor, span.start));
      parts.push('█'.repeat(Math.max(2, span.end - span.start)));
      cursor = span.end;
    }
    parts.push(doc.content.slice(cursor));

    const now = new Date().toISOString();
    const snapshot = active.map((f) => ({
      findingId: f.id,
      decision: f.decision as DecisionStatus,
      scope: {...f.scope},
      findingRev: f.rev,
    }));
    for (const finding of accepted) finding.decision = 'applied';
    batch.status = 'frozen';
    batch.frozenAt = now;
    batch.rev += 1;
    batch.updatedAt = now;
    batch.generated = {
      content: parts.join(''),
      appliedFindingIds: accepted.map((f) => f.id),
      decisions: snapshot,
      batchRev: batch.rev,
      generatedAt: now,
    };
    this.record(options.actor ?? 'reviewer', 'freeze_generate', docId, batchId, {
      batchRev: batch.rev,
      appliedCount: accepted.length,
      rejectedCount: active.length - accepted.length,
      missingCount: batch.findings.length - active.length,
    });
    return {batch, doc};
  }

  private record(
    actor: string,
    action: AuditAction,
    documentId: string,
    batchId: string,
    detail: Record<string, unknown>,
    findingId?: string,
  ) {
    this.audit.push({
      id: ++this.auditSeq,
      at: new Date().toISOString(),
      actor,
      action,
      documentId,
      batchId,
      findingId,
      detail,
    });
  }
}

/** 合并相交/相邻的接受范围，避免重叠建议导致半脱敏。 */
export function mergeSpans(spans: AppliedSpan[]): AppliedSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: AppliedSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({...span});
    }
  }
  return merged;
}

export const store = new Store();
