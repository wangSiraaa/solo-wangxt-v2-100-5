// 实验任务包：版本标识、发布校验、独立公式判定、提交冻结与证据重放
import { analyzeFormula } from "./math";
import type {
  AnalysisResult,
  FrozenFormulaResult,
  FrozenSubmission,
  PendingSubmission,
  TaskAnswerMap,
  TaskAttempt,
  TaskFormulaSpec,
  TaskPackage,
  VariableDef,
} from "./types";

export const ENGINE_VERSION = "formula-engine-1";
export const TASK_PACKAGE_KIND = "dimension-notebook-task-package";
export const EVIDENCE_KIND = "dimension-notebook-submission-evidence";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 32 位 FNV-1a：足够为本地任务/提交生成稳定、幂等的短指纹，不依赖 crypto.subtle。 */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function packageContent(pkg: Pick<TaskPackage, "packageId" | "version" | "title" | "description" | "formulas">) {
  return stableStringify({
    packageId: pkg.packageId,
    version: pkg.version,
    title: pkg.title,
    description: pkg.description,
    formulas: pkg.formulas.map((f) => ({
      id: f.id,
      latex: f.latex,
      note: f.note,
      requiredVariables: f.requiredVariables,
      targetUnit: f.targetUnit,
      expectedValue: f.expectedValue ?? null,
      tolerance: f.tolerance ?? null,
    })),
  });
}

export function computePackageContentHash(
  pkg: Pick<TaskPackage, "packageId" | "version" | "title" | "description" | "formulas">,
): string {
  return stableHash(packageContent(pkg));
}

export function versionIdFor(packageId: string, version: number): string {
  return `${packageId}@${version}`;
}

export function makeBlankTask(now: number = Date.now()): TaskPackage {
  const packageId = `tpk_${Math.random().toString(36).slice(2, 10)}`;
  const version = 1;
  const draft: TaskPackage = {
    id: `draft_${Math.random().toString(36).slice(2, 10)}`,
    packageId,
    versionId: versionIdFor(packageId, version),
    version,
    status: "draft",
    title: "",
    description: "",
    formulas: [],
    contentHash: "",
    createdAt: now,
    updatedAt: now,
  };
  draft.contentHash = computePackageContentHash(draft);
  return draft;
}

export interface PublishResult {
  task: TaskPackage;
  errors: string[];
}

export function validateTaskDraft(task: TaskPackage): string[] {
  const errors: string[] = [];
  if (!task.title.trim()) errors.push("任务标题不能为空");
  if (task.formulas.length === 0) {
    errors.push("至少需要一条检查公式");
    return errors;
  }
  const formulaIds = new Set<string>();
  task.formulas.forEach((f, i) => {
    const label = `检查 ${i + 1}（${f.note || f.id}）`;
    if (!f.id.trim()) errors.push(`${label}：公式 ID 不能为空`);
    if (formulaIds.has(f.id)) errors.push(`${label}：公式 ID「${f.id}」重复`);
    formulaIds.add(f.id);
    if (!f.latex.trim()) errors.push(`${label}：公式不能为空`);
    if (f.expectedValue !== undefined && f.expectedValue !== null && !Number.isFinite(f.expectedValue)) {
      errors.push(`${label}：期望值必须是有限数字`);
    }
    if (f.tolerance !== undefined && f.tolerance !== null && (!Number.isFinite(f.tolerance) || f.tolerance < 0)) {
      errors.push(`${label}：容差必须是非负有限数字`);
    }
    const names = new Set<string>();
    f.requiredVariables.forEach((v) => {
      if (!v.name.trim()) errors.push(`${label}：存在空变量名`);
      if (names.has(v.name)) errors.push(`${label}：变量「${v.name}」重复`);
      names.add(v.name);
    });
  });
  return errors;
}

/** 发布草稿。调用方需先处理 errors；成功后内容哈希和版本 ID 被重新冻结。 */
export function publishTaskDraft(draft: TaskPackage, now: number = Date.now()): PublishResult {
  const errors = validateTaskDraft(draft);
  if (errors.length) return { task: draft, errors };
  const versionId = versionIdFor(draft.packageId, draft.version);
  const published: TaskPackage = {
    ...draft,
    id: versionId,
    versionId,
    status: "published",
    title: draft.title.trim(),
    description: draft.description.trim(),
    formulas: draft.formulas.map(normalizeFormula),
    contentHash: "",
    updatedAt: now,
    publishedAt: now,
  };
  published.contentHash = computePackageContentHash(published);
  return { task: published, errors: [] };
}

export function createRevision(published: TaskPackage, now: number = Date.now()): TaskPackage {
  const version = published.version + 1;
  const draft: TaskPackage = {
    ...structuredClone(published),
    id: `draft_${Math.random().toString(36).slice(2, 10)}`,
    version,
    versionId: versionIdFor(published.packageId, version),
    status: "draft",
    publishedAt: undefined,
    createdAt: now,
    updatedAt: now,
  };
  draft.contentHash = computePackageContentHash(draft);
  return draft;
}

