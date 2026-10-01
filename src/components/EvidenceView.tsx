// 证据视图：完整展示一次冻结提交 —— 任务版本指纹、公式、变量、结果、量纲问题、重放复核。
import { useMemo } from "react";
import type { Attempt, FrozenCheck, FrozenCheckResult } from "../engine/types";
import { replayAttempt } from "../engine/grading";
import { buildEvidenceFile, downloadJSON } from "../storage/taskPackage";
import Tex from "./Tex";

function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function fmt(n: number | undefined): string {
  if (n === undefined) return "";
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) {
    const [m, e] = n.toExponential(6).split("e");
    return `${m.replace(/\.?0+$/, "")}\\times10^{${Number(e)}}`;
  }
  return String(Number(n.toFixed(10)));
}

function toTexUnit(unit: string): string {
  if (!unit) return "";
  const parts = unit.split(/\s*\/\s*/);
  const encode = (seg: string) =>
    seg.split(/\s+/).map((factor) => {
      const pow = factor.split("^");
      const base = `\\mathrm{${pow[0]}}`;
      return pow.length > 1 ? `${base}^{${pow[1]}}` : base;
    }).join("\\,");
  if (parts.length === 1) return encode(parts[0]);
  return `${encode(parts[0])}/${parts.slice(1).map(encode).join("/")}`;
}

const STATUS_LABEL: Record<Attempt["status"], string> = {
  passed: "通过（已冻结）",
  rejected: "拒绝（已冻结诊断）",
  in_progress: "进行中",
};

export default function EvidenceView({ attempt, collapsible = false }: { attempt: Attempt; collapsible?: boolean }) {
  const replay = useMemo(
    () => (attempt.status === "in_progress" ? null : replayAttempt(attempt.frozenChecks, attempt.results)),
    [attempt],
  );

  const byId = useMemo(() => new Map(attempt.results.map((r) => [r.checkId, r])), [attempt]);
  const download = () =>
    downloadJSON(
      buildEvidenceFile(attempt, replay),
      `证据_${attempt.code}_v${attempt.version}_第${attempt.seq}次_${attempt.status}.json`,
    );

  return (
    <div className={`evidence status-${attempt.status === "passed" ? "ok" : attempt.status === "rejected" ? "err" : "empty"}`}>
      <div className="evidence-head">
        <span className={`badge ${attempt.status === "passed" ? "ok" : attempt.status === "rejected" ? "err" : "empty"}`}>
          {STATUS_LABEL[attempt.status]}
        </span>
        <strong>{attempt.taskTitle}</strong>
        <span className="muted small">
          {attempt.code} · v{attempt.version} · 第 {attempt.seq} 次尝试
        </span>
        <button type="button" className="mini-btn" onClick={download} data-testid="export-evidence">
          导出证据 JSON
        </button>
      </div>

      <dl className="evidence-meta">
        <dt>任务版本指纹</dt><dd><code title={attempt.contentHash}>{shortHash(attempt.contentHash)}</code></dd>
        <dt>评分规则</dt><dd><code>{attempt.gradingEngine}</code></dd>
        <dt>开始 / 提交</dt><dd>{fmtTime(attempt.startedAt)} ／ {fmtTime(attempt.submittedAt)}</dd>
        <dt>尝试标识</dt><dd><code title={attempt.attemptId}>{shortHash(attempt.attemptId)}</code> 槽位 <code>{attempt.slotKey}</code></dd>
      </dl>

      {replay && (
        <div className={`replay ${replay.replayable ? "ok" : "err"}`} data-testid="replay-banner">
          {replay.replayable
            ? `✔ 证据可重放：用当前引擎按冻结的公式与变量重算，${replay.checks.length} 条检查判定完全一致`
            : "⚠ 重放结果与冻结证据不一致（下方仍以冻结证据为准）"}
          {!collapsible && (
            <ul className="replay-detail">
              {replay.checks.map((c) => (
                <li key={c.checkId} className={c.consistent ? "ok" : "err"}>{c.checkId}：{c.detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {attempt.frozenChecks.map((check) => {
        const r = byId.get(check.checkId);
        return <CheckEvidence key={check.checkId} check={check} result={r} index={attempt.frozenChecks.indexOf(check)} />;
      })}
    </div>
  );
}

function CheckEvidence({ check, result, index }: { check: FrozenCheck; result?: FrozenCheckResult; index: number }) {
  return (
    <section className="check-evidence">
      <header className="check-head">
        <span>检查 {index + 1}</span>
        {check.prompt && <strong>{check.prompt}</strong>}
        {result && (
          <span className={`badge ${result.passed ? "ok" : "err"}`}>
            {result.passed ? "通过" : `拒绝 · ${result.reason}`}
          </span>
        )}
      </header>

      <div className="display-area">
        <div className="display-row">
          <span className="row-tag">冻结公式</span>
          <div className="tex-box"><Tex tex={result?.originalTex ?? check.latex} /></div>
        </div>
        {result?.substitutedTex && (
          <div className="display-row">
            <span className="row-tag">代入计算式</span>
            <div className="tex-box"><Tex tex={result.substitutedTex} /></div>
          </div>
        )}
        {result && (
          <div className="display-row result-row">
            <span className="row-tag">结果</span>
            <div className="tex-box">
              {result.passed || result.targetValue !== undefined || result.value !== undefined ? (
                <div>
                  {result.value !== undefined && (
                    <span className="result-line">
                      <Tex tex={`= ${fmt(result.value)}${result.resultUnit ? `~${toTexUnit(result.resultUnit)}` : ""}`} />
                    </span>
                  )}
                  {result.targetValue !== undefined && (
                    <span className="result-line converted">
                      <Tex tex={`= ${fmt(result.targetValue)}~${toTexUnit(result.targetUnit ?? "")}`} />
                      <span className="muted small">（按目标单位 {check.targetUnit} 换算）</span>
                    </span>
                  )}
                </div>
              ) : (
                <span className="err-text">无结果值（求值被拒绝）</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="frozen-vars">
        <span className="muted small">冻结变量：</span>
        {Object.entries(check.variables).map(([name, spec]) => {
          const v = result?.submittedVariables[name];
          return (
            <code key={name} className="frozen-var">
              {name} = {v?.value ?? "∅"} {v?.unit ?? spec.unit}
              {spec.unit && v && v.unit.trim() !== spec.unit.trim() && (
                <em className="err-text"> （要求 {spec.unit || "纯数"}）</em>
              )}
            </code>
          );
        })}
        {check.requireNumber && check.expectedValue !== undefined && (
          <span className="muted small">通过条件：结果须 ≈ {check.expectedValue} {check.targetUnit}（容差 {check.tolerance ?? "1e-6 相对"}）</span>
        )}
      </div>

      {result?.verdict && (
        <div className={`verdict ${result.passed ? "ok-text" : "err-text"}`} data-testid="check-verdict">
          {result.passed ? "✔ " : "✘ "}{result.verdict}
        </div>
      )}

      {result && result.issues.length > 0 && (
        <ul className="issue-list">
          {result.issues.map((iss, i) => (
            <li key={i} className={`issue ${iss.kind}`}>
              <span className={`dot ${iss.kind}`} />
              <span className="issue-kind">{iss.kind === "error" ? "错误" : "未验证"}</span>
              <span className="issue-msg">{iss.message}</span>
              <span className="issue-snippet">定位：<Tex tex={iss.snippet || "·"} block={false} /></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
