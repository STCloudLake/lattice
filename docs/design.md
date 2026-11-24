# Lattice — 一个可检查的学习者模型，让学习发生在缝隙里

> 全新设计 v1 · 2026-11-24
> 旧项目 Computhon / "广而告知" 判定为**演示原型，代码零保留**；
> 只继承三条洞察：15 秒剂量、多域环境表面、注意力事件是独有信号。
> 本文是架构与产品设计，不是实现计划；实现计划见 §17。

---

## §0 一句话

**把"学什么、何时学、怎么学"从 LLM 的即兴发挥，变成一份任何人可以读、可以改、可以重算的学习者模型；
再把这份模型接到用户本来就在刷的那些界面上。**

不是又一个 Anki，也不是又一个 AI tutor。是**中间那层没人做的账**。

---

## §1 为什么现在做（问题定义）

三类现有产品各自缺一块：

| 类型 | 代表 | 强 | 缺 |
|---|---|---|---|
| 记忆工具 | Anki / SuperMemo | FSRS 调度、长期留存 | 没有知识结构、没有上下文、全靠手动 |
| AI 教学 | learnharness | 教学法严谨、知识图、provenance | **pull**：你必须坐下来开一个 session |
| 云 tutor | Khanmigo / 各种 "AI 学习路径" | 生成能力、体验 | 没有持久学习者模型，或模型不可见、不可导出 |

**空缺 = 一个持久的、可检查的、跨表面的学习者模型。**

用户的问题不是"没有学习材料"，而是"**从不开始**"。所以产品必须出现在用户已经在的地方（新标签页、B 站侧栏、搜索结果、IDE、终端），
用极小的剂量，且**由模型决定推什么**——而不是"每日轮换"。

> 设计的第一性原理：**理解（understanding）与可用（availability）是两件事。**
> 前者由推理与作答证据给出，后者由检索证据给出。混成一个数，产品就会给错建议。
> 这条原则决定了下面所有的账目划分。

---

## §2 设计原则（10 条，含"抄什么/拒什么"）

1. **四本账，永不合并**：知识 / 掌握 / 调度 / 上下文。任何一页 UI 都可以同时读它们，但没有任何代码路径可以同时写它们。
2. **事件日志是唯一真相，其余都是投影。** 改算法 = 重放日志重建投影，不迁移数据。
3. **确定性优先。** 打分、排序、调度全部是纯函数。LLM 只做四件事：抽取、判同、生成、解释。**绝不让 LLM 做调度决策。**
4. **可检查。** 每个数字都能回答"你凭什么这么算"：数据、公式、版本。数据可导出为纯文本，可 diff，可进 git。
5. **本地优先。** 单人单机跑得起来，不需要服务器、不需要账号、不需要联网（除模型调用）。多用户是可选的服务端模式。
6. **一次只加一层复杂度。** M0 不许出现向量库、图数据库、多智能体、同步协议。
7. **本体极简**：`proposition` + `chain`（premises **联合** ⟹ conclusion）。没有独立边表——先修关系是**推导出来的**。
8. **理解与可用分离**，对应两条独立的数：`mastery`（Beta 后验）与 `R`（FSRS 保留率）。
9. **被动曝光只证明注意力，不证明知识。** 停留时长不能涨掌握度——这条规则能挡住 90% 的"伪个性化"。
10. **可评估。** 一个没有评测的开源学习项目只是玩具。要能回答"我们的推送真的让人记住了吗"，用留白对照（§13）。

**从 learnharness 抄的是思想，不是代码**（AGPL-3.0）：
port/adapter 分层、三段式抽取（extractor → auditor → 确定性 merge）、coverage 账本、provenance 到 span、最小先修树、一步一检。
**拒绝的**：纯文件存储（无查询能力）、不存掌握度（push 场景必需）、单一桌面形态、5-agent 投票式决策。

---

## §3 系统架构

### 3.1 一个核心，多种运行时

