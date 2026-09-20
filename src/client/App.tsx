import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Check, FlaskConical, Lock, Play, RotateCcw, Save, Snowflake, X,
} from 'lucide-react';
import type {DecisionItemInput, FindingDTO, FreezeRecord, RunDTO, Span} from '../shared/types';
import {api, ApiError} from './api';

type Summary = {id: string; name: string; revision: number; updatedAt: string};
type Row = Summary & {content: string};
type Stage = 'pending' | 'accepted' | 'rejected' | 'applied';
type Notice = {kind: 'info' | 'error'; text: string};

const STAGES: {key: Stage; label: string; hotkey: string}[] = [
  {key: 'pending', label: '待审', hotkey: '1'},
  {key: 'accepted', label: '接受', hotkey: '2'},
  {key: 'rejected', label: '拒绝', hotkey: '3'},
  {key: 'applied', label: '已应用', hotkey: '4'},
];

function stageOf(finding: FindingDTO, frozen: boolean): Stage {
  if (frozen && !finding.gone && finding.decision?.kind === 'accepted') return 'applied';
  if (finding.decision?.kind === 'accepted') return 'accepted';
  if (finding.decision?.kind === 'rejected') return 'rejected';
  return 'pending';
}

const LIFECYCLE_LABEL: Record<string, string> = {
  new: '新增', carried: '复用', returning: '重现', gone: '消失',
};

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [detectors, setDetectors] = useState<{versions: string[]; latest: string} | null>(null);
  const [selected, setSelected] = useState('alpha');
  const [row, setRow] = useState<Row | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [detectorVersion, setDetectorVersion] = useState('');
  const [run, setRun] = useState<RunDTO | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [freeze, setFreeze] = useState<FreezeRecord | null>(null);
  const [stage, setStage] = useState<Stage>('pending');
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.documents().then(setItems).catch(() => undefined);
    api.detectors().then(value => {
      setDetectors(value);
      setDetectorVersion(value.latest);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    setRow(null);
    setRun(null);
    setFreeze(null);
    setNotice(null);
    api.document(selected).then(value => {
      setRow(value);
      setDraft(value.content);
    }).catch(() => undefined);
  }, [selected]);

  const frozen = !!run?.frozen;
  const docStale = !!run && !!row && run.documentRevision !== row.revision;

  const staged = useMemo(
    () => run ? run.findings.filter(f => stageOf(f, frozen) === stage) : [],
    [run, stage, frozen],
  );
  const counts = useMemo(() => {
    const result: Record<Stage, number> = {pending: 0, accepted: 0, rejected: 0, applied: 0};
    if (run) for (const f of run.findings) result[stageOf(f, frozen)] += 1;
    return result;
  }, [run, frozen]);
  const pendingFresh = run ? run.findings.filter(f => !f.gone && !f.decision).length : 0;

  useEffect(() => setCursor(0), [stage, run?.id]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({block: 'nearest'});
  }, [cursor, staged.length]);

  const flash = useCallback((kind: 'info' | 'error', text: string) => setNotice({kind, text}), []);

  // ---- document ---------------------------------------------------------

  async function saveDocument() {
    if (!row) return;
    setSaving(true);
    try {
      const saved = await api.saveDocument(row.id, draft, row.revision);
      setRow(saved);
      setItems(current => current.map(item => item.id === saved.id
        ? {...item, revision: saved.revision, updatedAt: new Date().toISOString()} : item));
      flash('info', `已保存为 revision ${saved.revision}；检测基于旧文档，请重新检测后再审阅。`);
    } catch (error) {
      if (error instanceof ApiError && error.message === 'revision_conflict') {
        const current = error.body.current as Row;
        setRow(current);
        setDraft(current.content);
        flash('error', `文档已被另一页面更新（revision ${current.revision}）：已加载最新版本，请重新套用你的修改，不会覆盖对方。`);
      } else {
        flash('error', '保存失败');
      }
    } finally {
      setSaving(false);
    }
  }

  // ---- analysis ---------------------------------------------------------

  async function analyzeDoc() {
    if (!row) return;
    setAnalyzing(true);
    setFreeze(null);
    try {
      const next = await api.analyze(row.id, detectorVersion || undefined);
      setRun(next);
      const carried = next.findings.filter(f => f.lifecycle === 'carried').length;
      const gone = next.findings.filter(f => f.gone).length;
      const fresh = next.findings.filter(f => !f.gone && f.lifecycle !== 'carried').length;
      flash('info', `检测完成：${next.findings.length - gone} 条建议`
        + (carried ? `，复用 ${carried} 条仍匹配的人工决策` : '')
        + (gone ? `，${gone} 条消失` : '')
        + (fresh ? `，${fresh} 条需审阅` : ''));
    } catch {
      flash('error', '检测失败');
    } finally {
      setAnalyzing(false);
    }
  }

  // ---- decisions --------------------------------------------------------

  // Batch submit with per-item compare-and-set. The server commits valid
  // items even when siblings fail (partial batch commit).
  const submitItems = useCallback(async (items: DecisionItemInput[]) => {
    if (!run || frozen || items.length === 0) return;
    setBusy(true);
    try {
      const result = await api.decide(run.docId, run.id, items);
      setRun(result.run);
      if (result.errors.length) {
        const reasons = [...new Set(result.errors.map(e => e.error))];
        flash('error', `${result.applied.length} 项已提交，${result.errors.length} 项失败（${reasons.join('、')}），列表已刷新为服务端状态。`);
      } else {
        setNotice(null);
      }
    } catch (error) {
      if (error instanceof ApiError && error.message === 'run_frozen') {
        setRun(await api.run(run.docId, run.id));
        flash('error', '该 revision 已冻结，决策不可修改。');
      }
    } finally {
      setBusy(false);
    }
  }, [run, frozen, flash]);

  const decideOne = useCallback((finding: FindingDTO, decision: DecisionItemInput['decision']) => {
    void submitItems([{
      findingKey: finding.key, decision,
      baseRevision: finding.decision?.revision ?? 0,
    }]);
  }, [submitItems]);

  const adjustRange = useCallback((finding: FindingDTO, range: Span) => {
    void submitItems([{
      findingKey: finding.key, decision: 'accepted', range,
      baseRevision: finding.decision?.revision ?? 0,
    }]);
  }, [submitItems]);

  function batchDecide(decision: 'accepted' | 'rejected') {
    if (!run) return;
    // Only pending fresh findings are batch targets; reviewed items keep
    // their decision (undo them first if you want to change them).
    const targets = run.findings.filter(f => !f.gone && !f.decision);
    void submitItems(targets.map(f => ({findingKey: f.key, decision, baseRevision: 0})));
  }

  // ---- freeze -----------------------------------------------------------

  async function freezeRun() {
    if (!run) return;
    if (pendingFresh > 0) {
      flash('error', `还有 ${pendingFresh} 条待审建议；最终文本只能由完整冻结集生成。`);
      setStage('pending');
      return;
    }
    setBusy(true);
    try {
      const record = await api.freeze(run.docId, run.id, run.setRevision);
      setRun(await api.run(run.docId, run.id));
      setFreeze(record);
      setStage('applied');
      flash('info', `已冻结 ${record.id}（文档 r${record.documentRevision} / ${record.detectorVersion} / setRevision ${record.setRevision}），最终脱敏文本已生成。`);
    } catch (error) {
      if (!(error instanceof ApiError)) return;
      if (error.body.run) setRun(error.body.run as RunDTO);
      if (error.message === 'set_revision_conflict') {
        flash('error', '冻结失败：另一页面刚改动了决策（建议集版本冲突），列表已刷新，核对后重试——不会混合新旧决策。');
      } else if (error.message === 'document_changed') {
        flash('error', '冻结失败：文档在检测后被编辑过，请重新检测。');
      } else {
        flash('error', `冻结失败：${error.message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  // ---- keyboard ---------------------------------------------------------

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'
      || target.tagName === 'SELECT' || target.isContentEditable) {
      return;
    }
    if (event.key >= '1' && event.key <= '4') {
      setStage(STAGES[Number(event.key) - 1].key);
      return;
    }
    if (frozen || analyzing || busy || staged.length === 0) return;
    const index = Math.min(cursor, staged.length - 1);
    const finding = staged[index];
    const key = event.key.toLowerCase();
    if (key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor(Math.min(index + 1, staged.length - 1));
    } else if (key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor(Math.max(index - 1, 0));
    } else if (key === 'a') {
      event.preventDefault();
      decideOne(finding, 'accepted');
    } else if (key === 'r') {
      event.preventDefault();
      decideOne(finding, 'rejected');
    } else if (key === 'u' || key === 'z') {
      event.preventDefault();
      if (finding.decision) decideOne(finding, 'pending');
    }
  }, [staged, cursor, frozen, analyzing, busy, decideOne]);

  const current = staged[Math.min(cursor, Math.max(0, staged.length - 1))] ?? null;

  // ---- render -----------------------------------------------------------

  return (
    <main className="shell" onKeyDown={onKeyDown}>
      <header className="topbar">
        <FlaskConical size={20}/>
        <strong>文本脱敏审阅工作台</strong>
        <small>按 revision 冲突 · 冻结可追溯</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>文档</h2>
          <div className="list">
            {items.map(item =>
              <button className={item.id === selected ? 'active' : ''} key={item.id}
                onClick={() => setSelected(item.id)}>
                {item.name}<br/><small>Revision {item.revision}</small>
              </button>)}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={saveDocument} disabled={saving || !row}>
              <Save size={15}/>{saving ? '保存中' : '保存'}
            </button>
            <select aria-label="检测器版本" value={detectorVersion}
              onChange={e => setDetectorVersion(e.target.value)}
              disabled={!detectors || analyzing}>
              {detectors?.versions.map(version => <option key={version} value={version}>{version}</option>)}
            </select>
            <button onClick={analyzeDoc} disabled={analyzing || !row}>
              <Play size={15}/>{analyzing ? '检测中' : '检测'}
            </button>
            {row && <span className="pill">doc r{row.revision}</span>}
            {docStale && <span className="pill warn">检测已过期</span>}
          </div>
          <textarea aria-label="文档内容" value={draft} onChange={e => setDraft(e.target.value)}/>
          {docStale && <p className="hint warn">文档在检测后被编辑：当前 run 基于 r{run?.documentRevision}，冻结会被拒绝。</p>}
          <p className="hint">焦点离开输入框时：<b>A</b> 接受 · <b>R</b> 拒绝 · <b>U/Z</b> 撤销 · <b>J/K</b> 移动 · <b>1-4</b> 切换阶段</p>
        </section>

        <aside className="pane review">
          <div className="review-head">
            <h2>检测建议</h2>
            {run && <span className="pill">{run.id}</span>}
            {frozen && <span className="pill frozen"><Lock size={12}/>已冻结</span>}
          </div>

          {!run && <p className="hint">选择检测器版本并点击「检测」开始审阅。</p>}

          {run && <>
            <div className="tabs">
              {STAGES.map(({key, label, hotkey}) =>
                <button key={key} className={`tab ${stage === key ? 'active' : ''}`}
                  onClick={() => setStage(key)}>
                  {label}<span className="count">{counts[key]}</span><kbd>{hotkey}</kbd>
                </button>)}
            </div>

            {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

            {!frozen && stage === 'pending' && pendingFresh > 0 &&
              <div className="bulk">
                <button disabled={busy} onClick={() => batchDecide('accepted')}>
                  <Check size={14}/> 全部接受待审</button>
                <button disabled={busy} onClick={() => batchDecide('rejected')}>
                  <X size={14}/> 全部拒绝待审</button>
                <small>批量也逐条做 revision 校验，允许部分成功。</small>
              </div>}

            <div className="findings" ref={listRef}>
              {staged.length === 0 && <p className="hint">该阶段没有建议。</p>}
              {staged.map((finding, index) =>
                <FindingCard key={finding.key} finding={finding} active={index === cursor}
                  frozen={frozen} disabled={busy || analyzing}
                  appliedRange={freeze?.applied.find(a => a.findingKey === finding.key)?.range ?? null}
                  onAccept={() => decideOne(finding, 'accepted')}
                  onReject={() => decideOne(finding, 'rejected')}
                  onUndo={() => decideOne(finding, 'pending')}
                  onAdjust={range => adjustRange(finding, range)}/>)}
            </div>

            <div className="freeze-bar">
              {frozen
                ? <span className="frozen-note"><Snowflake size={15}/> 决策集已冻结（setRevision {run.setRevision}），不可撤销或修改。</span>
                : <>
                  <button className="primary" onClick={freezeRun} disabled={busy || analyzing || docStale}>
                    <Snowflake size={15}/> 冻结并生成最终文本
                  </button>
                  <small>待审须清零；setRevision {run.setRevision} 用于冻结并发冲突检测。</small>
                </>}
            </div>
          </>}
        </aside>
      </section>

      {freeze && <FinalTextPanel freeze={freeze} onClose={() => setFreeze(null)}/>}
      {current && <span className="sr-only" aria-live="polite">当前第 {cursor + 1} 条，共 {staged.length} 条</span>}
    </main>
  );
}

function FindingCard({finding, active, frozen, disabled, appliedRange,
  onAccept, onReject, onUndo, onAdjust}: {
  finding: FindingDTO; active: boolean; frozen: boolean; disabled: boolean;
  appliedRange: Span | null;
  onAccept: () => void; onReject: () => void; onUndo: () => void;
  onAdjust: (range: Span) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const stage = stageOf(finding, frozen);
  const effective = finding.decision?.custom && finding.decision.range
    ? finding.decision.range : finding.range;

  function beginAdjust() {
    setStart(effective.start);
    setEnd(effective.end);
    setEditing(true);
  }

  return (
    <div className={`card ${stage} ${active ? 'active' : ''} ${finding.gone ? 'gone' : ''}`}
      data-active={active}>
      <div className="card-row">
        <span className="rule">{finding.label}</span>
        <span className="key">{finding.key}</span>
        <span className={`lifecycle ${finding.lifecycle}`}>{LIFECYCLE_LABEL[finding.lifecycle]}</span>
      </div>
      {finding.gone
        ? <code className="snippet gone-text">最新检测中已消失（原范围 {finding.range.start}–{finding.range.end}）</code>
        : <code className="snippet">{finding.text}</code>}
      <div className="card-row meta">
        <span>范围 {effective.start}–{effective.end}</span>
        {finding.decision && <span>决策 rev {finding.decision.revision}</span>}
        {finding.decision?.custom && <span className="badge">自定义范围</span>}
        {stage === 'applied' && appliedRange
          && <span className="badge applied">已应用 {appliedRange.start}–{appliedRange.end}</span>}
      </div>
      {finding.priorDecision &&
        <p className="hint warn">旧决策（rev {finding.priorDecision.revision}）所覆盖文本已变化，未自动复用，需重新审阅。</p>}
      {!frozen && <div className="card-actions">
        {!finding.gone && stage !== 'accepted' &&
          <button disabled={disabled} onClick={onAccept}><Check size={13}/> 接受</button>}
        {!finding.gone && stage !== 'rejected' &&
          <button disabled={disabled} onClick={onReject}><X size={13}/> 拒绝</button>}
        {stage === 'accepted' && !editing &&
          <button className="ghost" disabled={disabled} onClick={beginAdjust}>调整范围</button>}
        {editing && <span className="range-edit">
          <label>起 <input type="number" value={start} onChange={e => setStart(Number(e.target.value))}/></label>
          <label>止 <input type="number" value={end} onChange={e => setEnd(Number(e.target.value))}/></label>
          <button className="primary small"
            onClick={() => {onAdjust({start, end}); setEditing(false);}}>应用</button>
          <button className="ghost small" onClick={() => setEditing(false)}>取消</button>
        </span>}
        {(stage === 'accepted' || stage === 'rejected') && !editing &&
          <button className="ghost" disabled={disabled} onClick={onUndo}>
            <RotateCcw size={13}/> 撤销</button>}
      </div>}
    </div>
  );
}

function FinalTextPanel({freeze, onClose}: {freeze: FreezeRecord; onClose: () => void}) {
  return <section className="final-panel">
    <header>
      <h2><Snowflake size={17}/> 最终脱敏文本</h2>
      <button className="ghost" onClick={onClose}>关闭</button>
    </header>
    <div className="freeze-meta">
      <span className="pill">冻结 {freeze.id}</span>
      <span className="pill">文档 r{freeze.documentRevision}</span>
      <span className="pill">{freeze.detectorVersion}</span>
      <span className="pill">setRevision {freeze.setRevision}</span>
      <span className="pill">{freeze.createdAt.slice(0, 19).replace('T', ' ')}</span>
      <span className="pill">{freeze.applied.length} 处已脱敏</span>
    </div>
    <pre className="redacted">{freeze.redactedContent}</pre>
    <details>
      <summary>追溯：冻结快照（{freeze.decisions.length} 条决策，含每项 revision）</summary>
      <pre className="snapshot">{JSON.stringify(freeze, null, 2)}</pre>
    </details>
  </section>;
}
