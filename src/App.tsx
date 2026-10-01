import { useCallback, useEffect, useRef, useState } from "react";
import FormulaCard from "./components/FormulaCard";
import StudentWorkspace from "./components/StudentWorkspace";
import TeacherStudio from "./components/TeacherStudio";
import EvidenceView from "./components/EvidenceView";
import type { Formula, TaskAttempt, TaskPackage } from "./engine/types";
import { completeSubmission, createAttempt } from "./engine/task";
import { db, newId } from "./storage/db";
import {
  buildExport,
  detectImport,
  downloadJSON,
  mergeEvidence,
  parseImport,
} from "./storage/exchange";

type Tab = "notebook" | "teacher" | "student" | "evidence";

function makeFormula(partial?: Partial<Formula>): Formula {
  return {
    id: newId(),
    latex: "",
    note: "",
    variables: {},
    targetUnit: "",
    createdAt: Date.now(),
    ...partial,
  };
}

export default function App() {
  const [tab, setTab] = useState<Tab>("notebook");
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [tasks, setTasks] = useState<TaskPackage[]>([]);
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const notebookFileRef = useRef<HTMLInputElement>(null);
  const studentFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([db.all(), db.allTasks(), db.allAttempts()])
      .then(([rows, taskRows, attemptRows]) => {
        setFormulas(rows);
        setTasks(taskRows);
        setAttempts(attemptRows);
      })
      .catch((e) => setNotice(`读取本地存储失败：${(e as Error).message}`))
      .finally(() => setLoaded(true));
  }, []);

  // 自由笔记变更防抖写入。任务/提交为关键证据，采用显式 await 写入而非防抖。
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      db.bulkPut(formulas).catch((e) => setNotice(`保存失败：${(e as Error).message}`));
    }, 300);
  }, [formulas, loaded]);

  // 恢复“提交冻结已经开始、但页面在完成前刷新”的提交。
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (!loaded || recoveredRef.current) return;
    recoveredRef.current = true;
    const pending = attempts.filter((a) => a.pendingSubmission);
    if (pending.length === 0) return;
    const byVersion = new Map(tasks.map((t) => [t.versionId, t]));
    const next = attempts.map((attempt) => {
      const p = attempt.pendingSubmission;
      const task = byVersion.get(attempt.versionId);
      if (!p) return attempt;
      if (!task) {
        return { ...attempt, pendingSubmission: null, updatedAt: Date.now() };
      }
      return completeSubmission(task, attempt, p).attempt;
    });
    setAttempts(next);
    void Promise.all(next.map((a) => db.putAttempt(a)));
    setNotice(`已恢复 ${pending.length} 条刷新中中断的提交；仍使用原幂等提交 ID`);
  }, [loaded, attempts, tasks]);

  const update = useCallback((id: string, patch: Partial<Formula>) => {
    setFormulas((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const remove = useCallback(async (id: string) => {
    setFormulas((fs) => fs.filter((f) => f.id !== id));
    await db.delete(id).catch(() => undefined);
  }, []);

  const add = () => setFormulas((fs) => [...fs, makeFormula()]);

  const addExample = (kind: "unit" | "degC" | "angle" | "dimErr" | "divZero") => {
    const presets: Record<string, Formula> = {
      unit: makeFormula({
        latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
        note: "匀变速直线运动位移",
        variables: {
          v: { value: "2", unit: "m/s" },
          t: { value: "3", unit: "s" },
          a: { value: "4", unit: "m/s^2" },
        },
        targetUnit: "m",
      }),
      degC: makeFormula({
        latex: "T_1+T_2",
        note: "摄氏度直接相加 —— 应提示偏移温标歧义并标记未验证",
        variables: {
          T_1: { value: "10", unit: "degC" },
          T_2: { value: "5", unit: "degC" },
        },
        targetUnit: "",
      }),
      angle: makeFormula({
        latex: "\\theta+\\alpha",
        note: "度与弧度相加 —— 量纲兼容，自动换算",
        variables: {
          theta: { value: "1", unit: "rad" },
          alpha: { value: "180", unit: "deg" },
        },
        targetUnit: "deg",
      }),
      dimErr: makeFormula({
        latex: "(a+b)\\cdot c",
        note: "m 与 kg 相加 —— 应定位到括号内的 + 节点",
        variables: {
          a: { value: "1", unit: "m" },
          b: { value: "2", unit: "kg" },
          c: { value: "3", unit: "" },
        },
        targetUnit: "",
      }),
      divZero: makeFormula({
        latex: "x/y",
        note: "除零 —— 必须明确报错，不产生 Infinity",
        variables: {
          x: { value: "10", unit: "m" },
          y: { value: "0", unit: "s" },
        },
        targetUnit: "",
      }),
    };
    setFormulas((fs) => [...fs, presets[kind]]);
  };

  const onExportNotebook = () => {
    if (formulas.length === 0) { setNotice("当前没有可导出的公式"); return; }
    downloadJSON(buildExport(formulas));
  };

  const onNotebookFile = async (file: File) => {
    const text = await file.text();
    const { formulas: imported, errors } = parseImport(text, new Set(formulas.map((f) => f.id)));
    if (imported.length === 0) {
      setNotice(errors[0] ?? "文件中没有可导入的公式");
      return;
    }
    setFormulas((fs) => [...fs, ...imported]);
    setNotice(`已导入 ${imported.length} 条公式${errors.length ? `；${errors.length} 条被跳过（${errors[0]}）` : ""}`);
  };

  const saveDraft = useCallback(async (task: TaskPackage, oldId?: string) => {
    setTasks((rows) => {
      const withoutOld = rows.filter((t) => t.id !== task.id && t.id !== oldId);
      return [...withoutOld, task];
    });
    await db.putTask(task);
    if (oldId && oldId !== task.id) await db.deleteTask(oldId);
  }, []);

  const deleteTask = useCallback(async (id: string) => {
    setTasks((rows) => rows.filter((t) => t.id !== id));
    await db.deleteTask(id);
  }, []);

  const upsertAttempt = useCallback(async (attempt: TaskAttempt) => {
    setAttempts((rows) => {
      const exists = rows.some((a) => a.id === attempt.id);
      return exists ? rows.map((a) => (a.id === attempt.id ? attempt : a)) : [...rows, attempt];
    });
    await db.putAttempt(attempt);
  }, []);

  const onStudentFile = async (file: File) => {
    const text = await file.text();
    const detected = detectImport(text, new Set(formulas.map((f) => f.id)));
    if (detected.type === "notebook") {
      setNotice("这是普通笔记 JSON；请在“自由笔记”页导入");
      return;
    }
    if (detected.type === "unknown") {
      setNotice(detected.errors.join("；"));
      return;
    }
    if (detected.type === "task") {
      if (detected.errors.length) {
        setNotice(`任务包被拒绝：${detected.errors.join("；")}`);
        return;
      }
      const task = detected.task;
      const existed = tasks.some((t) => t.id === task.id);
      setTasks((rows) => (rows.some((t) => t.id === task.id) ? rows : [...rows, task]));
      await db.putTask(task);
      let attempt = attempts.find((a) => a.versionId === task.versionId);
      if (!attempt) {
        attempt = createAttempt(task);
        setAttempts((rows) => [...rows, attempt!]);
        await db.putAttempt(attempt);
      }
      setTab("student");
      setNotice(existed
        ? `任务包 ${task.versionId} 已存在：复用同一尝试，不创建重复记录`
        : `已导入发布任务 ${task.title} v${task.version}，并生成幂等尝试 ${attempt.id}`);
      return;
    }
    const existing = attempts.find((a) => a.id === detected.submission.attemptId);
    const merged = mergeEvidence(existing, detected.submission);
    await upsertAttempt(merged);
    setTab("evidence");
    setNotice(existing
      ? "证据文件已归档；相同提交 ID 未重复添加"
      : "已导入离线提交证据，并按冻结版本创建证据档案");
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>量纲检查笔记本 · 实验任务包</h1>
        <p className="subtitle">
          本地运行 · IndexedDB 离线留痕 · 发布版本冻结 · 提交证据可重放
        </p>
        <nav className="tabs" aria-label="主要视图">
          <button type="button" className={tab === "notebook" ? "active" : ""} onClick={() => setTab("notebook")}>自由公式</button>
          <button type="button" className={tab === "teacher" ? "active" : ""} onClick={() => setTab("teacher")}>教师任务</button>
          <button type="button" className={tab === "student" ? "active" : ""} onClick={() => setTab("student")}>学生尝试</button>
          <button type="button" className={tab === "evidence" ? "active" : ""} onClick={() => setTab("evidence")}>提交证据</button>
        </nav>
        <div className="actions">
          {tab === "notebook" && <>
            <button type="button" onClick={add}>＋ 新建公式</button>
            <span className="sep" />
            <button type="button" className="ghost" onClick={() => addExample("unit")}>示例：单位运算</button>
            <button type="button" className="ghost" onClick={() => addExample("degC")}>示例：摄氏温标</button>
            <button type="button" className="ghost" onClick={() => addExample("angle")}>示例：角度弧度</button>
            <button type="button" className="ghost" onClick={() => addExample("dimErr")}>示例：量纲错误</button>
            <button type="button" className="ghost" onClick={() => addExample("divZero")}>示例：除零</button>
            <span className="sep" />
            <button type="button" className="ghost" onClick={onExportNotebook}>导出笔记 JSON</button>
            <button type="button" className="ghost" onClick={() => notebookFileRef.current?.click()}>导入笔记 JSON</button>
          </>}
          {tab === "student" && <>
            <button type="button" className="primary" onClick={() => studentFileRef.current?.click()}>导入发布任务 / 证据 JSON</button>
            <span className="muted small">重复导入同一版本会复用原尝试</span>
          </>}
          <input
            ref={notebookFileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onNotebookFile(f);
              e.target.value = "";
            }}
          />
          <input
            ref={studentFileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onStudentFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {notice && <div className="notice">{notice}</div>}
      </header>

      <main>
        {!loaded ? (
          <p className="muted">正在加载本地数据…</p>
        ) : tab === "notebook" ? (
          formulas.length === 0 ? (
            <div className="empty-state">
              <p>还没有公式。点击「新建公式」或加载一个示例开始。</p>
              <p className="muted small">
                规则：未赋值变量与除零都会明确报错；摄氏/华氏温标的四则运算、未列出的函数等会标记为「未验证」。
              </p>
            </div>
          ) : formulas.map((f, i) => (
            <FormulaCard
              key={f.id}
              formula={f}
              index={i}
              onChange={(patch) => update(f.id, patch)}
              onDelete={() => void remove(f.id)}
            />
          ))
        ) : tab === "teacher" ? (
          <TeacherStudio tasks={tasks} onSaveDraft={saveDraft} onDelete={deleteTask} onNotice={setNotice} />
        ) : tab === "student" ? (
          <StudentWorkspace tasks={tasks} attempts={attempts} onUpsertAttempt={upsertAttempt} onNotice={setNotice} />
        ) : (
          <EvidenceView attempts={attempts} tasks={tasks} />
        )}
      </main>

      <footer className="footer">
        <p>
          红色 = 明确错误；橙色 = 未验证。任务内公式独立判定；提交快照冻结公式、变量、结果、量纲问题、任务版本和引擎版本。
        </p>
      </footer>
    </div>
  );
}
