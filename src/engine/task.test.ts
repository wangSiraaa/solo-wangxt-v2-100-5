import { describe, expect, it } from "vitest";
import {
  completeSubmission,
  computePackageContentHash,
  createAttempt,
  createRevision,
  ENGINE_VERSION,
  evaluateFormula,
  makeAngleTask,
  makeBoundaryTask,
  publishTaskDraft,
  replaySubmission,
  startPendingSubmission,
  submissionIdFor,
} from "./task";
import { makeBlankTask } from "./task";
import type { TaskAnswerMap, TaskFormulaSpec, TaskPackage } from "./types";

function formula(patch: Partial<TaskFormulaSpec> = {}): TaskFormulaSpec {
  return {
    id: "f1",
    latex: "a+b",
    note: "",
    requiredVariables: [
      { name: "a", unit: "m" },
      { name: "b", unit: "m" },
    ],
    targetUnit: "m",
    expectedValue: 3,
    tolerance: 1e-9,
    ...patch,
  };
}

function publish(formulas: TaskFormulaSpec[], patch: Partial<TaskPackage> = {}) {
  const task = { ...makeBlankTask(1), title: "测试任务", formulas, ...patch };
  return publishTaskDraft(task, 2).task;
}

describe("任务包发布、修订与哈希", () => {
  it("发布冻结版本 ID、版本号和内容哈希", () => {
    const task = publish([formula()]);
    expect(task.status).toBe("published");
    expect(task.id).toBe(task.versionId);
    expect(task.contentHash).toBe(computePackageContentHash(task));
    expect(task.formulas[0].expectedValue).toBe(3);
  });

  it("修订派生新版本且旧内容不变", () => {
    const v1 = publish([formula()]);
    const draft = createRevision(v1, 3);
    expect(draft.packageId).toBe(v1.packageId);
    expect(draft.version).toBe(2);
    expect(draft.status).toBe("draft");
    expect(draft.versionId).not.toBe(v1.versionId);
    draft.title = "改标题";
    draft.formulas[0].expectedValue = 4;
    const v2 = publishTaskDraft(draft, 4).task;
    expect(v1.title).not.toBe(v2.title);
    expect(v1.formulas[0].expectedValue).toBe(3);
    expect(v2.formulas[0].expectedValue).toBe(4);
    expect(v2.contentHash).not.toBe(v1.contentHash);
  });

  it("修订发布后旧提交仍按旧版快照通过，新版生成独立尝试并须重新作答", () => {
    const v1 = publish([formula()]);
    const oldAttempt = createAttempt(v1, 1);
    const oldAnswers: TaskAnswerMap = {
      f1: { a: { value: "1", unit: "m" }, b: { value: "2", unit: "m" } },
    };
    const oldPending = startPendingSubmission(oldAttempt, oldAnswers, 2);
    const oldCompleted = completeSubmission(v1, { ...oldAttempt, pendingSubmission: oldPending }, oldPending, 3);
    expect(oldCompleted.submission.passed).toBe(true);

    const v2Draft = createRevision(v1, 4);
    v2Draft.formulas[0].expectedValue = 99;
    const v2 = publishTaskDraft(v2Draft, 5).task;
    const newAttempt = createAttempt(v2, 6);

    expect(newAttempt.id).not.toBe(oldAttempt.id);
    expect(newAttempt.submissions).toEqual([]);
    expect(oldCompleted.attempt.submissions[0].formulaResults[0].spec.expectedValue).toBe(3);
    expect(replaySubmission(oldCompleted.submission).passed).toBe(true);
  });
});

