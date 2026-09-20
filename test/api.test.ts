import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {DecisionsResponse, FreezeRecord, RunDTO} from '../src/shared/types';

const seedContent = 'Contact Ada at ada.lovelace@example.org or 555-0134.\nState: active.';

async function analyze(app: ReturnType<typeof createApp>, detectorVersion?: string) {
  const res = await request(app).post('/api/documents/alpha/analyze')
    .send(detectorVersion ? {detectorVersion} : {}).expect(201);
  return res.body as RunDTO;
}

function decide(run: RunDTO, key: string, decision: 'accepted' | 'rejected' | 'pending',
  extra: Record<string, unknown> = {}) {
  const base = run.findings.find(f => f.key === key)?.decision?.revision ?? 0;
  return {findingKey: key, decision, baseRevision: base, ...extra};
}

async function postDecisions(app: ReturnType<typeof createApp>, runId: string,
  items: unknown[], expectedStatus = 200) {
  const res = await request(app).post(`/api/documents/alpha/runs/${runId}/decisions`)
    .send({items}).expect(expectedStatus);
  return res.body as DecisionsResponse;
}

describe('redaction review service', () => {
  it('loads and conditionally updates a document (no last-write-wins)', async () => {
    const app = createApp();
    const before = await request(app).get('/api/documents/alpha').expect(200);
    await request(app).put('/api/documents/alpha')
      .send({content: 'updated', revision: before.body.revision}).expect(200);
    const conflict = await request(app).put('/api/documents/alpha')
      .send({content: 'stale', revision: before.body.revision}).expect(409);
    expect(conflict.body.error).toBe('revision_conflict');
    expect(conflict.body.current.content).toBe('updated');
  });

  it('detector upgrade: keeps rule identities and carries human decisions to new ranges', async () => {
    const app = createApp();
    // Seed document revision back to the fixture text and run detector-1.
    const doc = (await request(app).get('/api/documents/alpha')).body;
    const v1 = await analyze(app, 'detector-1');
    expect(v1.detectorVersion).toBe('detector-1');
    const emailKey = 'email#1';
    expect(v1.findings.map(f => f.key).sort()).toEqual(['email#1', 'phone#1']);
    // Accept the email on detector-1; reject the phone.
    const r1 = await postDecisions(app, v1.id, [
      decide(v1, emailKey, 'accepted'),
      decide(v1, 'phone#1', 'rejected'),
    ]);
    expect(r1.errors).toEqual([]);

    // Upgrade to detector-2. Identities persist; phone regex widened but
    // 555-0134 still matches at the same position; both decisions carry over.
    const v2 = await analyze(app, 'detector-2');
    expect(v2.findings.some(f => f.key === 'ssn#1')).toBe(false);
    const email = v2.findings.find(f => f.key === emailKey)!;
    const phone = v2.findings.find(f => f.key === 'phone#1')!;
    expect(email.lifecycle).toBe('carried');
    expect(email.decision?.kind).toBe('accepted');
    expect(phone.lifecycle).toBe('carried');
    expect(phone.decision?.kind).toBe('rejected');
  });

  it('slight range changes: carried accepted decision follows the new detector range', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-1');
    const phone = v1.findings.find(f => f.key === 'phone#1')!;
    const r1 = await postDecisions(app, v1.id, [
      decide(v1, 'email#1', 'rejected'),
      decide(v1, 'phone#1', 'accepted'),
    ]);
    expect(r1.applied).toHaveLength(2);
    // Widen the phone with trailing punctuation so detector-2's broader
    // phone regex grabs a longer span ("555-0134." no, use parens instead).
    await request(app).put('/api/documents/alpha').send({
      content: seedContent.replace('555-0134', '(555) 0134'),
      revision: 3,
    }).expect(200);

    const v2 = await analyze(app, 'detector-2');
    const next = v2.findings.find(f => f.key === 'phone#1')!;
    // detector-1 would not match the new formatting; detector-2 does.
    expect(next.text).toBe('(555) 0134');
    expect(next.lifecycle).toBe('carried');
    expect(next.decision?.kind).toBe('accepted');
    // The applied range must be the *new* detector range, not the old one.
    const freezeRes = await request(app).post(`/api/documents/alpha/runs/${v2.id}/freeze`)
      .send({setRevision: v2.setRevision}).expect(200);
    const freeze = freezeRes.body as FreezeRecord;
    const applied = freeze.applied.find(a => a.findingKey === 'phone#1')!;
    expect(applied.range).toEqual(next.range);
    expect(applied.range).not.toEqual(phone.range);
    expect(freeze.redactedContent).toContain('█'.repeat('(555) 0134'.length));
    expect(freeze.redactedContent).not.toContain('ada.lovelace@example.org█████');
  });

  it('custom range that no longer matches the same text is held back, not silently reused', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-2');
    const email = v1.findings.find(f => f.key === 'email#1')!;
    // Accept with a custom range covering only "ada.lovelace".
    const customRange = {start: email.range.start, end: email.range.start + 'ada.lovelace'.length};
    await postDecisions(app, v1.id, [
      decide(v1, 'email#1', 'accepted', {range: customRange}),
    ]);
    // Edit document so text at those offsets changes.
    await request(app).put('/api/documents/alpha').send({
      content: 'XX' + seedContent, revision: 3,
    }).expect(200);
    const v2 = await analyze(app, 'detector-2');
    const next = v2.findings.find(f => f.key === 'email#1')!;
    expect(next.decision).toBeNull();
    expect(next.lifecycle).toBe('returning');
    expect(next.priorDecision).toEqual({revision: 1, reason: 'text_changed'});
  });

  it('repeat analysis marks new and gone findings', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-2');
    // Review one item so the run has a decision to carry.
    await postDecisions(app, v1.id, [decide(v1, 'email#1', 'accepted')]);
    await request(app).put('/api/documents/alpha').send({
      content: 'Contact Ada at ada.lovelace@example.org. SSN 123-45-6789.\nState: active.',
      revision: 3,
    }).expect(200);
    const v2 = await analyze(app, 'detector-2');
    const keys = new Map(v2.findings.map(f => [f.key, f]));
    expect(keys.get('email#1')!.lifecycle).toBe('carried');
    expect(keys.get('ssn#1')!.lifecycle).toBe('new');
    expect(keys.get('phone#1')!.lifecycle).toBe('gone');
    expect(keys.get('phone#1')!.gone).toBe(true);
    expect(keys.get('ssn#1')!.decision).toBeNull();
  });
  it('document edit creates a new document revision; stale run freezes fail', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-2');
    const reviewed = await postDecisions(app, v1.id, [decide(v1, 'email#1', 'accepted')]);
    // Edit the document without re-analyzing: run is now stale.
    await request(app).put('/api/documents/alpha')
      .send({content: seedContent + '\nnew line', revision: 3}).expect(200);
    const res = await request(app).post(`/api/documents/alpha/runs/${v1.id}/freeze`)
      .send({setRevision: reviewed.setRevision}).expect(409);
    expect(res.body.error).toBe('document_changed');
    // The frozen run remains absent; get reports 404.
    await request(app).get(`/api/documents/alpha/runs/${v1.id}/freeze`).expect(404);
  });

  it('freeze and generate: all-or-nothing setRevision CAS, decisions frozen after', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-2');
    // Page A reviews the email: setRevision is now 1.
    const accepted = await postDecisions(app, v1.id,
      [{findingKey: 'email#1', decision: 'accepted', baseRevision: 0}]);
    expect(accepted.setRevision).toBe(1);

    // Page B holds a stale setRevision (0) and tries to freeze.
    const stale = await request(app).post(`/api/documents/alpha/runs/${v1.id}/freeze`)
      .send({setRevision: 0}).expect(409);
    expect(stale.body.error).toBe('set_revision_conflict');
    expect(stale.body.currentSetRevision).toBe(1);
    // Nothing was frozen: decisions are still mutable.
    await request(app).get(`/api/documents/alpha/runs/${v1.id}/freeze`).expect(404);

    // The other page rejects the phone; a freeze on revision 1 loses again —
    // a final text can never mix half-old and half-new decisions.
    await postDecisions(app, v1.id,
      [{findingKey: 'phone#1', decision: 'rejected', baseRevision: 0}]);
    const stale2 = await request(app).post(`/api/documents/alpha/runs/${v1.id}/freeze`)
      .send({setRevision: 1}).expect(409);
    expect(stale2.body.currentSetRevision).toBe(2);

    // Retrying with the current setRevision succeeds and freezes everything.
    const ok = await request(app).post(`/api/documents/alpha/runs/${v1.id}/freeze`)
      .send({setRevision: 2}).expect(200);
    const freeze = ok.body as FreezeRecord;
    expect(freeze.decisions.map(d => d.findingKey).sort()).toEqual(['email#1', 'phone#1']);
    expect(freeze.redactedContent).not.toContain('ada.lovelace@example.org');
    expect(freeze.redactedContent).toContain('555-0134'); // rejected stays visible
    expect(freeze.applied.map(a => a.findingKey)).toEqual(['email#1']);

    // Frozen: further decision mutation is rejected outright.
    const mutation = await request(app).post(`/api/documents/alpha/runs/${v1.id}/decisions`)
      .send({items: [{findingKey: 'phone#1', decision: 'accepted', baseRevision: 1}]})
      .expect(409);
    expect(mutation.body.error).toBe('run_frozen');

    // Freeze is idempotent and traceable: same id, full snapshot retained.
    const again = await request(app).post(`/api/documents/alpha/runs/${v1.id}/freeze`)
      .send({setRevision: 2}).expect(200);
    expect(again.body.id).toBe(freeze.id);
    expect(again.body.documentRevision).toBe(3);
    expect(again.body.detectorVersion).toBe('detector-2');
  });

  it('per-item revision conflict on concurrent review, no last-write-wins', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-2');
    // Page A accepts email at revision 0.
    await postDecisions(app, v1.id, [{findingKey: 'email#1', decision: 'accepted', baseRevision: 0}]);
    // Page B still holds revision 0 and tries to reject the same finding.
    const res = await postDecisions(app, v1.id,
      [{findingKey: 'email#1', decision: 'rejected', baseRevision: 0}], 409);
    expect(res.applied).toEqual([]);
    expect(res.errors[0]).toMatchObject({findingKey: 'email#1', error: 'revision_conflict'});
    expect(res.errors[0].current?.revision).toBe(1);
    // The first decision is intact, not overwritten.
    const run = (await request(app).get(`/api/documents/alpha/runs/${v1.id}`)).body as RunDTO;
    expect(run.findings.find(f => f.key === 'email#1')!.decision!.kind).toBe('accepted');
  });

  it('partial batch commit: valid items apply while conflicted items fail', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-2');
    // Phone gets reviewed first (its decision is now at revision 1).
    await postDecisions(app, v1.id, [{findingKey: 'phone#1', decision: 'rejected', baseRevision: 0}]);
    // One batch mixing a fresh accept, a stale CAS, an invalid range and an
    // unknown key. Only the fresh accept commits.
    const out = await postDecisions(app, v1.id, [
      {findingKey: 'email#1', decision: 'accepted', baseRevision: 0},
      {findingKey: 'phone#1', decision: 'accepted', baseRevision: 0}, // stale
      {findingKey: 'phone#1', decision: 'rejected', baseRevision: 1,
        range: {start: 0, end: 10}}, // rejected cannot carry a range
      {findingKey: 'ssn#9', decision: 'rejected', baseRevision: 0}, // unknown
    ], 200);
    const appliedKeys = out.applied.map(a => a.findingKey);
    const errorKeys = out.errors.map(e => `${e.findingKey}:${e.error}`);
    expect(appliedKeys).toEqual(['email#1']);
    expect(errorKeys).toEqual(expect.arrayContaining([
      'phone#1:revision_conflict',
      'phone#1:invalid_range',
      'ssn#9:unknown_finding',
    ]));
    expect(out.errors).toHaveLength(3);
    // setRevision bumped once, for the single applied item.
    expect(out.setRevision).toBe(2);
    // Server state reflects the partial commit: phone rejection survived.
    expect(out.run.findings.find(f => f.key === 'email#1')!.decision!.kind).toBe('accepted');
    expect(out.run.findings.find(f => f.key === 'phone#1')!.decision!.kind).toBe('rejected');
  });

  it('accepting a gone finding without a fresh explicit range is invalid', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-2');
    await request(app).put('/api/documents/alpha').send({
      content: 'Contact Ada at ada.lovelace@example.org.\nState: active.',
      revision: 3,
    }).expect(200);
    const v2 = await analyze(app, 'detector-2');
    const gone = v2.findings.find(f => f.key === 'phone#1' && f.gone)!;
    expect(gone).toBeTruthy();
    const out = await postDecisions(app, v2.id, [
      {findingKey: 'phone#1', decision: 'accepted', baseRevision: 0},
    ], 409);
    expect(out.applied).toEqual([]);
    expect(out.errors[0]).toMatchObject({findingKey: 'phone#1', error: 'invalid_range'});
  });

  it('duplicate key within one batch: first applies, later item conflicts', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-2');
    const out = await postDecisions(app, v1.id, [
      {findingKey: 'email#1', decision: 'accepted', baseRevision: 0},
      {findingKey: 'email#1', decision: 'rejected', baseRevision: 0}, // stale after first item
    ]);
    expect(out.applied.map(a => a.findingKey)).toEqual(['email#1']);
    expect(out.errors).toMatchObject([{findingKey: 'email#1', error: 'revision_conflict'}]);
    expect(out.run.findings.find(f => f.key === 'email#1')!.decision!.kind).toBe('accepted');
  });

  it('unfrozen decisions are reversible (pending) and revision-stamped', async () => {
    const app = createApp();
    const v1 = await analyze(app, 'detector-2');
    const first = await postDecisions(app, v1.id, [
      {findingKey: 'email#1', decision: 'accepted', baseRevision: 0},
    ]);
    const rev1 = first.run.findings.find(f => f.key === 'email#1')!.decision!.revision;
    expect(rev1).toBe(1);
    // Undo: pending removes the decision.
    const undone = await postDecisions(app, v1.id, [
      {findingKey: 'email#1', decision: 'pending', baseRevision: rev1},
    ]);
    const item = undone.applied.find(a => a.findingKey === 'email#1')!;
    expect(item.decision).toBeNull();
    expect(undone.run.findings.find(f => f.key === 'email#1')!.decision).toBeNull();
    // Undoing again with a stale baseRevision conflicts (decision absent => 0).
    const stale = await postDecisions(app, v1.id,
      [{findingKey: 'email#1', decision: 'pending', baseRevision: rev1}], 409);
    expect(stale.errors[0].error).toBe('revision_conflict');
  });
});
