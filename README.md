# 量纲检查笔记本（Dimension Notebook）

面向工程教师的**本地**公式笔记工具：输入公式 → 给变量赋数值与单位 → 自动计算并检查常见量纲错误。
无需服务器，数据只保存在浏览器 IndexedDB 中。

- **React 18 + TypeScript** 组织界面与文档
- **MathLive** 提供所见即所得的数学输入（`+ − × ÷`、幂、分数、括号、希腊字母/下标）
- **KaTeX** 渲染原式与代入后的计算式（问题节点红/橙色高亮）
- **mathjs** 负责表达式解析、单位量纲与常用单位换算
- **IndexedDB** 自动保存，支持 JSON 导出/导入（导出保留可再次编辑的 LaTeX 表达式）
- **实验任务包**：教师发布“草稿/版本化”任务 → 学生离线导入作答 → 每次提交冻结完整证据（公式、变量、结果、量纲问题、任务版本指纹），可重放复核

## 启动

```bash
npm install
npm run dev          # 本地开发（固定端口 5199）
npm run build        # 类型检查 + 生产构建到 dist/
npm test             # 56 个单元测试（引擎 + 任务包 + 导出导入）
node e2e/smoke.mjs   # 25 项公式笔记本端到端检查（需先 npm run dev）
node e2e/tasks.mjs   # 36 项实验任务包端到端检查（需先 npm run dev）
```

> E2E 依赖 Playwright Chromium：`npx playwright install chromium`。
> 若环境无 root 安装系统库（libnspr4/libnss3/atk/gbm…），可把对应 Debian deb 解包到用户目录，
> 再以 `LD_LIBRARY_PATH=/path/to/libs node e2e/tasks.mjs` 运行。

## 首版明确支持的范围

| 类别 | 内容 |
| --- | --- |
| 运算 | 加 `+`、减 `-`、乘（`×`、`·`、隐式乘法）、除 `÷`、幂 `^`、括号、一元正负号、分数 |
| 变量 | 字母、希腊字母（`θ`、`α`…）、下标（`x_1`、`T_{out}`、裸写 `T1` 视为 `T_1`）、常量 `π`/`e` |
| 单位 | 长度、质量、时间、温度（K、degC、degF）、角度（rad、deg、grad）、速度/加速度、力学/能量/功率/压强、频率、面积/体积/容积、常见电学单位及组合单位（如 `m/s^2`、`N*m`、`km/h`） |
| 换算 | 结果可指定目标单位（如 25 degC → K、180 deg → rad、100 km/h → m/s） |

## 检查规则（对应需求）

1. **量纲不兼容的相加/相减**：错误（红色），并定位到具体的 AST 表达式节点，在原式与代入式上高亮，问题列表显示该节点片段。相乘/相除不要求量纲一致。
2. **未定义变量**：明确报“变量 x 未赋值”，**绝不自动取零**；单位无法识别同样报错。
3. **除零**：在除法节点明确报“除数为零”，包括分母是带单位的零（如 `0 m/s`）；零的零次/负次幂也报无定义。不产生 `Infinity/NaN`。
4. **摄氏/华氏温标边界**：degC ↔ K ↔ degF 的**单位换算**正确（25 °C = 298.15 K = 77 °F，带 273.15 偏移）；但对摄氏度读数直接做加减乘除、取负、取幂会标记**未验证（橙色）**——这些运算物理含义有歧义，提示先换算到 K。求温差的正确做法是分别换算到 K 再相减。
5. **角度/弧度边界**：deg、rad、grad 同属角度量纲，`1 rad + 180 deg` 可正确相加；纯数（无量纲）与角度相加报量纲错误；纯数结果允许按角度换算（`pi/2 → 90 deg`）。
6. **超出支持范围**：函数（sin、cos、sqrt…）、取模、阶乘、关系符、±、矩阵/对象等，标记“未验证”而不是强行计算。
7. **公式隔离**：每条公式独立分析、独立持久化，一条公式的任何错误都不会影响其他公式。
8. **三段展示**：原式 → 替换变量后的计算式 → 结果（含结果单位及可选的目标单位换算值）。导出的 JSON 同时保存 LaTeX（可编辑本体）与中缀表达式（便于备份查看）。

## 实验任务包（教师发布 / 学生作答 / 证据冻结）

顶层「实验任务包」模块分两端，全部数据仍只存本地 IndexedDB（v2 新增 `tasks`、`attempts` 两个对象库）。

**教师端（草稿 / 发布 / 版本）**

