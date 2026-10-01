// JSON 导入 / 导出：自由笔记、教师发布任务包、冻结提交证据。
// 所有文件均为离线 JSON；发布内容与提交证据分别携带哈希/引擎版本用于复现。
import { latexToSource, LatexConvertError } from "../engine/latex";
import {
  computePackageContentHash,
  EVIDENCE_KIND,
  replaySubmission,
  TASK_PACKAGE_KIND,
} from "../engine/task";
import type {
  Formula,
  FrozenSubmission,
  TaskAttempt,
  TaskPackage,
  VariableDef,
} from "../engine/types";
import { newId } from "./db";

export interface ExportFile {
  app: "dimension-notebook";
  version: 1;
  exportedAt: string;
  formulas: ExportFormula[];
}

export interface ExportFormula {
  id: string;
  latex: string;
  note: string;
  source?: string;
  variables: Record<string, VariableDef>;
  targetUnit: string;
  createdAt: number;
}

export interface TaskPackageFile {
  app: "dimension-notebook";
  kind: typeof TASK_PACKAGE_KIND;
  version: 1;
  exportedAt: string;
  task: TaskPackage;
}

export interface EvidenceFile {
  app: "dimension-notebook";
  kind: typeof EVIDENCE_KIND;
  version: 1;
  exportedAt: string;
  submission: FrozenSubmission;
  replay?: ReturnType<typeof replaySubmission>;
}

export function buildExport(formulas: Formula[]): ExportFile {
  return {
    app: "dimension-notebook",
    version: 1,
    exportedAt: new Date().toISOString(),
    formulas: formulas.map((f) => {
      let source: string | undefined;
      try {
        source = latexToSource(f.latex).source;
      } catch (e) {
        if (e instanceof LatexConvertError) source = undefined;
      }
      return {
        id: f.id, latex: f.latex, note: f.note, source,
        variables: f.variables, targetUnit: f.targetUnit, createdAt: f.createdAt,
      };
    }),
  };
}

export function buildTaskPackageFile(task: TaskPackage): TaskPackageFile {
  return {
    app: "dimension-notebook",
    kind: TASK_PACKAGE_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    task,
  };
}

export function buildEvidenceFile(submission: FrozenSubmission): EvidenceFile {
  return {
    app: "dimension-notebook",
    kind: EVIDENCE_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    submission,
    replay: replaySubmission(submission),
  };
}