```
                    ┌──────────────── @lattice/core (纯 TS, 零 IO) ────────────────┐
                    │  knowledge  │ mastery │ schedule │ context │ policy │ path    │
                    │  四本账的领域逻辑 + 纯函数打分/排序/调度（100% 可单测）          │
                    └───────────────┬──────────────────────────┬───────────────────┘
                                    │ ports (接口)              │
              ┌─────────────────────┴──────┐          ┌────────┴─────────┐
              │ StoragePort / LlmPort /    │          │ 直接以库形式被引用  │
              │ ClockPort / IdPort         │          └────────┬─────────┘
              └──────┬──────────────┬──────┘                   │
                     │              │                          │
        ┌────────────▼───┐   ┌──────▼─────────┐      ┌─────────▼─────────┐
        │ storage-sqlite │   │ storage-opfs   │      │ surfaces          │
        │ (Node/daemon)  │   │ (浏览器内)      │      │ extension / cli   │
        └────────────────┘   └────────────────┘      │ daemon-http / mcp │
                                                     └───────────────────┘
```

**为什么是 TS 单一核心**：浏览器扩展本来就是 JS。若核心用 Python，扩展里必须再实现一遍（FSRS、mastery、path），
两份实现必然漂移。FSRS 有官方 `ts-fsrs`，Beta 后验/noisy-OR 只有十几行，统计部分不需要 Python 生态。
**代价**：以后要上 DKT 之类需要训练的东西，另起一个可选 Python 服务；但那不在路线图里（§18）。

### 3.2 两种部署形态（这是本设计的关键取舍）

| | **Solo（默认）** | **Daemon（进阶级）** |
|---|---|---|
| 组成 | 只有浏览器扩展 | 扩展 + 本地 `lattice` 进程 |
| 存储 | OPFS 里的 SQLite（WASM） | 文件系统 SQLite，WAL |
| 能力 | 新标签页/侧栏/通知推送、手动或页面捕获、复习、本地图 | + CLI、MCP、桌面组件、跨设备同步、批量导入、离线模型 |
| 安装 | 装扩展即可 | 装扩展 + 一行 `npx lattice` |
| 数据 | 在浏览器里（可导出） | 在磁盘上（可导出） |

**原则：Solo 必须是完整产品，不是试玩版。** daemon 只是"同一份数据的更强大入口"。
两者用同一套事件日志格式，迁移 = 导出/导入事件。

### 3.3 进程边界与安全

- 扩展 ↔ daemon：`http://127.0.0.1:<port>`，握手时 exchange 一次性 token，`Origin` 校验，仅回环地址。
- 扩展 ↔ 模型：默认**直连**用户自己的 provider（BYOK），key 存 `chrome.storage.local` 的独立命名空间；
  可选走 daemon 代发（key 不落在浏览器）。
- 扩展 ↔ 任意网页：**只读注入**，不注入 `<script>` 到页面上下文，不用 `eval`，不做跨域读取。
- 无遥测、无账号、无跟踪。更新检查是唯一的外呼，可关。

---

## §4 核心：四本账模型

这是整个设计的重心。四本账对应四种"关于学习者的事实"，写者不同、生命周期不同、可否重建不同。

| 账本 | 回答的问题 | 唯一写者 | 事实性质 | 可重建 |
|---|---|---|---|---|
| **K 知识账** | 世界上有哪些命题？谁蕴含谁？ | 抽取管线 | 客观、可争议、带出处 | 从内容+日志 |
| **M 掌握账** | 他理解到什么程度？ | 作答/解释证据 | 后验概率，带不确定性 | 重放 |
| **S 调度账** | 他什么时候会忘？ | 检索证据 | 状态机 + 时间常数 | 重放 |
| **C 上下文账** | 他什么时候会看、看了会怎样？ | 注意力证据 | 行为统计，非知识 | 重放 |

### 4.1 三条互不越界的证据通道

```
作答/解释  ──► M 掌握账      (正确性、推理质量)        强证据，稀疏
检索自评/测验 ──► S 调度账      (grade → FSRS)          中证据，频繁
曝光/停留/点击/跳过 ──► C 上下文账 (注意力与时机)         弱证据，海量
```

