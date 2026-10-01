// “实验任务”主视图：加载任务包与尝试 → 启动时恢复提交途中的尝试 → 教师/学生两端。
import { useCallback, useEffect, useState } from "react";
import type { Attempt, PublishedVersion, TaskPackage } from "../engine/types";
import { attemptStore, taskStore } from "../storage/db";
import { recoverInterrupted, resumeOrCreateInProgress } from "../storage/attempts";
import { GRADING_ENGINE } from "../engine/grading";
import { hashId } from "../engine/hash";
import TaskStudio, { makeCheck } from "./TaskStudio";
import TaskLocker from "./TaskLocker";
import AttemptWorkbench from "./AttemptWorkbench";

interface WorkSession {
  packageId: string;
  version: number;
  attemptId: string;
}

export default function TasksView({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const [role, setRole] = useState<"student" | "teacher">("student");
  const [packages, setPackages] = useState<TaskPackage[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState<WorkSession | null>(null);

  const refresh = useCallback(async () => {
    const [pkgs, atts] = await Promise.all([taskStore.allPackages(), attemptStore.all()]);
    setPackages(pkgs.sort((a, b) => a.updatedAt - b.updatedAt));
    setAttempts(atts.sort((a, b) => a.startedAt - b.startedAt));
    return atts;
  }, []);

  // 初次加载，然后恢复所有“提交途中”尝试（刷新中断 → 原地补完，不产生重复）
  useEffect(() => {
    (async () => {
      const atts = await refresh();
      const recovered = await recoverInterrupted(atts);
      if (recovered.length > 0) {
        notify(`检测到 ${recovered.length} 条提交途中刷新的尝试，已按同一记录原地补完（无重复尝试）`);
        await refresh();
      }
      setLoaded(true);
    })().catch((e) => notify(`读取本地任务数据失败：${(e as Error).message}`, false));
  }, [refresh, notify]);

  const currentAttempt = session
    ? attempts.find((a) => a.attemptId === session.attemptId) ?? null
    : null;

  const openWork = useCallback(async (pkg: TaskPackage, ver: PublishedVersion) => {
    // 优先复用该版本唯一的进行中槽位（getOrCreate 在 IndexedDB 事务内判重）
    const { attempt } = await resumeOrCreateInProgress(pkg, ver, attempts);
    await refresh();
    setSession({ packageId: pkg.packageId, version: ver.version, attemptId: attempt.attemptId });
  }, [attempts, refresh]);

  // 已提交后“再次作答”：新建下一条记录（seq 递增），失败/通过证据都保留
  const retry = useCallback(async () => {
    if (!session) return;
    const pkg = packages.find((p) => p.packageId === session.packageId);
    const ver = pkg?.versions.find((v) => v.version === session.version);
    if (!pkg || !ver) return;
    const now = Date.now();
    const seq = attempts.filter((a) => a.packageId === pkg.packageId && a.version === ver.version).length + 1;
    const fresh: Attempt = {
      attemptId: hashId("att"),
      slotKey: `slot:${pkg.packageId}:v${ver.version}`,
      packageId: pkg.packageId,
      code: pkg.code,
      version: ver.version,
      contentHash: ver.contentHash,
      status: "in_progress",
      seq,
      startedAt: now,
      submittedAt: null,
      submitting: false,
      // 修正场景：带上一次提交的答案作为初值，方便学生改错（证据仍是独立的新记录）
      answers: session.attemptId
        ? (attempts.find((a) => a.attemptId === session.attemptId)?.answers ?? {})
        : {},
      taskTitle: ver.title,
      frozenChecks: ver.checks,
      gradingEngine: GRADING_ENGINE,
      results: [],
    };
    await attemptStore.put(fresh);
    await refresh();
    setSession({ packageId: pkg.packageId, version: ver.version, attemptId: fresh.attemptId });
  }, [session, packages, attempts, refresh]);

  // 同步创建本地新包（立即返回供选中），再异步持久化。
  // 注意：不在这里 refresh()——异步读可能早于 put 落库，用旧列表覆盖刚加入的新包。
  const createPackage = useCallback((): TaskPackage => {
    const pkg: TaskPackage = {
      packageId: hashId("pkg"),
      code: `TASK-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      draft: { title: "", description: "", revisionNote: "", checks: [makeCheck()] },
      versions: [],
    };
    setPackages((ps) => [...ps, pkg]);
    setRole("teacher");
    void taskStore.putPackage(pkg).catch((e) =>
      notify(`保存任务包失败：${(e as Error).message}`, false));
    notify("已创建任务包草稿");
    return pkg;
  }, [notify]);

  // 先以函数式更新合并到最新本地状态（避免覆盖期间的其他编辑），再后台持久化
  const savePackage = useCallback((next: TaskPackage) => {
    setPackages((ps) => {
      const exists = ps.some((p) => p.packageId === next.packageId);
      return exists ? ps.map((p) => (p.packageId === next.packageId ? next : p)) : [...ps, next];
    });
    return taskStore.putPackage(next);
  }, []);

  const deletePackage = useCallback(async (packageId: string) => {
    await taskStore.deletePackage(packageId);
    await refresh();
  }, [refresh]);

  if (!loaded) return <p className="muted">正在加载实验任务…</p>;

  return (
    <div className="tasks-view">
      <div className="role-tabs">
        <button
          type="button"
          className={role === "student" ? "tab active" : "tab"}
          onClick={() => { setRole("student"); setSession(null); }}
          data-testid="tab-student"
        >
          学生：任务 / 作答 / 证据
        </button>
        <button
          type="button"
          className={role === "teacher" ? "tab active" : "tab"}
          onClick={() => { setRole("teacher"); setSession(null); }}
          data-testid="tab-teacher"
        >
          教师：草稿 / 发布 / 版本
        </button>
      </div>

      {role === "teacher" && (
        <TaskStudio
          packages={packages}
          onChange={(p) => void savePackage(p)}
          onChangeAsync={(p) => savePackage(p)}
          onCreate={() => createPackage()}
          onDelete={(id) => void deletePackage(id)}
          notify={notify}
        />
      )}

      {role === "student" && !currentAttempt && (
        <TaskLocker
          packages={packages}
          attempts={attempts}
          onImported={() => void refresh()}
          onOpenWork={(pkg, ver) => void openWork(pkg, ver)}
          notify={notify}
        />
      )}

      {role === "student" && currentAttempt && (
        <AttemptWorkbench
          attempt={currentAttempt}
          onChanged={async (next) => {
            await refresh();
            // 提交后保持在当前记录视图（看冻结证据）
            setSession({ packageId: next.packageId, version: next.version, attemptId: next.attemptId });
          }}
          onRetry={() => void retry()}
          onClose={() => setSession(null)}
        />
      )}
    </div>
  );
}
