import type {
  DecisionDTO, DecisionItemInput, FindingDTO, FreezeRecord, FrozenRef,
  ItemError, Lifecycle, RunDTO, RunSummary, Span,
} from '../shared/types';
import {detect, findingKey} from './detector';

export type DocRow = {id: string; name: string; revision: number; content: string; updatedAt: string};

type DecisionRecord = {kind: 'accepted' | 'rejected'; custom: boolean; range: Span | null; revision: number};
type FindingRecord = {
  ruleId: string; label: string; occurrence: number; range: Span; text: string;
  gone: boolean; lifecycle: Lifecycle;
};

export class RunFrozenError extends Error {}
export class DocumentChangedError extends Error {}
export class RevisionConflictError extends Error {
  constructor(readonly current: DocRow) {super('revision_conflict');}
}
export class SetRevisionConflictError extends Error {
  constructor(readonly run: RunRecord) {super('set_revision_conflict');}
}

type HeldBack = {revision: number; reason: 'text_changed'};

export class RunRecord {
  findings = new Map<string, FindingRecord>();
  decisions = new Map<string, DecisionRecord>();
  heldBack = new Map<string, HeldBack>();
  setRevision = 0;
  frozen: FreezeRecord | null = null;

  constructor(
    readonly id: string,
    readonly docId: string,
    readonly detectorVersion: string,
    readonly documentRevision: number,
    readonly content: string,
    readonly createdAt: string,
  ) {}
}

export class RedactionStore {
  readonly docs = new Map<string, DocRow>();
  readonly runs = new Map<string, RunRecord>();
  private seq = 0;

  constructor(seed: DocRow[]) {
    for (const row of seed) this.docs.set(row.id, structuredClone(row));
  }

  // ---- documents -------------------------------------------------------

  getDoc(id: string): DocRow | undefined {
    return this.docs.get(id);
  }

  listDocs(): DocRow[] {
    return [...this.docs.values()];
  }

  // Revision-checked edit. Never last-write-wins: a stale base revision
  // is rejected instead of silently overwriting the other writer's text.
  editDoc(id: string, content: string, revision: number): DocRow {
    const row = this.docs.get(id);
    if (!row) throw new Error('not_found');
    if (revision !== row.revision) throw new RevisionConflictError(row);
    row.content = content;
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    return row;
  }

