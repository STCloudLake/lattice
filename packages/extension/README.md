# Lattice 扩展（M0 骨架 + M1 捕获 + M2a/M2b 推送与打扰预算 + M2c 兴趣/自主内容）

Chrome/Edge 的 MV3 扩展：把新标签页变成 Lattice 的**今日推送**表面。
M0 的离线数据脊柱（事件日志 → 投影 → 复习）保持不变；M1a/M1b 增加了**用户主动触发**的
捕获链路：粘贴文本/抓取页面 → 你配置的 OpenAI 兼容模型抽取命题/推理链/领域 → 预览确认 → 入库。
M2a 把捕获的语义改成**兴趣信号**：知识像广告一样按小剂量推送，验证（复习/测验）是可选项。
M2b 加了「看板」：B 站/YouTube 的右侧侧栏、可选的系统通知，以及一个**打扰预算**
（每日 0–3 次 + 安静时段）让广告不变成骚扰；曝光/参与/跳过只进 C 账。
M2c 让用户**自己声明兴趣领域**，并由系统**主动准备内容**：首次运行就内置「计算机」「人工智能」
入门内容；配好模型后，声明但还缺内容的领域会被自动生成，不必依赖捕获页面。
没有后台爬取、没有遥测；数据只在本机浏览器里，可导出成纯文本 JSONL。

## 构建

在仓库根目录：

```bash
npm run build
```

`packages/extension/vendor/` 由 `scripts/build-extension.mjs` 生成（已 gitignore）：

- `vendor/lattice-core/` —— 打包好的 `@lattice/core` + `@lattice/extract`（ESM）
- `vendor/sqlite-wasm/` —— sqlite-wasm 官方 dist（含 `sqlite3.wasm`）

同时会把 `examples/seed-curriculum.json` 复制到 `data/seed-curriculum.json`（内置入门课程）。

## 加载（开发者模式）

1. 先跑 `npm run build`。
2. Chrome/Edge 打开 `chrome://extensions`（Edge：`edge://extensions`）。
3. 打开右上角「开发者模式」。
4. 点「加载已解压的扩展程序」，选择 `packages/extension/` 目录。
5. **新开一个标签页**（`chrome_url_overrides.newtab` 会接管新标签页）。
6. 首次运行自动载入内置入门内容（计算机 + 人工智能），toast
   `已为你准备「计算机」「人工智能」入门内容`，新标签页直接开始「今日推送」——**无需配置模型**。
   在卡片上点 **知道了** / **不感兴趣**，或点 **考考我** 进入可选的测验。
   想换/加领域：⚙ 设置 →「兴趣领域」添加；配好模型后系统会自动为缺内容的声明领域生成一小批内容。

7. 在 B 站/YouTube 打开视频页：右侧窄侧栏（最多 2 条，30 秒无操作自动收起，小把手可再展开）
   会从缓存快照里展示内容；它和系统通知共用「设置 → 推送 → 每日打扰上限」（默认 1 次，
   通知默认关闭）。侧栏的曝光/参与/跳过先排队，下次打开新标签页时并入事件日志。

> 不需要在扩展页里打开任何文件；`chrome://newtab` 就是入口。

## 目录

