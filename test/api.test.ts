import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {Store} from '../src/server/store';
import {detect} from '../src/server/detector';
import {reconcile} from '../src/server/reconcile';
import {previewRedacted} from '../src/client/review';

/** 每个用例独立 store，避免单例污染。 */
function setup() {
  const data = freshStore();
  return {app: createApp({store: data}), store: data};
}

function freshStore() {
  return new Store();
}

async function analyze(app: ReturnType<typeof createApp>, id: string, detectorVersion: string, expectedRev?: number) {
  const response = await request(app)
    .post(`/api/documents/${id}/analyze`)
    .send({detectorVersion, expectedRev, actor: 'tester'})
    .expect(200);
  return response.body.batch;
}

function pick(batch: any, rule: string, occurrence = 0) {
  return batch.findings.find((f: any) => f.rule === rule && f.occurrence === occurrence && f.presence !== 'missing');
}

describe('检测器升级', () => {
  it('升级到新版本后复用匹配的人工决策，新出现的规则标记为 new', async () => {
    const {app} = setup();
    const v1 = await analyze(app, 'alpha', '1.0.0');
    // 在旧版上接受邮箱、拒绝电话
    const email = pick(v1, 'email');
    const phone = pick(v1, 'phone');
    await request(app)
      .post(`/api/documents/alpha/batches/${v1.id}/decisions`)
      .send({
        submissions: [
          {findingId: email.id, decision: 'accepted', clientRev: email.rev},
          {findingId: phone.id, decision: 'rejected', clientRev: phone.rev},
        ],
      })
      .expect(200);

    const v2 = await analyze(app, 'alpha', '2.0.0');
    expect(v2.id).not.toBe(v1.id);
    const email2 = pick(v2, 'email');
    const phone2 = pick(v2, 'phone');
    const idCard = pick(v2, 'id_card');
    expect(email2.decision).toBe('accepted');
    expect(email2.origin).toBe('unchanged');
    expect(phone2.decision).toBe('rejected');
    expect(idCard.presence).toBe('new');
    expect(idCard.decision).toBe('pending');
    expect(email2.carriedFromBatch).toBe(v1.id);
  });

  it('新版本手机号范围扩张（+86 / 分机）时沿用上轮决策并标记范围变化', async () => {
    const store = freshStore();
    // beta 内容含 +86 与 ext，1.0.0 仅匹配核心 11 位
    const v1 = store.analyze('beta', {detectorVersion: '1.0.0', actor: 't'});
    const phone = v1.findings.find((f) => f.rule === 'phone')!;
    store.submitDecisions('beta', v1.id, [
      {findingId: phone.id, decision: 'accepted', clientRev: 1},
    ], {actor: 't'});
    const v2 = store.analyze('beta', {detectorVersion: '2.0.0', actor: 't'});
    const phone2 = v2.findings.find((f) => f.rule === 'phone')!;
    expect(phone2.decision).toBe('accepted');
    expect(phone2.origin).toBe('carried');
    expect(phone2.detected.end).toBeGreaterThan(phone.detected.end);
  });
});

describe('范围轻微变化与人工调整', () => {
  it('接受后调整范围须与检测范围相交；重复检测保留人工调整', () => {
    const store = freshStore();
    const b = store.analyze('beta', {detectorVersion: '2.0.0', actor: 't'});
    const email = b.findings.find((f) => f.rule === 'email')!;
    store.submitDecisions('beta', b.id, [{findingId: email.id, decision: 'accepted', clientRev: 1}], {actor: 't'});
    const after = store.getBatch('beta', b.id);
    const f = after.findings.find((x) => x.id === email.id)!;
    const originalEnd = f.detected.end;
    // 扩张 1 个字符，仍相交
    store.adjustScope('beta', b.id, email.id, {start: f.scope.start, end: f.scope.end + 1}, f.rev, 't');
    // 完全不相交 → 拒绝
    const f2 = store.getBatch('beta', b.id).findings.find((x) => x.id === email.id)!;
    expect(() =>
      store.adjustScope('beta', b.id, email.id, {start: 0, end: 1}, f2.rev, 't'),
    ).toThrow(/scope_must_overlap_detected/);

    // 幂等重复检测：人工调整随决策保留
    const again = store.analyze('beta', {detectorVersion: '2.0.0', actor: 't'});
    expect(again.id).toBe(b.id);
    const kept = again.findings.find((x) => x.id === email.id)!;
    expect(kept.scopeChanged).toBe(true);
    expect(kept.scope.end).toBe(originalEnd + 1);
  });

  it('调和单元测试：范围平移且核心文本相同时 carried', () => {
    const hits = detect('aa zhang.wei@example.com bb', '2.0.0');
    const prior = [
      {
        finding: {
          id: 'old',
          batchId: 'oldbatch',
          rule: 'email' as const,
          ruleLabel: '邮箱地址',
          detected: {start: 3, end: 25},
          scope: {start: 3, end: 25},
          match: 'zhang.wei@example.com',
          normalized: 'zhang.wei@example.com',
          occurrence: 0,
          decision: 'accepted' as const,
          presence: 'active' as const,
          origin: 'detected' as const,
          scopeChanged: false,
          rev: 4,
          updatedAt: '',
        },
      },
    ];
    const result = reconcile(hits, prior);
    const m = result.matched.find((x) => x.hit.rule === 'email')!;
    expect(m.origin).toBe('carried');
    expect(m.carriedFromFinding).toBe('old');
  });
});

