# Lattice 扩展（M0 骨架 + M1a 捕获）

Chrome/Edge 的 MV3 扩展：把新标签页变成 Lattice 的复习表面。
M0 的离线数据脊柱（事件日志 → 投影 → 复习）保持不变；M1a 增加了一条**用户主动触发**的
捕获链路：粘贴文本 → 你配置的 OpenAI 兼容模型抽取命题/推理链 → 预览确认 → 入库。
没有后台爬取、没有遥测；数据只在本机浏览器里，可导出成纯文本 JSONL。

## 构建

在仓库根目录：

```bash
npm run build
```

`packages/extension/vendor/` 由 `scripts/build-extension.mjs` 生成（已 gitignore）：

- `vendor/lattice-core/` —— 打包好的 `@lattice/core` + `@lattice/extract`（ESM）
- `vendor/sqlite-wasm/` —— sqlite-wasm 官方 dist（含 `sqlite3.wasm`）

## 加载（开发者模式）

1. 先跑 `npm run build`。
2. Chrome/Edge 打开 `chrome://extensions`（Edge：`edge://extensions`）。
3. 打开右上角「开发者模式」。
4. 点「加载已解压的扩展程序」，选择 `packages/extension/` 目录。
5. **新开一个标签页**（`chrome_url_overrides.newtab` 会接管新标签页）。
6. 首次是空状态：点「载入示例包」，然后按空格显示答案、按 1–4 评级。

> 不需要在扩展页里打开任何文件；`chrome://newtab` 就是入口。

## 目录

```
manifest.json            MV3 清单（含模型接口的 host_permissions / optional_host_permissions）
background.js            最小 service worker（M0 无后台任务）
newtab/                  新标签页 UI（HTML/CSS/原生 JS，无框架、无内联脚本）
worker/                  RPC worker —— 唯一写事件日志的地方
  worker.js              RPC 分发 + 打开数据库 + 回退持久化
  service.js             事件日志/投影/导入导出/抽取确认入库（DB 可注入，可被 Node 测试）
  llm.js                 OpenAI 兼容模型客户端（BYOK，60s 超时，中文错误）
  db.js                  sqlite-wasm 封装：OPFS → OPFS SAH pool → 内存
  persist.js             回退模式：整份事件日志 JSONL（+ coverage 镜像）存 chrome.storage.local
  util.js
data/sample-pack.json    示例命题包（来自 examples/sample-pack.json）
test/worker-smoke.mjs    M0 数据层冒烟测试（内存 SQLite + 假 chrome.storage）
test/capture-smoke.mjs   M1a 捕获链路冒烟测试（假 provider fetch + coverage/幂等）
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

诊断面板（页脚「诊断」）会显示 `存储: OPFS` 或 `存储: 回退(chrome.storage)`、实际 VFS，以及回退原因。

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

## 捕获文本（M1a）

页脚或空状态的「捕获文本」→ 填标题（可选）+ 粘贴文本 →「抽取」：

1. worker 先按规范化文本的指纹查 `coverage` 表；命中就直接显示「这段内容已经处理过
   （N 条命题，时间）」，并可「仍然重新抽取」。
2. 否则调模型抽取 → 身份消解（已有命题时再一次模型调用）→ 确定性 merge，返回**预览**，
   绝不自动入库。
3. 预览里命题可勾选/改措辞，链按 `前提 A + 前提 B ⟹ 结论 C` 展示（强度 ≥ 0.5 默认勾选），
   被丢弃的链折叠在「查看被丢弃的 N 项」。取消勾选命题会丢弃依赖它的链。
4. 「确认入库」把过滤后的计划交回 worker：一个事务写事件（命题 + 卡片 + 链）+ coverage
   记录，然后重放全部投影。toast 显示 `已入库 N 条命题 / M 条推理链`。

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

# 3) 真实 MV3 环境 E2E：自动启动 headless Edge/Chrome 并 --load-extension
#    内置本地 stub provider，不需要真实 API Key
node packages/extension/test/extension-e2e.mjs
```

`worker-smoke.mjs`：导入示例包、评级 3 张卡、测验、导出 JSONL → 重放并比对
`stateDigest`、模拟重启（回退持久化）、清空、再把 JSONL 导入空库验证 digest 复原。

`capture-smoke.mjs`：provider 客户端请求格式与 HTTP 错误映射（401/403/404/429/5xx，
中文且不含 Key）、超时/网络错误、`extractPreview → commitExtraction → replay`、
coverage 二次命中不调模型、重复提交幂等、回退模式重启后 coverage 仍在。

`extension-e2e.mjs`：从 background service worker 找到扩展 id，打开新标签页，
载入示例包，用真实键盘事件（空格 + 数字键）答题，读诊断面板，刷新验证持久化；
然后启动一个**不发送 CORS 头的本地 OpenAI 兼容 stub provider**（真实 DeepSeek/OpenAI
也不发 CORS，靠清单里的 host_permissions 才能调用），通过设置 UI 配置模型、测试连接、
捕获文本、断言预览 3 命题 + 1 链、确认入库后计数变化、再次捕获命中 coverage、诊断显示
`模型:`/`图谱:` 行；再开第二个标签页确认多标签可用，并断言无 console 错误 / CSP 违规。
（找不到浏览器时可用 `CHROME_PATH` 指定，或跳过此测试。）

## 已知边界（M1a）

- 捕获目前只有「粘贴文本」：网页选区/整页/PDF/字幕捕获与 Readability 正文抽取还没做。
- 捕获在调用模型期间不能从 UI 取消：最长等 worker 的 60s 模型超时。
- 预览里「身份消解判定为已有」的命题是只读的（本次只会复用，不会改写那条已有命题）。
- 没有 coverage 管理界面：要重新抽取同一段文本，用预览里的「仍然重新抽取」；彻底清掉
  覆盖记录用「清空数据」。
- 自定义 https provider 的「拒绝授权」分支没有自动化 E2E（需要真实交互授权），但代码路径
  会显示中文错误。
- 无 token 预算显示、无批量捕获、无 MCP/CLI 捕获入口。

## M0 刻意不做

- 无网页/PDF 捕获、无路径规划、无推送策略（M1/M2 之后）。
- 测验是「自己先想 → 揭晓 → 自评对错」，因为 M0 命题包格式里没有选项/解析字段。
- 无跨设备同步、无账号；导入 JSONL 是唯一的合并方式。