**硬规则**：
- 注意力证据**永不**写入 M。看了一整天不等于学会了。
- 一次 `grade` **同时**产生一条 S 更新和一条 M 证据（Beta 的 α/β 之一），但两者独立记录、独立可回滚。
- 任何 UI 同时展示 `mastery` 与 `R`，并明确标注这是两个不同的数。

### 4.2 为什么这比"一个分数"好

- **可诊断**：`mastery` 高但 `R` 低 = "懂了但想不起来" → 该做检索练习；
  `R` 高但 `mastery` 低 = "背得熟但没懂" → 该回头补先修。这是单向分数无法给的建议。
- **可校准**：Beta 后验自带区间，可以直接算 Brier/ECE（§13）。一个 37% 的掌握度和一个 90% 的掌握度应该被区别对待。
- **可替换**：模型换代（Beta→BKT→别的）只要重放日志。知识账不受影响。

---

## §5 数据契约

### 5.1 事件日志（唯一真相，append-only）

```sql
CREATE TABLE event (
  id           TEXT PRIMARY KEY,     -- ULID：单调、全局唯一，用于多设备并集合并
  device_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,     -- 设备内单调递增，幂等去重
  occurred_at  TEXT NOT NULL,        -- ISO8601 UTC，事实发生时间
  recorded_at  TEXT NOT NULL,        -- 写入时间（乱序/离线时二者不同）
  actor        TEXT NOT NULL,        -- human | system | llm:<model>@<promptver>
  type         TEXT NOT NULL,
  subject_id   TEXT,                 -- proposition / cue / goal / session
  payload      TEXT NOT NULL DEFAULT '{}',
  UNIQUE(device_id, seq)
);
CREATE INDEX event_time    ON event(occurred_at);
CREATE INDEX event_subject ON event(subject_id, occurred_at);
```

事件类型（v1 全量，**不要加没用的**）：

| type | 含义 | 关键 payload |
|---|---|---|
| `content.captured` | 用户主动捕获一段内容 | `{uri, span, text_hash}` |
| `content.extracted` | 抽取完成 | `{source_hash, extractor, n_props}` |
| `prop.asserted` | 新命题 | `{statement, aliases, provenance[]}` |
| `prop.merged` | 身份消解：A 就是 B | `{from, into, decided_by, reason}` |
| `chain.asserted` | 推理链 | `{premises[], conclusion, strength}` |
| `goal.set` | 学习目标 | `{target_ids[], deadline?}` |
| `review.rated` | 一次检索 | `{cue, proposition, grade, elapsed_days, r_before}` |
| `quiz.answered` | 一次作答 | `{proposition, correct, selected, latency_ms}` |
| `explain.written` | 自由解释 | `{proposition, text, rubric_score?}` |
| `exposure.shown` | 展示 | `{proposition, surface, policy_decision_id}` |
| `exposure.engaged` | 停留/点击 | `{proposition, dwell_ms}` |
| `exposure.skipped` | 划过 | `{proposition, dwell_ms}` |
| `interrupt.decided` | 投放决策（含反事实） | `{candidates[], chosen?, utility, budget, held_back}` |

> 事件**不存**派生结果。`R`、`mastery` 都是投影产物。这样任何公式改动都能重算历史。

### 5.2 知识账投影

```sql
CREATE TABLE proposition (
  id            TEXT PRIMARY KEY,
  statement     TEXT NOT NULL,
  name          TEXT,
  aliases       TEXT NOT NULL DEFAULT '[]',
  domain        TEXT,
  status        TEXT NOT NULL DEFAULT 'active',  -- active|superseded|archived
  valid_to      TEXT,                            -- 双时态：不再被断言的时间
  created_at    TEXT NOT NULL
);
CREATE TABLE proposition_merge (      -- 别名/义项消解，不物理删除
  from_id TEXT PRIMARY KEY, into_id TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT
);
CREATE TABLE chain (                  -- 前提是"联合"蕴含，不是分别
  id TEXT PRIMARY KEY, conclusion_id TEXT NOT NULL,
  premises TEXT NOT NULL,             -- JSON 数组
  strength REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL
);
CREATE TABLE provenance (             -- 每个断言都能回到出处
  subject_kind TEXT NOT NULL,         -- proposition|chain
  subject_id   TEXT NOT NULL,
  source_kind  TEXT NOT NULL,         -- page|pdf|video|note|session|import
  source_uri   TEXT, span TEXT,       -- span: {start,end,quote}
  captured_at  TEXT NOT NULL
);
CREATE TABLE coverage (               -- 同一段文本绝不重复抽取
  source_hash TEXT PRIMARY KEY,
  extractor_version TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  proposition_ids TEXT NOT NULL
);

-- 先修关系不建表，建视图（唯一真相是 chain）
CREATE VIEW prereq AS
  SELECT DISTINCT c.conclusion_id AS target, value AS prerequisite
  FROM chain c, json_each(c.premises) AS value;
```

