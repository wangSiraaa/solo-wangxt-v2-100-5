// 教师端单条检查编辑器：公式、必填变量（自动推导）、参考值与期望单位、目标单位、通过条件。
import { useMemo } from "react";
import type { TaskCheck, TaskRequiredVar, VariableDef } from "../engine/types";
import { analyzeFormula } from "../engine/math";
import { gradeCheck } from "../engine/grading";
import MathInput from "./MathInput";
import Tex from "./Tex";

interface Props {
  index: number;
  check: TaskCheck;
  onChange: (patch: Partial<TaskCheck>) => void;
  onRemove: () => void;
}

export default function CheckEditor({ index, check, onChange, onRemove }: Props) {
  // 必填变量由公式自动推导；教师只需给每个变量填参考数值与期望单位
  const detected = useMemo(() => {
    if (!check.latex.trim()) return [];
    try {
      // 复用引擎入口：用空变量跑一遍，从 variables 字段取名（语法错误时为空）
      return analyzeFormula(check.latex, {}, "").variables;
    } catch {
      return [];
    }
  }, [check.latex]);

  // 保证 variables 里始终有推导出来的键
  const vars = check.variables;
  const setVar = (name: string, patch: Partial<TaskRequiredVar>) => {
    const prev = vars[name] ?? { value: "", unit: "" };
    onChange({ variables: { ...vars, [name]: { ...prev, ...patch } } });
  };

  // 用参考答案实时自检（教师视角：标准答案能不能通过这条任务）
  const referenceAnswers: Record<string, VariableDef> = {};
  for (const name of detected) {
    const spec = vars[name];
    if (spec?.value?.trim()) referenceAnswers[name] = { value: spec.value.trim(), unit: spec.unit.trim() };
  }
  const frozenPreview = {
    checkId: check.checkId,
    prompt: check.prompt,
    latex: check.latex,
    variables: Object.fromEntries(detected.map((n) => [n, { unit: vars[n]?.unit.trim() ?? "" }])),
    targetUnit: check.targetUnit.trim(),
    requireNumber: check.requireNumber,
    ...(check.expectedValue !== undefined && Number.isFinite(check.expectedValue)
      ? { expectedValue: Number(check.expectedValue) } : {}),
    ...(check.tolerance !== undefined && Number.isFinite(check.tolerance) ? { tolerance: check.tolerance } : {}),
  };
  const selfTest = useMemo(
    () => (check.latex.trim() ? gradeCheck(frozenPreview, referenceAnswers) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [check.latex, check.targetUnit, check.requireNumber, check.expectedValue, check.tolerance, JSON.stringify(vars), detected.join(",")],
  );

  return (
    <section className="card check-edit">
      <header className="card-head">
        <strong>检查 {index + 1}</strong>
        <input
          className="prompt-input"
          value={check.prompt}
          placeholder="题面，如：把 180° 换算成弧度"
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
        <button type="button" className="mini-btn danger" onClick={onRemove}>删除检查</button>
      </header>

      <div className="card-body">
        <label className="field-label">
          公式（学生作答时冻结只读）
          <MathInput value={check.latex} onChange={(latex) => onChange({ latex })} placeholder="例如 \\theta·\\frac{\\pi}{180}" />
        </label>

        {detected.length > 0 && (
          <div className="ref-vars">
            <div className="field-label">必填变量与参考答案（<b>参考数值不会导出给学生</b>，期望单位会作为提示下发）</div>
            <div className="var-table">
              <div className="var-row var-head"><span>变量</span><span>参考数值</span><span>期望单位</span><span /></div>
              {detected.map((name) => {
                const spec = vars[name] ?? { value: "", unit: "" };
                return (
                  <div className="var-row" key={name}>
                    <span className="var-name">{name}</span>
                    <input
                      className="num-input"
                      inputMode="decimal"
                      placeholder="参考答案值"
                      value={spec.value ?? ""}
                      onChange={(e) => setVar(name, { value: e.target.value })}
                    />
                    <input
                      className="unit-input"
                      list="unit-suggestions"
                      placeholder="如 deg（留空=纯数）"
                      value={spec.unit}
                      onChange={(e) => setVar(name, { unit: e.target.value })}
                    />
                    <span />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid-2">
          <label className="field-label">目标单位（学生结果按此换算；留空 = 使用计算单位）
            <input
              data-testid="target-unit-input"
              list="unit-suggestions"
              value={check.targetUnit}
              placeholder="如 rad、K、m/s"
              onChange={(e) => onChange({ targetUnit: e.target.value })}
            />
          </label>
          <div className="pass-cond">
            <label className="inline-check">
              <input
                type="checkbox"
                className="cb"
                checked={check.requireNumber}
                onChange={(e) => onChange({ requireNumber: e.target.checked })}
              />
              数值必须匹配期望值才通过
            </label>
            {check.requireNumber && (
              <div className="grid-2 tight">
                <label className="field-label">期望值（目标单位下）
                  <input
                    data-testid="expected-value-input"
                    inputMode="decimal"
                    value={check.expectedValue ?? ""}
                    placeholder="如 3.14159"
                    onChange={(e) => onChange({ expectedValue: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                </label>
                <label className="field-label">相对容差（留空 = 1e-6）
                  <input
                    inputMode="decimal"
                    value={check.tolerance ?? ""}
                    placeholder="如 0.01"
                    onChange={(e) => onChange({ tolerance: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        {selfTest && (
          <div className={`self-test ${selfTest.passed ? "ok" : "err"}`} data-testid="self-test">
            <span className={`badge ${selfTest.passed ? "ok" : "err"}`}>
              {selfTest.passed ? "参考答案自检通过" : "参考答案自检未通过"}
            </span>
            <span>{selfTest.verdict}</span>
            {selfTest.originalTex && <Tex tex={selfTest.originalTex} block={false} />}
          </div>
        )}
      </div>
    </section>
  );
}
