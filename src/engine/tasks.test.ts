import { describe, it, expect } from "vitest";
import { gradeAttempt, gradeCheck, replayAttempt, GRADING_ENGINE } from "./grading";
import {
  freezeDraft, publishSelfCheck, draftFromVersion,
  parseTaskPackage, planImport, buildPackageFile, computeVersionHash,
} from "../storage/taskPackage";
import { freezeSubmission } from "../storage/attempts";
import { canonicalJSON, contentHash } from "./hash";
import type { Attempt, FrozenCheck, TaskDraft, VariableDef } from "./types";

const V = (value: string, unit = ""): VariableDef => ({ value, unit });

function frozenCheck(p: Partial<FrozenCheck> = {}): FrozenCheck {
  return {
    checkId: "c1",
    prompt: "p",
    latex: "\\theta",
    variables: { theta: { unit: "deg" } },
    targetUnit: "rad",
    requireNumber: true,
    expectedValue: Math.PI,
    ...p,
  };
}

function draftFor(p: Partial<TaskDraft> = {}): TaskDraft {
  return {
    title: "角度换算实验",
    description: "deg → rad",
    revisionNote: "首版",
    checks: [{
      checkId: "c1",
      prompt: "把 180 度换算为弧度",
      latex: "\\theta",
      variables: { theta: { value: "180", unit: "deg" } },
      targetUnit: "rad",
      requireNumber: true,
      expectedValue: Math.PI,
    }],
    ...p,
  };
}

function publish(draft = draftFor()) {
  const r = freezeDraft("pkg-1", draft, []);
  if (!r.version) throw new Error(r.errors.join("; "));
  return r.version;
}

function makeAttempt(checks: FrozenCheck[], answers: Record<string, Record<string, VariableDef>>, seq = 1): Attempt {
  return {
    attemptId: `att-${seq}`,
    slotKey: "slot:pkg-1:v1",
    packageId: "pkg-1",
    code: "TASK",
    version: 1,
    contentHash: "fnv1a-00000000",
    status: "in_progress",
    seq,
    startedAt: 1000,
    submittedAt: null,
    submitting: true, // 模拟“提交标志已写、证据未写”的中断状态
    answers,
    taskTitle: checks[0] ? "t" : "t",
    frozenChecks: checks,
    gradingEngine: GRADING_ENGINE,
    results: [],
  };
}

describe("规范化指纹", () => {
  it("键顺序不同产生同一指纹；内容变化指纹改变", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1, b: 2 })).not.toBe(contentHash({ a: 1, b: 3 }));
    expect(canonicalJSON({ b: 1, a: 2 })).toBe(canonicalJSON({ a: 2, b: 1 }));
  });
});

describe("发布冻结", () => {
  it("参考答案自检通过才能发布，并冻结版本号与指纹", () => {
    const v = publish();
    expect(v.version).toBe(1);
    expect(v.contentHash).toMatch(/^fnv1a-/);
    // 学生包中剥离参考答案值，只保留单位提示
    expect(v.checks[0].variables.theta).toEqual({ unit: "deg" });
    expect("value" in v.checks[0].variables.theta).toBe(false);
    expect(publishSelfCheck(draftFor())).toEqual([]);
  });

  it("标题为空 / 无检查 / 语法错误的草稿不能发布", () => {
    expect(freezeDraft("p", draftFor({ title: "  " }), []).errors.length).toBeGreaterThan(0);
    expect(freezeDraft("p", draftFor({ checks: [] }), []).errors.length).toBeGreaterThan(0);
    expect(
      freezeDraft("p", draftFor({ checks: [{ ...draftFor().checks[0], latex: "\\frac{a}{" }] }), []).errors[0],
    ).toContain("无法转换");
  });

  it("要求数值匹配但参考答案不完整时拒绝发布", () => {
    const d = draftFor({ checks: [{ ...draftFor().checks[0], variables: { theta: { value: "", unit: "deg" } } }] });
    const r = freezeDraft("pkg-1", d, []);
    expect(r.errors.join()).toContain("参考答案不完整");
  });

  it("参考答案本身过不了任务（摄氏直接相加=未验证）时不能发布", () => {
    const d: TaskDraft = {
      title: "坏任务", description: "", revisionNote: "",
      checks: [{
        checkId: "c1", prompt: "摄氏度相加", latex: "T_1+T_2",
        variables: { T_1: { value: "10", unit: "degC" }, T_2: { value: "5", unit: "degC" } },
        targetUnit: "", requireNumber: false,
      }],
    };
    // 结构上可以冻结……
    const r = freezeDraft("pkg-1", d, []);
    expect(r.version).not.toBeNull();
    // ……但发布前自检必须拦住（未验证不得作为通过标准）
    const problems = publishSelfCheck(d);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("未通过");
  });

  it("修订派生新版本：版本号递增，旧版本内容不变", () => {
    const v1 = publish();
    const d2 = draftFromVersion(v1);
    d2.checks[0].targetUnit = "deg";
    d2.checks[0].variables.theta = { value: "180", unit: "deg" };
    d2.revisionNote = "目标单位改为 deg";
    const r2 = freezeDraft("pkg-1", d2, [v1]);
    expect(r2.version!.version).toBe(2);
    expect(r2.version!.contentHash).not.toBe(v1.contentHash);
    // 旧版本指纹稳定（重算一致）
    expect(computeVersionHash("pkg-1", strip(v1))).toBe(v1.contentHash);
  });
});