> **关键判断**：`concept_edges(prerequisite)` 是典型的过早抽象。链条本身就是关系；
> 从 `chain` 派生 `prereq` 视图，图结构和教学路径用的是同一份真相，不会出现"边表和链条不一致"。
> 只有从外部导入的课程（没有链条）才需要显式 `requires`，那时再加一张 `asserted_edge` 表也不迟。

### 5.3 掌握账 / 调度账 / 上下文账投影

```sql
CREATE TABLE mastery (                -- understanding：Beta 后验
  proposition_id TEXT PRIMARY KEY,
  alpha REAL NOT NULL DEFAULT 2.0,
  beta  REAL NOT NULL DEFAULT 2.0,
  updated_at TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE schedule (               -- availability：FSRS-6 状态（每个命题一份）
  proposition_id TEXT PRIMARY KEY,
  stability REAL, difficulty REAL, state TEXT NOT NULL DEFAULT 'new',
  last_review_at TEXT, due_at TEXT, review_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE cue (                    -- 检索路线：多对一，多个 cue 共享一份调度
  id TEXT PRIMARY KEY, proposition_id TEXT NOT NULL,
  front TEXT NOT NULL, back TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'recall',   -- recall|cloze|apply|contrast
  created_at TEXT NOT NULL
);
CREATE TABLE context_bucket (         -- 注意力统计，不参与知识判断
  bucket TEXT PRIMARY KEY,            -- 'hour:9|surface:newtab|host:bilibili.com'
  exposures INTEGER, engaged INTEGER, skipped INTEGER,
  quiz_attempts INTEGER, quiz_correct INTEGER,
  updated_at TEXT
);
CREATE TABLE interrupt (              -- 投放记录 + 反事实标记
  id TEXT PRIMARY KEY, proposition_id TEXT, surface TEXT,
  predicted_utility REAL, budget_remaining REAL,
  held_back INTEGER NOT NULL DEFAULT 0,   -- 1 = 对照（不展示但记录）
  observed TEXT, decided_at TEXT
);
```

### 5.4 双时态（唯一不能事后补的东西）

学习者的理解会变，误解和纠正会永久并存。所以：
- `occurred_at`（事实何时成立）vs `recorded_at`（我们何时知道）；
- `proposition.valid_to` + `proposition_merge` 表达"这条后来被取代/合并了"；
- 所有默认查询只取 `status='active'`。想看"我当时是怎么以为的"，按 `occurred_at` 时间旅行。

---

## §6 知识构建管线

```
capture → normalize → extract → identify → merge → coverage
 (用户)    (Readability)  (LLM)     (LLM)     (纯代码)  (纯代码)
```

### 6.1 阶段职责

1. **capture**：用户主动触发（选区/整页/PDF/字幕/笔记）。**不做后台爬取**——见 §14 版权。
2. **normalize**：正文抽取 → 规范化文本 → `source_hash`（sha256）。命中 `coverage` 就跳过（幂等）。
3. **extract**（LLM，唯一看得到原文的阶段）：
   输出 `{propositions[{statement, name, aliases, span}], chains[{premises[], conclusion}]}`。
   **强制**：每个命题必须带 `span`（原文位置），否则整条丢弃。这挡住"看起来合理但原文没有"的幻觉。
