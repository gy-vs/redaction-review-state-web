import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Check, CheckCheck, FileLock2, FlaskConical, RotateCcw, Save, ShieldCheck, X} from 'lucide-react';
import type {
  AuditEvent,
  Batch,
  DetectorInfo,
  DocSummary,
  Finding,
} from '../shared/types';
import {api, type ApiError, type DocRow} from './api';
import {
  buildSubmissions,
  counts,
  groupByLane,
  LANES,
  missingFindings,
  originLabel,
  previewRedacted,
  type LaneKey,
} from './review';

type Toast = {kind: 'error' | 'info' | 'success'; text: string} | null;

export default function App() {
  const [items, setItems] = useState<DocSummary[]>([]);
  const [detectors, setDetectors] = useState<DetectorInfo[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [detectorVersion, setDetectorVersion] = useState('2.0.0');
  const [doc, setDoc] = useState<DocRow | null>(null);
  const [draft, setDraft] = useState('');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const batch = useMemo(
    () => batches.find((b) => b.id === batchId) ?? batches[batches.length - 1] ?? null,
    [batches, batchId],
  );
  const frozen = batch?.status === 'frozen';
  const lanes = useMemo(() => groupByLane(batch), [batch]);
  const gone = useMemo(() => missingFindings(batch), [batch]);
  const stats = useMemo(() => counts(batch), [batch]);
  const canGenerate = !!batch && !frozen && stats.active > 0 && stats.pending === 0;

  const notify = useCallback((next: Toast) => {
    setToast(next);
    if (next) window.setTimeout(() => setToast(null), 5000);
  }, []);

  const describeError = useCallback(
    (error: ApiError) => {
      const map: Record<string, string> = {
        revision_conflict: '文档 revision 冲突：内容已被另一页面修改，请重新加载后再操作',
        batch_revision_conflict: '建议批次已被另一页面更新，已为你刷新，未覆盖对方决策',
        document_revision_conflict: '文档在检测后被编辑：该批次不能生成，请在新 revision 重新检测',
        batch_frozen: '该批次已冻结并生成最终文本，决策不可再修改',
        incomplete_decisions: '仍有待审建议：必须完整决策后才能生成最终脱敏文本',
        finding_revision_conflict: '该建议已被另一页面修改，请刷新后重试（未做覆盖）',
        only_accepted_scope_adjustable: '只有“接受”状态的建议可以调整范围',
        scope_must_overlap_detected: '调整后的范围必须与检测器原始范围相交',
        invalid_scope: '范围不合法（需在文档内且 start < end）',
      };
      notify({kind: 'error', text: map[error.error] ?? `操作失败：${error.error}`});
    },
    [notify],
  );

  const loadAudit = useCallback(async (id: string) => {
    try {
      const value = await api.audit(id);
      setAudit(value.events.reverse());
    } catch {
      /* 审计加载失败不阻塞审阅 */
    }
  }, []);

  const loadDocument = useCallback(
    async (id: string) => {
      const value = await api.getDocument(id);
      setDoc(value);
      setDraft(value.content);
      const list = await api.listBatches(id);
      setBatches(list.batches);
      setBatchId(list.batches[list.batches.length - 1]?.id ?? null);
      setChecked(new Set());
      await loadAudit(id);
    },
    [loadAudit],
  );

  useEffect(() => {
    api.listDocuments().then(setItems).catch(() => undefined);
    api.detectors().then((value) => setDetectors(value.versions)).catch(() => undefined);
  }, []);

  useEffect(() => {
    loadDocument(selected).catch((error: ApiError) => describeError(error));
  }, [selected, loadDocument, describeError]);

  const syncBatch = useCallback(
    (next: Batch, message?: string) => {
      setBatches((prev) => {
        const others = prev.filter((b) => b.documentId !== next.documentId || b.id !== next.id);
        return [...others, next].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
      setBatchId(next.id);
      if (message) notify({kind: 'success', text: message});
    },
    [notify],
  );

  async function saveDocument() {
    if (!doc) return;
    setBusy(true);
    try {
      const value = await api.saveDocument(doc.id, draft, doc.revision);
      setDoc(value);
      setDraft(value.content);
      notify({kind: 'success', text: `文档已保存（revision ${value.revision}）。旧批次仍保留待追溯。`});
      await loadDocument(doc.id);
    } catch (error) {
      describeError(error as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function runAnalyze() {
    if (!doc) return;
    setBusy(true);
    try {
      const {batch: next} = await api.analyze(doc.id, detectorVersion, doc.revision);
      const existed = batches.some((b) => b.id === next.id);
      syncBatch(next);
      notify({
        kind: existed ? 'info' : 'success',
        text: existed
          ? '重复检测：复用既有批次与全部人工决策'
          : `检测完成（${next.detectorVersion} @ rev ${next.documentRev}），匹配的人工决策已沿用`,
      });
      await loadAudit(doc.id);
    } catch (error) {
      describeError(error as ApiError);
    } finally {
      setBusy(false);
    }
  }

  /** 部分批量提交：只发送勾选条目；冲突条目由服务端逐条返回，不覆盖。 */
  const submit = useCallback(
    async (
      decision: 'accepted' | 'rejected' | 'pending',
      ids: Set<string>,
      source?: Finding[],
    ) => {
      if (!batch || frozen) return;
      const findings = source ?? batch.findings;
      const submissions = buildSubmissions(ids, decision, findings, frozen);
      if (submissions.length === 0) return;
      setBusy(true);
      try {
        const result = await api.submitDecisions(batch.documentId, batch.id, submissions);
        syncBatch(result.batch);
        setChecked((prev) => {
          const next = new Set(prev);
          for (const item of submissions) next.delete(item.findingId);
          return next;
        });
        if (result.conflicts.length > 0) {
          notify({
            kind: 'error',
            text: `${result.conflicts.length} 条建议已被另一页面改动，已保留服务端版本，未做覆盖`,
          });
        } else {
          const label = decision === 'pending' ? '已撤销为待审' : decision === 'accepted' ? '已接受' : '已拒绝';
          notify({kind: 'success', text: `${result.applied} 条建议${label}`});
        }
        await loadAudit(batch.documentId);
      } catch (error) {
        describeError(error as ApiError);
      } finally {
        setBusy(false);
      }
    },
    [batch, frozen, syncBatch, notify, describeError, loadAudit],
  );

  async function generate() {
    if (!batch || !doc) return;
    setBusy(true);
    try {
      const result = await api.generate(doc.id, batch.id, batch.rev, doc.revision);
      setDoc(result.document);
      syncBatch(result.batch, '决策集已冻结，最终脱敏文本已生成');
      setChecked(new Set());
      await loadAudit(doc.id);
    } catch (error) {
      describeError(error as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const laneIds = (lane: LaneKey) => new Set(lanes[lane].map((f) => f.id));
  const allActiveIds = () =>
    new Set(batch?.findings.filter((f) => f.presence !== 'missing').map((f) => f.id) ?? []);

  // 键盘批量审阅：输入控件内不拦截。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!batch || frozen) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
        event.preventDefault();
        setChecked(allActiveIds());
        return;
      }
      if (event.key === 'Escape') {
        setChecked(new Set());
        return;
      }
      let ids = checked;
      if (checked.size === 0) {
        // 无勾选时作用于“待审”泳道；Shift+ 键作用于全部活跃建议。
        ids = event.shiftKey ? allActiveIds() : laneIds('pending');
      }
      if (ids.size === 0) return;
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        void submit('accepted', ids);
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        void submit('rejected', ids);
      } else if (event.key === 'z' || event.key === 'Z') {
        event.preventDefault();
        void submit('pending', ids);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [batch, frozen, checked, submit]);

  const dirty = doc?.content !== draft;

  return (
    <main className="shell">
      <header className="topbar">
        <ShieldCheck size={20} />
        <strong>文本脱敏审阅工作台</strong>
        <small>revision × 检测器版本 · 决策冻结可追溯</small>
      </header>
      {toast && (
        <div className={`toast ${toast.kind}`}>
          {toast.kind === 'error' ? <X size={15} /> : <Check size={15} />}
          <span>{toast.text}</span>
        </div>
      )}
      <section className="workspace">
        <aside className="pane doc-pane">
          <h2>文档</h2>
          <div className="list">
            {items.map((item) => (
              <button
                className={item.id === selected ? 'active' : ''}
                onClick={() => setSelected(item.id)}
                key={item.id}
              >
                {item.name}
                <br />
                <small>rev {item.revision}</small>
              </button>
            ))}
          </div>
          <h3>检测器版本</h3>
          <select
            value={detectorVersion}
            onChange={(event) => setDetectorVersion(event.target.value)}
          >
            {detectors.map((d) => (
              <option value={d.version} key={d.version}>
                {d.version}
              </option>
            ))}
          </select>
          <ul className="rule-list">
            {detectors
              .find((d) => d.version === detectorVersion)
              ?.rules.map((rule) => (
                <li key={rule.id}>
                  <code>{rule.id}</code> {rule.description}
                </li>
              ))}
          </ul>
        </aside>

        <section className="pane editor-pane">
          <div className="toolbar">
            <button className="primary" onClick={saveDocument} disabled={busy || !dirty}>
              <Save size={15} />
              保存编辑
            </button>
            <button onClick={runAnalyze} disabled={busy || !doc}>
              <FlaskConical size={15} />
              运行 / 重复检测
            </button>
            {dirty && <span className="warn">有未保存修改</span>}
            <span className="spacer" />
            {doc && <span className="pill">rev {doc.revision}</span>}
          </div>
          <textarea
            ref={textareaRef}
            aria-label="文档内容"
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="preview">
            <h3>接受集脱敏预览（未冻结）</h3>
            <pre>{batch ? previewRedacted(draft, batch.findings) : draft}</pre>
          </div>
        </section>

        <aside className="pane review-pane">
          {!batch ? (
            <p className="empty">尚无检测批次，请先运行检测。</p>
          ) : (
            <>
              <div className="batch-head">
                <h2>审阅批次</h2>
                <div className="batch-meta">
                  <span className="pill">detector {batch.detectorVersion}</span>
                  <span className="pill">doc rev {batch.documentRev}</span>
                  <span className="pill">batch rev {batch.rev}</span>
                  {frozen ? (
                    <span className="pill frozen">
                      <FileLock2 size={13} /> 已冻结
                    </span>
                  ) : (
                    <span className="pill open">未冻结</span>
                  )}
                </div>
                {batches.length > 1 && (
                  <select
                    value={batch.id}
                    onChange={(event) => {
                      setBatchId(event.target.value);
                      setChecked(new Set());
                    }}
                  >
                    {batches.map((b) => (
                      <option value={b.id} key={b.id}>
                        {b.detectorVersion} @ rev {b.documentRev} — {b.status === 'frozen' ? '冻结' : '开放'}
                      </option>
                    ))}
                  </select>
                )}
                <p className="keys">
                  勾选后 <kbd>A</kbd> 接受 <kbd>R</kbd> 拒绝 <kbd>Z</kbd> 撤销；未勾选时作用于待审泳道，
                  <kbd>Shift</kbd>+键 作用于全部，<kbd>Ctrl/⌘</kbd>+<kbd>A</kbd> 全选，<kbd>Esc</kbd> 清空。
                </p>
                <div className="bulk-bar">
                  <button
                    disabled={busy || frozen || checked.size === 0}
                    onClick={() => void submit('accepted', checked)}
                  >
                    <Check size={14} /> 接受所选
                  </button>
                  <button
                    disabled={busy || frozen || checked.size === 0}
                    onClick={() => void submit('rejected', checked)}
                  >
                    <X size={14} /> 拒绝所选
                  </button>
                  <button
                    disabled={busy || frozen || checked.size === 0}
                    onClick={() => void submit('pending', checked)}
                  >
                    <RotateCcw size={14} /> 撤销所选
                  </button>
                  <button
                    className="ghost"
                    disabled={busy || frozen}
                    onClick={() => void submit('accepted', allActiveIds())}
                    title="一键接受全部活跃建议"
                  >
                    <CheckCheck size={14} /> 全部接受
                  </button>
                  <span className="spacer" />
                  <button
                    className="primary generate"
                    disabled={busy || frozen || !canGenerate}
                    onClick={generate}
                    title={
                      stats.pending > 0 ? `还有 ${stats.pending} 条待审` : '冻结决策并生成最终文本'
                    }
                  >
                    <FileLock2 size={14} />
                    {frozen ? '已生成最终文本' : `生成最终脱敏文本${stats.pending ? `（剩 ${stats.pending} 待审）` : ''}`}
                  </button>
                </div>
              </div>

              {LANES.map((lane) => (
                <section className={`lane ${lane.key}`} key={lane.key}>
                  <h3>
                    {lane.title}
                    <span className="count">{lanes[lane.key].length}</span>
                    <small>{lane.hint}</small>
                  </h3>
                  {lanes[lane.key].length === 0 && <p className="empty-lane">—</p>}
                  {lanes[lane.key].map((finding) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      checked={checked.has(finding.id)}
                      frozen={!!frozen}
                      onToggle={() => toggle(finding.id)}
                      onQuick={(decision) =>
                        void submit(decision, new Set([finding.id]), [finding])
                      }
                      onScope={async (scope) => {
                        if (!batch) return;
                        setBusy(true);
                        try {
                          const result = await api.adjustScope(
                            doc!.id,
                            batch.id,
                            finding.id,
                            scope,
                            finding.rev,
                          );
                          syncBatch(result.batch, '范围已调整');
                          await loadAudit(doc!.id);
                        } catch (error) {
                          describeError(error as ApiError);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    />
                  ))}
                </section>
              ))}

              {gone.length > 0 && (
                <section className="lane missing">
                  <h3>
                    已消失（保留追溯，不参与生成）
                    <span className="count">{gone.length}</span>
                  </h3>
                  {gone.map((finding) => (
                    <div className="finding gone" key={finding.id}>
                      <code>{finding.ruleLabel}</code>
                      <span className="match">{finding.match}</span>
                      <small>
                        {finding.decision} · rev {finding.rev}
                      </small>
                    </div>
                  ))}
                </section>
              )}

              {batch.generated && (
                <section className="lane output">
                  <h3>最终脱敏文本（冻结集，{batch.generated.appliedFindingIds.length} 条应用）</h3>
                  <pre>{batch.generated.content}</pre>
                  <details>
                    <summary>冻结决策快照（{batch.generated.decisions.length} 条）与审计</summary>
                    <ol className="snapshot">
                      {batch.generated.decisions.map((d) => (
                        <li key={d.findingId}>
                          <code>{d.findingId}</code> {d.decision} [{d.scope.start},{d.scope.end})
                          <small>finding rev {d.findingRev}</small>
                        </li>
                      ))}
                    </ol>
                  </details>
                </section>
              )}
            </>
          )}
          <AuditTrail events={audit.filter((e) => batch && e.batchId === batch.id)} />
        </aside>
      </section>
    </main>
  );
}

function FindingCard({
  finding,
  checked,
  frozen,
  onToggle,
  onQuick,
  onScope,
}: {
  finding: Finding;
  checked: boolean;
  frozen: boolean;
  onToggle: () => void;
  onQuick: (decision: 'accepted' | 'rejected' | 'pending') => void;
  onScope: (scope: {start: number; end: number}) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(finding.scope.start);
  const [end, setEnd] = useState(finding.scope.end);

  return (
    <div className={`finding ${checked ? 'checked' : ''}`}>
      <label className="pick">
        <input type="checkbox" checked={checked} onChange={onToggle} disabled={frozen} />
      </label>
      <div className="finding-body">
        <div className="finding-line">
          <code>{finding.ruleLabel}</code>
          <span className="match">{finding.match}</span>
          {finding.scopeChanged && <span className="badge scope">范围已调整</span>}
          {originLabel(finding) && <span className="badge origin">{originLabel(finding)}</span>}
          <small className="rev">
            [{finding.scope.start},{finding.scope.end}) rev {finding.rev}
          </small>
        </div>
        {!frozen && (
          <div className="finding-actions">
            {finding.decision !== 'accepted' && (
              <button onClick={() => onQuick('accepted')}>
                <Check size={13} /> 接受
              </button>
            )}
            {finding.decision !== 'rejected' && (
              <button onClick={() => onQuick('rejected')}>
                <X size={13} /> 拒绝
              </button>
            )}
            {finding.decision === 'accepted' && (
              <button className="ghost" onClick={() => setEditing((v) => !v)}>
                调整范围
              </button>
            )}
            {finding.decision !== 'pending' && (
              <button className="ghost" onClick={() => onQuick('pending')}>
                <RotateCcw size={13} /> 撤销
              </button>
            )}
          </div>
        )}
        {editing && finding.decision === 'accepted' && (
          <div className="scope-editor">
            起始
            <input
              type="number"
              value={start}
              onChange={(e) => setStart(Number(e.target.value))}
            />
            结束
            <input type="number" value={end} onChange={(e) => setEnd(Number(e.target.value))} />
            <small>
              须与原始范围 [{finding.detected.start},{finding.detected.end}) 相交
            </small>
            <button
              onClick={async () => {
                await onScope({start, end});
                setEditing(false);
              }}
            >
              应用范围
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AuditTrail({events}: {events: AuditEvent[]}) {
  return (
    <section className="audit">
      <h3>该批次审计轨迹</h3>
      {events.length === 0 ? (
        <p className="empty-lane">暂无</p>
      ) : (
        <ol>
          {events.map((event) => (
            <li key={event.id}>
              <small>{new Date(event.at).toLocaleTimeString()}</small>{' '}
              <code>{event.action}</code> {event.actor}
              {event.findingId && <> · {event.findingId.slice(0, 10)}…</>}
              <pre>{JSON.stringify(event.detail)}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
