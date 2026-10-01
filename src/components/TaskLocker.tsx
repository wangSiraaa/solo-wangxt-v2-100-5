// 学生任务柜：导入任务包 → 按版本查看 → 进入作答 → 查看完整尝试历史（含失败证据）。
// 旧版本永远用冻结在尝试里的旧规则展示；新版本必须重新作答。
import { useMemo, useRef, useState } from "react";
import type { Attempt, PublishedVersion, TaskPackage } from "../engine/types";
import { parseTaskPackage, planImport } from "../storage/taskPackage";
import { taskStore } from "../storage/db";
import EvidenceView from "./EvidenceView";

interface Props {
  packages: TaskPackage[];
  attempts: Attempt[];
  onImported: () => void;
  onOpenWork: (pkg: TaskPackage, ver: PublishedVersion) => void;
  notify: (msg: string, ok?: boolean) => void;
}

function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

export default function TaskLocker({ packages, attempts, onImported, onOpenWork, notify }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [evidence, setEvidence] = useState<Attempt | null>(null);

  const attemptsByVer = useMemo(() => {
    const map = new Map<string, Attempt[]>();
    for (const a of attempts) {
      const key = `${a.packageId}:${a.version}`;
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.seq - b.seq);
    return map;
  }, [attempts]);

  const importFile = async (file: File) => {
    const text = await file.text();
    const { entries, errors } = parseTaskPackage(text);
    if (entries.length === 0) {
      notify(errors[0] ?? "文件中没有可导入的任务包", false);
      return;
    }
    const existing = packages.flatMap((p) =>
      p.versions.map((v) => ({ packageId: p.packageId, version: v.version, contentHash: v.contentHash })));
    const decisions = planImport(entries, existing);
    const adds = decisions.filter((d) => d.action === "add");
    const dups = decisions.filter((d) => d.action === "duplicate");
    const conflicts = decisions.filter((d) => d.action === "conflict");
    if (adds.length > 0) {
      await taskStore.importEntries(adds.map((d) => (d.action === "add" ? { entry: d.entry } : null!)).filter(Boolean));
      onImported();
    }
    const msgs: string[] = [];
    if (adds.length) msgs.push(`新导入 ${adds.length} 个任务版本`);
    if (dups.length) msgs.push(`${dups.length} 个为重复导入，已忽略（幂等）`);
    if (conflicts.length) msgs.push(`${conflicts.length} 个同版本号内容冲突，已拒绝`);
    notify([...msgs, ...errors].join("；") || "没有需要导入的新内容", conflicts.length === 0);
  };

  if (evidence) {
    return (
      <div className="locker-evidence">
        <button type="button" onClick={() => setEvidence(null)} data-testid="back-locker">← 返回任务柜</button>
        <EvidenceView attempt={evidence} />
      </div>
    );
  }

  return (
    <div className="locker">
      <div className="studio-actions">
        <button type="button" className="primary" onClick={() => fileRef.current?.click()} data-testid="import-package-btn">
          导入任务包 JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          data-testid="import-package"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
        <span className="muted small">重复导入同一包会被忽略；新版会作为新版本出现，不覆盖旧版与旧尝试</span>
      </div>

      {packages.length === 0 ? (
        <div className="empty-state">
          <p>还没有任务。请先在「教师工作室」发布并导出任务包，再在这里导入。</p>
        </div>
      ) : (
        packages.map((pkg) => (
          <PackageBlock
            key={pkg.packageId}
            pkg={pkg}
            attemptsByVer={attemptsByVer}
            onOpenWork={onOpenWork}
            onEvidence={setEvidence}
          />
        ))
      )}
    </div>
  );
}

function PackageBlock({
  pkg, attemptsByVer, onOpenWork, onEvidence,
}: {
  pkg: TaskPackage;
  attemptsByVer: Map<string, Attempt[]>;
  onOpenWork: (pkg: TaskPackage, ver: PublishedVersion) => void;
  onEvidence: (a: Attempt) => void;
}) {
  const versions = [...pkg.versions].reverse();
  return (
    <section className="card status-ok pkg-block" data-testid="pkg-block">
      <header className="card-head">
        <strong>{pkg.versions[pkg.versions.length - 1]?.title ?? pkg.code}</strong>
        <span className="muted small">{pkg.code} · packageId <code title={pkg.packageId}>{shortHash(pkg.packageId)}</code></span>
        <span className="badge empty">共 {pkg.versions.length} 个版本</span>
      </header>
      <div className="card-body">
        {versions.map((ver) => {
          const list = attemptsByVer.get(`${pkg.packageId}:${ver.version}`) ?? [];
          const passed = list.some((a) => a.status === "passed");
          const inProgress = list.find((a) => a.status === "in_progress");
          const isLatest = ver.version === pkg.versions[pkg.versions.length - 1].version;
          return (
            <div key={ver.version} className={`version-block ${isLatest ? "latest" : "old"}`} data-testid="version-block">
              <div className="version-block-head">
                <span className={`badge ${passed ? "ok" : inProgress ? "warn" : "empty"}`}>
                  {passed ? "已通过" : inProgress ? "作答中" : "未通过 / 未作答"}
                </span>
                <strong>v{ver.version}</strong>
                {isLatest ? <em className="muted small">最新版</em> : <em className="muted small">历史版本 · 旧尝试按此版规则展示</em>}
                {ver.revisionNote && <em className="muted small">修订：{ver.revisionNote}</em>}
                <code className="muted small" title={ver.contentHash}>{shortHash(ver.contentHash)}</code>
                <button
                  type="button"
                  className={isLatest ? "primary" : ""}
                  onClick={() => onOpenWork(pkg, ver)}
                  data-testid={`open-v${ver.version}`}
                >
                  {inProgress ? "继续作答" : passed ? "查看 / 再次作答" : list.length ? "查看诊断 / 再次作答" : "开始作答"}
                </button>
              </div>

              <div className="check-prompts muted small">
                {ver.checks.map((c) => (
                  <span key={c.checkId} className="check-chip">· {c.prompt || c.latex}</span>
                ))}
              </div>

              {list.length > 0 && (
                <ol className="attempt-history" data-testid="attempt-history">
                  {list.map((a) => (
                    <li key={a.attemptId}>
                      <button type="button" className="mini-btn" onClick={() => onEvidence(a)} data-testid="open-attempt">
                        第 {a.seq} 次：
                        <span className={a.status === "passed" ? "ok-text" : a.status === "rejected" ? "err-text" : "muted"}>
                          {a.status === "passed" ? "通过" : a.status === "rejected" ? "拒绝" : "进行中"}
                        </span>
                        （{a.submittedAt ? new Date(a.submittedAt).toLocaleString("zh-CN", { hour12: false }) : "未提交"}）
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
