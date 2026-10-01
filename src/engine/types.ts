// 量纲检查引擎的公共类型定义

/** 变量：数值文本 + 单位文本（单位留空表示纯数） */
export interface VariableDef {
  value: string;
  unit: string;
}

/** 一条公式 */
export interface Formula {
  id: string;
  /** MathLive 编辑产出的 LaTeX，导出后仍可重新编辑 */
  latex: string;
  /** 备注 */
  note: string;
  variables: Record<string, VariableDef>;
  /** 期望换算到的结果单位；留空表示使用计算得到的单位 */
  targetUnit: string;
  createdAt: number;
}

/** 问题严重级别：error = 明确错误；warning = 超出首版支持范围，结果未验证 */
export type IssueKind = "error" | "warning";

export interface Issue {
  kind: IssueKind;
  /** 定位到的 AST 节点路径（根节点为 []，子节点为序号数组） */
  path: number[];
  /** 该节点对应的原式片段（LaTeX） */
  snippet: string;
  message: string;
}

export type AnalysisStatus = "ok" | "unverified" | "error" | "empty";

export interface AnalysisResult {
  status: AnalysisStatus;
  /** 原式中识别出的变量名（不含 pi、e 等内置常量） */
  variables: string[];
  /** 所有问题（错误 + 未验证警告） */
  issues: Issue[];
  /** 原式对应的 mathjs 表达式 */
  source?: string;
  /** 替换变量后的计算式（mathjs 表达式） */
  substituted?: string;
  /** 原式的 TeX（带问题节点高亮） */
  originalTex?: string;
  /** 替换后计算式的 TeX（带问题节点高亮） */
  substitutedTex?: string;
  /** 结果数值（原始单位） */
  value?: number;
  /** 结果单位字符串，无量纲时为 "" */
  resultUnit?: string;
  /** 换算后的结果数值 */
  targetValue?: number;
  /** 换算后的结果单位 */
  targetUnit?: string;
  /** 给 UI 用的简短状态说明 */
  summary?: string;
}

// ===================== 实验任务包 =====================

/** 一条待发布任务的检查项（教师草稿态，可编辑、含参考答案） */
export interface TaskCheck {
  /** 任务内稳定 id：发布快照与尝试证据都用它定位 */
  checkId: string;
  /** 题面说明（学生可见） */
  prompt: string;
  /** MathLive LaTeX 表达式（学生作答时只读） */
  latex: string;
  /**
   * 必填变量：发布时由 LaTeX 自动推导并冻结。
   * value 是教师参考答案值（学生包中会被剥离），unit 是期望单位（学生可见的提示）。
   */
  variables: Record<string, TaskRequiredVar>;
  /** 目标单位（学生作答时按此换算） */
  targetUnit: string;
  /** 通过条件：数值是否必须匹配；不要求时只要引擎判定 ok 即通过 */
  requireNumber: boolean;
  /** 期望结果值（目标单位下）；requireNumber 为 true 时必填 */
  expectedValue?: number;
  /** 相对容差（如 0.01 = 1%）；缺省用引擎默认容差 */
  tolerance?: number;
}

export interface TaskRequiredVar {
  /** 教师参考数值；导出给学生前会被剥离 */
  value?: string;
  /** 期望单位（学生可见的单位提示，留空表示纯数） */
  unit: string;
}

/** 发布快照中冻结的检查项（不含参考答案数值） */
export interface FrozenCheck {
  checkId: string;
  prompt: string;
  latex: string;
  variables: Record<string, { unit: string }>;
  targetUnit: string;
  requireNumber: boolean;
  expectedValue?: number;
  tolerance?: number;
}

/** 任务版本状态：draft 草稿；published 已发布不可变 */
export type TaskLifecycle = "draft" | "published";

/** 已发布的不可变版本（发布即冻结，修改只能派生新版本） */
export interface PublishedVersion {
  version: number;
  publishedAt: number;
  /** 本版本修订说明（教师可写，如“把目标单位从 rad 改为 deg”） */
  revisionNote: string;
  title: string;
  description: string;
  checks: FrozenCheck[];
  /** 对冻结内容（不含本字段与时间戳）算出的内容指纹 */
  contentHash: string;
}

/** 教师本地的任务包：草稿 + 一串已发布版本 */
export interface TaskPackage {
  /** 包稳定标识：同一包重复导入按它幂等去重 */
  packageId: string;
  code: string;
  createdAt: number;
  updatedAt: number;
  /** 未发布草稿；发布后清空（再次修订会从最新版本复制出新草稿） */
  draft: TaskDraft | null;
  versions: PublishedVersion[];
}

export interface TaskDraft {
  title: string;
  description: string;
  checks: TaskCheck[];
  revisionNote: string;
}

// ===================== 学生尝试 =====================

export type AttemptStatus = "in_progress" | "passed" | "rejected";

/** 一次检查的冻结结果（证据的一部分） */
export interface FrozenCheckResult {
  checkId: string;
  /** 引擎判定：ok / unverified / error / empty */
  engineStatus: AnalysisStatus;
  /** 本检查是否通过 */
  passed: boolean;
  /** 不通过原因（错误码），通过时为 null */
  reason: RejectReason | null;
  /** 人类可读的判定说明 */
  verdict: string;
  /** 学生提交的变量 */
  submittedVariables: Record<string, VariableDef>;
  /** 结果数值与单位（有值时） */
  value?: number;
  resultUnit?: string;
  targetValue?: number;
  targetUnit?: string;
  /** 冻结的引擎问题（量纲 / 未定义变量 / 除零 / 未验证…） */
  issues: Issue[];
  source?: string;
  substituted?: string;
  originalTex?: string;
  substitutedTex?: string;
  summary?: string;
}

/** 不通过原因码：任务逻辑据此拒绝，绝不把错误算通过 */
export type RejectReason =
  | "engine_error"
  | "unverified"
  | "empty"
  | "missing_variable"
  | "unit_mismatch"
  | "target_conversion_failed"
  | "wrong_number"
  | "threw";

/** 一次提交的完整证据（冻结公式、变量、结果、量纲问题与任务版本） */
export interface Attempt {
  attemptId: string;
  /** 幂等槽位：同一包版本的进行中尝试固定为一个（刷新/重复提交复用） */
  slotKey: string;
  packageId: string;
  /** 任务代码快照（便于展示） */
  code: string;
  version: number;
  /** 发布版本内容指纹：证据与版本绑定 */
  contentHash: string;
  status: AttemptStatus;
  /** 同一包版本下的尝试序号（1 起，每次新增可追溯记录） */
  seq: number;
  startedAt: number;
  submittedAt: number | null;
  /** 提交途中标志：写入证据前崩溃/刷新，重启据此原地补完而不是新建尝试 */
  submitting: boolean;
  /** 学生作答（变量），in_progress 期间也会持久化 */
  answers: Record<string, Record<string, VariableDef>>;
  /** 冻结的任务版本本体：旧版任务被修订后，旧尝试仍按旧规则展示 */
  taskTitle: string;
  frozenChecks: FrozenCheck[];
  /** 评分规则版本，保证证据可重放 */
  gradingEngine: string;
  results: FrozenCheckResult[];
}

/** 重放比对结果 */
export interface ReplayReport {
  replayable: boolean;
  /** 每个检查当前引擎重算与冻结证据是否一致 */
  checks: { checkId: string; consistent: boolean; detail: string }[];
}
