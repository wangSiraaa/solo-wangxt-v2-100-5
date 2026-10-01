// 端到端：实验任务包全流程（真实 UI + 真实 JSON 文件通道）
// 验收：
//  1) 学生完成角度换算发布任务 → 可重放的通过快照；
//  2) 摄氏读数直接相加（未验证）与除零（错误）的尝试被明确拒绝并保留诊断；
//  3) 教师发布修订版后，旧版已提交尝试按旧规则展示，新版须重新作答；
//  4) 重复导入同一包 / 提交途中刷新不制造重复尝试；修正后重试新增记录且不覆盖失败证据。
import { chromium } from "playwright";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = "http://localhost:5199/";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const teacherCtx = await browser.newContext({ acceptDownloads: true });
const studentCtx = await browser.newContext({ acceptDownloads: true });
const teacher = await teacherCtx.newPage();
const student = await studentCtx.newPage();
const consoleErrors = [];
student.on("pageerror", (e) => consoleErrors.push(String(e)));
student.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

const tmp = mkdtempSync(join(tmpdir(), "taskpkg-"));

// ============ 教师端：发布任务 A 与任务 B ============
await teacher.goto(URL, { waitUntil: "networkidle" });
await teacher.getByTestId("tab-tasks").click();
await teacher.getByTestId("tab-teacher").click();