4. **identify**（LLM，**看不到原文**，只看候选命题 + 已有命题索引）：
   只判"这个是不是已有的那个"（link-or-create，**等价偏置**：同义归并）。
   它**不能**创建边、不能改文本、不能删。这是 learnharness auditor 的核心纪律，照抄。
5. **merge**（纯代码，唯一写账本的阶段）：别名并集、provenance 并集、链去重（按 premises 集合+conclusion）、
   成环检测（Kahn）、写 `coverage`。
6. **断言失败要可见**：schema 校验失败的输出进 dead-letter 表 + UI 可见，**不静默丢弃**。

### 6.2 为什么这样不漂移

LLM 只做判断题，落账交给确定性代码。三个后果：
- **可重放**：同一份原文 + 同一版本 extractor → 同一条链（温度 0 + 固定 prompt 版本 + 固定 id 生成规则）；
- **可增量**：coverage 保证不重复抽，新内容只走增量；
- **可审计**：每条命题能追到 span，每个 merge 能追到"谁判的、凭什么"。

### 6.3 质量闸门（开源项目必须诚实）

- 低 `strength` 的链**不进自动路径**，进"待复核"队列；
- 用户可一键指出"这条错了"，产生 `prop.corrected` 事件 → 影响后续抽取的 few-shot；
- 内置 20–50 条人工标注的先修边作为回归测试（§13）。

---

## §7 学习者模型

### 7.1 两个数，两套公式

**可用性（availability）** —— FSRS-6，每个命题一份：

```
R(t) = (1 + FACTOR · t / S) ^ DECAY        # 官方 FSRS 的保持率形式
```
用 `ts-fsrs`（MIT）官方实现，不自己维护参数表。单人冷启动用默认参数；
每积累约 200 条 review 可重拟合一次（拟合是离线任务，产物是参数文件，可回滚）。

**理解（understanding）** —— 每命题一个 Beta 后验：

```
α ← α + w · e^(-λΔt)        (证据为"正确/解释得好")
β ← β + w · e^(-λΔt)        (证据为"错误/解释不出来")
mastery = α/(α+β)           区间 = Beta 分位数 (如 10%~90%)
w = 证据权重：quiz 1.0 / 自评 recall 0.6 / 自由解释(LLM 评分) 0.4
```

冷启动 `α=β=2` → 0.5，带一个大区间，诚实表示"不知道"。

### 7.2 何时把"错了"当成证据

不是所有错误都降 mastery：**粗心**不该降。用作答延迟 + 置信度做区分：
快速且自信地错 → 是误解（β 大幅增加）；
慢且犹豫地错 → 是没学会（β 小幅增加）。
这条规则写在 `mastery.ts` 里，有单测。

### 7.3 不可用的东西（明确排除）

| 方案 | 门槛 | 判断 |
|---|---|---|
| DKT / AKT / SAINT | 10⁵–10⁶ 交互、上千学习者 | ❌ 单人 = 训练集即测试集 |
| 完整 KST/ALEKS | 350–500 项专家结构 | ❌ 标注成本 >> 收益 |
| RL 课程编排 | 可重置模拟器 + 可信 reward | ❌ |
| Elo/IRT | 数百次作答 | ⏳ M2 可选，做题目难度校准 |
| pyBKT | 中等 | ⏳ 想要"可解释掌握曲线"再上 |

---

## §8 路径规划

目标不是"课程表"，是**从你现在的位置，到目标命题的最小先修树**。

```
plan(goal) :
  T ← backwards-search(goal, prereq)         # 沿 chain 反向展开
  T ← prune(T, mastery ≥ 0.9)                # 已掌握的不教
  T ← minimize(T)                            # 最小节点、最小深度
  return T

frontier(T) = { p ∈ leaves(T) : ∀ q ∈ prereq(p), mastery(q) ≥ 0.7 }
```

- `frontier` 上的命题 = **现在可以教的**；
- 排序：`0.6 × ZPD + 0.4 × IG`（目标成功率 0.85 的钟形权重 + 信息增益）；
- 复习:新学 ≈ 65:35，**且复习优先**（逾期积压永远先清）；
- 选 cue：同命题的多个 cue 里加权随机（弱 cue 权重高，未试过的 cue 有基础权重），
  **学习/重学阶段固定用同一个 cue**（修那条检索路径），这是 learnharness flashcards 的设计，照抄。

