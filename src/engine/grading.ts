// 任务评分引擎：把“任务版本 + 学生变量”冻结成结构化尝试证据。
// 关键约束：
//  - 量纲错误 / 未定义变量 / 除零 / 未验证表达式一律判不通过，绝不产生通过；
//  - 每条检查独立求值，一条抛错只记 threw，不影响包内其他检查；
//  - 证据与任务版本（contentHash）和评分规则版本（GRADING_ENGINE）绑定，可重放复核。

import { analyzeFormula } from "./math";
import type {
  AnalysisResult, FrozenCheck, FrozenCheckResult, RejectReason, ReplayReport, VariableDef,
} from "./types";

/** 评分规则版本：评分逻辑发生语义变化时升级，证据中永久记录 */
export const GRADING_ENGINE = "grading-1.0.0";

const DEFAULT_REL_TOL = 1e-6;
const DEFAULT_ABS_TOL = 1e-9;

/** 结构问题（error 问题）的中文原因描述 */
function reasonText(reason: RejectReason, r: AnalysisResult): string {
  switch (reason) {
    case "empty":
      return "公式为空，无法判定";
    case "engine_error":
      return `求值引擎报告 ${r.issues.filter((i) => i.kind === "error").length} 处错误（量纲不兼容 / 未定义变量 / 除零等），不通过`;
    case "unverified":
      return "表达式含有未验证项（摄氏温标直接运算、超出支持范围等），不能作为通过结果";
    default:
      return reason;
  }
}

/** 判定单条检查。任何意外异常都收敛为 threw，绝不让一条检查拖垮整个任务 */
export function gradeCheck(check: FrozenCheck, variables: Record<string, VariableDef>): FrozenCheckResult {
  let r: AnalysisResult;
  try {
    r = analyzeFormula(check.latex, variables, check.targetUnit);
  } catch (e) {
    return {
      checkId: check.checkId,
      engineStatus: "error",
      passed: false,
      reason: "threw",
      verdict: `求值过程抛出异常：${(e as Error).message}`,
      submittedVariables: cloneVars(variables),
      issues: [],
    };
  }

  const submitted = cloneVars(variables);
  const base: FrozenCheckResult = {
    checkId: check.checkId,
    engineStatus: r.status,
    passed: false,
    reason: null,
    verdict: "",
    submittedVariables: submitted,
    issues: r.issues.map((i) => ({ ...i })),
    source: r.source,
    substituted: r.substituted,
    originalTex: r.originalTex,
    substitutedTex: r.substitutedTex,
    value: r.value,
    resultUnit: r.resultUnit,
    targetValue: r.targetValue,
    targetUnit: r.targetUnit,
    summary: r.summary,
  };

  // 1) 空表达式
  if (r.status === "empty") {
    return { ...base, reason: "empty", verdict: reasonText("empty", r) };
  }
  // 2) 明确错误（量纲 / 未定义变量 / 除零 / 语法）
  if (r.status === "error") {
    // 细分：优先指出未填的必填变量，方便学生诊断
    const missing = check.variables
      ? Object.keys(check.variables).filter((name) => !variables[name] || variables[name].value.trim() === "")
      : [];
    if (missing.length > 0 && r.issues.some((i) => i.message.includes("未赋值"))) {
      return { ...base, reason: "missing_variable", verdict: `必填变量未赋值：${missing.join("、")}（系统不会自动取零）` };
    }
    return { ...base, reason: "engine_error", verdict: reasonText("engine_error", r) };
  }
  // 3) 未验证（摄氏读数直接四则、超出支持范围等）——不得视为通过。
  //    其中确属“目标单位换算失败”的未验证项，用更明确的原因归类。
  if (r.status === "unverified") {
    const convIssue = r.issues.some((i) => i.message.includes("无法换算到目标单位"));
    if (convIssue && check.targetUnit.trim() && r.targetValue === undefined) {
      return {
        ...base,
        reason: "target_conversion_failed",
        verdict: `结果未能换算到目标单位“${check.targetUnit.trim()}”：量纲不兼容或单位无法识别`,
      };
    }
    return { ...base, reason: "unverified", verdict: reasonText("unverified", r) };
  }

  // status === "ok"
  // 4) 必填变量单位检查：与教师声明的期望单位不一致时明确拒绝
  const unitMismatch = Object.entries(check.variables ?? {}).find(([name, spec]) => {
    const got = variables[name]?.unit.trim() ?? "";
    return got !== spec.unit.trim();
  });
  if (unitMismatch) {
    const [name, spec] = unitMismatch;
    const got = variables[name].unit.trim() || "纯数（无单位）";
    const want = spec.unit.trim() || "纯数（无单位）";
    return { ...base, reason: "unit_mismatch", verdict: `变量 ${name} 的单位应为 ${want}，实际填写 ${got}` };
  }

  // 5) 目标单位换算：声明了目标单位却没得到换算值 → 拒绝
  if (check.targetUnit.trim() && r.targetValue === undefined) {
    return {
      ...base,
      reason: "target_conversion_failed",
      verdict: `结果未能换算到目标单位“${check.targetUnit.trim()}”，量纲不兼容或单位无法识别`,
    };
  }

  // 6) 数值通过条件
  if (check.requireNumber) {
    const expected = Number(check.expectedValue);
    if (!Number.isFinite(expected)) {
      return { ...base, reason: "wrong_number", verdict: "任务未配置有效期望值，无法判定数值（按拒绝处理）" };
    }
    const actual = check.targetUnit.trim() ? r.targetValue : r.value;
    if (actual === undefined || !Number.isFinite(actual)) {
      return { ...base, reason: "wrong_number", verdict: "没有可比较的有限结果值" };
    }
    const rel = Number.isFinite(check.tolerance) && (check.tolerance as number) >= 0
      ? (check.tolerance as number)
      : DEFAULT_REL_TOL;
    const tol = Math.max(Math.abs(expected) * rel, DEFAULT_ABS_TOL);
    if (Math.abs(actual - expected) > tol) {
      return {
        ...base,
        reason: "wrong_number",
        verdict: `结果 ${formatActual(actual, check, r)} 与期望值 ${expected} ${check.targetUnit.trim() || ""} 不符（容差 ±${tol}）`,
      };
    }
    return { ...base, passed: true, verdict: `通过：结果 ${formatActual(actual, check, r)} 与期望值一致（容差 ±${tol}）` };
  }

  // 不要求数值：引擎判定 ok 即通过（量纲/未验证等已在前面拦截）
  return { ...base, passed: true, verdict: `通过：${r.summary ?? "表达式已验证，无错误或未验证项"}` };
}