  listRuns(docId: string): RunRecord[] {
    return [...this.runs.values()].filter(run => run.docId === docId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun(docId: string, runId: string): RunRecord | undefined {
    const run = this.runs.get(runId);
    return run && run.docId === docId ? run : undefined;
  }

  // ---- analysis & decision carry-over ----------------------------------

  // Creates a new run for the current document revision. Human decisions are
  // reused from the most recent run using the same detector version when they
  // still match:
  //  - non-custom decisions follow the new detector range automatically
  //  - custom ranges are verified against the text they used to cover; if
  //    that text moved/changed (document edited, range drifted) the decision
  //    is held back as priorDecision(text_changed) and must be re-reviewed
  // Findings present before but absent now are retained as "gone".
  analyze(docId: string, detectorVersion: string): RunRecord {
    const row = this.docs.get(docId);
    if (!row) throw new Error('not_found');
    this.seq += 1;
    const run = new RunRecord(
      `${docId}-r${this.seq}`, docId, detectorVersion, row.revision,
      row.content, new Date().toISOString(),
    );
    const raw = detect(row.content, detectorVersion);
    const freshKeys = new Set<string>();
    for (const hit of raw) {
      const key = findingKey(hit.ruleId, hit.occurrence);
      freshKeys.add(key);
      run.findings.set(key, {
        ruleId: hit.ruleId, label: hit.label, occurrence: hit.occurrence,
        range: hit.range, text: hit.text, gone: false, lifecycle: 'new',
      });
    }

    // Reuse from the immediately preceding analysis regardless of its
    // detector version: finding identity is (ruleId, occurrence) and rule
    // ids stay stable across detector upgrades.
    const previous = this.listRuns(docId)[0];
    if (previous) {
      const prevFresh = new Set(
        [...previous.findings].filter(([, f]) => !f.gone).map(([key]) => key),
      );
      for (const key of freshKeys) {
        const lifecycle: Lifecycle = prevFresh.has(key) ? 'returning' : 'new';
        run.findings.get(key)!.lifecycle = lifecycle;
        const prior = previous.decisions.get(key);
        if (!prior) continue;
        if (prior.custom && prior.range) {
          const covered = prior.range.end <= run.content.length
            ? run.content.slice(prior.range.start, prior.range.end) : null;
          const wasCovered = previous.content.slice(prior.range.start, prior.range.end);
          if (covered === null || covered !== wasCovered) {
            // The custom range no longer points at the same text: keep the
            // audit trail but do not auto-reuse the decision.
            run.heldBack.set(key, {revision: prior.revision, reason: 'text_changed'});
            continue;
          }
          run.decisions.set(key, {...prior});
        } else {
          // Non-custom decision: follow the detector's current range.
          run.decisions.set(key, {...prior, range: null});
        }
        run.findings.get(key)!.lifecycle = 'carried';
      }

      // Disappeared findings: keep them (with their decision) as "gone" so
      // the reviewer can see what vanished during re-detection.
      for (const [key, prevFinding] of previous.findings) {
        if (!freshKeys.has(key) && !prevFinding.gone) {
          run.findings.set(key, {...prevFinding, gone: true, lifecycle: 'gone'});
          const prior = previous.decisions.get(key);
          if (prior) run.decisions.set(key, {...prior});
        }
      }
    }

    this.runs.set(run.id, run);
    return run;
  }

  // ---- decision mutation -----------------------------------------------

  // Applies a batch with per-item compare-and-set on decision revision.
  // Valid items commit even when siblings in the same batch fail
  // (partial batch commit); every applied item bumps the run setRevision.
  applyDecisions(run: RunRecord, items: DecisionItemInput[]) {
    if (run.frozen) throw new RunFrozenError(run.id);
    const applied: {findingKey: string; revision: number; decision: DecisionDTO | null}[] = [];
    const errors: ItemError[] = [];

    for (const item of items) {
      const finding = run.findings.get(item.findingKey);
      if (!finding) {
        errors.push({findingKey: item.findingKey, error: 'unknown_finding'});
        continue;
      }
      const expected = item.baseRevision ?? 0;
      const currentRevision = run.decisions.get(item.findingKey)?.revision ?? 0;
      if (currentRevision !== expected) {
        errors.push({
          findingKey: item.findingKey,
          error: 'revision_conflict',
          current: currentRevision
            ? {revision: currentRevision, decision: toDecisionDTO(run.decisions.get(item.findingKey)!)}
            : null,
        });
        continue;
      }

      if (item.decision === 'pending') {
        run.decisions.delete(item.findingKey);
        run.setRevision += 1;
        applied.push({findingKey: item.findingKey, revision: run.setRevision, decision: null});
        continue;
      }

      const current = run.decisions.get(item.findingKey) ?? null;
      let custom = false;
      let range: Span | null = null;
      if (item.decision === 'accepted' && item.range) {
        const {start, end} = item.range;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start
            || end > run.content.length) {
          errors.push({findingKey: item.findingKey, error: 'invalid_range'});
          continue;
        }
        custom = true;
        range = {start, end};
      } else if (item.decision === 'rejected' && item.range) {
        errors.push({findingKey: item.findingKey, error: 'invalid_range'});
        continue;
      } else if (item.decision === 'accepted' && finding.gone && !item.range) {
        // A gone finding cannot be accepted without an explicit new range.
        errors.push({findingKey: item.findingKey, error: 'invalid_range'});
        continue;
      }

      const nextRevision = (current?.revision ?? 0) + 1;
      const record: DecisionRecord = {kind: item.decision, custom, range, revision: nextRevision};
      run.decisions.set(item.findingKey, record);
      run.setRevision += 1;
      applied.push({findingKey: item.findingKey, revision: run.setRevision, decision: toDecisionDTO(record)});
    }
    return {applied, errors};
  }

  // ---- freeze & final text ---------------------------------------------

  // Freezes the complete decision set. Either the whole set freezes
  // atomically (setRevision CAS) or this fails — a final text can never
  // mix half-new and half-old decisions.
  freeze(run: RunRecord, baseSetRevision: number): FreezeRecord {
    if (run.frozen) return run.frozen; // idempotent once frozen
    if (baseSetRevision !== run.setRevision) {
      throw new SetRevisionConflictError(run);
    }
    const doc = this.docs.get(run.docId);
    if (!doc || doc.revision !== run.documentRevision) {
      throw new DocumentChangedError(run.id);
    }

    const acceptedSpans = [...run.findings]
      .filter(([, f]) => !f.gone)
      .map(([key, f]) => {
        const decision = run.decisions.get(key);
        if (!decision || decision.kind !== 'accepted') return null;
        return {
          findingKey: key,
          ruleId: f.ruleId,
          range: decision.custom && decision.range ? decision.range : f.range,
          revision: decision.revision,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Mask from the end so earlier offsets stay valid.
    const ordered = acceptedSpans.slice().sort((a, b) => b.range.start - a.range.start);
    let redactedContent = run.content;
    for (const span of ordered) {
      redactedContent = redactedContent.slice(0, span.range.start)
        + '█'.repeat(span.range.end - span.range.start)
        + redactedContent.slice(span.range.end);
    }

    this.seq += 1;
    const freeze: FreezeRecord = {
      id: `${run.id}-f${this.seq}`,
      docId: run.docId,
      runId: run.id,
      documentRevision: run.documentRevision,
      detectorVersion: run.detectorVersion,
      setRevision: run.setRevision,
      createdAt: new Date().toISOString(),
      redactedContent,
      applied: acceptedSpans,
      decisions: [...run.decisions.entries()].map(([findingKey, decision]) => ({
        findingKey, decision: toDecisionDTO(decision),
      })),
    };
    run.frozen = freeze;
    return freeze;
  }
}

function toDecisionDTO(record: DecisionRecord): DecisionDTO {
  return {kind: record.kind, custom: record.custom, range: record.range, revision: record.revision};
}

// ---- DTO projection ----------------------------------------------------

export function toRunDTO(run: RunRecord): RunDTO {
  const findings: FindingDTO[] = [];
  for (const [key, finding] of run.findings) {
    const decision = run.decisions.get(key);
    findings.push({
      key,
      ruleId: finding.ruleId,
      label: finding.label,
      occurrence: finding.occurrence,
      range: finding.range,
      text: finding.text,
      gone: finding.gone,
      lifecycle: finding.lifecycle,
      decision: decision ? toDecisionDTO(decision) : null,
      priorDecision: run.heldBack.get(key) ?? null,
    });
  }
  findings.sort((a, b) => (Number(a.gone) - Number(b.gone)) || a.range.start - b.range.start);
  const frozen: FrozenRef | null = run.frozen
    ? {freezeId: run.frozen.id, at: run.frozen.createdAt} : null;
  return {
    id: run.id, docId: run.docId, documentRevision: run.documentRevision,
    detectorVersion: run.detectorVersion, content: run.content, createdAt: run.createdAt,
    setRevision: run.setRevision, frozen, findings,
  };
}

export function toRunSummary(run: RunRecord): RunSummary {
  const fresh = [...run.findings.values()].filter(f => !f.gone).length;
  return {
    id: run.id, documentRevision: run.documentRevision, detectorVersion: run.detectorVersion,
    createdAt: run.createdAt, setRevision: run.setRevision,
    frozen: run.frozen ? {freezeId: run.frozen.id, at: run.frozen.createdAt} : null,
    total: run.findings.size, fresh,
  };
}