export function makeAngleTask(now: number = Date.now()): TaskPackage {
  const task = {
    ...makeBlankTask(now),
    title: "角度单位换算实验",
    description: "把 180° 与半弧度相加，并换算为度；通过条件要求目标单位换算成功。",
    formulas: [{
      id: "angle-sum",
      latex: "\\alpha+\\beta",
      note: "角度/弧度相加后换算为度",
      requiredVariables: [
        { name: "alpha", unit: "deg", label: "角度读数" },
        { name: "beta", unit: "rad" },
      ],
      targetUnit: "deg",
      expectedValue: null,
      tolerance: 1e-8,
    }],
  };
  return publishTaskDraft(task, now).task;
}

export function makeBoundaryTask(now: number = Date.now()): TaskPackage {
  const task = {
    ...makeBlankTask(now),
    title: "温度读数与除零边界实验",
    description: "任务包含彼此独立的检查：摄氏读数直接相加和除零都必须拒绝，同时保留诊断。",
    formulas: [
      {
        id: "celsius-direct-add",
        latex: "T_1+T_2",
        note: "摄氏读数直接相加：偏移温标运算未验证，不得通过",
        requiredVariables: [
          { name: "T_1", unit: "degC" },
          { name: "T_2", unit: "degC" },
        ],
        targetUnit: "",
        expectedValue: null,
        tolerance: null,
      },
      {
        id: "divide-zero",
        latex: "x/y",
        note: "除零：必须明确报错，不能影响另一条检查",
        requiredVariables: [
          { name: "x", unit: "m" },
          { name: "y", unit: "s" },
        ],
        targetUnit: "",
        expectedValue: null,
        tolerance: null,
      },
    ],
  };
  return publishTaskDraft(task, now).task;
}

function normalizeFormula(f: TaskFormulaSpec): TaskFormulaSpec {
  return {
    ...f,
    id: f.id.trim(),
    latex: f.latex.trim(),
    note: f.note,
    targetUnit: f.targetUnit.trim(),
    requiredVariables: f.requiredVariables.map((v) => ({
      name: v.name.trim(),
      unit: v.unit.trim(),
      label: v.label?.trim() || undefined,
    })),
    expectedValue: f.expectedValue ?? null,
    tolerance: f.tolerance ?? null,
  };
}

export function defaultAnswers(task: TaskPackage): TaskAnswerMap {
  return Object.fromEntries(task.formulas.map((f) => [
    f.id,
    Object.fromEntries(f.requiredVariables.map((v) => [v.name, { value: "", unit: v.unit }])),
  ]));
}