function strip(v: ReturnType<typeof publish>) {
  const { publishedAt, contentHash, ...rest } = v;
  void publishedAt; void contentHash;
  return rest;
}

describe("评分引擎：拒绝规则与检查隔离", () => {
  it("角度换算正确作答 → 通过，结果可重放", () => {
    const check = frozenCheck();
    const r = gradeCheck(check, { theta: V("180", "deg") });
    expect(r.passed).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.targetValue!).toBeCloseTo(Math.PI, 6);
    const replay = replayAttempt([check], [r]);
    expect(replay.replayable).toBe(true);
  });

  it("摄氏度读数直接相加 → 未验证，明确拒绝并保留诊断", () => {
    const check = frozenCheck({
      latex: "T_1+T_2",
      variables: { T_1: { unit: "degC" }, T_2: { unit: "degC" } },
      targetUnit: "", requireNumber: false,
    });
    const r = gradeCheck(check, { T_1: V("10", "degC"), T_2: V("5", "degC") });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("unverified");
    expect(r.issues.some((i) => i.message.includes("偏移温标"))).toBe(true);
  });

  it("除零 → engine_error 拒绝，诊断含除数为零", () => {
    const check = frozenCheck({
      latex: "x/y", variables: { x: { unit: "m" }, y: { unit: "s" } },
      targetUnit: "", requireNumber: false,
    });
    const r = gradeCheck(check, { x: V("10", "m"), y: V("0", "s") });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("engine_error");
    expect(r.issues.some((i) => i.message.includes("除数为零"))).toBe(true);
    expect(r.value).toBeUndefined();
  });

  it("未定义（未赋值）变量 → missing_variable，绝不自动取零", () => {
    const check = frozenCheck({
      latex: "a+b", variables: { a: { unit: "m" }, b: { unit: "m" } },
      targetUnit: "", expectedValue: 3,
    });
    const r = gradeCheck(check, { a: V("1", "m") });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("missing_variable");
    expect(r.verdict).toContain("b");
  });

  it("单位与教师声明不符 → unit_mismatch；数值错误 → wrong_number", () => {
    const check = frozenCheck();
    expect(gradeCheck(check, { theta: V("180", "rad") }).reason).toBe("unit_mismatch");
    expect(gradeCheck(check, { theta: V("90", "deg") }).reason).toBe("wrong_number");
  });

  it("一条失败公式不影响其他独立检查，整体仅在全部通过时通过", () => {
    const ok = frozenCheck({ checkId: "ok" });
    const bad = frozenCheck({
      checkId: "bad", latex: "x/y",
      variables: { x: { unit: "m" }, y: { unit: "s" } },
      targetUnit: "", requireNumber: false,
    });
    const { results, passed } = gradeAttempt([ok, bad], {
      ok: { theta: V("180", "deg") },
      bad: { x: V("1", "m"), y: V("0", "s") },
    });
    expect(passed).toBe(false);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[1].reason).toBe("engine_error");
  });

  it("目标单位换算失败（量纲不兼容）→ target_conversion_failed", () => {
    const check = frozenCheck({ latex: "x", variables: { x: { unit: "m" } }, targetUnit: "kg", expectedValue: 1 });
    const r = gradeCheck(check, { x: V("1", "m") });
    expect(r.reason).toBe("target_conversion_failed");
  });
});