> 与"AI 生成学习路径"产品的区别：我们的路径是一个**可复算的图搜索**，
> LLM 只负责把结果讲成人话（"你卡在 A→B 这一步，因为 C 一直错"）。可复现、可 A/B、可反驳。

---

## §9 注意力与投放策略（这是本产品独有的部分）

### 9.1 投放效用

```
U(p, c) = [ V(p) · Π(p) · Q(p) ] / [ 1 + C(c) ]

V(p)  目标权重：目标反向可达性 × 图中心性（越接近目标、越是被多条链依赖，越值钱）
Π(p)  学习潜力：(1 - R(p)) × (0.9 - mastery(p))⁺ × ZPD_weight   # 快忘了 + 还没懂
Q(p)  内容质量：cue 存在性、历史通过率、抽取置信
C(c)  打断成本：由 C 账本估计（当前页面类型、时段、最近打断次数、疲劳）
```

投放规则不是"每天推 N 张"，而是：
- 每天一个**打断预算**（credits），每次投放扣费，`C` 高的场景扣得多；
- 只在 `U > 阈值` 且 `预算 > 0` 时投放；否则静默（**静默是默认状态**）；
- 表面按侵入度分级：新标签页（免费）< 页内角标（中）< 系统通知（贵）。

### 9.2 反事实日志（让"是否有效"可回答）

每次 `interrupt.decided` 记录：候选集、被选者、预测效用、预算余额。
**随机留白 5%** 的候选不展示（`held_back=1`），之后用延迟测验（day 3/7/30）比较：
`Δretention = P(记住 | 推过) − P(记住 | 留白)`。

没有这个，所有"个性化推送有效"的说法都是自我安慰。这也是开源社区最缺的东西——
Anki、learnharness 都没有内建的效果评测。

### 9.3 不打扰的硬约束

- 用户正在输入 / 视频全屏 / 页面处于 `visibilitychange=hidden` → 永不打断；
- 单次会话打断 ≤ 1 次；连续 2 次被跳过 → 当天自动降级为"只更新新标签页"；
- 所有阈值用户可调，且**默认保守**（宁可少推）。

---

## §10 表面层（Surfaces）

| 表面 | 侵入度 | 交互 | 状态 |
|---|---|---|---|
| 新标签页 | 低 | 卡片流 + 一题 | M0 |
| 页内角标/侧栏 | 中 | 15 秒卡 + quiz | M1 |
| 通知 | 高 | 一句话 + 一个动作 | M1 |
| CLI (`lattice due / plan / explain`) | 零 | 终端复习 | M1（daemon） |
| MCP server | 零 | 让任意 agent 读写学习者模型 | M2 |
| 桌面浮层 | 中 | 常驻卡片 | M3（可选） |

**扩展的约束（MV3 必须正视的）**：
- service worker 随时被回收 → 事件**先落 OPFS/IndexedDB 再发**，`chrome.alarms` 冲刷，绝不用内存 buffer + setInterval；
- 所有捕获/注入只在用户手势或明确授权下发生（`activeTab`）；
- 不做全文档 `querySelectorAll('*')` 扫描；用 `IntersectionObserver` + 最小选择器；
- 权限最小化：`storage, alarms, notifications, activeTab` + 用户显式授权的站点；

---

## §11 检索与上下文注入（token 预算）

- **M0**：SQLite `FTS5` BM25 足够（命题 statement + aliases + 来源标题）。
- **M2**：`FTS5 + sqlite-vec` 混合，RRF 融合（各取 top-20）。
- **注入原则：注入长度 ≈ 常数，不随知识库增长。** 每次 LLM 调用只给：
  `frontier top-k` + `相关命题的链条邻域` + `该用户在此域的历史错误摘要`。
  **禁止**把"全部卡片"塞进 prompt（旧 demo 的 5-agent 全量注入是反面教材）。

---

## §12 同步与多设备

事件日志是 append-only 的**观察集合**，所以合并 = **集合并集**：

