// 量纲检查引擎与实验任务包的公共类型定义

/** 变量：数值文本 + 单位文本（单位留空表示纯数） */
export interface VariableDef {
  value: string;
  unit: string;
}

/** 一条自由笔记公式 */
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

// ---------- 实验任务包 ----------

export type TaskPublishStatus = "draft" | "published";

export interface RequiredVariableSpec {
  name: string;
  /** 学生必须使用的单位；空字符串表示必须为无量纲纯数 */
  unit: string;
  label?: string;
}

export interface TaskFormulaSpec {
  id: string;
  /** MathLive LaTeX。发布后作为快照的一部分冻结，不允许被后续修订覆盖。 */
  latex: string;
  note: string;
  requiredVariables: RequiredVariableSpec[];
  /** 学生结果必须换算到的单位；空字符串表示保留求值单位 */
  targetUnit: string;
  /** 可选通过条件：目标单位数值（无目标单位时为原始单位数值） */
  expectedValue?: number | null;
  /** 允许的绝对误差；缺省使用 1e-9 */
  tolerance?: number | null;
}

export interface TaskPackage {
  /** IndexedDB 主键。发布版等于 versionId，草稿使用本地随机 ID。 */
  id: string;
  /** 同一任务系列的稳定标识，修订版保持不变 */
  packageId: string;
  /** 跨版本稳定标识：packageId@version */
  versionId: string;
  version: number;
  status: TaskPublishStatus;
  title: string;
  description: string;
  formulas: TaskFormulaSpec[];
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
}

/** 每个公式公式 ID 对应一组变量答案 */
export type TaskAnswerMap = Record<string, Record<string, VariableDef>>;

export interface FrozenFormulaResult {
  /** 冻结发布版中的完整公式规格，证据重放不依赖后来的任务修订 */
  spec: TaskFormulaSpec;
  variables: Record<string, VariableDef>;
  analysis: AnalysisResult;
  passed: boolean;
  /** 任务层面的拒绝原因（必填变量/单位/期望值等；引擎诊断仍在 analysis.issues） */
  reasons: string[];
}

export interface PendingSubmission {
  /** 由“尝试 + 任务版本 + 规范化答案”确定，刷新恢复时仍指向同一次提交 */
  id: string;
  startedAt: number;
  answers: TaskAnswerMap;
}

export interface FrozenSubmission {
  id: string;
  attemptId: string;
  packageId: string;
  versionId: string;
  version: number;
  packageTitle: string;
  packageContentHash: string;
  engineVersion: string;
  submittedAt: number;
  passed: boolean;
  answers: TaskAnswerMap;
  formulaResults: FrozenFormulaResult[];
}

export interface TaskAttempt {
  /** 同一 package version 的稳定尝试 ID，重复导入不会生成第二份 */
  id: string;
  packageId: string;
  versionId: string;
  version: number;
  /** 学生仍可修改的当前答案；已提交记录不可变 */
  answers: TaskAnswerMap;
  submissions: FrozenSubmission[];
  /** 提交冻结开始后、页面刷新时尚未完成的提交 */
  pendingSubmission: PendingSubmission | null;
  createdAt: number;
  updatedAt: number;
}
