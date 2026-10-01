// 实验任务包 JSON 格式 + 发布冻结 + 幂等导入规划 + 证据导出。
//
// 包文件（教师 → 学生，离线分发）：
// {
//   "app": "dimension-notebook",
//   "format": "dimension-notebook/task-package",
//   "version": 1,
//   "packages": [ { packageId, code, version: PublishedVersion, ... }, ... ]
// }
//
// 设计要点：
//  - 已发布版本整体冻结（含 contentHash）；重复导入按 packageId+version 幂等去重；
//  - 同包同版本号但内容指纹不同 = 冲突，拒绝覆盖；
//  - 学生包中剥离教师参考答案数值（variables 只保留单位提示）；
//  - 发布前用参考答案完整自检一次：连“标准答案”都过不了的任务不允许发布。

import { gradeAttempt } from "../engine/grading";
import { inspectFormula } from "../engine/math";
import { contentHash } from "../engine/hash";
import type {
  FrozenCheck, PublishedVersion, TaskDraft, TaskPackage, Attempt, ReplayReport,
} from "../engine/types";

export const PACKAGE_FILE_APP = "dimension-notebook";
export const PACKAGE_FILE_FORMAT = "dimension-notebook/task-package";
export const EVIDENCE_FILE_FORMAT = "dimension-notebook/attempt-evidence";

export interface PackageEntry {
  packageId: string;
  code: string;
  version: PublishedVersion;
}

export interface PackageFile {
  app: typeof PACKAGE_FILE_APP;
  format: typeof PACKAGE_FILE_FORMAT;
  version: 1;
  exportedAt: string;
  packages: PackageEntry[];
}

export interface EvidenceFile {
  app: typeof PACKAGE_FILE_APP;
  format: typeof EVIDENCE_FILE_FORMAT;
  version: 1;
  exportedAt: string;
  attempt: Attempt;
  replay: ReplayReport | null;
}

/** 参与 contentHash 的版本字段（不含 publishedAt / contentHash 自身） */
export function versionHashInput(packageId: string, v: Omit<PublishedVersion, "publishedAt" | "contentHash">): unknown {
  return { packageId, version: v.version, title: v.title, description: v.description, revisionNote: v.revisionNote, checks: v.checks };
}

export function computeVersionHash(packageId: string, v: Omit<PublishedVersion, "publishedAt" | "contentHash">): string {
  return contentHash(versionHashInput(packageId, v));
}

// ---------------- 发布冻结 ----------------

export interface FreezeResult {
  version: PublishedVersion | null;
  errors: string[];
}

/**
 * 把草稿冻结成下一个不可变版本。
 * 校验：标题、至少一条检查、每条检查结构合法、要求数值时参考答案完整且自检通过。
 */
export function freezeDraft(
  packageId: string,
  draft: TaskDraft,
  prevVersions: PublishedVersion[],
  now: number = Date.now(),
): FreezeResult {
  const errors: string[] = [];
  const title = draft.title.trim();
  if (!title) errors.push("任务标题不能为空");
  if (draft.checks.length === 0) errors.push("至少需要一条公式检查");

  const checkIds = new Set<string>();
  const frozenChecks: FrozenCheck[] = [];

  draft.checks.forEach((c, i) => {
    const label = `检查 ${i + 1}（${c.prompt.trim() || "未命名"}）`;
    const insp = inspectFormula(c.latex);
    if (insp.empty) { errors.push(`${label}：公式为空`); return; }
    if (!insp.structurallyValid) { errors.push(`${label}：${insp.structuralError}`); return; }

    if (!checkIds.has(c.checkId)) checkIds.add(c.checkId);
    else errors.push(`${label}：检查 id 重复`);

    // 必填变量在发布时由公式自动推导；只冻结单位提示，参考答案值不进学生包
    const variables: FrozenCheck["variables"] = {};
    const referenceAnswers: Record<string, { value: string; unit: string }> = {};
    for (const name of insp.variables) {
      const spec = c.variables[name];
      const unit = spec?.unit?.trim() ?? "";
      variables[name] = { unit };
      const refVal = spec?.value?.trim() ?? "";
      if (refVal) referenceAnswers[name] = { value: refVal, unit };
    }

    let expectedValue: number | undefined;
    if (c.requireNumber) {
      const ev = Number(c.expectedValue);
      if (!Number.isFinite(ev)) {
        errors.push(`${label}：要求数值匹配，但期望值缺失或不是有限数字`);
      } else {
        expectedValue = ev;
      }
      const missingRefs = insp.variables.filter((name) => !referenceAnswers[name]);
      if (missingRefs.length > 0) {
        errors.push(`${label}：参考答案不完整，缺少变量 ${missingRefs.join("、")} 的参考数值（发布前必须能用答案自检通过）`);
      }
    }

    frozenChecks.push({
      checkId: c.checkId,
      prompt: c.prompt,
      latex: c.latex,
      variables,
      targetUnit: c.targetUnit.trim(),
      requireNumber: c.requireNumber,
      ...(expectedValue !== undefined ? { expectedValue } : {}),
      ...(c.tolerance !== undefined && Number.isFinite(c.tolerance) ? { tolerance: c.tolerance } : {}),
    });
  });

  if (errors.length > 0) return { version: null, errors };

  const next: Omit<PublishedVersion, "publishedAt" | "contentHash"> = {
    version: prevVersions.length === 0 ? 1 : Math.max(...prevVersions.map((v) => v.version)) + 1,
    title,
    description: draft.description.trim(),
    revisionNote: draft.revisionNote.trim(),
    checks: frozenChecks,
  };
  return {
    version: { ...next, publishedAt: now, contentHash: computeVersionHash(packageId, next) },
    errors: [],
  };
}

