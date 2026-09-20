import type {Span} from '../shared/types';

export type RawFinding = {ruleId: string; label: string; occurrence: number; range: Span; text: string};
export type DetectorRule = {id: string; label: string; pattern: RegExp};

// Rule sets are versioned. v2 keeps the v1 ids so identities survive an
// upgrade; a future version may drop or add rules (gone / new findings).
const RULESETS: Record<string, DetectorRule[]> = {
  'detector-1': [
    {id: 'email', label: 'Email address', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g},
    {id: 'phone', label: 'Phone number', pattern: /\b\d{3}[-.\s]\d{4}\b/g},
  ],
  'detector-2': [
    {id: 'email', label: 'Email address', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g},
    // Wider than v1: accepts country prefixes and "(555) 0134" style, while
    // still requiring a separator + 3-4 digits (so SSNs are not swallowed).
    {id: 'phone', label: 'Phone number',
      pattern: /(?:\+?\d{1,3}[\s.-])?(?:\(\d{2,4}\)|\d{3})[\s.-]\d{3,4}\b/g},
    {id: 'ssn', label: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/g},
  ],
};

export const DETECTOR_VERSIONS = Object.keys(RULESETS);
export const LATEST_DETECTOR = 'detector-2';

export function detectorExists(version: string): boolean {
  return Object.hasOwn(RULESETS, version);
}

// Scans content and numbers occurrences of each rule starting at 1,
// ordered by document position. Identity across runs = (ruleId, occurrence).
export function detect(content: string, detectorVersion: string): RawFinding[] {
  const rules = RULESETS[detectorVersion];
  if (!rules) throw new Error(`unknown detector version: ${detectorVersion}`);
  const hits: RawFinding[] = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let occurrence = 0;
    for (const match of content.matchAll(rule.pattern)) {
      occurrence += 1;
      const start = match.index ?? 0;
      hits.push({
        ruleId: rule.id,
        label: rule.label,
        occurrence,
        range: {start, end: start + match[0].length},
        text: match[0],
      });
    }
  }
  return hits.sort((a, b) => a.range.start - b.range.start || a.ruleId.localeCompare(b.ruleId));
}

export function findingKey(ruleId: string, occurrence: number): string {
  return `${ruleId}#${occurrence}`;
}