```
merge(A, B) = A ∪ B        # 按 event.id 去重
派生状态 = replay(merge(...))   # 各设备本地重算，不需要冲突解决
```

- 只有"派生状态"是有冲突的，而它随时可以从日志重建 → **不需要 CRDT**；
- 传输：一个可选的极简 sync 服务（或用户自己的 WebDAV / git 仓库 / Syncthing）；
- 端到端加密可选（日志是纯文本，加密即密文块）；
- 这也意味着**导出 = 发一个 JSONL**，导入 = 追加，天然可逆。

---

## §13 评测体系（开源项目的信誉来源）

三件事，缺一不可：

1. **重放**：拿任意历史事件日志，重算全部投影，与当前值对比 → 检验确定性与公式改动影响。
2. **合成学习者**：用已知 ground-truth 的参数生成模拟学习者（有遗忘曲线、有误解、有粗心），
   检验 `mastery` 的收敛与校准（Brier、ECE）、`plan` 的步数效率。
3. **线上留白对照**：§9.2 的 5% 对照 + 延迟测验 → 真实学习增量。

指标（写进 README，不放水）：

| 指标 | 定义 | 目标 |
|---|---|---|
| 校准 | Brier / ECE of mastery | 优于常数基线 |
| 留存 | day-30 正确率 vs FSRS 预测 | 差距 < 0.1 |
| 效率 | 达到 mastery≥0.8 所需分钟数 | 优于"随机复习" |
| 增量 | 推送 vs 留白的延迟测验差 | > 0 且显著 |
| 成本 | 学到一个命题的 token 数 | 持续下降 |

**回归测试**：50 条人工标注先修边 + 20 个合成学习者场景。改抽取 prompt 必须过这套。

---

## §14 隐私、安全、版权

- **本地优先**：默认数据不出机器；唯一外呼是用户配置的模型 provider 与（可关的）更新检查。
- **威胁模型**：扩展是高权限组件 → 最小权限、无远程代码、无 `<script>` 注入、CSP 收紧。
- **版权**：只处理**用户主动提供**的内容（选区/上传/自己买的 PDF）；存 `span` 与引用链接，
  不缓存全文、不建全文库、不对公网做批量抓取。导出给用户的是"他的笔记 + 我们生成的命题"，不是原文副本。
- **可删除**：一键导出 / 一键删除全部事件与投影；删除是真删（事件日志除外，给 7 天撤销窗口）。
- **不做的**：不做学生监控、不做教师后台强制上报、不卖数据。这些写进 LICENSE/NOTICE 旁边的 `ETHICS.md`。

---

## §15 开源治理

| 项 | 决定 | 理由 |
|---|---|---|
| 代码许可 | **Apache-2.0** | 专利授权 + 允许商用采纳，最利于形成插件/表面生态 |
| 数据格式规范 | Apache-2.0（同一许可） | 规范要被别人实现才有价值 |
| 文档 | CC-BY-4.0 | |
| 不能做 | 直接拷贝 learnharness 代码 | 它是 AGPL-3.0；思想可学，代码不可搬 |
| 贡献门槛 | 改算法必须带评测结果；改格式必须升版本号 | 这是唯一能防" vibe-coded 漂移"的机制 |

**数据格式版本化**：`format.json = {"version": 1}`；新版本必须提供迁移函数 + 旧版本只读支持。
（旧 demo 没有迁移机制，`next_direction` 有列无值就是活教材。）

**插件契约**：先只开放两个稳定接口——`Surface`（能读 frontier、能上报事件）与 `Ingest`（能产出 captured 事件）。
**不要**一开始开放"插件可写知识账"——那会让图质量失控。

---

## §16 仓库结构

