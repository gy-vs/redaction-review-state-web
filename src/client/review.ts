import type {Batch, DecisionSubmission, DecisionStatus, Finding} from '../shared/types';

export type LaneKey = 'pending' | 'accepted' | 'rejected' | 'applied';

export const LANES: Array<{key: LaneKey; title: string; hint: string}> = [
  {key: 'pending', title: '待审', hint: 'A 接受 · R 拒绝'},
  {key: 'accepted', title: '接受', hint: '范围可调 · Z 撤销 · R 拒绝'},
  {key: 'rejected', title: '拒绝', hint: 'Z 撤销 · A 接受'},
  {key: 'applied', title: '已应用', hint: '已冻结，不可修改'},
];

/** 四阶段分组；消失建议不进入任何操作泳道，单独展示。 */
export function groupByLane(batch: Batch | null): Record<LaneKey, Finding[]> {
  const groups: Record<LaneKey, Finding[]> = {
    pending: [],
    accepted: [],
    rejected: [],
    applied: [],
  };
  if (!batch) return groups;
  for (const finding of batch.findings) {
    if (finding.presence === 'missing') continue;
    groups[finding.decision as LaneKey]?.push(finding);
  }
  for (const lane of Object.keys(groups) as LaneKey[]) {
    groups[lane].sort((a, b) => a.detected.start - b.detected.start);
  }
  return groups;
}

export function missingFindings(batch: Batch | null): Finding[] {
  if (!batch) return [];
  return batch.findings
    .filter((f) => f.presence === 'missing')
    .sort((a, b) => a.detected.start - b.detected.start);
}

export function counts(batch: Batch | null) {
  const groups = groupByLane(batch);
  return {
    pending: groups.pending.length,
    accepted: groups.accepted.length,
    rejected: groups.rejected.length,
    applied: groups.applied.length,
    missing: missingFindings(batch).length,
    active: batch ? batch.findings.filter((f) => f.presence !== 'missing').length : 0,
  };
}

/** 构造部分批量提交；只发送用户勾选且仍可操作的建议。 */
export function buildSubmissions(
  selected: Set<string>,
  decision: Extract<DecisionStatus, 'accepted' | 'rejected' | 'pending'>,
  findings: Finding[],
  frozen: boolean,
): DecisionSubmission[] {
  if (frozen) return [];
  return findings
    .filter(
      (f) =>
        selected.has(f.id) &&
        f.presence !== 'missing' &&
        f.decision !== decision &&
        f.decision !== 'applied',
    )
    .map((f) => ({findingId: f.id, decision, clientRev: f.rev}));
}

/** 客户端本地脱敏预览，与服务端 mergeSpans 规则一致。 */
export function previewRedacted(content: string, findings: Finding[]): string {
  const spans = findings
    .filter((f) => f.decision === 'accepted' || f.decision === 'applied')
    .map((f) => ({start: f.scope.start, end: f.scope.end}))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{start: number; end: number}> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({...span});
  }
  let out = '';
  let cursor = 0;
  for (const span of merged) {
    out += content.slice(cursor, span.start) + '█'.repeat(Math.max(2, span.end - span.start));
    cursor = span.end;
  }
  return out + content.slice(cursor);
}

export function originLabel(finding: Finding): string {
  if (finding.presence === 'missing') return '已消失';
  if (finding.presence === 'new') return '新出现';
  if (finding.origin === 'carried') return '决策已沿用·范围变化';
  if (finding.origin === 'unchanged') return '决策已沿用';
  return '';
}