async function setMathField(page, card, tex) {
  await card.locator("math-field").first().evaluate((el, v) => {
    el.setValue(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, tex);
}

async function fillCheck(page, card, spec) {
  await card.locator(".prompt-input").fill(spec.prompt);
  await setMathField(page, card, spec.latex);
  await page.waitForTimeout(120);
  const rows = card.locator(".ref-vars .var-row:not(.var-head)");
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const [val, unit] = spec.refVars[i];
    const inputs = rows.nth(i).locator("input");
    if (val !== null) await inputs.nth(0).fill(val);
    if (unit !== null) await inputs.nth(1).fill(unit);
  }
  if (spec.targetUnit !== undefined) await card.getByTestId("target-unit-input").fill(spec.targetUnit);
  if (spec.requireNumber === false) {
    const cb = card.locator(".inline-check input.cb");
    if (await cb.isChecked()) await cb.uncheck();
  } else if (spec.expected !== undefined) {
    await card.getByTestId("expected-value-input").fill(String(spec.expected));
  }
}

// 任务 A：角度换算 180 deg → π rad
await teacher.getByTestId("new-package").click();
await teacher.getByTestId("draft-title").fill("角度换算实验");
let card = teacher.locator(".check-edit").first();
await fillCheck(teacher, card, {
  prompt: "把 180 度换算为弧度",
  latex: "\\theta",
  refVars: [["180", "deg"]],
  targetUnit: "rad",
  expected: String(Math.PI),
});
await teacher.waitForTimeout(200);
check("教师 A：参考答案自检通过",
  (await card.locator("[data-testid=self-test] .badge").innerText()).includes("通过"));
await teacher.getByTestId("publish-btn").click();
await teacher.waitForTimeout(250);
check("教师 A：已发布 v1", (await teacher.locator(".version-row .badge").first().innerText()) === "v1");

// 任务 B：温差与速度（有正确做法；学生用摄氏直接相加 / 除零作答时必须被拒绝）
//  b1: T_2 - T_1，正确做法先换算 K（参考 283.15 K - 278.15 K = 5 K，目标 K）
//  b2: d / t，正确做法 100 m / 20 s = 5 m/s（目标 m/s）；学生写 t=0 触发除零
await teacher.getByTestId("new-package").click();
await teacher.getByTestId("draft-title").fill("温度差与速度");
let c1 = teacher.locator(".check-edit").first();
await fillCheck(teacher, c1, {
  prompt: "求温差（先换算到 K 再相减）",
  latex: "T_2-T_1",
  refVars: [["283.15", "K"], ["278.15", "K"]],
  targetUnit: "K",
  expected: "5",
});
await teacher.getByTestId("add-check").click();
await teacher.waitForTimeout(100);
let c2 = teacher.locator(".check-edit").nth(1);
await fillCheck(teacher, c2, {
  prompt: "求速度 d/t（注意除数不能为零）",
  latex: "d/t",
  refVars: [["100", "m"], ["20", "s"]],
  targetUnit: "m/s",
  expected: "5",
});
await teacher.waitForTimeout(200);
const selfTests = await teacher.locator(".check-edit [data-testid=self-test] .badge").allInnerTexts();
check("教师 B：两条参考答案自检都通过", selfTests.every((t) => t.includes("通过")), selfTests.join(" | "));
await teacher.getByTestId("publish-btn").click();
await teacher.waitForTimeout(250);

// 导出两个包为真实文件（用“导出全部”，再从文件里拆分）
const allDownload = teacher.waitForEvent("download");
await teacher.getByRole("button", { name: "导出全部已发布包（JSON）" }).click();
const dl = await allDownload;
const allPath = join(tmp, "all.json");
await dl.saveAs(allPath);
const all = JSON.parse(readFileSync(allPath, "utf8"));
check("导出文件是任务包格式且含 2 个包",
  all.format === "dimension-notebook/task-package" && all.packages.length === 2);
const pkgA = all.packages.find((p) => p.version.title === "角度换算实验");
const pkgB = all.packages.find((p) => p.version.title === "温度差与速度");
const fileA = join(tmp, "a.json");
const fileB = join(tmp, "b.json");
writeFileSync(fileA, JSON.stringify({ ...all, packages: [pkgA] }));
writeFileSync(fileB, JSON.stringify({ ...all, packages: [pkgB] }));
// 学生包变量表中只有单位提示，不含教师参考变量数值（value 键不应出现在 variables 内）
const strippedVarsOk = [pkgA, pkgB].every((p) =>
  p.version.checks.every((c) => Object.values(c.variables).every((s) => !("value" in s))));
check("学生包中不含教师参考变量数值（仅下发单位提示）", strippedVarsOk);

// ============ 学生端：干净上下文导入 ============
await student.goto(URL, { waitUntil: "networkidle" });
await student.getByTestId("tab-tasks").click();
await student.getByTestId("tab-student").click();

async function importFile(page, path) {
  await page.getByTestId("import-package").setInputFiles(path);
  await page.waitForTimeout(300);
}

await importFile(student, fileA);
await importFile(student, fileB);
check("学生：导入后任务柜有 2 个任务包",
  await student.getByTestId("pkg-block").count() === 2);

// ---- 验收 4a：重复导入同一包幂等，不制造重复 ----
await importFile(student, fileA);
const dupNotice = await student.locator(".notice").innerText();
check("重复导入同一包被忽略（幂等）", dupNotice.includes("重复导入"), dupNotice);
const blocksAfterDup = await student.getByTestId("pkg-block").count();
check("重复导入后仍只有 2 个任务包", blocksAfterDup === 2, `${blocksAfterDup}`);

// ============ 验收 1：角度换算 → 可重放通过快照 ============
const blockA = student.locator(".pkg-block", { hasText: "角度换算实验" });
await blockA.getByTestId("open-v1").click();
await student.waitForTimeout(200);
const workA = student.locator(".check-work");
const inA = workA.locator(".var-row:not(.var-head) input");
await inA.nth(0).fill("180");
await inA.nth(1).fill("deg");
await student.waitForTimeout(250);
check("A：作答实时预览已验证",
  (await workA.getByTestId("live-badge").innerText()).includes("已验证"));
await student.getByTestId("submit-attempt").click();
await student.waitForTimeout(400);
const evA = student.locator(".evidence");
await evA.waitFor();
check("验收1：提交后证据为通过", (await evA.locator(".evidence-head .badge").innerText()).includes("通过"));
check("验收1：证据可重放（当前引擎重算一致）",
  (await student.getByTestId("replay-banner").innerText()).includes("可重放"));
const evAText = await evA.innerText();
check("验收1：证据冻结公式/变量(180 deg)/目标单位(rad)/结果(≈π)",
  evAText.includes("180") && evAText.includes("deg") && /rad/.test(evAText) && /3\.14159/.test(evAText));
check("验收1：证据含版本指纹与评分规则标识",
  evAText.includes("fnv1a") && evAText.includes("grading-1.0.0"));

// ============ 验收 2：摄氏直接相加（未验证）+ 除零（错误）被拒绝 ============
await student.getByRole("button", { name: "返回版本列表" }).click();
const blockB = student.locator(".pkg-block", { hasText: "温度差与速度" });
await blockB.getByTestId("open-v1").click();
await student.waitForTimeout(200);
const works = student.locator(".check-work");
// b1 错误做法：T_2 - T_1 直接用摄氏度读数（30 degC − 25 degC）→ 未验证
const w1 = works.nth(0);
const i1 = w1.locator(".var-row:not(.var-head) input");
await i1.nth(0).fill("30"); await i1.nth(1).fill("degC");
await i1.nth(2).fill("25"); await i1.nth(3).fill("degC");
// b2 错误做法：100 m / 0 s → 除零
const w2 = works.nth(1);
const i2 = w2.locator(".var-row:not(.var-head) input");
await i2.nth(0).fill("100"); await i2.nth(1).fill("m");
await i2.nth(2).fill("0"); await i2.nth(3).fill("s");
await student.waitForTimeout(300);
const liveBadges = await student.locator("[data-testid=live-badge]").allInnerTexts();
check("验收2：两条检查预览都不显示通过",
  liveBadges.every((b) => !b.includes("已验证")), liveBadges.join(" | "));
await student.getByTestId("submit-attempt").click();
await student.waitForTimeout(400);
const evB = student.locator(".evidence");
check("验收2：整体证据明确拒绝",
  (await evB.locator(".evidence-head .badge").innerText()).includes("拒绝"));
const evBText = await evB.innerText();
check("验收2：摄氏读数直接相减被标记为未验证（不得通过）", evBText.includes("偏移温标"));
check("验收2：除零被明确报错（除数为零），不产生结果值", evBText.includes("除数为零"));
const verdicts = await evB.locator("[data-testid=check-verdict]").allInnerTexts();
check("验收2：两条检查各自独立给出拒绝原因（unverified / engine_error）",
  verdicts.some((v) => v.includes("未验证项")) && verdicts.some((v) => v.includes("引擎报告")));

// ============ 验收 4b：修正后重试新增可追溯记录，失败证据不被覆盖 ============
await student.getByTestId("retry-attempt").click();
await student.waitForTimeout(300);
// 新尝试预填了上次答案；只修正 b2（0 s → 20 s），b1 仍是摄氏直接相减 → 整体仍拒绝
const worksR = student.locator(".check-work");
await worksR.nth(1).locator(".var-row:not(.var-head) input").nth(2).fill("20");
await student.waitForTimeout(300);
const badgeB2AfterFix = await worksR.nth(1).getByTestId("live-badge").innerText();
check("修正 b2 后，除零检查实时变为已验证（=5 m/s）", badgeB2AfterFix.includes("已验证"), badgeB2AfterFix);
const badgeB1AfterFix = await worksR.nth(0).getByTestId("live-badge").innerText();
check("b1 仍为未验证（摄氏读数直接相减）", badgeB1AfterFix.includes("未验证"), badgeB1AfterFix);
await student.getByTestId("submit-attempt").click();
await student.waitForTimeout(400);
await student.getByRole("button", { name: "返回版本列表" }).click();
await student.waitForTimeout(200);
const histB = blockB.locator("[data-testid=attempt-history] li");
check("验收4：重试新增第 2 条记录（不覆盖第 1 次失败）", await histB.count() === 2, `${await histB.count()}`);
const histBText = await histB.allInnerTexts();
check("验收4：第 1 次与第 2 次都保留在历史中且都为拒绝",
  histBText[0].includes("第 1 次") && histBText[0].includes("拒绝") &&
  histBText[1].includes("第 2 次") && histBText[1].includes("拒绝"),
  histBText.join(" / "));
// 打开第 1 次证据：旧的除零诊断仍在（第 2 次已修 b2）
await histB.nth(0).getByTestId("open-attempt").click();
await student.locator(".evidence").waitFor();
await student.waitForTimeout(200);
const oldDiag = await student.locator(".evidence").innerText();
check("验收4：第 1 次失败证据仍保留“除数为零”诊断（未被修正覆盖）",
  oldDiag.includes("除数为零") && oldDiag.includes("偏移温标"));
await student.getByTestId("back-locker").click();

// 再修正 b1（换算成 K），第 3 次提交通过，验证可追溯到成功
// 变量行顺序按公式 T_2-T_1 推导：第一行 T_2=303.15 K，第二行 T_1=298.15 K（差为 +5 K）
await blockB.getByTestId("version-block").getByRole("button", { name: /再次作答/ }).last().click();
await student.waitForTimeout(300);
const works3 = student.locator(".check-work");
// b1：换算到 K（变量行顺序 T_2、T_1）
const k1 = works3.nth(0).locator(".var-row:not(.var-head) input");
await k1.nth(0).fill("303.15"); await k1.nth(1).fill("K");
await k1.nth(2).fill("298.15"); await k1.nth(3).fill("K");
// b2：显式确保 d=100 m、t=20 s（不依赖重试预填）
const k2 = works3.nth(1).locator(".var-row:not(.var-head) input");
await k2.nth(0).fill("100"); await k2.nth(1).fill("m");
await k2.nth(2).fill("20"); await k2.nth(3).fill("s");
await student.waitForTimeout(400);
await student.getByTestId("submit-attempt").click();
await student.waitForTimeout(400);
const thirdHead = await student.locator(".evidence .evidence-head .badge").innerText();
if (!thirdHead.includes("通过")) {
  console.log("第3次判定：", await student.locator("[data-testid=check-verdict]").allInnerTexts());
  console.log("第3次冻结变量：", await student.locator(".frozen-var").allInnerTexts());
}
check("修正全部错误后第 3 次尝试通过（=5 K 与 =5 m/s）", thirdHead.includes("通过"));
await student.getByRole("button", { name: "返回版本列表" }).click();
await student.waitForTimeout(200);
check("B 共保留 3 条可追溯尝试记录", await blockB.locator("[data-testid=attempt-history] li").count() === 3);

// ============ 验收 4c：提交途中刷新 → 原地补完，不产生重复 ============
// 在已通过的 A 上发起一次新作答，置崩溃钩子后提交，再刷新
await blockA.getByTestId("open-v1").click();
// 有进行中尝试 → 工作台；否则 → 最新尝试证据。A 已全部提交，应进入证据视图。
await student.waitForFunction(
  () => !!document.querySelector(".evidence") || !!document.querySelector(".check-work"),
  { timeout: 10000 },
);
await student.waitForTimeout(200);
// 若落在工作台（异常情况下），先补填；否则点“再次作答”进入新作答
if (await student.locator(".check-work").count()) {
  console.log("（A v1 落在工作台）");
} else {
  await student.getByTestId("retry-attempt").click();
  await student.locator(".check-work").waitFor();
}
await student.waitForTimeout(300);
// 新工作台可能没有预填答案，显式填 theta=180 deg
const crashInputs = student.locator(".check-work .var-row:not(.var-head) input");
if (await crashInputs.count()) {
  await crashInputs.nth(0).fill("180");
  await crashInputs.nth(1).fill("deg");
  await student.waitForTimeout(250);
}
// 重试预填了上次 180 deg 的答案，直接提交
await student.evaluate(() => { window.__CRASH_HOOK__ = "crashAfterSubmitFlag"; });
await student.getByTestId("submit-attempt").click();
await student.waitForTimeout(500); // 等待阶段一落库 + 抛错
await student.evaluate(() => { delete window.__CRASH_HOOK__; });
// 刷新前：IndexedDB 里只有 1 条 in_progress(submitting)，没有冻结结果
const midCount = await student.evaluate((id) => new Promise((resolve) => {
  const open = indexedDB.open("dimension-notebook");
  open.onsuccess = () => {
    const db = open.result;
    const t = db.transaction("attempts", "readonly");
    t.objectStore("attempts").getAll().onsuccess = (e) => {
      const atts = e.target.result.filter((a) => a.packageId === id && a.version === 1);
      resolve({ total: atts.length, submitting: atts.filter((a) => a.submitting).length });
    };
  };
}), pkgA.packageId);
check("崩溃窗口内 A v1 有 2 条尝试，其中 1 条 submitting（结果尚未冻结）",
  midCount.total === 2 && midCount.submitting === 1, JSON.stringify(midCount));
// 刷新 → 启动恢复原地补完
await student.reload({ waitUntil: "networkidle" });
await student.waitForTimeout(700);
await student.getByTestId("tab-tasks").click();
const recoverNotice = await student.locator(".notice").innerText().catch(() => "");
check("刷新后提示提交途中尝试已原地补完", recoverNotice.includes("原地补完"), recoverNotice);
const afterCount = await student.evaluate((id) => new Promise((resolve) => {
  const open = indexedDB.open("dimension-notebook");
  open.onsuccess = () => {
    const db = open.result;
    const t = db.transaction("attempts", "readonly");
    t.objectStore("attempts").getAll().onsuccess = (e) => {
      const atts = e.target.result.filter((a) => a.packageId === id && a.version === 1);
      resolve({
        total: atts.length,
        submitting: atts.filter((a) => a.submitting).length,
        passed: atts.filter((a) => a.status === "passed").length,
        distinctIds: new Set(atts.map((a) => a.attemptId)).size,
      });
    };
  };
}), pkgA.packageId);
check("验收4：刷新后无重复尝试（仍 2 条、id 不重复），无 submitting 残留，中断那条已补完为通过",
  afterCount.total === 2 && afterCount.submitting === 0 && afterCount.passed === 2 &&
  afterCount.distinctIds === 2,
  JSON.stringify(afterCount));

// ============ 验收 3：教师发布修订版 v2，旧尝试按旧规则展示，新版须重新作答 ============
await teacher.getByTestId("tab-teacher").click();
await teacher.locator(".pkg-item", { hasText: "角度换算实验" }).click();
await teacher.getByTestId("revise-btn").click();
await teacher.waitForTimeout(200);
const cardV2 = teacher.locator(".check-edit").first();
await cardV2.getByTestId("target-unit-input").fill("deg");
await cardV2.getByTestId("expected-value-input").fill("180");
// 派生草稿清空了参考值，重填 theta=180 deg 通过自检
await teacher.waitForTimeout(150);
const refsV2 = cardV2.locator(".ref-vars .var-row:not(.var-head) input");
await refsV2.nth(0).fill("180");
await refsV2.nth(1).fill("deg");
await teacher.waitForTimeout(250);
const selfV2 = await cardV2.locator("[data-testid=self-test] .badge").innerText();
check("教师 A v2：参考答案自检通过（180 deg→180 deg）", selfV2.includes("通过"), selfV2);
await teacher.getByTestId("publish-btn").click();
await teacher.waitForTimeout(250);
check("教师 A：存在 v1、v2 两个已发布版本", await teacher.locator(".version-row").count() === 2);

// 下载只含 A 最新版（v2）的包并导入学生端
const dlV2 = teacher.waitForEvent("download");
await teacher.locator(".pkg-editor").getByRole("button", { name: "导出此包 JSON" }).click();
const d2 = await dlV2;
const v2Path = join(tmp, "a-v2.json");
await d2.saveAs(v2Path);
await importFile(student, v2Path);
const noticeV2 = await student.locator(".notice").innerText();
check("v2 作为新版本导入（不覆盖 v1）", noticeV2.includes("新导入 1"), noticeV2);

const blockA2 = student.locator(".pkg-block", { hasText: "角度换算实验" });
const versionBlocks = blockA2.getByTestId("version-block");
check("验收3：学生端出现 v2（最新）与 v1（历史）", await versionBlocks.count() === 2);
// 版本倒序：nth(0)=v2, nth(1)=v1
const v2Block = versionBlocks.nth(0);
const v1Block = versionBlocks.nth(1);
check("验收3：旧版 v1 仍标记已通过（旧规则展示）",
  (await v1Block.locator(".badge").first().innerText()).includes("已通过"));
check("验收3：新版 v2 须重新作答（显示开始作答/未作答）",
  (await v2Block.locator(".badge").first().innerText()).includes("未作答") ||
  (await v2Block.getByRole("button").innerText()).includes("开始作答"));
// v1 历史尝试证据仍是旧规则 rad / π
await v1Block.locator("[data-testid=attempt-history] li").first().getByTestId("open-attempt").click();
await student.locator(".evidence").waitFor();
await student.waitForTimeout(200);
const oldV1Evidence = await student.locator(".evidence").innerText();
check("验收3：v1 旧证据按旧规则展示（rad、≈3.14159），不受 v2 影响",
  /rad/.test(oldV1Evidence) && /3\.14159/.test(oldV1Evidence) &&
  (await student.getByTestId("replay-banner").innerText()).includes("可重放"));
await student.getByTestId("back-locker").click();
// v2 作答并通过（180 deg → 180 deg）
await v2Block.getByRole("button", { name: /开始作答/ }).click();
await student.waitForTimeout(200);
const wv2 = student.locator(".check-work");
const vi = wv2.locator(".var-row:not(.var-head) input");
await vi.nth(0).fill("180"); await vi.nth(1).fill("deg");
await student.waitForTimeout(300);
await student.getByTestId("submit-attempt").click();
await student.waitForTimeout(400);
const evV2 = await student.locator(".evidence").innerText();
check("验收3：v2 按新规则作答通过（180 deg），证据独立",
  evV2.includes("通过") && /180\s*deg/.test(evV2.replace(/\s+/g, " ")));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length) console.log("学生端控制台错误：", JSON.stringify(consoleErrors.slice(0, 8), null, 1));
await browser.close();
if (failed.length) process.exit(1);
