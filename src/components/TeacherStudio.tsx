import { useMemo, useState } from "react";
import { analyzeFormula } from "../engine/math";
import {
  createRevision,
  makeAngleTask,
  makeBlankTask,
  makeBoundaryTask,
  publishTaskDraft,
  validateTaskDraft,
} from "../engine/task";
import type { RequiredVariableSpec, TaskFormulaSpec, TaskPackage } from "../engine/types";
import { buildTaskPackageFile, downloadJSON } from "../storage/exchange";
import MathInput from "./MathInput";

interface Props {
  tasks: TaskPackage[];
  onSaveDraft: (task: TaskPackage, oldId?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onNotice: (message: string) => void;
}

export default function TeacherStudio({ tasks, onSaveDraft, onDelete, onNotice }: Props) {
  const [selectedId, setSelectedId] = useState<string>("");
  const drafts = tasks.filter((t) => t.status === "draft");
  const published = tasks.filter((t) => t.status === "published");
  const selected = tasks.find((t) => t.id === selectedId)
    ?? drafts[0]
    ?? null;
  const [validation, setValidation] = useState<string[]>([]);

  const groups = useMemo(() => {
    const map = new Map<string, TaskPackage[]>();
    published.forEach((t) => {
      const list = map.get(t.packageId) ?? [];
      list.push(t);
      map.set(t.packageId, list);
    });
    return [...map.values()].map((list) => list.sort((a, b) => b.version - a.version));
  }, [published]);

  const update = async (patch: Partial<TaskPackage>) => {
    if (!selected || selected.status !== "draft") return;
    const next = { ...selected, ...patch, updatedAt: Date.now() };
    await onSaveDraft(next, selected.id);
  };

  const updateFormula = async (formulaId: string, patch: Partial<TaskFormulaSpec>) => {
    if (!selected) return;
    await update({
      formulas: selected.formulas.map((f) => (f.id === formulaId ? { ...f, ...patch } : f)),
    });
  };

  const addFormula = async () => {
    if (!selected) return;
    const spec: TaskFormulaSpec = {
      id: `check_${Math.random().toString(36).slice(2, 7)}`,
      latex: "",
      note: "",
      requiredVariables: [],
      targetUnit: "",
      expectedValue: null,
      tolerance: null,
    };
    await update({ formulas: [...selected.formulas, spec] });
  };

  const publish = async () => {
    if (!selected) return;
    const errors = validateTaskDraft(selected);
    setValidation(errors);
    if (errors.length) {
      onNotice(`无法发布：${errors[0]}`);
      return;
    }
    const result = publishTaskDraft(selected);
    if (result.errors.length) return;
    await onSaveDraft(result.task, selected.id);
    setSelectedId(result.task.id);
    setValidation([]);
    onNotice(`已发布 ${result.task.title} v${result.task.version}（${result.task.versionId}）`);
  };

  const revise = async (task: TaskPackage) => {
    const draft = createRevision(task);
    await onSaveDraft(draft);
    setSelectedId(draft.id);
    setValidation([]);
    onNotice(`已从 v${task.version} 派生 v${draft.version} 草稿；旧发布版保持不变`);
  };

  const createDraft = async () => {
    const draft = makeBlankTask();
    await onSaveDraft(draft);
    setSelectedId(draft.id);
  };

  const seed = async (factory: () => TaskPackage) => {
    const task = factory();
    await onSaveDraft(task);
    setSelectedId(task.id);
  };

  return (
    <div className="split-layout">
      <aside className="sidebar">
        <button type="button" onClick={() => void createDraft()}>＋ 新建草稿</button>
        <div className="seed-actions">
          <button type="button" className="ghost" onClick={() => void seed(makeAngleTask)}>装入角度发布样例</button>
          <button type="button" className="ghost" onClick={() => void seed(makeBoundaryTask)}>装入边界发布样例</button>
        </div>
        <h3>草稿</h3>
        {drafts.length === 0 && <p className="muted small">暂无草稿</p>}
        {drafts.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`list-item ${selected?.id === t.id ? "active" : ""}`}
            onClick={() => setSelectedId(t.id)}
          >
            <strong>{t.title || "未命名任务"}</strong>
            <span>v{t.version} 草稿</span>
          </button>
        ))}
        <h3>已发布版本</h3>
        {groups.map((list) => (
          <div className="version-group" key={list[0].packageId}>
            <div className="group-title">{list[0].title}</div>
            {list.map((t) => (
              <div key={t.id} className="published-row">
                <button type="button" className={`list-item ${selected?.id === t.id ? "active" : ""}`} onClick={() => setSelectedId(t.id)}>
                  <strong>v{t.version}</strong>
                  <span className="mono small">{t.versionId}</span>
                </button>
                <div className="row-actions">
                  <button type="button" className="mini-btn" onClick={() => revise(t)}>修订</button>
                  <button type="button" className="mini-btn" onClick={() => downloadJSON(buildTaskPackageFile(t), `${t.versionId}.json`)}>包</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </aside>

      <section className="workspace-panel">
        {!selected ? (
          <div className="empty-state">请新建或选择一个任务草稿。</div>
        ) : selected.status === "published" ? (
          <PublishedPreview task={selected} onRevise={() => void revise(selected)} />
        ) : (
          <div className="editor">
            <div className="panel-head">
              <h2>任务草稿 · v{selected.version}</h2>
              <div>
                <button type="button" onClick={() => void onDelete(selected.id)} className="danger ghost">删除草稿</button>
                <button type="button" className="primary" onClick={() => void publish()}>发布此版本</button>
              </div>
            </div>
            {validation.length > 0 && (
              <div className="issue-box">
                {validation.map((v) => <div key={v}>• {v}</div>)}
              </div>
            )}
            <label className="field-label">任务标题
              <input value={selected.title} onChange={(e) => void update({ title: e.target.value })} />
            </label>
            <label className="field-label">任务说明
              <textarea value={selected.description} onChange={(e) => void update({ description: e.target.value })} rows={3} />
            </label>
            <div className="formula-editor-list">
              {selected.formulas.map((f, i) => (
                <FormulaEditor key={f.id} index={i} formula={f} onChange={(p) => void updateFormula(f.id, p)} onRemove={() => void update({ formulas: selected.formulas.filter((x) => x.id !== f.id) })} />
              ))}
            </div>
            <button type="button" onClick={() => void addFormula()}>＋ 添加独立检查</button>
            <p className="muted small hash-line">
              包系列：<code>{selected.packageId}</code>；版本：<code>{selected.versionId}</code>。
              发布会冻结当前公式、必填变量、目标单位与通过条件。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function PublishedPreview({ task, onRevise }: { task: TaskPackage; onRevise: () => void }) {
  return (
    <div className="editor">
      <div className="panel-head">
        <h2>{task.title} · v{task.version}</h2>
        <button type="button" className="primary" onClick={onRevise}>派生修订草稿</button>
      </div>
      <p>{task.description}</p>
      <p className="muted small mono">版本 ID：{task.versionId}<br />内容哈希：{task.contentHash}</p>
      {task.formulas.map((f, i) => <FormulaSnapshot key={f.id} formula={f} index={i} />)}
    </div>
  );
}

function FormulaSnapshot({ formula, index }: { formula: TaskFormulaSpec; index: number }) {
  return (
    <div className="task-formula-editor">
      <h4>检查 {index + 1}：{formula.note || formula.id}</h4>
      <MathInput value={formula.latex} onChange={() => undefined} readOnly />
      <div className="meta-grid">
        <span>目标单位：{formula.targetUnit || "自动"}</span>
        <span>通过值：{formula.expectedValue ?? "仅要求已验证"}</span>
        <span>变量：{formula.requiredVariables.map((v) => `${v.name}[${v.unit || "纯数"}]`).join("、") || "无"}</span>
      </div>
    </div>
  );
}

function FormulaEditor({ index, formula, onChange, onRemove }: {
  index: number;
  formula: TaskFormulaSpec;
  onChange: (patch: Partial<TaskFormulaSpec>) => void;
  onRemove: () => void;
}) {
  const preview = useMemo(() => analyzeFormula(
    formula.latex,
    Object.fromEntries(formula.requiredVariables.map((v) => [v.name, { value: "1", unit: v.unit }])),
    formula.targetUnit,
  ), [formula.latex, formula.requiredVariables, formula.targetUnit]);

  const setVar = (i: number, patch: Partial<RequiredVariableSpec>) => {
    onChange({ requiredVariables: formula.requiredVariables.map((v, idx) => (idx === i ? { ...v, ...patch } : v)) });
  };
  const addVar = () => onChange({
    requiredVariables: [...formula.requiredVariables, { name: `x${formula.requiredVariables.length + 1}`, unit: "" }],
  });

  return (
    <div className="task-formula-editor">
      <div className="editor-row">
        <h4>独立检查 {index + 1}</h4>
        <button type="button" className="mini-btn danger" onClick={onRemove}>移除</button>
      </div>
      <label className="field-label">检查说明
        <input value={formula.note} onChange={(e) => onChange({ note: e.target.value })} />
      </label>
      <label className="field-label">公式 LaTeX
        <MathInput value={formula.latex} onChange={(latex) => onChange({ latex })} />
      </label>
      <div className="required-vars">
        <div className="editor-row"><strong>必填变量</strong><button type="button" className="mini-btn" onClick={addVar}>添加</button></div>
        {formula.requiredVariables.map((v, i) => (
          <div className="req-var-row" key={`${v.name}-${i}`}>
            <input value={v.name} placeholder="变量名" onChange={(e) => setVar(i, { name: e.target.value })} />
            <input value={v.unit} placeholder="必填单位，空=纯数" onChange={(e) => setVar(i, { unit: e.target.value })} />
            <button type="button" className="mini-btn danger" onClick={() => onChange({ requiredVariables: formula.requiredVariables.filter((_, idx) => idx !== i) })}>×</button>
          </div>
        ))}
      </div>
      <div className="criteria-grid">
        <label className="field-label">目标单位
          <input value={formula.targetUnit} onChange={(e) => onChange({ targetUnit: e.target.value })} />
        </label>
        <label className="field-label">期望数值（可选）
          <input
            value={formula.expectedValue ?? ""}
            inputMode="decimal"
            onChange={(e) => onChange({ expectedValue: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </label>
        <label className="field-label">容差
          <input
            value={formula.tolerance ?? ""}
            inputMode="decimal"
            onChange={(e) => onChange({ tolerance: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </label>
      </div>
      <div className={`draft-preview ${preview.status}`}>
        用样例值 1 预检：{preview.status} {preview.summary}
        {preview.issues.map((iss, i) => <div key={i}>· {iss.message}</div>)}
      </div>
    </div>
  );
}