```
lattice/
├─ packages/
│  ├─ core/                 # 纯 TS：model / mastery / fsrs / path / policy / ports
│  │  ├─ src/model/         # Proposition, Chain, Goal, Cue
│  │  ├─ src/ledger/        # 四本账的读写语义（只依赖 ports）
│  │  ├─ src/policy/        # utility, budget, zpd, ig（纯函数）
│  │  └─ src/path/          # minimal-tree, frontier
│  ├─ storage-sqlite/       # Node adapter (better-sqlite3, WAL)
│  ├─ storage-opfs/         # Browser adapter (sqlite-wasm + OPFS)
│  ├─ llm/                  # OpenAI-compatible / Anthropic / local
│  ├─ extract/              # normalize + extract + identify prompts（带版本号）
│  ├─ extension/            # MV3：newtab / inline / background / popup
│  ├─ daemon/               # 本地 HTTP + 调度 + 同步端点
│  ├─ cli/                  # lattice due|plan|add|export|replay
│  └─ mcp/                  # MCP server（出站工具）
├─ eval/                    # replay, synthetic learner, benchmarks, fixtures
├─ docs/                    # 规范：data-format / policy / plugin-api / ethics
└─ examples/
```

---

## §17 路线图

| 阶段 | 时间 | 交付 | 验收 |
|---|---|---|---|
| **M0 骨架** | 2 周 | core + sqlite + 事件日志 + FSRS + Beta + 手动导入命题 + 新标签页复习/quiz + 导出 | 能重放、能校准、能导出；单测覆盖 core |
| **M1 图谱** | +3 周 | capture → extract → identify → merge + coverage + 最小先修树 + frontier + 页内角标 | 50 条标注边通过；无环；每条命题可追 span |
| **M2 策略** | +3 周 | 效用/预算/反事实 + daemon + CLI + MCP + 混合检索 | 留白对照跑起来；token 注入恒定 |
| **M3 生态** | +4 周 | 同步、插件 API、Anki/Obsidian 导入、桌面浮层、公开评测报告 | 第二个表面由外部贡献者完成 |

**M0 就要有的东西**：事件日志、可重放、评测骨架、导出。这四样是"以后还能改"的保险。

---

## §18 明确不做

1. 向量数据库 / 图数据库 / 知识图谱可视化大屏（M3 之前）
2. 多智能体投票决策（旧 demo 的 5-agent 方案：5 次 LLM 调用、不可复现、不可审计 → 用纯函数策略替代）
3. 深度知识追踪、RL 课程编排、完整 KST
4. 云端账号体系、社交功能、排行榜
5. 自动后台爬取网页建库
6. 移动 App（等桌面/扩展站住再说）
7. 插件可写知识账

---

## §19 开放问题（我故意没有替你定的）

1. **名字**：`Lattice`（工作名）/ `Marginalia`（更贴"缝隙里学习"）/ 其他。品牌不影响架构，但影响文档与域名。
2. **Solo 模式的存储**：`sqlite-wasm + OPFS` 是否在主浏览器稳定可用、FTS5 是否随官方 wasm 构建提供——**需实测**；
   不行就退到 IndexedDB + `minisearch`（BM25 自己实现），代价是查询能力下降。
3. **首次体验**：没有内容就没有图。M0 的"第一个 5 分钟"是从一个 PDF 开始，还是从 5 张手写卡开始？
4. **反事实留白**是否默认开启？伦理上"故意不教"需要明示——建议默认开，但在设置里写清楚。
5. **是否接受 AGPL**：若接受，可以直接复用 learnharness 的部分实现（省 2–3 周），代价是产品必须 AGPL。
   若目标是"被教育机构/公司采纳"，选 Apache-2.0 更稳。

---

## §20 与既有方案的关系（一句话版）

| | 它是什么 | 与 Lattice 的关系 |
|---|---|---|
| learnharness | 桌面 AI 教学外壳，纯文件、不存掌握度 | 抄教学法与抽取纪律；补上 push、掌握度、可评测 |
| Anki | 最强的调度器 + 最弱的模型 | 用它的 FSRS，补上知识结构与上下文 |
| Mem0/Zep/Letta | 通用 agent 记忆 | 解决的是"记住偏好"，不是"学会知识"；不采用 |
| GraphRAG/LightRAG | 文档→图的离线管线 | 只在"整门课→大纲候选"时离线借鉴 |
| "AI 学习路径"产品 | 生成一份路径清单 | 没有持久模型、没有测量；我们是可复算的图搜索 |
