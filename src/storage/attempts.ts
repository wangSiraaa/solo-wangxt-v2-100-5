// 学生尝试生命周期服务：
//  - 每个任务版本只有一个进行中槽位（slotKey），刷新/重复进入复用，绝不制造重复尝试；
//  - 提交分两阶段持久化：先写 submitting=true 标志，再冻结完整证据；
//    若两阶段之间刷新/崩溃，启动时按同一 attemptId 原地补完，仍然只有一条记录；
//  - 修正后再次提交 = 新建下一条记录（seq 递增），失败证据永久保留、不被覆盖。

import { gradeAttempt, GRADING_ENGINE } from "../engine/grading";
import { hashId } from "../engine/hash";
import type {
  Attempt, FrozenCheckResult, PublishedVersion, TaskPackage, VariableDef,
} from "../engine/types";
import { attemptStore } from "./db";

/** 一个学生（本浏览器即一个学生）在一个包版本上的进行中尝试槽位 */
export const slotKey = (packageId: string, version: number): string =>
  `slot:${packageId}:v${version}`;

/** 同一槽位下下一条尝试的序号 */
export function nextSeq(packageAttempts: Attempt[], packageId: string, version: number): number {
  const same = packageAttempts.filter((a) => a.packageId === packageId && a.version === version);
  return same.length === 0 ? 1 : Math.max(...same.map((a) => a.seq)) + 1;
}

/** 取回复用进行中尝试；没有则创建（IndexedDB 事务内判重） */
export async function resumeOrCreateInProgress(
  pkg: TaskPackage,
  ver: PublishedVersion,
  allAttempts: Attempt[],
): Promise<{ attempt: Attempt; created: boolean }> {
  const key = slotKey(pkg.packageId, ver.version);
  return attemptStore.getOrCreateInProgress(key, () => {
    const now = Date.now();
    return {
      attemptId: hashId("att"),
      slotKey: key,
      packageId: pkg.packageId,
      code: pkg.code,
      version: ver.version,
      contentHash: ver.contentHash,
      status: "in_progress",
      seq: nextSeq(allAttempts, pkg.packageId, ver.version),
      startedAt: now,
      submittedAt: null,
      submitting: false,
      answers: {},
      taskTitle: ver.title,
      frozenChecks: ver.checks,
      gradingEngine: GRADING_ENGINE,
      results: [],
    };
  });
}

export async function saveAnswers(
  attempt: Attempt,
  checkId: string,
  variables: Record<string, VariableDef>,
): Promise<Attempt> {
  const updated: Attempt = { ...attempt, answers: { ...attempt.answers, [checkId]: variables } };
  await attemptStore.put(updated);
  return updated;
}

/**
 * 纯函数：把一次提交冻结成最终证据（不触碰存储，便于单测）。
 * 冻结内容：任务版本检查项、学生变量、引擎结果、量纲问题、通过判定、版本指纹。
 */
export function freezeSubmission(attempt: Attempt, now: number = Date.now()): Attempt {
  const { results, passed } = gradeAttempt(attempt.frozenChecks, attempt.answers);
  const frozenResults: FrozenCheckResult[] = results.map((r) => ({
    ...r,
    // 深拷贝 issues / variables，保证证据对象不可被后续编辑影响
    issues: r.issues.map((i) => ({ ...i })),
    submittedVariables: Object.fromEntries(
      Object.entries(r.submittedVariables).map(([k, v]) => [k, { ...v }]),
    ),
  }));
  return {
    ...attempt,
    status: passed ? "passed" : "rejected",
    submitting: false,
    submittedAt: now,
    results: frozenResults,
  };
}

/** 测试钩子：模拟“证据写入前刷新/崩溃”（e2e 通过 window.__CRASH_HOOK 注入） */
declare global {
  interface Window {
    __CRASH_HOOK__?: "crashAfterSubmitFlag";
  }
}

/**
 * 提交：阶段一写 submitting 标志 → （崩溃窗口）→ 阶段二冻结结果。
 * 返回最终尝试；调用方在阶段一之后刷新页面，启动恢复会原地补完同一条记录。
 */
export async function submitAttempt(attempt: Attempt): Promise<Attempt> {
  const flagged: Attempt = { ...attempt, submitting: true };
  await attemptStore.put(flagged);

  if (typeof window !== "undefined" && window.__CRASH_HOOK__ === "crashAfterSubmitFlag") {
    // 模拟刷新：这里直接抛错，记录已以 submitting=true 落库
    throw new Error("模拟提交途中刷新（证据尚未写入）");
  }

  const done = freezeSubmission(flagged);
  await attemptStore.put(done);
  return done;
}

/**
 * 启动/进入时恢复所有“提交途中”的尝试：用冻结在记录里的任务版本与答案原地补完。
 * 关键：记录 id 不变、seq 不变，因此刷新绝不会制造重复尝试。
 */
export async function recoverInterrupted(allAttempts: Attempt[]): Promise<Attempt[]> {
  const pending = allAttempts.filter((a) => a.status === "in_progress" && a.submitting);
  if (pending.length === 0) return [];
  const recovered: Attempt[] = [];
  for (const a of pending) {
    const done = freezeSubmission(a);
    await attemptStore.put(done);
    recovered.push(done);
  }
  return recovered;
}
