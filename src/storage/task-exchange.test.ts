import { describe, expect, it } from "vitest";
import { buildTaskPackageFile, detectImport, mergeEvidence, parseEvidence, parseTaskPackage } from "./exchange";
import { completeSubmission, createAttempt, makeAngleTask, startPendingSubmission } from "../engine/task";
import type { FrozenSubmission, TaskAttempt } from "../engine/types";

describe("任务包 JSON", () => {
  it("发布包可解析，重复内容哈希一致", () => {
    const task = makeAngleTask();
    const text = JSON.stringify(buildTaskPackageFile(task));
    const parsed = parseTaskPackage(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.task.versionId).toBe(task.versionId);
    expect(parsed.task.contentHash).toBe(task.contentHash);
    expect(detectImport(text).type).toBe("task");
  });

  it("篡改发布公式会因内容哈希不一致被拒绝", () => {
    const file = buildTaskPackageFile(makeAngleTask());
    file.task.formulas[0].latex = "\\alpha-\\beta";
    const parsed = parseTaskPackage(JSON.stringify(file));
    expect(parsed.errors.some((e) => e.includes("哈希不一致"))).toBe(true);
  });

  it("草稿任务包拒绝导入学生端", () => {
    const file = buildTaskPackageFile({ ...makeAngleTask(), status: "draft" });
    const parsed = parseTaskPackage(JSON.stringify(file));
    expect(parsed.errors.some((e) => e.includes("已发布"))).toBe(true);
  });
});

describe("证据 JSON 与幂等归档", () => {
  function submit(): { attempt: TaskAttempt; submission: FrozenSubmission } {
    const task = makeAngleTask();
    let attempt = createAttempt(task);
    const answers = {
      "angle-sum": {
        alpha: { value: "180", unit: "deg" },
        beta: { value: "0.5", unit: "rad" },
      },
    };
    const pending = startPendingSubmission(attempt, answers);
    attempt = { ...attempt, answers, pendingSubmission: pending };
    return completeSubmission(task, attempt, pending);
  }

  it("证据包可识别并携带冻结结果", () => {
    const { submission } = submit();
    const text = JSON.stringify({
      app: "dimension-notebook",
      kind: "dimension-notebook-submission-evidence",
      version: 1,
      exportedAt: new Date().toISOString(),
      submission,
    });
    const parsed = parseEvidence(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.submission?.formulaResults[0].passed).toBe(true);
    expect(detectImport(text).type).toBe("evidence");
  });

  it("同一证据重复合并不制造重复提交；缺少尝试时创建档案", () => {
    const { submission } = submit();
    const created = mergeEvidence(undefined, submission);
    expect(created.submissions).toHaveLength(1);
    const again = mergeEvidence(created, submission);
    expect(again).toBe(created);
  });
});