function formatActual(actual: number, check: FrozenCheck, r: AnalysisResult): string {
  const unit = check.targetUnit.trim() ? (r.targetUnit ?? check.targetUnit.trim()) : (r.resultUnit ?? "");
  return `${Number(actual.toFixed(10))}${unit ? ` ${unit}` : ""}`;
}

function cloneVars(vars: Record<string, VariableDef>): Record<string, VariableDef> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { value: v.value, unit: v.unit }]));
}

/** 判定整个任务版本：隔离逐条检查，全部通过任务才通过 */
export function gradeAttempt(
  checks: FrozenCheck[],
  answers: Record<string, Record<string, VariableDef>>,
): { results: FrozenCheckResult[]; passed: boolean } {
  const results = checks.map((c) => gradeCheck(c, answers[c.checkId] ?? {}));
  return { results, passed: results.every((r) => r.passed) };
}

/**
 * 用当前引擎对已冻结证据重放：同一任务版本 + 同一提交变量必须得到相同判定，
 * 否则说明该证据在当前环境不可复现（证据中记录了引擎与版本，仍按冻结内容展示）。
 */
export function replayAttempt(checks: FrozenCheck[], results: FrozenCheckResult[]): ReplayReport {
  const byId = new Map(results.map((r) => [r.checkId, r]));
  const report = checks.map((c) => {
    const frozen = byId.get(c.checkId);
    if (!frozen) {
      return { checkId: c.checkId, consistent: false, detail: "证据中缺少该检查的冻结结果" };
    }
    let replay: FrozenCheckResult;
    try {
      replay = gradeCheck(c, frozen.submittedVariables);
    } catch (e) {
      return { checkId: c.checkId, consistent: false, detail: `重放抛异常：${(e as Error).message}` };
    }
    const consistent =
      replay.passed === frozen.passed &&
      replay.reason === frozen.reason &&
      replay.engineStatus === frozen.engineStatus;
    return {
      checkId: c.checkId,
      consistent,
      detail: consistent
        ? `重放一致（${frozen.passed ? "通过" : `拒绝：${frozen.reason}`}）`
        : `重放不一致：证据为 ${frozen.passed ? "通过" : frozen.reason}，当前引擎给出 ${replay.passed ? "通过" : replay.reason}`,
    };
  });
  return { replayable: report.every((c) => c.consistent), checks: report };
}