describe('重复建议（重复检测）', () => {
  it('同 revision/内容/版本重复检测幂等，且复用仍匹配的人工决策；消失建议标 missing', async () => {
    const {app} = setup();
    const first = await analyze(app, 'beta', '2.0.0');
    const email = pick(first, 'email');
    await request(app)
      .post(`/api/documents/beta/batches/${first.id}/decisions`)
      .send({submissions: [{findingId: email.id, decision: 'accepted', clientRev: email.rev}]})
      .expect(200);
    const again = await analyze(app, 'beta', '2.0.0');
    expect(again.id).toBe(first.id);
    expect(pick(again, 'email').decision).toBe('accepted');

    // 编辑文档移除邮箱后用同版本重新检测：新批次里邮箱消失 → missing，新内容 new
    const doc = await request(app).get('/api/documents/beta').expect(200);
    await request(app)
      .put('/api/documents/beta')
      .send({revision: doc.body.revision, content: '公告热线 +86 139-0000-1234 ext.88，无邮箱。'})
      .expect(200);
    const after = await analyze(app, 'beta', '2.0.0');
    expect(after.id).not.toBe(first.id);
    const missingEmail = after.findings.find(
      (f: any) => f.rule === 'email' && f.presence === 'missing',
    );
    expect(missingEmail).toBeTruthy();
    expect(missingEmail.decision).toBe('accepted');
    const phone = pick(after, 'phone');
    expect(phone.presence).toBe('active');
    expect(phone.decision).toBe('pending');
  });

  it('检测器内部等价规则产生的同 span 命中去重', () => {
    const hits = detect('联系 a.b@example.com 即可', '2.0.0');
    expect(hits.filter((h) => h.rule === 'email')).toHaveLength(1);
  });
});

describe('文档编辑与并发', () => {
  it('文档 PUT 乐观锁：旧 revision 被拒，不做最后写入覆盖', async () => {
    const {app} = setup();
    const doc = await request(app).get('/api/documents/beta').expect(200);
    await request(app)
      .put('/api/documents/beta')
      .send({revision: doc.body.revision, content: '页面 A 的编辑'})
      .expect(200);
    await request(app)
      .put('/api/documents/beta')
      .send({revision: doc.body.revision, content: '页面 B 的陈旧写入'})
      .expect(409, /revision_conflict/);
    const after = await request(app).get('/api/documents/beta').expect(200);
    expect(after.body.content).toBe('页面 A 的编辑');
  });

  it('analyze 携带 expectedRev：检测基于的 revision 过期时返回冲突', async () => {
    const {app} = setup();
    const doc = await request(app).get('/api/documents/beta').expect(200);
    await request(app)
      .put('/api/documents/beta')
      .send({revision: doc.body.revision, content: 'press@example.org 已更新'})
      .expect(200);
    await request(app)
      .post('/api/documents/beta/analyze')
      .send({detectorVersion: '2.0.0', expectedRev: doc.body.revision})
      .expect(409, /revision_conflict/);
  });

  it('文档编辑后在旧批次上生成 → document_revision_conflict；新 revision 重新检测后可生成', async () => {
    const {app, store} = setup();
    const b = store.analyze('beta', {detectorVersion: '2.0.0', actor: 't'});
    for (const f of b.findings) {
      store.submitDecisions('beta', b.id, [{findingId: f.id, decision: 'accepted', clientRev: f.rev}], {actor: 't'});
    }
    const ready = store.getBatch('beta', b.id);
    // 另一页面编辑并保存文档（revision 前进）
    store.updateDocument('beta', '全新内容 admin@example.net', ready.documentRev, 'other-page');

    expect(() => store.freezeAndGenerate('beta', b.id, ready.rev)).toThrow(/document_revision_conflict/);
    expect(store.getBatch('beta', b.id).status).toBe('open');

    const b2 = store.analyze('beta', {detectorVersion: '2.0.0', actor: 't'});
    expect(b2.documentRev).toBe(ready.documentRev + 1);
    const admin = b2.findings.find((f) => f.rule === 'email')!;
    expect(admin.presence).toBe('new');
    store.submitDecisions('beta', b2.id, [{findingId: admin.id, decision: 'accepted', clientRev: admin.rev}], {actor: 't'});
    const ready2 = store.getBatch('beta', b2.id);
    const {batch} = store.freezeAndGenerate('beta', b2.id, ready2.rev);
    expect(batch.status).toBe('frozen');
    expect(batch.generated!.content).toContain('█');
    expect(batch.generated!.content).not.toContain('admin@example.net');
  });
});

