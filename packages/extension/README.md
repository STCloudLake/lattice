# Lattice 扩展（M0 骨架）

Chrome/Edge 的 MV3 扩展：把新标签页变成 Lattice 的复习表面。
M0 完全离线——没有 LLM、没有网络请求、没有遥测；数据只在本机浏览器里，可导出成纯文本 JSONL。

## 构建

在仓库根目录：

```bash
npm run build
```

`packages/extension/vendor/` 由 `scripts/build-extension.mjs` 生成（已 gitignore）：

- `vendor/lattice-core/` —— 打包好的 `@lattice/core`（ESM）
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
manifest.json            MV3 清单
background.js            最小 service worker（M0 无后台任务）
newtab/                  新标签页 UI（HTML/CSS/原生 JS，无框架、无内联脚本）
worker/                  RPC worker —— 唯一写事件日志的地方
  worker.js              RPC 分发 + 打开数据库 + 回退持久化
  service.js             事件日志/投影/导入导出（DB 可注入，可被 Node 测试）
  db.js                  sqlite-wasm 封装：OPFS → OPFS SAH pool → 内存
  persist.js             回退模式：整份事件日志 JSONL 存 chrome.storage.local
  util.js
data/sample-pack.json    示例命题包（来自 examples/sample-pack.json）
test/worker-smoke.mjs    headless 冒烟测试（内存 SQLite + 假 chrome.storage）
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

# 2) 真实 MV3 环境 E2E：自动启动 headless Edge/Chrome 并 --load-extension
node packages/extension/test/extension-e2e.mjs
```

`worker-smoke.mjs`：导入示例包、评级 3 张卡、测验、导出 JSONL → 重放并比对
`stateDigest`、模拟重启（回退持久化）、清空、再把 JSONL 导入空库验证 digest 复原。

`extension-e2e.mjs`：从 background service worker 找到扩展 id，打开新标签页，
载入示例包，用真实键盘事件（空格 + 数字键）答题，读诊断面板，刷新验证持久化，
再开第二个标签页确认多标签可用，并断言无 console 错误 / CSP 违规。
（找不到浏览器时可用 `CHROME_PATH` 指定，或跳过此测试。）

## M0 刻意不做

- 无 LLM、无网页/PDF 捕获、无知识图谱抽取、无路径规划、无推送策略（M1/M2）。
- 测验是「自己先想 → 揭晓 → 自评对错」，因为 M0 命题包格式里没有选项/解析字段。
- 无跨设备同步、无账号；导入 JSONL 是唯一的合并方式。