export function downloadJSON(data: unknown, filename?: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? `量纲笔记_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  formulas: Formula[];
  errors: string[];
}

export function parseImport(text: string, existingIds: Set<string>): ImportResult {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { formulas: [], errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as Partial<ExportFile & TaskPackageFile>;
  if (!obj || obj.app !== "dimension-notebook" || !Array.isArray(obj.formulas)) {
    return { formulas: [], errors: ["不是本工具导出的笔记文件（缺少 app/formulas 字段）"] };
  }

  const formulas: Formula[] = [];
  obj.formulas.forEach((f, i) => {
    const label = `第 ${i + 1} 条`;
    if (!f || typeof f !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }

    let id = typeof f.id === "string" ? f.id : newId();
    if (existingIds.has(id)) id = newId();
    const vars: Record<string, VariableDef> = {};
    if (f.variables && typeof f.variables === "object") {
      for (const [k, v] of Object.entries(f.variables as Record<string, unknown>)) {
        const vv = v as Partial<VariableDef>;
        if (vv && typeof vv === "object") {
          vars[k] = { value: String(vv.value ?? ""), unit: String(vv.unit ?? "") };
        }
      }
    }
    formulas.push({
      id,
      latex: f.latex,
      note: typeof f.note === "string" ? f.note : "",
      variables: vars,
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
    });
  });

  return { formulas, errors };
}

export type DetectedImport =
  | { type: "notebook"; result: ImportResult }
  | { type: "task"; task: TaskPackage; errors: string[] }
  | { type: "evidence"; submission: FrozenSubmission; errors: string[] }
  | { type: "unknown"; errors: string[] };

export function detectImport(text: string, existingFormulaIds: Set<string> = new Set()): DetectedImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { type: "unknown", errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as { app?: unknown; kind?: unknown; formulas?: unknown };
  if (!obj || obj.app !== "dimension-notebook") {
    return { type: "unknown", errors: ["不是本工具导出的 JSON 文件"] };
  }
  if (obj.kind === TASK_PACKAGE_KIND) {
    const result = parseTaskPackage(text);
    return { type: "task", task: result.task, errors: result.errors };
  }
  if (obj.kind === EVIDENCE_KIND) {
    const result = parseEvidence(text);
    if (result.submission) return { type: "evidence", submission: result.submission, errors: result.errors };
    return { type: "unknown", errors: result.errors };
  }
  if (Array.isArray(obj.formulas)) {
    return { type: "notebook", result: parseImport(text, existingFormulaIds) };
  }
  return { type: "unknown", errors: ["无法识别的 JSON 包类型"] };
}

export interface TaskPackageImport {
  task: TaskPackage;
  errors: string[];
}

export function parseTaskPackage(text: string): TaskPackageImport {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { task: null as unknown as TaskPackage, errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as Partial<TaskPackageFile>;
  if (!obj || obj.app !== "dimension-notebook" || obj.kind !== TASK_PACKAGE_KIND || !obj.task) {
    return { task: null as unknown as TaskPackage, errors: ["不是实验任务包文件"] };
  }
  const task = obj.task as Partial<TaskPackage>;
  if (task.status !== "published") errors.push("只能向学生端导入已发布任务；草稿请在教师端继续编辑");
  for (const field of ["packageId", "versionId", "title", "contentHash"] as const) {
    if (typeof task[field] !== "string" || !(task[field] as string).trim()) errors.push(`任务包缺少 ${field}`);
  }
  if (typeof task.version !== "number" || task.version < 1) errors.push("任务版本号无效");
  if (!Array.isArray(task.formulas) || task.formulas.length === 0) errors.push("任务包没有检查公式");
  const formulaIds = new Set<string>();
  task.formulas?.forEach((f) => {
    if (typeof f.id !== "string" || !f.id) errors.push("存在缺少 ID 的检查公式");
    if (formulaIds.has(String(f.id))) errors.push(`检查公式 ID 重复：${String(f.id)}`);
    formulaIds.add(String(f.id));
    if (typeof f.latex !== "string" || !f.latex.trim()) errors.push(`检查 ${String(f.id)} 缺少公式`);
    f.requiredVariables?.forEach((v) => {
      if (typeof v.name !== "string" || !v.name.trim()) errors.push(`检查 ${String(f.id)} 存在无效变量名`);
      if (typeof v.unit !== "string") errors.push(`变量 ${String(v.name)} 的必填单位无效`);
    });
  });

  const normalized: TaskPackage = {
    id: String(task.id ?? task.versionId ?? ""),
    packageId: String(task.packageId ?? ""),
    versionId: String(task.versionId ?? ""),
    version: Number(task.version ?? 1),
    status: "published",
    title: String(task.title ?? ""),
    description: String(task.description ?? ""),
    formulas: Array.isArray(task.formulas) ? task.formulas.map((f) => ({
      id: String(f.id),
      latex: String(f.latex),
      note: String(f.note ?? ""),
      requiredVariables: Array.isArray(f.requiredVariables) ? f.requiredVariables.map((v) => ({
        name: String(v.name),
        unit: String(v.unit ?? ""),
        label: typeof v.label === "string" ? v.label : undefined,
      })) : [],
      targetUnit: String(f.targetUnit ?? ""),
      expectedValue: typeof f.expectedValue === "number" ? f.expectedValue : null,
      tolerance: typeof f.tolerance === "number" ? f.tolerance : null,
    })) : [],
    contentHash: String(task.contentHash ?? ""),
    createdAt: Number(task.createdAt ?? Date.now()),
    updatedAt: Number(task.updatedAt ?? Date.now()),
    publishedAt: typeof task.publishedAt === "number" ? task.publishedAt : Date.now(),
  };

  if (normalized.id !== normalized.versionId) errors.push("任务主键与版本标识不一致，拒绝导入");
  const recomputed = computePackageContentHash(normalized);
  if (normalized.contentHash && recomputed !== normalized.contentHash) {
    errors.push(`任务内容哈希不一致：文件可能被篡改（期望 ${normalized.contentHash}，实际 ${recomputed}）`);
  }

  return { task: normalized, errors };
}

export interface EvidenceImport {
  submission: FrozenSubmission | null;
  errors: string[];
}

export function parseEvidence(text: string): EvidenceImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { submission: null, errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as Partial<EvidenceFile>;
  if (!obj || obj.app !== "dimension-notebook" || obj.kind !== EVIDENCE_KIND || !obj.submission) {
    return { submission: null, errors: ["不是提交证据文件"] };
  }
  const submission = obj.submission as FrozenSubmission;
  if (!submission.id || !submission.versionId || !Array.isArray(submission.formulaResults)) {
    return { submission: null, errors: ["证据缺少提交 ID、任务版本或冻结结果"] };
  }
  return { submission, errors: [] };
}

/** 将外部证据归档回同一版本尝试；尝试不存在时创建一个只含历史证据的归档尝试。 */
export function mergeEvidence(
  attempt: TaskAttempt | undefined,
  submission: FrozenSubmission,
  now: number = Date.now(),
): TaskAttempt {
  if (attempt) {
    if (attempt.submissions.some((s) => s.id === submission.id)) return attempt;
    return {
      ...attempt,
      submissions: [...attempt.submissions, submission].sort((a, b) => a.submittedAt - b.submittedAt),
      updatedAt: now,
    };
  }
  return {
    id: submission.attemptId,
    packageId: submission.packageId,
    versionId: submission.versionId,
    version: submission.version,
    answers: structuredClone(submission.answers),
    submissions: [submission],
    pendingSubmission: null,
    createdAt: submission.submittedAt,
    updatedAt: now,
  };
}