```
manifest.json            MV3 清单（含模型接口的 host_permissions / optional_host_permissions、
                         bilibili/youtube 声明式 content_scripts、notifications + alarms 权限）
background.js            后台 service worker：捕获入口 + M2b 通知闹钟（90 分钟）
shared/billboard.js      推送层共享契约：billboard 快照/打扰预算/曝光队列/difficulty 展示
content/sidebar.js       视频站右侧看板 content script（读快照、排队曝光、不碰数据库）
content/sidebar.css      侧栏样式（固定右侧、可折叠、不遮挡页面控件）
newtab/                  新标签页 UI（HTML/CSS/原生 JS，无框架、无内联脚本）
  curriculum-guard.js    M2c 页面侧「每领域每天最多生成一次」守卫（可在 Node 里测试）
worker/                  RPC worker —— 唯一写事件日志的地方
  worker.js              RPC 分发 + 打开数据库 + 回退持久化
  service.js             事件日志/投影/导入导出/抽取确认入库/声明兴趣/课程生成
  llm.js                 OpenAI 兼容模型客户端（BYOK，60s 超时，中文错误）
  db.js                  sqlite-wasm 封装：OPFS → OPFS SAH pool → 内存
  persist.js             回退模式：整份事件日志 JSONL（+ coverage 镜像）存 chrome.storage.local
  util.js
data/sample-pack.json    示例命题包（来自 examples/sample-pack.json）
data/seed-curriculum.json 内置入门课程（14 命题 / 3 链，来自 examples/seed-curriculum.json）
test/worker-smoke.mjs    M0 数据层冒烟测试（内存 SQLite + 假 chrome.storage）
test/capture-smoke.mjs   M1a 捕获链路冒烟测试（假 provider fetch + coverage/幂等）
test/feed-smoke.mjs      M2a 推送层冒烟测试（feed 剂量/同日照去重/跳过疲劳/兴趣）
test/curriculum-smoke.mjs M2c 声明兴趣 + seed 幂等 + 课程生成 + 每日一次守卫
test/m2b-smoke.mjs       M2b 打扰预算/快照容错/曝光队列/侧栏 DOM/通知 picker
test/extension-e2e.mjs   真实 MV3 E2E（含本地 stub provider + 真实侧栏注入）
vendor/                  构建产物（不提交）
```

## 存储

Architecture：`newtab`（UI）⇄ `worker`（数据库）。浏览器 OPFS 里的 SQLite 只能在
Web Worker 中运行，所以 UI 只通过一个很小的 RPC（`{op, args}` → `{ok, result|error}`）访问数据。

打开顺序（前一步失败才尝试下一步）：

1. `sqlite3.oo1.OpfsDb('/lattice.sqlite')` —— 经典 OPFS VFS，需要跨源隔离
   （SharedArrayBuffer）。
2. `installOpfsSAHPoolVfs()` —— OPFS 同步句柄池 VFS，只在 worker 中可用，
   **不需要 SharedArrayBuffer**；同一个 OPFS 池同时只能被一个标签页持有。
3. 内存 SQLite + 整份事件日志以 JSONL 镜像到 `chrome.storage.local`（防抖 ~300ms）。

诊断面板（页脚「诊断」）会显示 `存储: OPFS` 或 `存储: 回退(chrome.storage)`、实际 VFS、回退原因、
M2a 的 `推送: 每日 N 条 · 今日已展示 X · 参与 Y · 跳过 Z · 兴趣 …` 行，以及 M2c 的两行：
`兴趣:`（已声明的领域与水平）和 `待生成:`（声明了但内容还不够的领域）。

### manifest 里有三个「非可选」的键

MV3 默认不允许 WebAssembly 编译，默认也不给扩展页面跨源隔离。要让 OPFS SQLite
真的跑起来，`manifest.json` 必须包含：

| 键 | 作用 |
|---|---|
| `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` | 否则 `WebAssembly.instantiate` 被 CSP 拒绝（实测报 CRITICAL：Aborted CompileError） |
| `cross_origin_embedder_policy: require-corp` + `cross_origin_opener_policy: same-origin` | 否则没有 `SharedArrayBuffer`，经典 `opfs` VFS 装不上，只能退到 SAH 池/内存 |

实测（headless Edge 158，MV3 开发者模式加载）：走的是 `VFS: opfs`，多标签页共用同一
份数据库（SQLite 文件锁），刷新后数据仍在。

## 模型配置（BYOK，M1a）

⚙ 设置 →「模型」：选预设（DeepSeek / OpenAI / 本地 Ollama·LM Studio / 自定义），
填 `接口地址`、`模型`、`API Key`，可先「测试连接」（worker 发一次很小的 chat completion，
回报延迟与模型名）。保存写入 `chrome.storage.local.latticeProvider`。

- **模型名不写死在代码里**：点「拉取模型」会 `GET {接口地址}/models` 并用返回列表填充下拉候选。
  厂商会改名（DeepSeek 已把 `deepseek-chat` 换成 `deepseek-flash`），这样改名不用等发版。
- 请求是 OpenAI 兼容格式：`POST {接口地址}/chat/completions`，`Authorization: Bearer <key>`，
  body `{model, messages, temperature, max_tokens?, stream:false}`，读 `choices[0].message.content`。
