## v2.0.37 — 修 #93 follow-up：apiKey 模式 cascade reuse 不工作

### 真的有

zhangzhang-bit 升 v2.0.36 后还是报 "ID 还是每次都变化"，贴的 log：

```
01:25:26 CascadeChat: uid=claude-opus-4-6-thinking enum=0 msgs=42 reuse=false
01:25:52 CascadeChat: uid=claude-opus-4-6-thinking enum=0 msgs=44 reuse=false
01:26:33 CascadeChat: uid=claude-opus-4-6-thinking enum=0 msgs=52 reuse=false
```

`msgs` 一路涨到 52 但每次 `reuse=false`，cascadeId 每轮都换——说明 cascade reuse 根本没启用。

### 根因

v2.0.25 加过一个保护：**callerKey 没有 per-user 维度时禁用 cascade reuse**，防止"两个 end-user 用同一个 apikey 互串 cascade 状态"：

```js
const sharedApiKeyNoScope = !hasPerUserScope(callerKey) && !CASCADE_REUSE_ALLOW_SHARED_API_KEY;
```

`hasPerUserScope` 当时检查：
- `callerKey.includes(':user:')` — body 里有 `user` / `metadata.user_id` / `previous_response_id` 这种用户信号
- `callerKey.startsWith('session:')` 或 `'client:')` — header 提供了 session id 或者完全没 apikey 时 fallback 到 IP+UA

但 `callerKeyFromRequest` 在 **apiKey 存在但 body 没用户信号**时，直接 return `api:<hash>` — 没 fallback 到 IP+UA。所以 zhangzhang-bit 的场景：
- 自建服务器，单用户用 apikey 跑 claudecode
- claudecode 没发 `metadata.user_id`（旧版本 / 自定义编译）
- → callerKey = `api:<hash>` → `hasPerUserScope` = false → reuse 全程禁用

每次新请求都拿不到 cascade pool 里的旧 entry，cascadeId 重新开，cascade 内部的中间状态（已读文件 mental model、思考链）全丢——看起来就是"上下文丢"。

### 修法

**callerKeyFromRequest** 在 apiKey 模式 + 无 body subKey 时，**自动加 `:client:<ip+ua-hash>` fallback subkey**：

```diff
 if (apiKey) {
   const base = `api:${sha256Hex(apiKey).slice(0, 32)}`;
-  return bodySubKey ? `${base}:user:${bodySubKey}` : base;
+  if (bodySubKey) return `${base}:user:${bodySubKey}`;
+  const ipua = ipUaFingerprint(req);
+  return ipua ? `${base}:client:${ipua}` : base;
 }
```

`hasCallerScope` / chat.js 本地的 `hasPerUserScope` 同步把 `:client:` substring 也算 scope（不仅 prefix）。

效果：
- **单用户自建场景**：同一个 IP/UA 跨多轮 → 同一 callerKey → cascade 命中 ✓
- **多用户共享 apikey**：不同 IP / 不同 UA → 不同 subkey → 不串话 ✓
- **NAT 后多设备同 IP+UA**：仍然可能撞 — 这种情况下要靠 body.metadata.user_id 细分（已有逻辑没动）

### 测试

caller-key.test.js +3 个 test：
- 验证 fallback subkey 形态 `^api:[a-f0-9]+:client:[a-f0-9]{16}$`
- 验证不同 IP/UA → 不同 subkey（多用户隔离）
- 验证同 IP/UA → 同 subkey（reuse 命中前提）
- 验证 IP+UA 都为空时回落到 bare apikey

```
✔ caller-key tests
ℹ tests 403 (was 400)
ℹ pass 403
ℹ fail 0
```

### 数字

- **测试**：v2.0.36 之前 399 → v2.0.37 现在 **403**（+4）
- **代码改动**：caller-key.js +20 行（fallback + helper），chat.js +5 行（hasPerUserScope 加 `:client:` 检查）
- **API 不变**：旧客户端不受影响
- **依赖不变**：仍然 zero-dep

### 回退

如果发现 reuse 反而带来问题（账号串话 / cascade not found 之类），可以用 env 关掉：

```bash
WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE=1   # 仅关 sonnet 4.6
```

或者完全禁用所有自动 reuse fallback——目前没单独 env 关 client-fallback subkey，需要的话开 issue 我加。

### 升级路径

```
docker compose pull && docker compose up -d
```

升完后 server log 应该能看到：
- 第二轮起 `reuse=true` 出现
- cascadeId 不再每轮换
- `msgs` 数字也会重置（reuse 后 cascade 自己保留状态，不需要每次重发完整历史）
