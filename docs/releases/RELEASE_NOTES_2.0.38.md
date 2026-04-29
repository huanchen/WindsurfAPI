## v2.0.38 — 一波三连：#100 cwd fallback / #101 cascade timeout invalidation / #102 kimi-k2-6 dialect

### #100 yunduobaba — opus 拒绝读 Windows path

**症状**：用户在 VPS 上跑 proxy + Windows 上跑 claudecode，对 opus-4-7 说"分析 `C:\Users\renfei\Downloads\WindsurfAPI-master` 这个项目"，opus 不是 emit Read/Glob tool_call 让 claudecode 在本地 Windows 执行，而是直接脑补一段 JSON：

```json
{"project":"WindsurfAPI","path":"...","status":"not_analyzed","reason":"path is on a Windows local machine and is not accessible from the current Linux workspace (…). No files from that project are available for inspection.","suggestion":"Please copy the WindsurfAPI-master directory into the current workspace, or run this analysis on the Windows machine where the files reside, so the contents (package.json, source files, README) can be read and analyzed."}
```

**根因**：用户的 claudecode 没在 system prompt 里发 canonical `<env>` block（fork / 旧版 / 自定义编译），proxy 的 `extractCallerEnvironment` 拿不到 cwd → cascade 上游内置 system prompt 的"workspace is /tmp/windsurf-workspace"赢了 → 模型混合了 emulated tool_call（成功 emit 了 list_directory）和 cascade 内置 prompt 的"Linux workspace"先验，最终输出脑补 JSON。

debug log 关键行：
```
01:45:58 Chat[63jw4n]: env NOT lifted (extractor returned empty); nearest env-shaped substring in messages: ntEnvFromSystem()`
01:46:00 ToolParser: matched xml format, name=list_directory   ← 模型其实 emit 了
```

**修法**：`extractCallerEnvironment` 加最后 fallback —— 当所有现有 patterns 都没拿到 cwd 时，扫描第一条 user message 的开头，匹配裸 absolute path（Windows `C:\...` / Unix `/home/...` / Tilde `~/...`），拿来当 cwd hint 注入 tool_calling_section。

保守约束（避免误伤）：
- 仅扫 **role=user** 的 message（不扫 system / assistant）
- 仅匹配 **第一个** user message 的开头（path 必须是首个非琐碎 token，不接受 mid-prose path）
- 路径以常见 file extension 结尾的拒绝（那是 file 不是 cwd）
- `^[A-Z]:[\\/]|^\/[A-Za-z]|^~[\\/]` 三种绝对路径 shape

yunduobaba 的 prompt `C:\Users\renfei\...分析下这个项目`（path 直接和中文连一起没空格）能正确 lift。

加了 9 个 regression test 覆盖正反例。

### #101 nalayahfowlkest-ship-it — cascade timeout 后下轮上下文丢

**症状**：v2.0.37 升完后用 claude-opus-4.6-thinking + Claude Code，先报：

```
API Error: {"type":"error","error":{"type":"upstream_error","message":"Encountered retryable error from model provider: context deadline exceeded (Client.Timeout or context cancellation while reading body)"}}
```

下一轮模型说：

> I can see the content from a previous tool call ... However, I don't have the earlier conversation context that explains what specific task you'd like me to work on.

**根因**：cascade 上游 model provider 超时 mid-stream，trajectory 被留在 inconsistent state（assistant 没说完，但前面的 tool_result chunk 在里面）。proxy 之前只在 client.js 显式 catch 到"cascade not_found"时才 mark `reuseEntryDead=true`，对于"context deadline exceeded"这种上游 timeout **不识别**，于是 stream 失败后照常把 cascade entry 还回 reuse pool。下一个请求 reuse 命中 → cascade 上游加载半坏的 trajectory → 模型只看见尾部 tool_result，前面 user prompt 全丢。

**修法**：stream 和 non-stream 两条 catch 路径都加上：

```js
if (/context deadline exceeded|context cancellation while reading body|client\.timeout/i.test(err.message)) {
  reuseEntryDead = true;
}
```

dead 的 entry 不会被 `poolCheckin` 还回 pool。下次请求拿到 fresh cascade，proxy 重新 replay 完整 message history 给 cascade，模型至少看得到全部上下文（即便 cascade 自己得从头来）。

加了 4 个 regression test：
- 静态校验 stream 路径的 catch 区域包含 timeout 正则 + `reuseEntryDead = true`
- 静态校验 non-stream 路径同样有
- 正例测试：用户报的字面错误串能匹配
- 反例测试：rate limit / panel state / cascade not_found 不会误命中

### #102 cookire — kimi-k2-6 cascade 报 "invalid tool call"

**症状**：OpenCode + `kimi-2.6`（即 model key `kimi-k2-6`）报 cascade 上游错误：

```
[WARN] Cascade error step {errorText=The model produced an invalid tool call. trail=[{type:34,status:3},{type:14,status:3},{type:15,status:3},{type:17,status:3}]}
[ERROR] Stream error after retries: The model produced an invalid tool call.
```

**根因**：`pickToolDialect` 之前看到任何 `kimi-*` 或 provider=`moonshot` 都路由到 `kimi_k2` vLLM 方言（`<|tool_calls_section_begin|>...<|tool_call_begin|>...`）。这个方言只在原版 `kimi-k2` / `kimi-k2-thinking` 上验证过——cascade 上游对那两个 SKU 自带匹配的 parser。新出的 `kimi-k2.5` / `kimi-k2-6` 由不同 runtime serve，cascade 上游的 parser 不接受 vLLM markup，直接 reject 报 "invalid tool call"。

**修法**：把 `pickToolDialect` 收紧——只有显式 `kimi-k2` / `kimi-k2-thinking` 才用 `kimi_k2` 方言，其他所有 Moonshot SKU 默认走 `openai_json_xml`（`<tool_call>{...}</tool_call>`，cascade 通用接受）。

```diff
 if (normalizedProvider === 'moonshot' || normalizedModelKey.startsWith('kimi')) {
-  return 'kimi_k2';
+  if (normalizedModelKey === 'kimi-k2' || normalizedModelKey === 'kimi-k2-thinking') {
+    return 'kimi_k2';
+  }
+  return 'openai_json_xml';
 }
```

加了 2 个 regression test 锁定路由表（K2/K2-thinking → vLLM；K2.5/K2-6 → openai_json_xml）。

### 数字

- **测试**：v2.0.37 之前 403 → v2.0.38 现在 **418**（+15 / 0 失败）
- **suites**：81 → **83** (+2)
- **代码改动**：
  - `src/handlers/chat.js`: extractCallerEnvironment + scanUserMessageForBareCwd helper（#100）；stream + non-stream catch 加 timeout invalidation（#101）
  - `src/handlers/tool-emulation.js`: pickToolDialect 收紧（#102）
- **API 不变**：旧客户端不受影响
- **依赖不变**：仍然 zero-dep

### 升级路径

```
docker compose pull && docker compose up -d
```

升完后：
- **#100 用户**：在 user prompt 开头写 path 就能自动当 cwd 用，opus 应该正确 emit Read/Glob tool_call
- **#101 用户**：cascade 上游再 timeout 时下一轮不会"失忆"，proxy 重发完整 history
- **#102 用户**：kimi-k2-6 / kimi-k2.5 在 OpenCode / 任何客户端下都能正常 tool-call