- 当前 DeepSeek 预设：接口地址 `https://api.deepseek.com`（带不带 `/v1` 都可），
  模型 `deepseek-flash` 或 `deepseek-v4-pro`。以 `GET /models` 的结果为准。
- 本机接口（`127.0.0.1` / `localhost`）允许空 Key。
- **API Key 只在 `chrome.storage.local`**：不写 SQLite、不进事件日志、不进导出、诊断只显示
  `模型: <model> (<preset>)`。所有错误信息都做了 Key 脱敏。
- 自定义 https 接口在保存时会请求运行时站点权限（`chrome.permissions.request`，清单里
  `optional_host_permissions: ["https://*/*"]`）；拒绝授权会给出中文错误。
- 清单已内置 `https://api.deepseek.com/*`、`https://api.openai.com/*`、
  `http://127.0.0.1:*/*`、`http://localhost:*/*`；本机 provider 不需要额外授权。

## 今日推送（M2a）

**捕获一个页面 = 告诉系统「我对这个领域感兴趣」**，不是「把这个页面变成卷子」。
新标签页默认就是「今日推送」：一次一张卡，像广告一样小剂量、被动曝光。

- 卡片：`领域` 徽标 + `基础/前沿/复习` 标签 + **难度**（`★★★☆☆ 应用`，来自
  `proposition.difficulty`，旧数据没有就省略）+ 命题（标题）+ 一句提示（有卡片时）+ 灰色 meta
  （`掌握 42% · R 71%`、`来自「经济学」`）。
- 动作：**知道了**（写 `exposure.engaged`，下一张）、**不感兴趣**（写 `exposure.skipped`，
  下一张，同一命题被跳过 2 次后不再推）、**考考我**（可选验证：复用卡片流程的测验模式，
  只写掌握账）。
- 展示一张卡会写一次 `exposure.shown`（`day = YYYY-MM-DD`）：**同一命题一天只出现一次**，
  刷新/重开标签页当天也不会重复。曝光只进 C 账（上下文/注意力），**永不改掌握或调度**。
- 空状态：「今天的知识看完了 ✓」+「去复习」（切到复习队列）+ 捕获提示；
  复习队列仍可通过顶栏「复习 N」标签进入，原有评级/测验流程完全保留。
- 剂量：「设置 → 推送」每日 3 / 5 / 10 条，存在 `chrome.storage.local.latticeFeedSettings`，
  默认 3；worker 的 `feed({dose})` 只接收算好的 `dose`，策略本身在 `@lattice/core` 的
  `buildFeed()` 里（可复现、可测试）。
- 捕获入库后 toast 会显示 `已加入「经济学」· 今日推荐已更新`，并立即重算推送；
  抽取管线把 `domain` 同时写进 `proposition.domain` 和 `interest.observed`（兴趣只影响排序）。
- RPC：`feed({dose, now?})` → 卡片数据 + 兴趣；`exposure({propositionId, kind, surface})` →
  追加一条 C 账事件并返回重算后的 feed；`diagnostics()` 增加 `feed` 字段；M2b 的
  `drainExposures({exposures})` 把侧栏/通知排队的曝光一次并入事件日志（记录自带 id，
  `INSERT OR IGNORE` 保证重复 drain 幂等）。

## 侧栏与系统通知（M2b）

**知识像广告一样投放，就需要「广告位」和「频次控制」。** M2b 增加两个主动打扰表面，并给它们
一个共享的每日预算：

- **架构（不改存储）**：SQLite 事件日志仍只在新标签页的 Worker 里。新标签页每次算完 feed
  就把一份小快照写进 `chrome.storage.local.latticeBillboard`
  （`{day, dose, refreshedAt, items:[{propositionId, cueId, statement, domain, reason, tier,
  cognitive, mastery, retrievability, score}]}`）。侧栏和 background 只读快照，永不打开 DB。
- **侧栏**：manifest 声明式注入 `*://*.bilibili.com/*`、`*://*.youtube.com/*`
  （`content/sidebar.js` + `content/sidebar.css`，`document_idle`），右侧固定窄面板
  （300px，top 96px），最多 2 条；不遮挡页面控件，可折叠；30 秒无交互自动收起（**只收起，
  不写 skip**），小把手可再展开。动作：**知道了**（`exposure.engaged`）、
  **不感兴趣**（`exposure.skipped`）、**打开 Lattice**（background 开新标签页）。
  每张实际展示的卡在同一 day 只排一次 `exposure.shown(surface:'sidebar')`。
