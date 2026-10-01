import { useMemo, useState } from "react";
import {
  completeSubmission,
  createAttempt,
  replaySubmission,
  startPendingSubmission,
  submissionIdFor,
} from "../engine/task";
import type {
  FrozenSubmission,
  TaskAnswerMap,
  TaskAttempt,
  TaskFormulaSpec,
  TaskPackage,
  VariableDef,
} from "../engine/types";
import { buildEvidenceFile, downloadJSON } from "../storage/exchange";
import FormulaCard from "./FormulaCard";

interface Props {
  tasks: TaskPackage[];
  attempts: TaskAttempt[];
  onUpsertAttempt: (attempt: TaskAttempt) => Promise<void>;
  onNotice: (message: string) => void;
}

function toFormula(spec: TaskFormulaSpec, variables: Record<string, VariableDef>) {
  return {
    id: spec.id,
    latex: spec.latex,
    note: spec.note,
    variables,
    targetUnit: spec.targetUnit,
    createdAt: 0,
  };
}

export default function StudentWorkspace({ tasks, attempts, onUpsertAttempt, onNotice }: Props) {
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const published = useMemo(
    () => tasks.filter((t) => t.status === "published").sort((a, b) => b.publishedAt! - a.publishedAt!),
    [tasks],
  );
  const task = published.find((t) => t.versionId === selectedVersionId) ?? published[0] ?? null;
  const attempt = task ? attempts.find((a) => a.versionId === task.versionId) : undefined;

  const groups = useMemo(() => {
    const map = new Map<string, TaskPackage[]>();
    published.forEach((t) => {
      const list = map.get(t.packageId) ?? [];
      list.push(t);
      map.set(t.packageId, list);
    });
    return [...map.values()].map((list) => list.sort((a, b) => a.version - b.version));
  }, [published]);

  if (!task) {
    return <div className="empty-state">尚未导入或发布任务包。教师可在“教师任务”中发布，学生可导入发布版 JSON。</div>;
  }
  const active = attempt ?? createAttempt(task);

  const updateAnswer = async (formulaId: string, variables: Record<string, VariableDef>) => {
    const answers: TaskAnswerMap = { ...active.answers, [formulaId]: variables };
    await onUpsertAttempt({ ...active, answers, updatedAt: Date.now() });
  };

  const submit = async () => {
    const pending = startPendingSubmission(active, active.answers);
    const staged: TaskAttempt = { ...active, pendingSubmission: pending, updatedAt: Date.now() };
    await onUpsertAttempt(staged);
    // 即使提交过程中刷新，pending 已先持久化；恢复时用同一幂等 ID 冻结。
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const { attempt: completed, submission, duplicated } = completeSubmission(task, staged, pending);
    await onUpsertAttempt(completed);
    onNotice(duplicated
      ? `相同答案已存在：复用提交 ${submission.id.slice(0, 8)}，未制造重复记录`
      : submission.passed
        ? `提交通过，已冻结快照 ${submission.id.slice(0, 8)}`
        : `提交被拒绝，错误/未验证证据已保留（${submission.id.slice(0, 8)}）`);
  };

  const currentSubmissionId = submissionIdFor(active, active.answers);
  const hasSameSubmission = active.submissions.some((s) => s.id === currentSubmissionId);
  const pending = active.pendingSubmission;

  return (
    <div className="split-layout">
      <aside className="sidebar">
        <h3>已发布任务</h3>
        {groups.map((list) => (
          <div className="version-group" key={list[0].packageId}>
            <div className="group-title">{list[0].title}</div>
            {list.map((t) => {
              const a = attempts.find((x) => x.versionId === t.versionId);
              const latest = a?.submissions.at(-1);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`list-item ${task.id === t.id ? "active" : ""}`}
                  onClick={() => setSelectedVersionId(t.versionId)}
                >
                  <strong>v{t.version}</strong>
                  <span>{a ? `${a.submissions.length} 次提交` : "未开始"}</span>
                  {latest && <span className={`mini-pass ${latest.passed ? "pass" : "fail"}`}>{latest.passed ? "最近通过" : "最近拒绝"}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      <section className="workspace-panel task-work">
        <div className="panel-head">
          <div>
            <h2>{task.title} <span className="version-tag">v{task.version}</span></h2>
            <p className="muted small mono">{task.versionId} · hash {task.contentHash}</p>
          </div>
          <button type="button" className="primary" disabled={!!pending || hasSameSubmission} onClick={() => void submit()}>
            {pending ? "正在冻结提交…" : hasSameSubmission ? "该答案已提交" : "提交并冻结证据"}
          </button>
        </div>
        <p>{task.description}</p>
        {pending && <div className="notice">检测到一次未完成提交（{pending.id.slice(0, 8)}）。刷新后会恢复为同一条记录。</div>}

        <div className="formula-runner-list">
          {task.formulas.map((spec, i) => (
            <div key={spec.id} className="runner-block">
              <FormulaCard
                formula={toFormula(spec, active.answers[spec.id] ?? {})}
                index={i}
                readOnly
                editableVariables
                variableNames={spec.requiredVariables.map((v) => v.name)}
                onChange={(patch) => void updateAnswer(spec.id, patch.variables ?? active.answers[spec.id] ?? {})}
              />
              <RequiredHint spec={spec} />
            </div>
          ))}
        </div>

        <AttemptHistory attempt={active} />
      </section>
    </div>
  );
}

function RequiredHint({ spec }: { spec: TaskFormulaSpec }) {
  return (
    <div className="required-hint">
      必填：{spec.requiredVariables.map((v) => <code key={v.name}>{v.name}：{v.unit || "纯数"}</code>)}
      ；目标单位：<code>{spec.targetUnit || "自动"}</code>
    </div>
  );
}

function AttemptHistory({ attempt }: { attempt: TaskAttempt }) {
  const [openId, setOpenId] = useState("");
  return (
    <div className="history-panel">
      <h3>完整尝试历史（失败证据不覆盖）</h3>
      {attempt.submissions.length === 0 && <p className="muted small">还没有提交。每次提交会冻结公式、变量、结果、量纲问题和任务版本。</p>}
      {[...attempt.submissions].reverse().map((s) => (
        <EvidenceRecord key={s.id} submission={s} open={openId === s.id} onToggle={() => setOpenId(openId === s.id ? "" : s.id)} />
      ))}
    </div>
  );
}

function EvidenceRecord({ submission, open, onToggle }: { submission: FrozenSubmission; open: boolean; onToggle: () => void }) {
  const replay = replaySubmission(submission);
  return (
    <article className={`evidence-card ${submission.passed ? "pass" : "fail"}`}>
      <header>
        <button type="button" className="collapse-btn" onClick={onToggle}>{open ? "▾" : "▸"}</button>
        <strong>{new Date(submission.submittedAt).toLocaleString()}</strong>
        <span className={`badge ${submission.passed ? "ok" : "err"}`}>{submission.passed ? "通过" : "拒绝"}</span>
        <span className="mono small">{submission.id}</span>
        <span className={`replay ${replay.matchesSnapshot ? "ok" : "err"}`}>
          重放{replay.matchesSnapshot ? "一致" : "不一致"}
        </span>
        <button type="button" className="mini-btn" onClick={() => downloadJSON(buildEvidenceFile(submission), `evidence_${submission.id}.json`)}>
          导出证据 JSON
        </button>
      </header>
      {open && (
        <div className="evidence-body">
          <p className="small muted">
            任务 v{submission.version} · {submission.versionId} · 引擎 {submission.engineVersion} ·
            任务内容哈希 {submission.packageContentHash}
          </p>
          {submission.formulaResults.map((r, i) => (
            <div key={r.spec.id} className="frozen-result">
              <div className="frozen-title">
                <strong>检查 {i + 1}：{r.spec.note || r.spec.id}</strong>
                <span className={`badge ${r.passed ? "ok" : "err"}`}>{r.passed ? "通过" : "拒绝"}</span>
              </div>
              {r.reasons.map((reason) => <div className="err-text small" key={reason}>任务判定：{reason}</div>)}
              <FormulaCard
                formula={toFormula(r.spec, r.variables)}
                index={i}
                readOnly
                editableVariables={false}
                variableNames={r.spec.requiredVariables.map((v) => v.name)}
                defaultCollapsed={r.passed}
                onChange={() => undefined}
              />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