describe("任务判定与公式隔离", () => {
  it("角度发布任务：180 deg + 0.5 rad 可换算并通过", () => {
    const task = makeAngleTask();
    const r = evaluateFormula(task.formulas[0], {
      alpha: { value: "180", unit: "deg" },
      beta: { value: "0.5", unit: "rad" },
    });
    expect(r.analysis.status).toBe("ok");
    expect(r.analysis.targetUnit).toBe("deg");
    expect(r.analysis.targetValue).toBeCloseTo(180 + 90 / Math.PI, 10);
    expect(r.passed).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("摄氏读数直接相加是未验证，不能通过", () => {
    const task = makeBoundaryTask();
    const r = evaluateFormula(task.formulas[0], {
      T_1: { value: "10", unit: "degC" },
      T_2: { value: "5", unit: "degC" },
    });
    expect(r.analysis.status).toBe("unverified");
    expect(r.passed).toBe(false);
    expect(r.analysis.issues.some((i) => i.message.includes("偏移温标"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("未验证"))).toBe(true);
  });

  it("除零明确错误且不影响同一任务的另一条独立检查", () => {
    const task = makeBoundaryTask();
    const bad = evaluateFormula(task.formulas[1], {
      x: { value: "10", unit: "m" },
      y: { value: "0", unit: "s" },
    });
    expect(bad.analysis.status).toBe("error");
    expect(bad.passed).toBe(false);
    expect(bad.analysis.issues.some((i) => i.message.includes("除数为零"))).toBe(true);

    const independent = evaluateFormula(task.formulas[0], {
      T_1: { value: "10", unit: "K" },
      T_2: { value: "5", unit: "K" },
    });
    expect(independent.analysis.status).toBe("ok");
  });

  it("未定义变量、错误单位和不满足期望值均拒绝", () => {
    const spec = formula();
    const missing = evaluateFormula(spec, { a: { value: "1", unit: "m" } });
    expect(missing.passed).toBe(false);
    expect(missing.reasons.some((r) => r.includes("b 未填写"))).toBe(true);

    const wrongUnit = evaluateFormula(spec, {
      a: { value: "1", unit: "kg" },
      b: { value: "2", unit: "m" },
    });
    expect(wrongUnit.passed).toBe(false);
    expect(wrongUnit.reasons.some((r) => r.includes("必须使用单位"))).toBe(true);

    const wrongValue = evaluateFormula(spec, {
      a: { value: "1", unit: "m" },
      b: { value: "1", unit: "m" },
    });
    expect(wrongValue.passed).toBe(false);
    expect(wrongValue.reasons.some((r) => r.includes("不满足期望值"))).toBe(true);
  });
});

describe("提交冻结、幂等与重放", () => {
  it("冻结公式、变量、结果、问题、任务版本和引擎版本", () => {
    const task = makeBoundaryTask();
    const attempt = createAttempt(task, 10);
    const answers: TaskAnswerMap = {
      "celsius-direct-add": {
        T_1: { value: "10", unit: "degC" },
        T_2: { value: "5", unit: "degC" },
      },
      "divide-zero": {
        x: { value: "10", unit: "m" },
        y: { value: "0", unit: "s" },
      },
    };
    const pending = startPendingSubmission(attempt, answers, 11);
    const { submission } = completeSubmission(task, { ...attempt, pendingSubmission: pending }, pending, 12);
    expect(submission.passed).toBe(false);
    expect(submission.versionId).toBe(task.versionId);
    expect(submission.packageContentHash).toBe(task.contentHash);
    expect(submission.engineVersion).toBe(ENGINE_VERSION);
    expect(submission.formulaResults).toHaveLength(2);
    expect(submission.formulaResults[0].spec.latex).toContain("T");
    expect(submission.formulaResults[1].variables.y.value).toBe("0");
    expect(replaySubmission(submission).matchesSnapshot).toBe(true);
  });

  it("相同答案重复完成 pending 不新增提交；修正后重试新增历史", () => {
    const task = publish([formula({
      latex: "a/b",
      requiredVariables: [
        { name: "a", unit: "m" },
        { name: "b", unit: "s" },
      ],
      targetUnit: "m/s",
      expectedValue: 5,
    })]);
    let attempt = createAttempt(task, 1);
    const badAnswers: TaskAnswerMap = {
      f1: { a: { value: "10", unit: "m" }, b: { value: "0", unit: "s" } },
    };
    const badPending = startPendingSubmission(attempt, badAnswers, 2);
    const first = completeSubmission(task, attempt, badPending, 3);
    attempt = first.attempt;
    expect(first.duplicated).toBe(false);
    expect(attempt.submissions).toHaveLength(1);
    expect(attempt.submissions[0].passed).toBe(false);

    // 模拟刷新：pending ID 不变，再次 complete 复用失败证据。
    const recovered = completeSubmission(task, { ...attempt, pendingSubmission: badPending }, badPending, 4);
    expect(recovered.duplicated).toBe(true);
    expect(recovered.attempt.submissions).toHaveLength(1);

    const goodAnswers: TaskAnswerMap = {
      f1: { a: { value: "10", unit: "m" }, b: { value: "2", unit: "s" } },
    };
    expect(submissionIdFor(attempt, goodAnswers)).not.toBe(badPending.id);
    const goodPending = startPendingSubmission(attempt, goodAnswers, 5);
    const second = completeSubmission(task, recovered.attempt, goodPending, 6);
    expect(second.duplicated).toBe(false);
    expect(second.attempt.submissions).toHaveLength(2);
    expect(second.attempt.submissions[0].passed).toBe(false);
    expect(second.attempt.submissions[1].passed).toBe(true);
    expect(second.attempt.submissions[0].id).not.toBe(second.attempt.submissions[1].id);
  });
});