- **系统通知**：background 每 90 分钟一个 `chrome.alarms` 检查，**默认关闭**（设置里打开）。
  满足预算 + 非安静时段 + 快照是今天 + 今天还没通知过时，取快照里**分数最高且今天没展示/通知
  过**的一条，最多发 1 条；通知按钮「知道了 / 打开」= 参与 + 开新标签页，用户关闭 = skip。
- **打扰预算**：设置 → 推送：`每日打扰上限` 0/1/2/3（默认 1）、`安静时段`（默认 23:00–08:00，
  起止相同 = 不启用）、`侧栏开关`、B 站/YouTube 站点开关、`允许系统通知`。
  存在 `chrome.storage.local.latticeInterruptSettings`；计数器 `latticeInterruptState =
  {day, used}` 跨天自动清零。**侧栏和通知共用同一预算**；用尽或安静时段内：不注入、不入队、
  不发通知（新标签页的「今日推送」不算打扰，永远可用）。
- **曝光队列**：侧栏/通知把 `{id, propositionId, kind, surface, at, day}` 追加到
  `latticePendingExposures`；新标签页启动（以及从后台回到前台）时调用
  `drainExposures` 并入事件日志并清理已入库记录。记录 id 同时作为事件 id，崩溃后重复 drain
  也不会重复计数；同日 `latticeExposureGuard` 保证 drain 之前也不会重复展示。
- **难度展示**：快照与 feed 卡片/侧栏都显示 `proposition.difficulty` 的
  `★★☆☆☆ + 理解`（tier 1–5；认知层级：记忆/理解/应用/分析/评价）；字段缺失时静默省略。
- **诊断**：新增 `打扰: 上限 N 次 · 今日已用 M · 安静 … · 侧栏 开/关 · 通知 开/关 · 待入库曝光 X 条`。

权限新增 `alarms`、`notifications`；清单版本 bump 到 `0.4.0`（刷新 MV3 代码缓存；
诊断里的 `后台: m2b-1 ✓` 可确认后台是最新版）。

## 兴趣领域与自主内容（M2c）

**用户可以自己说「我想学这个」，不必等捕获页面来推断。** 声明本身也是一条 C 账事件
（`interest.declared`），没有第二份「本地设置」真相：重启后由事件日志重放出来。

- 首次运行（0 命题 + 0 兴趣）自动调用 `seedCurriculum()`：一个事务导入内置
  `data/seed-curriculum.json`（计算机 7 + 人工智能 7，含推理链）并为两个领域写
  `interest.declared`（入门）。toast：`已为你准备「计算机」「人工智能」入门内容`。
  重复执行是幂等的（`meta` 标记 + 「已有内容就不注入」双保险；清空数据后可用空状态里的
  「载入入门内容」重新载入）。
- ⚙ 设置 →「兴趣领域」：每行 `领域名 · 水平 · [移除]`；输入框 + 水平下拉（入门/进阶/高级）+
  「添加」。列表来自 worker 的 `curriculumNeeds()`，页面**不**在本地持久化兴趣。
  捕获页面仍会自动贡献 `interest.observed`（诊断里的 `兴趣` 行会显示），只是没被声明就不会
  主动生成内容。
- 自主准备内容：当 `curriculumNeeds()` 非空（声明了但 < 6 条命题）或今日推送为空时——
  - 有可用模型：挑「已有命题最少」的领域，每次生成 6 条左右（`generateCurriculum`，actor
    `llm:<model>@curriculum-v1`），成功后 toast `已加入 N 条 · 今日推荐已更新` 并重算推送；
  - 没有模型：在推送下方显示非阻塞提示
    `点 ⚙ 配置模型后，系统会为你主动准备「<领域>」的内容`（保存模型后会立刻重试）。
  - 规则：同一领域**每天最多生成一次**（`chrome.storage.local.latticeCurriculumState =
    { '<领域>': 'YYYY-MM-DD' }`，成功后才写）；同一时刻只允许一个生成在飞；同一页面会话
    不重复尝试同一领域——这三条都在 `newtab/curriculum-guard.js`，可在 Node 里单独测。