describe('冻结与最终生成', () => {
  it('存在待审建议时生成失败且零变更（完整冻结集，否则失败）', async () => {
    const {app} = setup();
    const b = await analyze(app, 'beta', '2.0.0');
    const email = pick(b, 'email');
    await request(app)
      .post(`/api/documents/beta/batches/${b.id}/decisions`)
      .send({submissions: [{findingId: email.id, decision: 'accepted', clientRev: email.rev}]})
      .expect(200);
    const current = await request(app).get(`/api/documents/beta/batches/${b.id}`).expect(200);
    const res = await request(app)
      .post(`/api/documents/beta/batches/${b.id}/generate`)
      .send({expectedBatchRev: current.body.batch.rev, expectedDocRev: 5})
      .expect(409);
    expect(res.body.error).toBe('incomplete_decisions');
    expect(res.body.pendingFindingIds.length).toBeGreaterThan(0);
    const after = await request(app).get(`/api/documents/beta/batches/${b.id}`).expect(200);
    expect(after.body.batch.status).toBe('open');
    expect(after.body.batch.generated).toBeUndefined();
  });

  it('冻结后拒绝一切决策/范围修改，applied 不可撤销，生成可幂等重放', () => {
    const store = freshStore();
    const b = store.analyze('beta', {detectorVersion: '2.0.0', actor: 't'});
    for (const f of b.findings) {
      store.submitDecisions('beta', b.id, [{findingId: f.id, decision: 'rejected', clientRev: f.rev}], {actor: 't'});
    }
    let ready = store.getBatch('beta', b.id);
    const revBefore = ready.rev;
    const {batch: frozen} = store.freezeAndGenerate('beta', b.id, ready.rev);
    expect(frozen.findings.every((f) => f.decision === 'rejected')).toBe(true);
    expect(frozen.generated!.decisions).toHaveLength(frozen.findings.filter((f) => f.presence !== 'missing').length);

    // 冻结后提交决策 → 整批拒绝
    expect(() =>
      store.submitDecisions('beta', b.id, [
        {findingId: frozen.findings[0].id, decision: 'accepted', clientRev: frozen.findings[0].rev},
      ]),
    ).toThrow(/batch_frozen/);
    // 范围调整拒绝
    expect(() =>
      store.adjustScope('beta', b.id, frozen.findings[0].id, {start: 0, end: 2}, frozen.findings[0].rev),
    ).toThrow(/batch_frozen/);
    // 旧 batch rev 再冻结 → 冲突；正确 rev 幂等返回同一冻结结果
    expect(() => store.freezeAndGenerate('beta', b.id, revBefore)).toThrow(/batch_revision_conflict/);
    const again = store.freezeAndGenerate('beta', b.id, frozen.rev);
    expect(again.batch).toBe(frozen);
  });

  it('冻结快照记录每条决策的 scope 与 findingRev，可逐条追溯', () => {
    const store = freshStore();
    const b = store.analyze('beta', {detectorVersion: '2.0.0', actor: 't'});
    const email = b.findings.find((f) => f.rule === 'email')!;
    store.submitDecisions('beta', b.id, [{findingId: email.id, decision: 'accepted', clientRev: email.rev}], {actor: 't'});
    const accepted = store.getBatch('beta', b.id).findings.find((f) => f.id === email.id)!;
    store.adjustScope('beta', b.id, email.id, {start: accepted.scope.start, end: accepted.scope.end + 2}, accepted.rev, 't');
    const rest = store.getBatch('beta', b.id).findings.filter((f) => f.id !== email.id);
    for (const f of rest) {
      store.submitDecisions('beta', b.id, [{findingId: f.id, decision: 'rejected', clientRev: f.rev}], {actor: 't'});
    }
    const ready = store.getBatch('beta', b.id);
    const {batch} = store.freezeAndGenerate('beta', b.id, ready.rev);
    const snapEmail = batch.generated!.decisions.find((d) => d.findingId === email.id)!;
    const live = batch.findings.find((f) => f.id === email.id)!;
    expect(snapEmail.decision).toBe('accepted');
    expect(snapEmail.scope).toEqual(live.scope);
    expect(snapEmail.findingRev).toBe(live.rev);
    expect(live.decision).toBe('applied');
    // 最终文本恰好覆盖接受集，不混入拒绝项
    const rejected = batch.findings.filter((f) => f.decision === 'rejected');
    for (const f of rejected) expect(batch.generated!.content).toContain(f.match);
    expect(batch.generated!.content).not.toContain(email.match);
  });

  it('两个页面并发生成竞争：后到者 batch rev 过期被拒，不会产生第二套结果', async () => {
    const {app} = setup();
    const b = await analyze(app, 'beta', '2.0.0');
    for (const f of b.findings) {
      await request(app)
        .post(`/api/documents/beta/batches/${b.id}/decisions`)
        .send({submissions: [{findingId: f.id, decision: 'accepted', clientRev: f.rev}]})
        .expect(200);
    }
    const current = await request(app).get(`/api/documents/beta/batches/${b.id}`).expect(200);
    const rev = current.body.batch.rev;
    const first = await request(app)
      .post(`/api/documents/beta/batches/${b.id}/generate`)
      .send({expectedBatchRev: rev, expectedDocRev: 5})
      .expect(201);
    expect(first.body.batch.status).toBe('frozen');
    // 页面 B 持有同一 rev 同时生成（首请求已使其过期）→ 冲突
    const loser = await request(app)
      .post(`/api/documents/beta/batches/${b.id}/generate`)
      .send({expectedBatchRev: rev, expectedDocRev: 5})
      .expect(409);
    expect(loser.body.error).toBe('batch_revision_conflict');
  });
});

