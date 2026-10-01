// 教师任务工作室：创建/编辑任务包草稿 → 发布不可变版本 → 导出 JSON 给学生。
// 发布后不能原地改内容；修订只能从已发布版本派生新草稿、发布新版本。
import { useEffect, useState } from "react";
import type { PublishedVersion, TaskCheck, TaskPackage } from "../engine/types";
import {
  draftFromVersion, freezeDraft, publishSelfCheck,
  buildPackageFile, downloadJSON,
} from "../storage/taskPackage";
import { hashId } from "../engine/hash";
import CheckEditor from "./CheckEditor";
interface Props {
  packages: TaskPackage[];
  /** 创建一个新包（父级负责持久化），返回新包对象 */
  onCreate: () => TaskPackage;
  /** 同步更新（草稿编辑） */
  onChange: (next: TaskPackage) => void;
  /** 持久化并等待完成（发布等关键操作） */
  onChangeAsync: (next: TaskPackage) => Promise<void>;
  onDelete: (packageId: string) => void;
  notify: (msg: string, ok?: boolean) => void;
}

function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

export default function TaskStudio({ packages, onChange, onChangeAsync, onCreate, onDelete, notify }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(packages[0]?.packageId ?? null);
  const selected = packages.find((p) => p.packageId === selectedId) ?? packages[0] ?? null;

  // 选中项被删除 / 列表变化时回退到第一个包
  useEffect(() => {
    if (selectedId && !packages.some((p) => p.packageId === selectedId)) {
      setSelectedId(packages[0]?.packageId ?? null);
    }
  }, [packages, selectedId]);

  return (
    <div className="studio">
      <div className="studio-actions">
        <button
          type="button"
          className="primary"
          onClick={() => {
            // 同步得到新包并立即选中（父级同时持久化 + 刷新列表，不产生时序竞态）
            const pkg = onCreate();
            setSelectedId(pkg.packageId);
          }}
          data-testid="new-package"
        >
          ＋ 新建任务包
        </button>
        <button
          type="button"
          onClick={() => {
            const file = buildPackageFile(packages);
            if (!file) { notify("还没有已发布的任务包可导出（请先发布）", false); return; }
            downloadJSON(file, `实验任务包_${new Date().toISOString().slice(0, 10)}.json`);
            notify(`已导出 ${file.packages.length} 个任务包（均为最新发布版本）`);
          }}
        >
          导出全部已发布包（JSON）
        </button>
      </div>

      <div className="studio-grid">
        <aside className="pkg-list">
          {packages.length === 0 && <p className="muted small">还没有任务包。</p>}
          {packages.map((p) => {
            const latest = p.versions[p.versions.length - 1];
            return (
              <button
                type="button"
                key={p.packageId}
                className={`pkg-item ${selectedId === p.packageId ? "active" : ""}`}
                onClick={() => setSelectedId(p.packageId)}
              >
                <div className="pkg-item-title">{p.draft?.title || latest?.title || "（未命名）"}</div>
                <div className="muted small">
                  {p.code} · 已发布 {p.versions.length} 版 {p.draft ? "· 有草稿" : ""}
                </div>
              </button>
            );
          })}
        </aside>

        <div className="pkg-detail">
          {!selected ? (
            <div className="empty-state"><p>选择或新建一个任务包。</p></div>
          ) : (
            <PackageEditor
              key={selected.packageId}
              pkg={selected}
              onChange={onChange}
              onChangeAsync={onChangeAsync}
              onDelete={() => { onDelete(selected.packageId); setSelectedId(null); }}
              notify={notify}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PackageEditor({
  pkg, onChange, onChangeAsync, onDelete, notify,
}: {
  pkg: TaskPackage;
  onChange: (next: TaskPackage) => void;
  onChangeAsync: (next: TaskPackage) => Promise<void>;
  onDelete: () => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const [showVersions, setShowVersions] = useState(false);
  const draft = pkg.draft;
  const latest = pkg.versions[pkg.versions.length - 1];

  // 每次发布（版本数增加）后自动展开版本列表，便于确认新版本已冻结
  const versionCount = pkg.versions.length;
  useEffect(() => {
    if (versionCount > 0) setShowVersions(true);
  }, [versionCount]);

  const patchDraft = (patch: Partial<NonNullable<TaskPackage["draft"]>>) => {
    onChange({ ...pkg, draft: { ...(draft ?? emptyDraft()), ...patch }, updatedAt: Date.now() });
  };

  const saveDraft = () => {
    if (!draft) return;
    onChange({ ...pkg, draft, updatedAt: Date.now() });
    notify("草稿已保存（学生看不到草稿，只有发布版可导出）");
  };

  const publish = async () => {
    if (!draft) return;
    const { version, errors } = freezeDraft(pkg.packageId, draft, pkg.versions);
    if (errors.length > 0 || !version) {
      notify(`无法发布：${errors[0]}${errors.length > 1 ? `（等 ${errors.length} 项）` : ""}`, false);
      return;
    }
    const selfCheck = publishSelfCheck(draft);
    if (selfCheck.length > 0) {
      notify(`无法发布：${selfCheck[0]}`, false);
      return;
    }
    const next: TaskPackage = {
      ...pkg,
      versions: [...pkg.versions, version],
      draft: null,
      updatedAt: Date.now(),
    };
    // 等待持久化完成后再刷新，避免“刚发布立刻导出/新建”读到旧列表
    await onChangeAsync(next);
    notify(`已发布 v${version.version}（内容指纹 ${shortHash(version.contentHash)}），该版本已冻结不可修改`);
  };

  const revise = async (v: PublishedVersion) => {
    await onChangeAsync({ ...pkg, draft: draftFromVersion(v), updatedAt: Date.now() });
    notify(`已从 v${v.version} 派生新草稿；发布后将成为 v${v.version + 1}，旧版与旧尝试不受影响`);
  };

  const exportOne = () => {
    const file = buildPackageFile([pkg]);
    if (!file) { notify("该包还没有发布版本", false); return; }
    downloadJSON(file, `任务包_${pkg.code}_v${latest!.version}.json`);
  };

  return (
    <div className="pkg-editor">
      <div className="pkg-editor-head">
        <h2>{latest?.title || "新任务包"}</h2>
        <div className="muted small">
          {pkg.code} · packageId <code title={pkg.packageId}>{shortHash(pkg.packageId)}</code>
          {latest && <> · 最新 v{latest.version} · 指纹 <code title={latest.contentHash}>{shortHash(latest.contentHash)}</code></>}
        </div>
        <div className="row-actions">
          <button type="button" className="mini-btn" onClick={exportOne}>导出此包 JSON</button>
          <button type="button" className="mini-btn danger" onClick={onDelete}>删除整个任务包</button>
        </div>
      </div>

      {draft ? (
        <>
          <div className="draft-meta">
            <label className="field-label">任务标题
              <input value={draft.title} onChange={(e) => patchDraft({ title: e.target.value })} data-testid="draft-title" placeholder="例如：角度换算实验" />
            </label>
            <label className="field-label">任务说明（学生可见）
              <input value={draft.description} onChange={(e) => patchDraft({ description: e.target.value })} placeholder="实验目的与要求…" />
            </label>
            <label className="field-label">本版修订说明
              <input value={draft.revisionNote} onChange={(e) => patchDraft({ revisionNote: e.target.value })} placeholder={pkg.versions.length ? "例如：把目标单位从 rad 改为 deg" : "首次发布"} />
            </label>
          </div>

          <div className="check-list">
            {draft.checks.map((c, i) => (
              <CheckEditor
                key={c.checkId}
                index={i}
                check={c}
                onChange={(patch) => {
                  const checks = draft.checks.map((x, j) => (j === i ? { ...x, ...patch } : x));
                  patchDraft({ checks });
                }}
                onRemove={() => patchDraft({ checks: draft.checks.filter((_, j) => j !== i) })}
              />
            ))}
          </div>

          <div className="publish-bar">
            <button
              type="button"
              onClick={() => patchDraft({ checks: [...draft.checks, makeCheck()] })}
              data-testid="add-check"
            >
              ＋ 添加公式检查
            </button>
            <span className="sep" />
            <button type="button" onClick={saveDraft}>保存草稿</button>
            <button type="button" className="primary" onClick={() => void publish()} data-testid="publish-btn">
              检查并发布为 v{pkg.versions.length + 1}
            </button>
          </div>
        </>
      ) : (
        <div className="no-draft">
          <p>当前没有草稿。已发布内容冻结，不能直接修改。</p>
          {latest && (
            <button type="button" className="primary" onClick={() => void revise(latest)} data-testid="revise-btn">
              从最新版 v{latest.version} 派生修订草稿
            </button>
          )}
        </div>
      )}

      <div className="versions">
        <button type="button" className="ghost" onClick={() => setShowVersions((s) => !s)}>
          {showVersions ? "▾ 隐藏" : "▸ 查看"}已发布版本（{pkg.versions.length}）
        </button>
        {showVersions && pkg.versions.slice().reverse().map((v) => (
          <VersionRow key={v.version} v={v} onRevise={() => revise(v)} />
        ))}
      </div>
    </div>
  );
}

function VersionRow({ v, onRevise }: { v: PublishedVersion; onRevise: () => void }) {
  return (
    <div className="version-row">
      <span className="badge ok">v{v.version}</span>
      <span>{v.title}</span>
      {v.revisionNote && <em className="muted small">“{v.revisionNote}”</em>}
      <span className="muted small">{new Date(v.publishedAt).toLocaleString("zh-CN", { hour12: false })}</span>
      <code className="muted small" title={v.contentHash}>{shortHash(v.contentHash)}</code>
      <span className="muted small">{v.checks.length} 条检查</span>
      <button type="button" className="mini-btn" onClick={onRevise}>派生修订</button>
    </div>
  );
}

export function emptyDraft(): NonNullable<TaskPackage["draft"]> {
  return { title: "", description: "", revisionNote: "", checks: [makeCheck()] };
}

export function makeCheck(): TaskCheck {
  return {
    checkId: hashId("chk"),
    prompt: "",
    latex: "",
    variables: {},
    targetUnit: "",
    requireNumber: true,
    expectedValue: undefined,
  };
}
