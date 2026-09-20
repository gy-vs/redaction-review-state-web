import type {DetectorInfo, RuleId, Scope} from '../shared/types';

export interface RawHit {
  rule: RuleId;
  start: number;
  end: number;
  match: string;
  normalized: string;
  /** 同一归一化键在文档中的出现序号（从 0 起）。 */
  occurrence: number;
}

interface RuleDef {
  id: RuleId;
  label: string;
  description: string;
  patterns: RegExp[];
  normalize: (match: string) => string;
}

const lower = (value: string) => value.toLowerCase();
const digits = (value: string) => value.replace(/\D/g, '');

const EMAIL: RuleDef = {
  id: 'email',
  label: '邮箱地址',
  description: '电子邮件地址',
  // 故意保留一条等价规则，用于验证检测器内部对重复命中的去重。
  patterns: [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/g],
  normalize: lower,
};

// v1：仅 3-4 位分隔的 11 位号码，范围不含分机。
const PHONE_V1: RuleDef = {
  id: 'phone',
  label: '电话号码',
  description: '中国大陆手机号（分隔符形式）',
  patterns: [/(?<!\d)1[3-9]\d(?:[- ]?\d{4}){2}(?!\d)/g],
  normalize: digits,
};

// v2：支持 +86 前缀，且分机/连字符也纳入范围 —— 用于“范围轻微变化”场景。
const PHONE_V2: RuleDef = {
  id: 'phone',
  label: '电话号码',
  description: '中国大陆手机号（含 +86 前缀与分机）',
  patterns: [/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d(?:[- ]?\d{4}){2}(?:[- ]?(?:ext|x|分机)\.?\s?\d{2,6})?(?!\d)/gi],
  normalize: digits,
};

const ID_CARD: RuleDef = {
  id: 'id_card',
  label: '身份证号',
  description: '18 位居民身份证号',
  patterns: [/(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g],
  normalize: (value) => value.toUpperCase(),
};

export const DETECTORS: Record<string, {info: DetectorInfo; rules: RuleDef[]}> = {
  '1.0.0': {
    info: {
      version: '1.0.0',
      rules: [
        {id: 'email', label: EMAIL.label, description: EMAIL.description},
        {id: 'phone', label: PHONE_V1.label, description: PHONE_V1.description},
      ],
    },
    rules: [EMAIL, PHONE_V1],
  },
  '2.0.0': {
    info: {
      version: '2.0.0',
      rules: [
        {id: 'email', label: EMAIL.label, description: EMAIL.description},
        {id: 'phone', label: PHONE_V2.label, description: PHONE_V2.description},
        {id: 'id_card', label: ID_CARD.label, description: ID_CARD.description},
      ],
    },
    rules: [EMAIL, PHONE_V2, ID_CARD],
  },
};

export const DEFAULT_DETECTOR_VERSION = '2.0.0';

export function detectorInfo(version: string): DetectorInfo | undefined {
  return DETECTORS[version]?.info;
}

export function detectorVersions(): string[] {
  return Object.keys(DETECTORS).sort();
}

/** 运行检测器；同一 span 的重复命中只保留一条（重复建议去噪）。 */
export function detect(content: string, version: string): RawHit[] {
  const detector = DETECTORS[version];
  if (!detector) throw new Error(`unknown_detector_version:${version}`);

  const bySpan = new Map<string, RawHit & {ruleLabel: string}>();
  for (const rule of detector.rules) {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const match = m[0];
        const start = m.index;
        const end = start + match.length;
        const key = `${rule.id}:${start}:${end}`;
        if (!bySpan.has(key)) {
          bySpan.set(key, {
            rule: rule.id,
            start,
            end,
            match,
            normalized: rule.normalize(match),
            occurrence: 0,
            ruleLabel: rule.label,
          });
        }
        if (pattern.lastIndex === start) pattern.lastIndex += 1;
      }
    }
  }

  const raw = [...bySpan.values()];
  // 同一规则的重叠命中（可选前缀/分机导致）只保留最长一条，避免重复建议。
  const byRule = new Map<RuleId, typeof raw>();
  for (const hit of raw) {
    const list = byRule.get(hit.rule) ?? [];
    list.push(hit);
    byRule.set(hit.rule, list);
  }
  const deduped: typeof raw = [];
  for (const list of byRule.values()) {
    list.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: typeof list = [];
    for (const hit of list) {
      const last = kept[kept.length - 1];
      if (last && hit.start < last.end) {
        if (hit.end - hit.start > last.end - last.start) kept[kept.length - 1] = hit;
        continue;
      }
      kept.push(hit);
    }
    deduped.push(...kept);
  }

  const hits = deduped.sort((a, b) => a.start - b.start || a.end - b.end);
  // 出现序号按归一化值计数，便于跨修订精确定位同一条建议。
  const seen = new Map<string, number>();
  for (const hit of hits) {
    const key = `${hit.rule}:${hit.normalized}`;
    const next = seen.get(key) ?? 0;
    hit.occurrence = next;
    seen.set(key, next + 1);
  }
  return hits.map(({ruleLabel: _ruleLabel, ...hit}) => hit);
}

export function spanOverlaps(a: Scope, b: Scope): boolean {
  return a.start < b.end && b.start < a.end;
}
