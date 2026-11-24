# Lattice 扩展（M0 骨架 + M1 捕获 + M2a 推送 + M2c 兴趣/自主内容）

Chrome/Edge 的 MV3 扩展：把新标签页变成 Lattice 的**今日推送**表面。
M0 的离线数据脊柱（事件日志 → 投影 → 复习）保持不变；M1a/M1b 增加了**用户主动触发**的
捕获链路：粘贴文本/抓取页面 → 你配置的 OpenAI 兼容模型抽取命题/推理链/领域 → 预览确认 → 入库。
M2a 把捕获的语义改成**兴趣信号**：知识像广告一样按小剂量推送，验证（复习/测验）是可选项。
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

> 不需要在扩展页里打开任何文件；`chrome://newtab` 就是入口。

## 目录

```
manifest.json            MV3 清单（含模型接口的 host_permissions / optional_host_permissions）
background.js            最小 service worker（M0 无后台任务）
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
test/extension-e2e.mjs   真实 MV3 E2E（含本地 stub provider，无需真实 Key）
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

- 卡片：`领域` 徽标 + `基础/前沿/复习` 标签 + 命题（标题）+ 一句提示（有卡片时）+ 灰色 meta
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
  追加一条 C 账事件并返回重算后的 feed；`diagnostics()` 增加 `feed` 字段。

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
诊断里的 `后台: m1b-capture-1 ✓` 就是用来暴露这个问题的——如果显示「后台: 未响应」，
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
（找不到浏览器时可用 `CHROME_PATH` 指定，或跳过此测试。）

## 已知边界（M1/M2a/M2c）

- 捕获目前只有「粘贴文本 / 工具栏抓整页 / 右键抓选区」：PDF、字幕捕获还没做。
- 捕获在调用模型期间不能从 UI 取消：最长等 worker 的 60s 模型超时。
- 预览里「身份消解判定为已有」的命题是只读的（本次只会复用，不会改写那条已有命题）。
- 没有 coverage 管理界面：要重新抽取同一段文本，用预览里的「仍然重新抽取」；彻底清掉
  覆盖记录用「清空数据」。
- 自定义 https provider 的「拒绝授权」分支没有自动化 E2E（需要真实交互授权），但代码路径
  会显示中文错误。
- 无 token 预算显示、无批量捕获、无 MCP/CLI 捕获入口。
- M2a 只做了新标签页这一个推送表面：侧栏/通知/打断预算、反事实留白（held_back）与
  3/7/30 天延迟测验都还没做。
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
- 推送层（M2a）不做通知/侧栏，也不把曝光当成学习证据。

