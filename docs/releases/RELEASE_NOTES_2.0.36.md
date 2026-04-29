## v2.0.36 — 修 #93 routingModelKey ReferenceError + #98 workspace 标记 shell-redirect

### 真的有 (P0 stream 完结崩)

zhangzhang-bit 在 #93 贴的图：

```
你好
{"message": "你好！我是 Claude Sonnet 4.6，由 Anthropic 开发。有什么我可以帮助你的吗？"}

API Error: {"type":"error","error":{"type":"upstream_error","message":"routingModelKey is not defined"}}
正常回复以后还会报一个模型错误的 错误
```

**正常响应是发出去了，stream 完结的时候 ReferenceError 崩**。

### 根因

v2.0.33 我加 GLM5.1 silence fallback (`shouldFallbackThinkingToText`) 的时候，引用了 `routingModelKey` 和 `body`：

```js
// chat.js:2087 (streamResponse 内)
if (shouldFallbackThinkingToText({
  routingModelKey,   // ← 这个变量根本不在 streamResponse 作用域里
  body,              // ← body 也不在
  ...
}))
```

`streamResponse` 是 top-level 函数，签名是 `function streamResponse(id, created, model, modelKey, ...)` —— 它接收的参数叫 `modelKey`（caller 那边传的就是 `routingModelKey`，但函数内部参数名是 `modelKey`）。

JS 对象 shorthand `{ routingModelKey }` 等于 `{ routingModelKey: routingModelKey }` —— 在 streamResponse 作用域里 `routingModelKey` 没定义，立马 ReferenceError 抛出。

每个 stream finish 都会触发，所以**整个 v2.0.33 / v2.0.34 / v2.0.35 上所有 stream 响应都是这样：响应正常发，结尾爆错**。

### 修法

把 `shouldFallbackThinkingToText` 的签名从 `body` 改成 `wantThinking` boolean——一次在 `handleChatCompletions`（body 在作用域里）算好，通过 deps 透传：

```diff
-export function shouldFallbackThinkingToText({ routingModelKey, body, ... }) {
+export function shouldFallbackThinkingToText({ routingModelKey, wantThinking, ... }) {
   ...
-  if (body && (body.reasoning_effort || body.thinking?.type === 'enabled')) return false;
+  if (wantThinking) return false;
   return true;
 }
```

call sites:
- streamResponse 走 `deps.wantThinking`（caller 在 chat.js:1190 那边塞进去）
- nonStreamResponse 加新 trailing 参数 `wantThinking = false`，caller 传 `wantThinking`

加了 lock-in regression test：

```js
it('signature has no `body` param — guards against #93 ReferenceError regression', () => {
  const src = shouldFallbackThinkingToText.toString();
  const args = src.match(/^function\s+\w+\s*\(\s*\{([^}]+)\}/)[1];
  assert.ok(!/\bbody\b/.test(args));
  assert.ok(/\bwantThinking\b/.test(args));
});
```

以后再有人改回 body 参数会立刻挂掉。

### 顺便修了 #98 workspace 标记 shell-redirect

nalayahfowlkest-ship-it 在 #98 报的：

```
IN: find <workspace> -type f -name '*.md'
OUT: /usr/bin/bash: line 1: workspace: No such file or directory
```

模型把 `<workspace>` 当成字面值塞进 shell command —— 但 bash 把 `<` 解析成输入重定向，所以 `find < workspace -type f` 等价于"以 workspace 文件为输入运行 find"，shell 找不到 workspace 文件就 die。

v2.0.33 我加了 system prompt 提示"workspace path is hidden, use relative paths"，但提示太软，模型还是会把字面 `<workspace>` 拼进命令。

**v2.0.36 改强**：

```diff
-Your sandbox workspace path is hidden from the user; if asked for path/cwd,
-say real path unavailable; use relative/tool paths.
+Workspace path hidden; "<workspace>" is a redaction marker, NOT a path —
+never pass it to shell tools (shell reads "<" as redirection). Use "."
+for cwd or relative paths. If asked for cwd, say unavailable.
```

显式说"redaction marker, NOT a path"和"shell reads '<' as redirection" —— 把"为啥不能用"也告诉模型，避免它觉得这只是提示。

5 个 preamble builder 都用同一个常量，所以一处改全覆盖。preamble 长度从 138 chars → 235 chars，仍在 640 chars hard cap 内。regression test 改成同时断言 `workspace path hidden` 和 `redaction marker` 两个关键短语都在。

### 没修：claudecode 503 "no available accounts"

zhangzhang-bit 报的另一个：

```
❯ 你好
⎿ API Error: 503 No available accounts: no available accounts.
  This is a server-side issue, usually temporary
```

我们 proxy 的 503 错误信息是 `'No active accounts'`、`'账号队列超时: <reason>'`、`'No active accounts available'` —— 但用户看到的是 "no available accounts" 全小写。

**怀疑**：这不是我们 proxy 直接产出的串。可能是：
- sub2api 中间层把我们的 503 回包改写过
- claudecode CLI 自己看到 503 后展示一个 generic message

需要用户提供 `LOG_LEVEL=debug` 重启后复现的 server 日志才能定位。如果实际发出的是我们的"账号队列超时"，那是另一类问题（账号不够 / probe 还没跑完 / model 在该账号 tier 不可用）；如果发出的是 "No active accounts" 但客户端看到了别的串，那就是中间层重写。

### 数字

- **测试**：v2.0.35 之前 400 → v2.0.36 现在 **399**（-1：thinking-fallback-glm.test.js 整理掉一个 redundant body-shape test，新加一个 signature-shape regression test，净 -1）
- **suites**：81（不变）
- **代码改动**：3 处函数签名（shouldFallbackThinkingToText / nonStreamResponse / streamResponse deps）+ 1 处常量字符串（WORKSPACE_PATH_HINT）
- **API 不变**：旧客户端不受影响
- **依赖不变**：仍然 zero-dep

### 影响范围

- v2.0.33 / v2.0.34 / v2.0.35 用户现在每次 stream 响应都会有结尾 ReferenceError —— 升 v2.0.36 后清掉
- #98 用户用 emulated tools (GLM/Kimi) 在 claudecode/openclaw 跑 Bash 时会不再卡 `find <workspace>` 类语句

### 升级路径

```
docker compose pull && docker compose up -d
```