- 捕获/声明/曝光只进 C 账，绝不改掌握度或 FSRS：生成的内容是普通命题，会像其他内容一样
  经过合并、卡片生成与推送策略。
- 「清空数据」会连同兴趣与 `latticeCurriculumState` 一起清掉（meta 里的 seed 标记也被删除）。

## 捕获入口（M1b）

- **点工具栏图标** → 抓当前页面正文 → 打开新标签页 → 自动抽取 → 预览 → 确认入库。
- **右键选中文字** → 「存入 Lattice（选中文字）」→ 只抓选中部分。
- 新标签页顶栏「捕获」/ 页脚「捕获文本」→ 手动粘贴。

**默认自动入库**（设置 →「捕获与入库」）：抽取完成后直接写入，只给一条结果 toast，
不弹确认框。关闭该开关后，每次捕获都会先展示命题/推理链让你确认，再入库。
自动入库失败（模型报错、校验不通过、commit 失败）时会自动打开捕获弹窗显示原因。

正文提取（`content/page-extract.js`，注入到当前页）：剔除 nav/header/footer/aside/form/
aria-hidden，优先 article/main/role=main，否则按段落密度选容器，按块级元素保留段落与列表，
上限 12000 字；只读、不改页面、不联网。

**改完扩展文件后必须「重新加载」**：`edge://extensions` → 本扩展 → 重新加载。
只是重启浏览器**不保证**刷新 service worker（Chromium 会按扩展版本缓存代码）。
诊断里的 `后台: m2b-1 ✓` 就是用来暴露这个问题的——如果显示「后台: 未响应」，
说明后台是旧版本，重载即可。发版时请同时 bump `manifest.json` 的 version。

## 捕获文本（M1a）

页脚或空状态的「捕获文本」→ 填标题（可选）+ 粘贴文本 →「抽取」：

1. worker 先按规范化文本的指纹查 `coverage` 表；命中就直接显示「这段内容已经处理过
   （N 条命题，时间）」，并可「仍然重新抽取」。
2. 否则调模型抽取 → 身份消解（已有命题时再一次模型调用）→ 确定性 merge，返回**预览**，
   绝不自动入库。
3. 预览里命题可勾选/改措辞，链按 `前提 A + 前提 B ⟹ 结论 C` 展示（强度 ≥ 0.5 默认勾选），
   被丢弃的链折叠在「查看被丢弃的 N 项」。取消勾选命题会丢弃依赖它的链。
4. 「确认入库」把过滤后的计划交回 worker：一个事务写事件（命题 + 卡片 + 链 + 兴趣/领域）
   + coverage 记录，然后重放全部投影。有领域时 toast 显示
   `已加入「<领域>」· 今日推荐已更新`，否则显示 `已入库 N 条命题 / M 条推理链`。

幂等有三道保护：coverage 命中、同 statement 复用已有命题、同链去重。所以同一段文本/
同一计划重复提交都不会产生重复节点。回退（内存 SQLite）模式下 coverage 会镜像到
`chrome.storage.local.latticeCoverage`，重启后仍然命中。

## 键盘

| 键 | 作用 |
|---|---|
| `空格` / `Enter` | 显示答案 |
| `1` `2` `3` `4` | 重来 / 困难 / 一般 / 简单（复习模式） |
| `1` `2` | 答对了 / 答错了（设置里切到「测验」模式） |
| `Tab` / `Shift+Tab` | 在按钮与输入框之间移动 |
| `Esc` | 关闭对话框 |

## 测试

```bash
npm run build

# 1) 数据层 headless 冒烟测试：内存 SQLite + 假 chrome.storage.local
node packages/extension/test/worker-smoke.mjs

# 2) M1a 捕获链路冒烟测试：假 provider fetch + 真实 service/抽取管线
node packages/extension/test/capture-smoke.mjs

# 2b) M2a 推送层冒烟测试：feed 剂量/同日照去重/跳过疲劳/兴趣排序
node packages/extension/test/feed-smoke.mjs

# 2c) M2c 声明兴趣 + 内置课程 seed 幂等 + 课程生成 + 每日一次守卫
node packages/extension/test/curriculum-smoke.mjs

# 2d) M2b 打扰预算/快照容错/曝光队列/侧栏 DOM 桩/通知 picker
node packages/extension/test/m2b-smoke.mjs

# 3) 真实 MV3 环境 E2E：自动启动 headless Edge/Chrome 并 --load-extension
#    内置本地 stub provider，不需要真实 API Key
node packages/extension/test/extension-e2e.mjs
```

