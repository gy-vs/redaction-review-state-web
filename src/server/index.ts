import express from 'express';
import {fileURLToPath} from 'node:url';
import type {DecisionSubmission, Scope} from '../shared/types';
import {DEFAULT_DETECTOR_VERSION, detectorInfo, detectorVersions} from './detector';
import {RevisionConflict, store} from './store';

const CONFLICT_CODES = new Set([
  'revision_conflict',
  'batch_frozen',
  'batch_revision_conflict',
  'document_revision_conflict',
  'finding_revision_conflict',
  'incomplete_decisions',
  'only_accepted_scope_adjustable',
  'finding_missing',
  'invalid_scope',
  'scope_must_overlap_detected',
  'unknown_detector',
]);

export function createApp(deps: {store?: import('./store').Store} = {}) {
  const data = deps.store ?? store;
  const app = express();
  app.use(express.json({limit: '1mb'}));

  // 集中映射领域冲突；绝不做静默的最后写入覆盖。
  const fail = (res: express.Response, error: unknown) => {
    if (error instanceof RevisionConflict) {
      const status = error.code === 'not_found' ? 404 : CONFLICT_CODES.has(error.code) ? 409 : 400;
      return res.status(status).json({error: error.code, ...error.detail});
    }
    return res.status(500).json({error: 'internal'});
  };

  app.get('/api/bootstrap', (_req, res) =>
    res.json({
      family: 'document-redaction',
      count: data.listDocuments().length,
      detectorVersions: detectorVersions(),
      defaultDetectorVersion: DEFAULT_DETECTOR_VERSION,
    }),
  );

  app.get('/api/detectors', (_req, res) =>
    res.json({versions: detectorVersions().map((v) => detectorInfo(v)!)}),
  );

  app.get('/api/documents', (_req, res) =>
    res.json(
      data.listDocuments().map(({content: _content, ...row}) => ({
        ...row,
        latestBatchId: data.latestBatch(row.id)?.id ?? null,
      })),
    ),
  );

  app.get('/api/documents/:id', (req, res) => {
    try {
      const row = data.getDocument(req.params.id);
      res.set('ETag', `"${row.revision}"`);
      res.json(row);
    } catch (error) {
      fail(res, error);
    }
  });

  app.put('/api/documents/:id', (req, res) => {
    try {
      const row = data.updateDocument(
        req.params.id,
        String(req.body.content ?? ''),
        Number(req.body.revision),
        String(req.body.actor ?? 'reviewer'),
      );
      res.json(row);
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/documents/:id/batches', (req, res) => {
    try {
      res.json({batches: data.listBatches(req.params.id)});
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/documents/:id/batches/:bid', (req, res) => {
    try {
      res.json({batch: data.getBatch(req.params.id, req.params.bid)});
    } catch (error) {
      fail(res, error);
    }
  });

  // 重复检测幂等：同 revision + 内容 + 检测器版本复用既有批次与全部人工决策。
  app.post('/api/documents/:id/analyze', (req, res) => {
    try {
      const batch = data.analyze(req.params.id, {
        detectorVersion: req.body.detectorVersion,
        expectedRev: req.body.expectedRev,
        actor: String(req.body.actor ?? 'reviewer'),
      });
      res.json({batch});
    } catch (error) {
      fail(res, error);
    }
  });

  // 部分批量提交：成功的写入，rev 冲突的逐条返回；冻结批次整批拒绝。
  app.post('/api/documents/:id/batches/:bid/decisions', (req, res) => {
    try {
      const submissions = (req.body.submissions ?? []) as DecisionSubmission[];
      const result = data.submitDecisions(req.params.id, req.params.bid, submissions, {
        actor: String(req.body.actor ?? 'reviewer'),
      });
      res.json({batch: result.batch, conflicts: result.conflicts, applied: result.applied});
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/documents/:id/batches/:bid/findings/:fid/scope', (req, res) => {
    try {
      const scope = req.body.scope as Scope;
      const batch = data.adjustScope(
        req.params.id,
        req.params.bid,
        req.params.fid,
        {start: Number(scope?.start), end: Number(scope?.end)},
        Number(req.body.clientRev),
        String(req.body.actor ?? 'reviewer'),
      );
      res.json({batch});
    } catch (error) {
      fail(res, error);
    }
  });

  // 最终脱敏文本：完整冻结集，原子成功或失败。
  app.post('/api/documents/:id/batches/:bid/generate', (req, res) => {
    try {
      const result = data.freezeAndGenerate(req.params.id, req.params.bid, Number(req.body.expectedBatchRev), {
        expectedDocRev: req.body.expectedDocRev,
        actor: String(req.body.actor ?? 'reviewer'),
      });
      res.status(201).json({batch: result.batch, document: result.doc});
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/audit', (req, res) => {
    const docId = typeof req.query.documentId === 'string' ? req.query.documentId : undefined;
    const batchId = typeof req.query.batchId === 'string' ? req.query.batchId : undefined;
    const events = data.audit.filter(
      (event) =>
        (!docId || event.documentId === docId) && (!batchId || event.batchId === batchId),
    );
    res.json({events});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