/** 用参考答案对即将发布的版本自检：标准答案必须全部通过才允许发布 */
export function publishSelfCheck(draft: TaskDraft): string[] {
  const problems: string[] = [];
  draft.checks.forEach((c, i) => {
    const answers: Record<string, { value: string; unit: string }> = {};
    for (const [name, spec] of Object.entries(c.variables)) {
      if (spec.value?.trim()) answers[name] = { value: spec.value.trim(), unit: spec.unit.trim() };
    }
    const frozenPreview: FrozenCheck = {
      checkId: c.checkId,
      prompt: c.prompt,
      latex: c.latex,
      variables: Object.fromEntries(Object.entries(c.variables).map(([k, v]) => [k, { unit: v.unit.trim() }])),
      targetUnit: c.targetUnit.trim(),
      requireNumber: c.requireNumber,
      ...(Number.isFinite(c.expectedValue) ? { expectedValue: Number(c.expectedValue) } : {}),
      ...(c.tolerance !== undefined ? { tolerance: c.tolerance } : {}),
    };
    const { results } = gradeAttempt([frozenPreview], { [c.checkId]: answers });
    const r = results[0];
    if (r && !r.passed) problems.push(`检查 ${i + 1}：按参考答案自检未通过 —— ${r.verdict}`);
  });
  return problems;
}

/** 从已发布版本派生一份新草稿（修订只能走新版本，不能原地改发布内容） */
export function draftFromVersion(v: PublishedVersion): TaskDraft {
  return {
    title: v.title,
    description: v.description,
    revisionNote: "",
    checks: v.checks.map((c) => ({
      checkId: c.checkId,
      prompt: c.prompt,
      latex: c.latex,
      // 派生时单位提示保留，参考数值留空（教师重新填写/试算）
      variables: Object.fromEntries(Object.entries(c.variables).map(([k, s]) => [k, { value: "", unit: s.unit }])),
      targetUnit: c.targetUnit,
      requireNumber: c.requireNumber,
      ...(c.expectedValue !== undefined ? { expectedValue: c.expectedValue } : {}),
      ...(c.tolerance !== undefined ? { tolerance: c.tolerance } : {}),
    })),
  };
}

// ---------------- 包文件 ----------------

export function buildPackageFile(packages: TaskPackage[]): PackageFile | null {
  const entries: PackageEntry[] = [];
  for (const p of packages) {
    const latest = p.versions[p.versions.length - 1];
    if (latest) entries.push({ packageId: p.packageId, code: p.code, version: latest });
  }
  if (entries.length === 0) return null;
  return {
    app: PACKAGE_FILE_APP,
    format: PACKAGE_FILE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    packages: entries,
  };
}

export function downloadJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------- 导入解析与幂等规划（纯函数，便于单测） ----------------

export interface ParsedPackages {
  entries: PackageEntry[];
  errors: string[];
}