- 一个任务包含若干条独立“公式检查”：公式 LaTeX、自动推导的必填变量（教师填参考值 + 期望单位）、目标单位、通过条件（数值容差匹配，或仅要求引擎判定 ok）。
- 草稿可反复保存；**发布即冻结**为不可变版本（`version` 递增 + 内容指纹 `contentHash`，FNV-1a）。
- 发布前用教师参考答案完整自检：标准答案过不了（含摄氏未验证、除零等）的任务不允许发布。
- 已发布内容不能原地修改；「派生修订」从旧版本复制新草稿，发布产生新版本，旧版本与旧尝试不受影响。
- 导出 JSON 分发给学生；学生包只含单位提示与通过条件，**不含教师参考变量数值**。

**学生端（导入 / 作答 / 历史 / 证据）**

- 导入按 `packageId + version` **幂等**：重复导入同一包忽略；同版本号但指纹不同判为冲突、拒绝覆盖；更新版本作为新版本出现，不覆盖旧版与旧尝试。
- 每个包版本只有一个进行中槽位（`slotKey`），刷新/重复进入复用，绝不产生重复尝试。
- 提交**两阶段持久化**：先写 `submitting=true` 标志，再冻结完整证据。若两阶段之间刷新，启动时按同一 `attemptId` 原地补完，仍然只有一条记录。
- 修正后再次提交是 `seq` 递增的**新记录**；失败/通过证据都永久保留、不被覆盖。
- 历史版本永远用冻结在尝试里的旧规则（`frozenChecks` + `contentHash` + `gradingEngine`）展示；新版本必须重新作答。

**任务判定（`src/engine/grading.ts`）**——以下情形一律不通过，且逐条检查隔离，一条失败不影响其他独立检查：

| 原因码 | 含义 |
| --- | --- |
| `missing_variable` | 必填变量未赋值（绝不自动取零） |
| `engine_error` | 引擎明确错误：量纲不兼容、除零、语法错误等 |
| `unverified` | 摄氏/华氏读数直接四则、超出支持范围等未验证表达式 |
| `unit_mismatch` | 变量单位与教师声明不一致 |
| `target_conversion_failed` | 声明了目标单位却无法换算（量纲不兼容/单位不可识别） |
| `wrong_number` | 结果值与期望不符（超出容差） |
| `threw` | 求值抛异常（收敛为该检查失败，不波及其他检查） |

**JSON 包格式**：任务包 `format: "dimension-notebook/task-package"`（`packages[].version` 为完整冻结版本，含 `contentHash`，导入时重算指纹防篡改）；证据 `format: "dimension-notebook/attempt-evidence"`（含冻结任务版本、提交变量、逐检查结果与量纲问题、重放报告）。证据视图可一键导出 JSON，并用当前引擎对冻结输入**重放**复核判定一致性。

## 项目结构

```
src/
  engine/
    latex.ts        # MathLive LaTeX → mathjs 中缀表达式（含范围控制）
    math.ts         # 解析/量纲检查/定位/求值/换算，输出结构化 Issue；inspectFormula 结构探查
    units.ts        # 首版常用单位清单（输入提示）
    types.ts        # Formula / AnalysisResult / TaskPackage / Attempt 等类型
    hash.ts         # 规范化 JSON + FNV-1a 内容指纹
    grading.ts      # 任务判定（拒绝原因/检查隔离）与证据重放
    math.test.ts    # 引擎测试（摄氏、角度、除零、定位、隔离…）
    tasks.test.ts   # 任务包/评分/幂等导入/版本/证据冻结测试
  storage/
    db.ts           # IndexedDB 封装（v2：formulas / tasks / attempts + slotKey 事务判重）
    exchange.ts     # 自由笔记 JSON 导出/导入
    taskPackage.ts  # 任务包发布冻结、JSON 格式、指纹校验、幂等导入规划、证据导出
    attempts.ts     # 尝试生命周期：幂等槽位、两阶段提交、崩溃恢复
    exchange.test.ts
  components/
    MathInput.tsx   # MathLive math-field 封装
    Tex.tsx         # KaTeX 渲染
    VariableTable.tsx
    FormulaCard.tsx # 单条公式：输入/赋值/三段展示/问题定位
    CheckEditor.tsx    # 教师：单条检查编辑 + 参考答案自检
    TaskStudio.tsx     # 教师：任务包草稿/发布/版本派生/导出
    TaskLocker.tsx     # 学生：导入/版本列表/尝试历史
    AttemptWorkbench.tsx # 学生：作答、实时预览、提交冻结
    EvidenceView.tsx   # 证据：冻结快照 + 量纲问题 + 重放复核 + 导出
    TasksView.tsx      # 实验任务主视图与状态编排
    UnitSuggestions.tsx
  App.tsx  main.tsx  styles.css
e2e/smoke.mjs       # 公式笔记本 Playwright 冒烟（25 项）
e2e/tasks.mjs       # 实验任务包 Playwright 端到端（36 项，覆盖四项验收）
```