export function createAttempt(task: TaskPackage, now: number = Date.now()): TaskAttempt {
  return {
    id: stableHash(`attempt:${task.versionId}`),
    packageId: task.packageId,
    versionId: task.versionId,
    version: task.version,
    answers: defaultAnswers(task),
    submissions: [],
    pendingSubmission: null,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizedVariable(def: VariableDef | undefined): { value: string; unit: string } | null {
  if (!def) return null;
  const value = def.value.trim();
  const unit = def.unit.trim();
  if (value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return { value: String(n), unit };
}

function unitsMatch(actual: string, required: string): boolean {
  // 任务中的必填单位是通过条件的一部分；必须精确匹配，避免 degC/K 等同量纲但语义不同的温标被绕过。
  return actual.trim() === required.trim();
}

export function evaluateFormula(
  spec: TaskFormulaSpec,
  variables: Record<string, VariableDef>,
): FrozenFormulaResult {
  const reasons: string[] = [];
  const normalized: Record<string, VariableDef> = {};

  for (const req of spec.requiredVariables) {
    const got = normalizedVariable(variables[req.name]);
    if (!got) {
      reasons.push(`变量 ${req.name} 未填写有限数值`);
      normalized[req.name] = { value: variables?.[req.name]?.value ?? "", unit: req.unit };
      continue;
    }
    if (got.unit !== req.unit && !unitsMatch(got.unit, req.unit)) {
      reasons.push(`变量 ${req.name} 必须使用单位「${req.unit || "无量纲纯数"}」，当前为「${got.unit}」`);
    }
    normalized[req.name] = { value: got.value, unit: got.unit };
  }

  let analysis: AnalysisResult;
  try {
    analysis = analyzeFormula(spec.latex, normalized, spec.targetUnit);
  } catch (e) {
    analysis = {
      status: "error",
      variables: spec.requiredVariables.map((v) => v.name),
      issues: [{ kind: "error", path: [], snippet: spec.latex, message: `求值引擎异常：${(e as Error).message}` }],
      summary: "求值引擎异常",
    };
  }

  if (analysis.status === "unverified") reasons.push("表达式结果未验证，不能按通过处理");
  if (analysis.status === "error") reasons.push("表达式存在明确错误，不能按通过处理");
  if (analysis.status === "empty") reasons.push("公式为空");

  let numeric: number | undefined;
  let actualUnit: string | undefined;
  if (spec.targetUnit.trim()) {
    numeric = analysis.targetValue;
    actualUnit = analysis.targetUnit;
    if (analysis.status === "ok" && numeric === undefined) {
      reasons.push(`结果未能换算到目标单位「${spec.targetUnit.trim()}」`);
    }
  } else {
    numeric = analysis.value;
    actualUnit = analysis.resultUnit;
  }

  if (analysis.status === "ok" && spec.expectedValue !== undefined && spec.expectedValue !== null) {
    if (numeric === undefined || !Number.isFinite(numeric)) {
      reasons.push("缺少可与通过条件比较的有限结果");
    } else {
      const tolerance = spec.tolerance ?? 1e-9;
      if (Math.abs(numeric - spec.expectedValue) > tolerance) {
        reasons.push(`结果 ${formatActual(numeric, actualUnit)} 不满足期望值 ${formatActual(spec.expectedValue, spec.targetUnit || analysis.resultUnit)}（容差 ${tolerance}）`);
      }
    }
  }

  return {
    spec,
    variables: normalized,
    analysis,
    passed: reasons.length === 0 && analysis.status === "ok",
    reasons,
  };
}

function formatActual(value: number, unit?: string): string {
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function canonicalAnswers(answers: TaskAnswerMap): string {
  return stableStringify(Object.fromEntries(Object.keys(answers).sort().map((id) => {
    const vars = answers[id] ?? {};
    return [id, Object.fromEntries(Object.keys(vars).sort().map((name) => {
      const v = normalizedVariable(vars[name]);
      return [name, v ?? { value: "", unit: vars[name]?.unit?.trim() ?? "" }];
    }))];
  })));
}

export function submissionIdFor(attempt: TaskAttempt, answers: TaskAnswerMap): string {
  return stableHash(`${attempt.id}:${attempt.versionId}:${canonicalAnswers(answers)}`);
}

function buildSubmission(
  task: TaskPackage,
  attempt: TaskAttempt,
  answers: TaskAnswerMap,
  id: string,
  submittedAt: number,
): FrozenSubmission {
  const formulaResults = task.formulas.map((spec) => evaluateFormula(spec, answers[spec.id] ?? {}));
  return {
    id,
    attemptId: attempt.id,
    packageId: task.packageId,
    versionId: task.versionId,
    version: task.version,
    packageTitle: task.title,
    packageContentHash: task.contentHash,
    engineVersion: ENGINE_VERSION,
    submittedAt,
    passed: formulaResults.length > 0 && formulaResults.every((r) => r.passed),
    answers: structuredClone(answers),
    formulaResults,
  };
}

export function startPendingSubmission(attempt: TaskAttempt, answers: TaskAnswerMap, now: number = Date.now()): PendingSubmission {
  const id = submissionIdFor(attempt, answers);
  return { id, startedAt: now, answers: structuredClone(answers) };
}

/** 完成冻结。同一答案重新提交或刷新后恢复 pending，都返回同一个 submission ID。 */
export function completeSubmission(
  task: TaskPackage,
  attempt: TaskAttempt,
  pending: PendingSubmission,
  now: number = Date.now(),
): { attempt: TaskAttempt; submission: FrozenSubmission; duplicated: boolean } {
  const existing = attempt.submissions.find((s) => s.id === pending.id);
  if (existing) {
    return {
      attempt: { ...attempt, pendingSubmission: null, updatedAt: now },
      submission: existing,
      duplicated: true,
    };
  }
  const submission = buildSubmission(task, attempt, pending.answers, pending.id, now);
  return {
    attempt: {
      ...attempt,
      answers: structuredClone(pending.answers),
      submissions: [...attempt.submissions, submission],
      pendingSubmission: null,
      updatedAt: now,
    },
    submission,
    duplicated: false,
  };
}

export function replayFormula(result: FrozenFormulaResult): FrozenFormulaResult {
  return evaluateFormula(result.spec, result.variables);
}

export interface ReplaySummary {
  passed: boolean;
  matchesSnapshot: boolean;
  formulaCount: number;
  mismatches: string[];
}

export function replaySubmission(submission: FrozenSubmission): ReplaySummary {
  const mismatches: string[] = [];
  submission.formulaResults.forEach((frozen) => {
    const current = evaluateFormula(frozen.spec, frozen.variables);
    const a = stableStringify({ analysis: frozen.analysis, passed: frozen.passed, reasons: frozen.reasons });
    const b = stableStringify({ analysis: current.analysis, passed: current.passed, reasons: current.reasons });
    if (a !== b) mismatches.push(frozen.spec.id);
  });
  const passed = submission.formulaResults.every((r) => replayFormula(r).passed);
  return {
    passed,
    matchesSnapshot: mismatches.length === 0 && passed === submission.passed,
    formulaCount: submission.formulaResults.length,
    mismatches,
  };
}
