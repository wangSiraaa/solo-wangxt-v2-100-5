import { useMemo, useState } from "react";
import { replaySubmission } from "../engine/task";
import type { FrozenSubmission, TaskAttempt, TaskPackage } from "../engine/types";
import { buildEvidenceFile, downloadJSON } from "../storage/exchange";
import FormulaCard from "./FormulaCard";

interface Props {
  attempts: TaskAttempt[];
  tasks: TaskPackage[];
}

export default function EvidenceView({ attempts, tasks }: Props) {
  const records = useMemo(() => attempts
    .flatMap((a) => a.submissions.map((s) => ({ attempt: a, submission: s })))
    .sort((a, b) => b.submission.submittedAt - a.submission.submittedAt), [attempts]);
  const [openId, setOpenId] = useState("");
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.versionId, t])), [tasks]);

  if (records.length === 0) {
    return <div className="empty-state">还没有冻结证据。提交后可在此按任务版本查看、重放和导出。</div>;
  }

  return (
    <div className="evidence-archive">
      <h2>提交证据档案</h2>
      <p className="muted small">证据内嵌旧版公式与变量，不依赖当前任务；修订发布后旧证据仍按旧规则展示。</p>
      {records.map(({ attempt, submission }) => {
        const task = taskById.get(submission.versionId);
        const replay = replaySubmission(submission);
        const open = openId === submission.id;
        return (
          <article key={submission.id} className={`evidence-card ${submission.passed ? "pass" : "fail"}`}>
            <header>
              <button type="button" className="collapse-btn" onClick={() => setOpenId(open ? "" : submission.id)}>{open ? "▾" : "▸"}</button>
              <strong>{submission.packageTitle || task?.title || attempt.packageId}</strong>
              <span className="version-tag">v{submission.version}</span>
              <span className={`badge ${submission.passed ? "ok" : "err"}`}>{submission.passed ? "通过" : "拒绝"}</span>
              <span className={`replay ${replay.matchesSnapshot ? "ok" : "err"}`}>
                当前引擎重放：{replay.matchesSnapshot ? "与冻结结果一致" : `不一致 ${replay.mismatches.join(", ")}`}
              </span>
              <span className="mono small">{submission.id}</span>
              <button type="button" className="mini-btn" onClick={() => downloadJSON(buildEvidenceFile(submission), `evidence_${submission.id}.json`)}>导出</button>
            </header>
            {open && <EvidenceDetail submission={submission} />}
          </article>
        );
      })}
    </div>
  );
}

function EvidenceDetail({ submission }: { submission: FrozenSubmission }) {
  return (
    <div className="evidence-body">
      <p className="small muted mono">
        versionId={submission.versionId}<br />
        packageHash={submission.packageContentHash}<br />
        engine={submission.engineVersion}
      </p>
      {submission.formulaResults.map((r, i) => (
        <div key={r.spec.id} className="frozen-result">
          <div className="frozen-title">
            <strong>{r.spec.note || r.spec.id}</strong>
            <span className={`badge ${r.passed ? "ok" : "err"}`}>{r.passed ? "通过" : "拒绝"}</span>
          </div>
          {r.reasons.map((reason) => <div className="err-text small" key={reason}>任务判定：{reason}</div>)}
          <FormulaCard
            formula={{
              id: r.spec.id,
              latex: r.spec.latex,
              note: r.spec.note,
              variables: r.variables,
              targetUnit: r.spec.targetUnit,
              createdAt: 0,
            }}
            index={i}
            readOnly
            editableVariables={false}
            variableNames={r.spec.requiredVariables.map((v) => v.name)}
            onChange={() => undefined}
          />
        </div>
      ))}
    </div>
  );
}
