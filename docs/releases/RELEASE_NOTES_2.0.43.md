## v2.0.43 — #103 + #104：allowlist 思考变体继承 + JSON 模式跨轮污染

两个长期没解决的体验 bug 一起处理。一个是 issue 区里 denvey 提的，一个是 ccnetcore 在 #104 里贴的「问候 `你好` 收到 `{"reply":"你好"}`」。

### 修法一：allowlist/blocklist 自动继承 -thinking 变体（#103）

**症状**：dashboard 显示的是基础模型名（`claude-opus-4.6`），用户在 allowlist 里加了它，结果走到 reasoning 路径请求 `claude-opus-4.6-thinking` 时直接 403 `model_blocked`，错误信息提到的模型名跟用户配置的对不上，没有任何线索能让用户自己排查。blocklist 反过来：运营把基础模型拉黑，`-thinking` 还是放过去。

**修法**：`isModelAllowed` 增加一个仅针对 `-thinking` 后缀的兄弟查找。基础模型在名单里时同时认 `-thinking` 变体，反过来也成立。

```js
function siblingsForAllowlist(modelId) {
  const sibs = [];
  if (modelId.endsWith('-thinking')) {
    sibs.push(modelId.slice(0, -'-thinking'.length));
  } else {
    sibs.push(modelId + '-thinking');
  }
  return sibs;
}
```

继承范围**只限 `-thinking`**。其他后缀（`-fast` / `-1m` / `-low|medium|high|xhigh` / `-mini` / `-nano` / `-codex` / `-max-*`）刻意不继承——那些是真的不同 entitlement（上下文窗口、延迟档、定价、模型架构），互通会让真的想细粒度控制的运营踩坑。

8 个新 regression test（`test/model-access-thinking-inheritance.test.js`）覆盖：

- 基础 → -thinking 继承（allowlist & blocklist）
- -thinking → 基础反向继承
- 不相关后缀（`-fast`/`-1m`/`-high`/`-mini`/`-codex`）**不**继承
- empty allowlist 仍然拒一切
- mode=all 时 list 被忽略

### 修法二：JSON 模式不再污染 cascade reuse 轨迹（#104）

**症状**：用 `claude-opus-4-7` 这种支持 cascade reuse 的模型，第一轮明确说"用 JSON 回答 keys: ..."，第二轮换成纯问候 `你好`，模型仍然返回 `{"reply":"你好"}`。号池里复现了，确实长期存在。

**根因**：`applyJsonResponseHint` 早期版本里，除了塞一个 `system` message，**还把 JSON-only 的长指令 append 到最近一条 user message 的 content 末尾**。这条被 cascade 上游存进了对话 trajectory。下一轮请求复用同一个 cascade 时，上游历史里仍然挂着「上一条用户消息：... [You MUST respond with valid JSON only ...]」，于是新一轮即使不要求 JSON，模型仍然按 trajectory 的暗示走 JSON 模式。

system message 不会进 trajectory（它是每轮重建的），所以问题完全出在 user content append 这一步。

**修法**：`applyJsonResponseHint` **只**注入 system message，**不再**改 user content 一个字符。

```js
export function applyJsonResponseHint(messages, responseFormat) {
  let sysContent = 'Respond with valid JSON only. ...';
  if (responseFormat?.type === 'json_schema' && ...) {
    sysContent += ' Conform to this JSON Schema:\n' + JSON.stringify(...);
  }
  return [{ role: 'system', content: sysContent }, ...messages];
}
```

system message 对 cascade routing 来说本身就更权威（cascade 上游不会把它当历史保存），既能在本轮强制 JSON 又不会渗到下一轮。

把整段 `appendJsonHintToContent` helper 删了（没人用了），把 `extractRequestedJsonKeys` 里残留的「split off 旧后缀」防御代码也清了——hint 不再进 user content 后这段是死代码。

3 个新 regression test（在 `test/messages.test.js`）：
- `applyJsonResponseHint` 后 user content 必须**字节级等于**输入
- tool_result 也不会被改
- 跨轮污染场景：明确断言 hinted user message 里**不含** "JSON only" 字样

加上把 thinking-routing.test.js 里那个原本断言 #103 bug 行为的 case 翻过来（现在断言「base 在 allowlist 时 -thinking 不被 block」）。

### 数字

- 测试：v2.0.42 是 457 → v2.0.43 是 **466** (+9 / 0 失败)
- suites：96 → **97** (+1)
- 代码改动：
  - `src/dashboard/model-access.js`: -thinking 兄弟继承
  - `src/handlers/chat.js`: `applyJsonResponseHint` 只注入 system / 删 `appendJsonHintToContent` / 清 `extractRequestedJsonKeys` 死代码
  - `test/model-access-thinking-inheritance.test.js`: 新文件
  - `test/messages.test.js` / `test/thinking-routing.test.js`: 翻转断言到新行为
- API 不变：`applyJsonResponseHint(messages, responseFormat)` 签名一样，只是不再改 user content

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后：

- dashboard 里把基础模型加进 allowlist 就够了，`-thinking` 自动放行（反之 blocklist 也是）
- 多轮对话里第一轮要求 JSON 不会再让后续不相关的轮次也走 JSON 模式
- 老用户存在客户端 / 缓存里的对话历史是干净的（user content 一直没被改过本身）
