// 学生作答工作台：按冻结的任务版本逐检查填写变量，实时引擎预览，提交后锁定为证据。
import { useMemo, useState } from "react";
import type { Attempt, VariableDef } from "../engine/types";
import { analyzeFormula } from "../engine/math";
import { saveAnswers, submitAttempt } from "../storage/attempts";
import VariableTable from "./VariableTable";
import Tex from "./Tex";
import EvidenceView from "./EvidenceView";

interface Props {
  attempt: Attempt;
  /** 尝试被保存/提交后回传给父组件（父组件刷新全局列表） */
  onChanged: (next: Attempt) => void;
  /** 提交完成后，学生可基于同一版本发起新一次尝试 */
  onRetry: () => void;
  onClose: () => void;
}

export default function AttemptWorkbench({ attempt, onChanged, onRetry, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 进行中尝试：实时保存答案；已提交尝试：直接看冻结证据
  if (attempt.status !== "in_progress") {
    return (
      <div className="workbench">
        <div className="workbench-bar">
          <button type="button" onClick={onClose}>返回版本列表</button>
          <button type="button" onClick={onRetry} data-testid="retry-attempt">
            {attempt.status === "rejected" ? "修正后再次作答（新增记录）" : "再次作答（新增记录）"}
          </button>
        </div>
        <EvidenceView attempt={attempt} />
      </div>
    );
  }

  const updateVars = async (checkId: string, variables: Record<string, VariableDef>) => {
    const next = await saveAnswers(attempt, checkId, variables);
    onChanged(next);
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const done = await submitAttempt(attempt);
      onChanged(done);
    } catch (e) {
      // 模拟刷新钩子抛错时，记录已以 submitting=true 落库；真实环境下页面已刷新
      setError(`提交中断：${(e as Error).message}（刷新页面会自动原地补完，不会产生重复尝试）`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workbench">
      <div className="workbench-bar">
        <button type="button" onClick={onClose}>返回版本列表</button>
        <span className="muted small">答案实时保存到 IndexedDB · 第 {attempt.seq} 次尝试 · 槽位 {attempt.slotKey}</span>
        <button type="button" className="primary" disabled={busy} onClick={submit} data-testid="submit-attempt">
          {busy ? "提交中…" : "提交并冻结证据"}
        </button>
      </div>
      {error && <div className="notice err-notice">{error}</div>}

      {attempt.frozenChecks.map((check, i) => (
        <CheckWorkbench
          key={check.checkId}
          index={i}
          check={check}
          variables={attempt.answers[check.checkId] ?? {}}
          onChange={(vars) => void updateVars(check.checkId, vars)}
        />
      ))}
    </div>
  );
}

function CheckWorkbench({
  index, check, variables, onChange,
}: {
  index: number;
  check: Attempt["frozenChecks"][number];
  variables: Record<string, VariableDef>;
  onChange: (vars: Record<string, VariableDef>) => void;
}) {
  const requiredNames = Object.keys(check.variables);
  const live = useMemo(
    () => analyzeFormula(check.latex, variables, check.targetUnit),
    [check.latex, check.targetUnit, variables],
  );

  const badgeCls = live.status === "ok" ? "ok" : live.status === "unverified" ? "warn" : live.status === "empty" ? "empty" : "err";
  const badgeText = live.status === "ok" ? "预览：已验证"
    : live.status === "unverified" ? "预览：未验证（不会通过）"
    : live.status === "empty" ? "预览：空" : "预览：有错误（不会通过）";

  // 变量表需要的 names = 冻结的必填变量（学生不能增删变量，但可以改单位以看到 unit_mismatch）
  return (
    <section className="card status-empty check-work">
      <header className="card-head">
        <strong>检查 {index + 1}{check.prompt ? `：${check.prompt}` : ""}</strong>
        <span className={`badge ${badgeCls}`} data-testid="live-badge">{badgeText}</span>
        <span className="summary">{live.summary}</span>
      </header>
      <div className="card-body">
        <div className="display-area">
          <div className="display-row">
            <span className="row-tag">任务公式</span>
            <div className="tex-box frozen-formula">
              <Tex tex={live.originalTex ?? check.latex} />
            </div>
          </div>
        </div>

        <div className="required-note muted small">
          必填变量：{requiredNames.join("、") || "（无）"}
          {check.targetUnit && <> · 目标单位：<code>{check.targetUnit}</code>（结果将按此换算后判定）</>}
          {check.requireNumber && check.expectedValue !== undefined && <> · 通过条件：结果 ≈ {check.expectedValue} {check.targetUnit}</>}
        </div>

        <VariableTable names={requiredNames} value={variables} onChange={onChange} />

        {live.issues.length > 0 && (
          <ul className="issue-list">
            {live.issues.map((iss, j) => (
              <li key={j} className={`issue ${iss.kind}`}>
                <span className={`dot ${iss.kind}`} />
                <span className="issue-kind">{iss.kind === "error" ? "错误" : "未验证"}</span>
                <span className="issue-msg">{iss.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