`worker-smoke.mjs`：导入示例包、评级 3 张卡、测验、导出 JSONL → 重放并比对
`stateDigest`、模拟重启（回退持久化）、清空、再把 JSONL 导入空库验证 digest 复原。

`capture-smoke.mjs`：provider 客户端请求格式与 HTTP 错误映射（401/403/404/429/5xx，
中文且不含 Key）、超时/网络错误、`extractPreview → commitExtraction → replay`、
coverage 二次命中不调模型、重复提交幂等、回退模式重启后 coverage 仍在。

`feed-smoke.mjs`：导入示例包后 `feed` 的剂量/形状/reason、`exposure.shown` 当天去重、
`engaged/skipped` 只进 C 账（掌握/调度不变）、跳过两次后不再推、到期复习按 `reviewShare`
限额出现、带 `domain` 的捕获写入 `interest.observed` + `proposition.domain` 并影响排序、
诊断里的推送事实、以及曝光事件跨重启保留。

`curriculum-smoke.mjs`：内置课程一次事务导入 14 命题/3 链 + 声明两个入门领域、重复 seed
幂等（含模拟重启、已有用户内容时不注入）、`declareInterest/removeInterest` 往返、
`curriculumNeeds` 的水平/计数、stub 模型生成 6 命题/1 链且 actor 为
`llm:stub-model@curriculum-v1`、重复生成不产生重复命题、每日一次守卫（hint / generate /
daily-limit / busy / attempted / 次日恢复 / 坏 storage 值），以及诊断字段。

`m2b-smoke.mjs`：在 Node 里加载**同一份** `shared/billboard.js` / `content/sidebar.js` /
`background.js`（classic script + vm + 假 chrome.storage + 迷你 DOM 桩），覆盖：打扰预算的
0/用尽/安静时段/跨天重置、安静时段跨夜窗口、快照容错（旧数据缺 tier/cognitive/domain）、
曝光队列同日去重与跨天不合并、通知 picker（最高分、排除已展示/已通知、错日快照）、
侧栏「最多 2 条 + 知道了/不感兴趣入队 + 30 秒自动收起不算 skip + 小把手重开 + 预算/站点/
安静时段/空快照时不渲染不入队」、以及通知链路「默认关闭 → 开 → 选最高分 → 消耗预算 →
点击 engaged → 用户关闭 skipped、程序化关闭不算 skip」。

`extension-e2e.mjs`：从 background service worker 找到扩展 id，打开新标签页，断言**首次运行
自动 seed** 的 toast、`共 14 命题` 与「今日推送」里的内置领域内容（此时**没有配置模型**）→
在设置里声明「数学」→ 推送下方出现「点 ⚙ 配置模型后…」提示、诊断出现 `兴趣:` / `待生成:` →
通过设置 UI 配置**不发送 CORS 头的本地 stub provider**（真实 DeepSeek/OpenAI 也不发 CORS，
靠清单里的 host_permissions 才能调用）并验证保存后自动为「数学」生成 6 条内容、stub 收到
`课程设计者` 提示、`latticeCurriculumState` 落下今日守卫、生成内容进入今日推送 →
测试连接、复习队列键盘评级、关闭自动入库后捕获文本（预览带领域、确认入库、推送重算）、
再次捕获命中 coverage、`知道了 / 不感兴趣 / 考考我`、诊断的 `推送:` / `兴趣:` / `待生成:` /
`模型:` / `图谱:` 行、每日剂量持久化、刷新后 seed 不重复执行且当天已展示内容不重复推送、
「今天的知识看完了 ✓」空状态、第二个标签页、以及无 console 错误 / CSP 违规。
M2b 额外用 `--host-resolver-rules=MAP www.bilibili.com 127.0.0.1` + `--no-proxy-server`
把本地 stub 页伪装成真实的 `http://www.bilibili.com:<port>/fake-bilibili`，让 manifest
里声明式侧栏 content script **真的在 bilibili 源上运行**：断言侧栏渲染 2 条（含难度星级）、
「知道了」推进并排队 engaged、「不感兴趣」排队 skipped，刷新新标签页后队列被 drain 进
事件日志（诊断 `参与 3 · 跳过 2`、`待入库曝光 0 条`），并验证打扰设置持久化、通知默认关闭。
（找不到浏览器时可用 `CHROME_PATH` 指定，或跳过此测试。）