export function parseTaskPackage(text: string): ParsedPackages {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { entries: [], errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as Partial<PackageFile>;
  if (!obj || obj.app !== PACKAGE_FILE_APP || obj.format !== PACKAGE_FILE_FORMAT || !Array.isArray(obj.packages)) {
    return { entries: [], errors: ["不是实验任务包文件（缺少正确的 app/format/packages 字段）"] };
  }

  const entries: PackageEntry[] = [];
  const errors: string[] = [];
  obj.packages.forEach((e, i) => {
    const label = `第 ${i + 1} 个任务包`;
    if (!e || typeof e !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    if (typeof e.packageId !== "string" || !e.packageId) { errors.push(`${label}：缺少 packageId，已跳过`); return; }
    if (typeof e.code !== "string") { errors.push(`${label}：缺少任务代码 code，已跳过`); return; }
    const v = e.version;
    if (!v || typeof v !== "object") { errors.push(`${label}：缺少发布版本 version，已跳过`); return; }
    if (!Number.isFinite(v.version) || typeof v.title !== "string" || !Array.isArray(v.checks)) {
      errors.push(`${label}：版本字段不完整（需要 version/title/checks），已跳过`);
      return;
    }
    if (typeof v.contentHash !== "string") { errors.push(`${label}：缺少内容指纹 contentHash（文件可能被截断），已跳过`); return; }

    // 重算指纹，检测文件被手工篡改
    const { publishedAt, contentHash: _h, ...rest } = v;
    void publishedAt; void _h;
    const actual = computeVersionHash(e.packageId, rest as Omit<PublishedVersion, "publishedAt" | "contentHash">);
    if (actual !== v.contentHash) {
      errors.push(`${label} v${v.version}：内容指纹不匹配（期望 ${v.contentHash}，实际 ${actual}），文件可能被篡改，已跳过`);
      return;
    }

    const ids = new Set<string>();
    let checkOk = true;
    for (const c of v.checks) {
      if (!c || typeof c.checkId !== "string" || typeof c.latex !== "string" || !c.variables) {
        errors.push(`${label} v${v.version}：存在结构不完整的检查项，已跳过`);
        checkOk = false;
        break;
      }
      if (ids.has(c.checkId)) {
        errors.push(`${label} v${v.version}：检查项 id 重复，已跳过`);
        checkOk = false;
        break;
      }
      ids.add(c.checkId);
    }
    if (!checkOk) return;
    entries.push({ packageId: e.packageId, code: e.code, version: v });
  });

  return { entries, errors };
}

export interface ExistingVersion {
  packageId: string;
  version: number;
  contentHash: string;
}

export type ImportDecision =
  | { action: "add"; entry: PackageEntry }
  | { action: "duplicate"; packageId: string; version: number; detail: string }
  | { action: "conflict"; packageId: string; version: number; detail: string };

/**
 * 幂等导入规划（纯函数）：
 *  - 本地没有该 packageId+version → 新增（含“同一包的更新版本”）；
 *  - 已有且指纹相同 → duplicate，不产生重复；
 *  - 同包同版本号但指纹不同 → conflict，拒绝覆盖（保护已有尝试引用的版本）。
 */
export function planImport(entries: PackageEntry[], existing: ExistingVersion[]): ImportDecision[] {
  return entries.map((entry) => {
    const found = existing.find((x) => x.packageId === entry.packageId && x.version === entry.version.version);
    if (!found) return { action: "add", entry };
    if (found.contentHash === entry.version.contentHash) {
      return {
        action: "duplicate",
        packageId: entry.packageId,
        version: entry.version.version,
        detail: `任务「${entry.version.title}」v${entry.version.version} 已在本地，重复导入已忽略`,
      };
    }
    return {
      action: "conflict",
      packageId: entry.packageId,
      version: entry.version.version,
      detail: `任务包 ${entry.packageId} 的 v${entry.version.version} 与本地版本内容不一致（同版本号不同指纹），为保护已有尝试已拒绝导入`,
    };
  });
}

// ---------------- 证据导出 ----------------

export function buildEvidenceFile(attempt: Attempt, replay: ReplayReport | null): EvidenceFile {
  return {
    app: PACKAGE_FILE_APP,
    format: EVIDENCE_FILE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    attempt,
    replay,
  };
}