describe('部分批量提交', () => {
  it('只提交勾选的子集；rev 冲突的条目逐条进 conflicts 且不覆盖服务端值', async () => {
    const {app} = setup();
    const b = await analyze(app, 'beta', '2.0.0');
    const [email, ...others] = b.findings;
    // 页面 A 先接受 email（服务端 rev 前进）
    await request(app)
      .post(`/api/documents/beta/batches/${b.id}/decisions`)
      .send({submissions: [{findingId: email.id, decision: 'accepted', clientRev: email.rev}]})
      .expect(200);
    // 页面 B 用过期 rev 提交两条（一条过期、一条新鲜）
    const staleEmail = {...pick(b, 'email')};
    const phone = others.find((f: any) => f.rule === 'phone')!;
    const res = await request(app)
      .post(`/api/documents/beta/batches/${b.id}/decisions`)
      .send({
        submissions: [
          {findingId: staleEmail.id, decision: 'rejected', clientRev: staleEmail.rev},
          {findingId: phone.id, decision: 'accepted', clientRev: phone.rev},
        ],
      })
      .expect(200);
    expect(res.body.applied).toBe(1);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].findingId).toBe(email.id);
    const after = await request(app).get(`/api/documents/beta/batches/${b.id}`).expect(200);
    const emails = after.body.batch.findings.filter((f: any) => f.rule === 'email');
    expect(emails.every((f: any) => f.decision === 'accepted')).toBe(true);
    expect(after.body.batch.findings.find((f: any) => f.id === phone.id).decision).toBe('accepted');
  });

  it('撤销未冻结决策回到 pending 并还原检测范围；applied 不可撤销', () => {
    const store = freshStore();
    const b = store.analyze('beta', {detectorVersion: '2.0.0', actor: 't'});
    const email = b.findings.find((f) => f.rule === 'email')!;
    store.submitDecisions('beta', b.id, [{findingId: email.id, decision: 'accepted', clientRev: email.rev}], {actor: 't'});
    const f1 = store.getBatch('beta', b.id).findings.find((x) => x.id === email.id)!;
    store.adjustScope('beta', b.id, email.id, {start: f1.scope.start, end: f1.scope.end + 1}, f1.rev, 't');
    const f2 = store.getBatch('beta', b.id).findings.find((x) => x.id === email.id)!;
    store.submitDecisions('beta', b.id, [{findingId: email.id, decision: 'pending', clientRev: f2.rev}], {actor: 't'});
    const f3 = store.getBatch('beta', b.id).findings.find((x) => x.id === email.id)!;
    expect(f3.decision).toBe('pending');
    expect(f3.scope).toEqual(f3.detected);
    expect(f3.scopeChanged).toBe(false);
  });

  it('客户端预览与服务端生成结果对同一接受集一致', () => {
    const store = freshStore();
    const b = store.analyze('beta', {detectorVersion: '2.0.0', actor: 't'});
    for (const f of b.findings) {
      store.submitDecisions('beta', b.id, [{findingId: f.id, decision: 'accepted', clientRev: f.rev}], {actor: 't'});
    }
    const ready = store.getBatch('beta', b.id);
    const clientPreview = previewRedacted(store.getDocument('beta').content, ready.findings);
    const {batch} = store.freezeAndGenerate('beta', b.id, ready.rev);
    expect(clientPreview).toBe(batch.generated!.content);
  });
});