## 已知边界（M1/M2a/M2b/M2c）

- 捕获目前只有「粘贴文本 / 工具栏抓整页 / 右键抓选区」：PDF、字幕捕获还没做。
- 捕获在调用模型期间不能从 UI 取消：最长等 worker 的 60s 模型超时。
- 预览里「身份消解判定为已有」的命题是只读的（本次只会复用，不会改写那条已有命题）。
- 没有 coverage 管理界面：要重新抽取同一段文本，用预览里的「仍然重新抽取」；彻底清掉
  覆盖记录用「清空数据」。
- 自定义 https provider 的「拒绝授权」分支没有自动化 E2E（需要真实交互授权），但代码路径
  会显示中文错误。
- 无 token 预算显示、无批量捕获、无 MCP/CLI 捕获入口。
- M2a 只做了新标签页推送表面；M2b 补了侧栏 + 系统通知 + 打扰预算，但反事实留白
  （held_back）与 3/7/30 天延迟测验仍未做（无法回答"推送是否真的提高了留存"）。
- M2b 侧栏只覆盖 bilibili.com / youtube.com（含子域），其它站点不注入；侧栏显示 2 条后
  仍按 feed 的"同题一天一次"去重，所以一天内重复打开视频页可能看不到新内容（预算也用完了）。
- 系统通知受浏览器限制：90 分钟闹钟可能被推迟/合并（后台被回收时更明显），默认关闭；
  无通知历史/免打扰白名单，预算用尽后当天不再推送。
- 打扰预算的读-改-写不是严格事务（侧栏与闹钟同时触发时极端概率多算一次）；它是注意力
  节流，不是学习证据，也不进事件日志。
- 侧栏/通知的曝光先存在 `chrome.storage.local`，需要打开一次新标签页（或从后台切回前台）
  才会并入事件日志；期间用同一份本地 guard 保证不重复展示。
- 领域由 LLM 抽取，跨材料可能不一致（示例包是 `economics`，捕获可能是 `经济学`）；
  尚未做领域实体归并，所以兴趣 boost 可能漏配（只会影响排序，不影响掌握）。
- 「考考我」仍是自评对错（命题包格式里没有选项/解析字段）。
- M2c 的「每天一次」守卫只在页面侧（`latticeCurriculumState`）：清浏览器存储或换配置文件会
  让它忘记今天的生成记录（最坏是多生成一批），它不是学习证据，也不写事件日志。
- M2c 生成时用 `buildMergePlan(candidate, {decisions: new Map()})`（全部视为新命题），
  只做**完全相同 statement** 的防御性去重；语义重复（换一种说法）仍可能进图。
- 自主生成只服务于**已声明**的领域；只由捕获推断出的兴趣（`interest.observed`）不会触发
  内容生成。
- 没有「生成中取消」：一次课程生成最多等 worker 的 60s 模型超时，期间不会发起第二次。

## M0 刻意不做

- 无跨设备同步、无账号；导入 JSONL 是唯一的合并方式。
- 测验是「自己先想 → 揭晓 → 自评对错」，因为 M0 命题包格式里没有选项/解析字段。
- 推送层（M2a/M2b）不把曝光当成学习证据：曝光只进 C 账，掌握/调度永远只由作答/评级改变。

## M2b 不做（明确边界）

- 不做"页内角标 / 桌面浮层 / 通知中心"等更多表面；侧栏只做视频站。
- 不做个性化打断成本模型（当前页面类型/时段/最近打断次数）；预算只是每日固定次数。
- 不做反事实留白与延迟测验（设计文档 §9.2 的下一步）。
- 不做侧栏内答题：侧栏只有 知道了 / 不感兴趣 / 打开 Lattice；验证仍在「考考我」里。

