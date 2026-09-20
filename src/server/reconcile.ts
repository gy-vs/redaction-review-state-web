import type {Finding, Scope} from '../shared/types';
import type {RawHit} from './detector';

/**
 * 跨 revision / 跨检测器版本调和：
 *  - 精确键（rule + normalized + occurrence）一致 → unchanged，原样复用；
 *  - 范围轻微变化（同规则、范围相交且核心文本相同/包含）→ carried，复用决策；
 *  - 其余新命中 → new（origin=detected）；
 *  - 上一批未匹配上的建议 → missing 保留，仍可追溯，但不参与生成。
 */

interface Prior {
  finding: Finding;
}

export interface ReconciledHit {
  hit: RawHit;
  presence: Finding['presence'];
  origin: Finding['origin'];
  carriedFromBatch?: string;
  carriedFromFinding?: string;
  reuseScope?: Scope;
  reuseScopeChanged?: boolean;
}

export interface ReconcileResult {
  matched: ReconciledHit[];
  missing: Finding[];
}

const exactKey = (rule: string, normalized: string, occurrence: number) =>
  `${rule}::${normalized}::${occurrence}`;

function hitKey(rule: string, normalized: string, occurrence: number) {
  return exactKey(rule, normalized, occurrence);
}

/** 核心文本相同且范围相交（允许分隔符/前缀/分机造成的轻微扩张或收缩）。 */
function nearMatch(a: RawHit, f: Finding): boolean {
  if (a.rule !== f.rule) return false;
  const intersects = a.start < f.scope.end && f.scope.start < a.end;
  if (!intersects) return false;
  const an = a.normalized;
  const bn = f.normalized;
  if (an === bn) return true;
  const longer = an.length >= bn.length ? an : bn;
  const shorter = an.length >= bn.length ? bn : an;
  if (!longer.includes(shorter)) return false;
  // 手机/证件类数字串：较短串至少占较长串 70%，避免把无关号码连在一起。
  return shorter.length / longer.length >= 0.7;
}

function score(hit: RawHit, f: Finding): number {
  let value: number;
  if (hit.normalized === f.normalized && hit.occurrence === f.occurrence) {
    value = 100; // 精确：同值、同出现次序
  } else if (hit.normalized === f.normalized) {
    value = 90; // 同值，出现次序漂移
  } else {
    value = 80; // 归一化值轻微变化（前缀/分机）
  }
  const overlap =
    Math.min(hit.end, f.scope.end) - Math.max(hit.start, f.scope.start);
  value += overlap;
  // 位置越近越优先
  value -= Math.abs(hit.start - f.scope.start) * 0.001;
  return value;
}

export function reconcile(hits: RawHit[], priors: Prior[]): ReconcileResult {
  const candidates = new Map<string, {prior: Prior; score: number; near: boolean}[]>();
  const usedPriors = new Set<string>();

  const push = (key: string, prior: Prior, value: number, near: boolean) => {
    const list = candidates.get(key) ?? [];
    list.push({prior, score: value, near});
    candidates.set(key, list);
  };

  hits.forEach((hit, index) => {
    const key = `${index}`;
    for (const prior of priors) {
      const f = prior.finding;
      const exact =
        f.rule === hit.rule &&
        f.normalized === hit.normalized &&
        f.occurrence === hit.occurrence;
      if (exact) {
        push(key, prior, score(hit, f) + 1000, false);
      } else if (nearMatch(hit, f)) {
        push(key, prior, score(hit, f), true);
      }
    }
  });

  // 全局贪心：按分数降序配对，保证一条旧建议最多复用给一条新命中。
  const pairs = new Map<number, {prior: Prior; near: boolean}>();
  const edges: Array<{hitIndex: number; priorId: string; score: number; near: boolean; prior: Prior}> = [];
  for (const [hitIndex, list] of candidates) {
    for (const c of list) {
      edges.push({
        hitIndex: Number(hitIndex),
        priorId: c.prior.finding.id,
        score: c.score,
        near: c.near,
        prior: c.prior,
      });
    }
  }
  edges.sort((a, b) => b.score - a.score);
  for (const edge of edges) {
    if (pairs.has(edge.hitIndex) || usedPriors.has(edge.priorId)) continue;
    pairs.set(edge.hitIndex, {prior: edge.prior, near: edge.near});
    usedPriors.add(edge.priorId);
  }

  const matched: ReconciledHit[] = [];
  hits.forEach((hit, index) => {
    const pair = pairs.get(index);
    if (!pair) {
      matched.push({hit, presence: 'new', origin: 'detected'});
      return;
    }
    const f = pair.prior.finding;
    const exactSpan = hit.start === f.scope.start && hit.end === f.scope.end;
    // 人工调整过的范围：若仍与新检测范围相交则保留调整，否则回落到检测器范围。
    let reuseScope: Scope | undefined;
    let reuseScopeChanged = false;
    if (f.scopeChanged) {
      const stillIntersects = hit.start < f.scope.end && f.scope.start < hit.end;
      if (stillIntersects) {
        reuseScope = f.scope;
        reuseScopeChanged = true;
      }
    }
    matched.push({
      hit,
      presence: 'active',
      origin: !pair.near && exactSpan ? 'unchanged' : 'carried',
      carriedFromBatch: f.batchId,
      carriedFromFinding: f.id,
      reuseScope,
      reuseScopeChanged,
    });
  });

  const missing = priors
    .filter((prior) => !usedPriors.has(prior.finding.id))
    .map((prior) => ({...prior.finding, presence: 'missing' as const}));

  return {matched, missing};
}

export {hitKey};