describe("提交冻结与中断恢复（纯函数部分）", () => {
  it("冻结时写入完整证据：公式/变量/结果/量纲问题/任务版本，并给出状态", () => {
    const check = frozenCheck();
    const attempt = makeAttempt([check], { c1: { theta: V("180", "deg") } });
    const frozen = freezeSubmission(attempt, 2000);
    expect(frozen.status).toBe("passed");
    expect(frozen.submittedAt).toBe(2000);
    expect(frozen.submitting).toBe(false);
    expect(frozen.results).toHaveLength(1);
    expect(frozen.results[0].submittedVariables.theta).toEqual(V("180", "deg"));
    expect(frozen.frozenChecks[0]).toEqual(check);
  });

  it("修正后重试是新记录（seq 不同），失败证据不被覆盖", () => {
    const check = frozenCheck();
    const fail = freezeSubmission(makeAttempt([check], { c1: { theta: V("90", "deg") } }, 1), 2000);
    expect(fail.status).toBe("rejected");
    expect(fail.seq).toBe(1);
    // 新记录复用答案槽位但 seq 递增
    const retryAttempt = makeAttempt([check], { c1: { theta: V("180", "deg") } }, 2);
    retryAttempt.attemptId = "att-2";
    const pass = freezeSubmission(retryAttempt, 3000);
    expect(pass.seq).toBe(2);
    expect(pass.status).toBe("passed");
    // 旧失败记录内容不变
    expect(fail.status).toBe("rejected");
    expect(fail.results[0].reason).toBe("wrong_number");
  });
});

describe("任务包 JSON 与幂等导入", () => {
  it("导出 → 解析往返；学生包不含参考答案", () => {
    const v = publish();
    const file = buildPackageFile([{
      packageId: "pkg-1", code: "TASK", createdAt: 1, updatedAt: 1, draft: null, versions: [v],
    }])!;
    const text = JSON.stringify(file);
    expect(text).not.toContain('"value":"180"');
    const { entries, errors } = parseTaskPackage(text);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].version.contentHash).toBe(v.contentHash);
  });

  it("篡改包内容 → 指纹校验失败，拒绝导入", () => {
    const v = publish();
    const file = buildPackageFile([{
      packageId: "pkg-1", code: "TASK", createdAt: 1, updatedAt: 1, draft: null, versions: [v],
    }])!;
    const tampered = JSON.parse(JSON.stringify(file));
    tampered.packages[0].version.title = "被篡改的标题";
    const { entries, errors } = parseTaskPackage(JSON.stringify(tampered));
    expect(entries).toHaveLength(0);
    expect(errors[0]).toContain("指纹不匹配");
  });

  it("重复导入=duplicate（不产生重复）；同版本号不同内容=conflict（拒绝覆盖）；新版=add", () => {
    const v1 = publish();
    const entry1 = { packageId: "pkg-1", code: "TASK", version: v1 };
    // 首次新增
    expect(planImport([entry1], []).map((d) => d.action)).toEqual(["add"]);
    // 再来一次：重复
    const dup = planImport([entry1], [{ packageId: "pkg-1", version: 1, contentHash: v1.contentHash }]);
    expect(dup[0].action).toBe("duplicate");
    // 同版本号不同指纹：冲突
    const conflict = planImport([entry1], [{ packageId: "pkg-1", version: 1, contentHash: "fnv1a-deadbeef" }]);
    expect(conflict[0].action).toBe("conflict");
    // 新版本：add（不影响 v1 的旧尝试）
    const d2 = draftFromVersion(v1);
    d2.revisionNote = "改";
    d2.checks[0].expectedValue = 3.14;
    d2.checks[0].variables.theta = { value: "180", unit: "deg" };
    const v2 = freezeDraft("pkg-1", d2, [v1]).version!;
    const addV2 = planImport(
      [{ packageId: "pkg-1", code: "TASK", version: v2 }],
      [{ packageId: "pkg-1", version: 1, contentHash: v1.contentHash }],
    );
    expect(addV2[0].action).toBe("add");
  });

  it("旧版尝试按旧规则展示：frozenChecks 保留在证据里，与新版互不影响", () => {
    const v1 = publish();
    const oldCheck = v1.checks[0];
    // 学生在 v1 上的通过快照
    const snapshot = freezeSubmission(makeAttempt([oldCheck], { c1: { theta: V("180", "deg") } }, 1));
    expect(snapshot.status).toBe("passed");
    // 教师发布 v2（目标单位换成 deg，期望值 180）
    const d2 = draftFromVersion(v1);
    d2.checks[0].targetUnit = "deg";
    d2.checks[0].expectedValue = 180;
    d2.checks[0].variables.theta = { value: "180", unit: "deg" };
    const v2 = freezeDraft("pkg-1", d2, [v1]).version!;
    // 旧证据里冻结的仍是 v1 规则（rad / π），重放仍通过
    const replay = replayAttempt(snapshot.frozenChecks, snapshot.results);
    expect(replay.replayable).toBe(true);
    expect(snapshot.contentHash).not.toBe(v2.contentHash);
  });

  it("非法文件与非任务包文件被拒绝", () => {
    expect(parseTaskPackage("not json").errors[0]).toContain("JSON");
    expect(parseTaskPackage(JSON.stringify({ app: "dimension-notebook", version: 1, formulas: [] })).errors[0])
      .toContain("实验任务包");
  });
});
