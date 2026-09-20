import express from 'express';
import {fileURLToPath} from 'node:url';
import type {DecisionItemInput} from '../shared/types';
import {DETECTOR_VERSIONS, LATEST_DETECTOR, detectorExists} from './detector';
import {
  DocumentChangedError, RedactionStore, RevisionConflictError, RunFrozenError,
  SetRevisionConflictError, toRunDTO, toRunSummary,
} from './store';

const seed = () => [
  {id: 'alpha', name: 'Primary redaction findings', revision: 3,
    content: 'Contact Ada at ada.lovelace@example.org or 555-0134.\nState: active.',
    updatedAt: new Date(0).toISOString()},
  {id: 'beta', name: 'Secondary redaction findings', revision: 5,
    content: 'Reach Bo at bo@example.org.\nState: review.',
    updatedAt: new Date(1000).toISOString()},
];

export function createApp(){
  const app = express();
  const store = new RedactionStore(seed());
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'document-redaction', count: store.listDocs().length}));

  app.get('/api/detectors', (_req, res) =>
    res.json({versions: DETECTOR_VERSIONS, latest: LATEST_DETECTOR}));

  app.get('/api/documents', (_req, res) =>
    res.json(store.listDocs().map(({content, ...row}) => row)));

  app.get('/api/documents/:id', (req, res) => {
    const row = store.getDoc(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });

  app.put('/api/documents/:id', (req, res) => {
    if (!store.getDoc(req.params.id)) return res.status(404).json({error: 'not_found'});
    try {
      const row = store.editDoc(req.params.id, String(req.body.content ?? ''), Number(req.body.revision));
      res.json(row);
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return res.status(409).json({error: 'revision_conflict', current: error.current});
      }
      throw error;
    }
  });

  // ---- runs ------------------------------------------------------------

  app.get('/api/documents/:id/runs', (req, res) => {
    if (!store.getDoc(req.params.id)) return res.status(404).json({error: 'not_found'});
    res.json({runs: store.listRuns(req.params.id).map(toRunSummary)});
  });

  app.post('/api/documents/:id/analyze', async (req, res) => {
    const docId = String(req.params.id);
    if (!store.getDoc(docId)) return res.status(404).json({error: 'not_found'});
    const detectorVersion = typeof req.body?.detectorVersion === 'string'
      ? req.body.detectorVersion : LATEST_DETECTOR;
    if (!detectorExists(detectorVersion)) {
      return res.status(400).json({error: 'unknown_detector', versions: DETECTOR_VERSIONS});
    }
    // Detection is async work; two pages analyzing concurrently simply race
    // to create separate runs, neither overwrites the other.
    await new Promise(resolve => setTimeout(resolve, 20));
    const run = store.analyze(docId, detectorVersion);
    res.status(201).json(toRunDTO(run));
  });

  function loadRun(req: express.Request, res: express.Response) {
    const run = store.getRun(String(req.params.id), String(req.params.runId));
    if (!run) {
      res.status(404).json({error: 'not_found'});
      return null;
    }
    return run;
  }

  app.get('/api/documents/:id/runs/:runId', (req, res) => {
    const run = loadRun(req, res);
    if (run) res.json(toRunDTO(run));
  });

  // Batch decision review. Per-item CAS (baseRevision, 0 = must not exist),
  // partial commits are allowed; the response reports exactly what applied
  // and what conflicted. Unfrozen decisions are reversible; a frozen run
  // rejects every mutation.
  app.post('/api/documents/:id/runs/:runId/decisions', (req, res) => {
    const run = loadRun(req, res);
    if (!run) return;
    try {
      const items: DecisionItemInput[] = Array.isArray(req.body?.items) ? req.body.items : [];
      const {applied, errors} = store.applyDecisions(run, items);
      res.status(errors.length && !applied.length ? 409 : 200)
        .json({setRevision: run.setRevision, applied, errors, run: toRunDTO(run)});
    } catch (error) {
      if (error instanceof RunFrozenError) {
        return res.status(409).json({error: 'run_frozen', frozen: run.frozen?.id});
      }
      throw error;
    }
  });

  // Freeze the complete decision set and generate the final redacted text.
  // setRevision CAS ensures the caller reviewed exactly the set that gets
  // frozen: concurrent decision edits force a reload-and-retry instead of
  // producing text from a half-old, half-new decision mix.
  app.post('/api/documents/:id/runs/:runId/freeze', (req, res) => {
    const run = loadRun(req, res);
    if (!run) return;
    try {
      const freeze = store.freeze(run, Number(req.body?.setRevision));
      res.json(freeze);
    } catch (error) {
      if (error instanceof SetRevisionConflictError) {
        return res.status(409).json({
          error: 'set_revision_conflict',
          currentSetRevision: error.run.setRevision,
          run: toRunDTO(error.run),
        });
      }
      if (error instanceof DocumentChangedError) {
        return res.status(409).json({
          error: 'document_changed',
          documentRevision: store.getDoc(req.params.id)?.revision,
          runDocumentRevision: run.documentRevision,
        });
      }
      throw error;
    }
  });

  app.get('/api/documents/:id/runs/:runId/freeze', (req, res) => {
    const run = loadRun(req, res);
    if (!run) return;
    if (!run.frozen) return res.status(404).json({error: 'not_frozen'});
    res.json(run.frozen);
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
