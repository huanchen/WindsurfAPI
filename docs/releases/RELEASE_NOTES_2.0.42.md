## v2.0.42 — 审计驱动的三处加固

v2.0.41 LS file-busy / docker self-update 上车后顺手开了一轮深度审计，按"跟刚修的那俩 bug 同类"分四个方向爬：文件覆写竞态 / 全局共享状态 / 含义模糊的返回值 / dashboard 没接通的能力。

下面三个就是审计抓出来值得这一轮处理的，都直接落地了。剩下的（dashboard backup-restore / 多 replica 共享 accounts.json / runtime settings 暴露 等）排到后面单独做。

### 修法一：cache key 跨租户泄漏（P0）

**根因**：`src/cache.js` 的 `cacheKey(body)` 只对 normalize 后的请求体做 sha256，**不带 caller 维度**。结果是：

- 用户 A 通过 API key X 发 `messages:[{role:'user',content:'hi'}]` → 缓存命中前未命中，存入
- 用户 B 通过 API key Y 发同样的 body → 命中 A 的缓存，**直接拿到 A 的回复**

虽然普通 chat completion 大部分情况下 body 差异足够大（messages 内容、tool_choice、metadata 都参与 hash），但只要两个 caller 用同模型问同一句简短问题就会撞。privacy 影响真实。

**修法**：

```js
export function cacheKey(body, callerKey = '') {
  const scope = String(callerKey || '');
  const json = JSON.stringify(normalize(body));
  return createHash('sha256').update(scope).update('\0').update(json).digest('hex');
}
```

`\0` 分隔符防止有人伪造 body 字段（比如 `model:'api:victim'`）跟另一个 caller 的 scope 串拼成同一字符串。

`src/handlers/chat.js:1240` 改为 `cacheKey(body, callerKey)`。callerKey 是 v2.0.37 起就有的请求作用域（`api:<hash>:user:<...>` 或 `api:<hash>:client:<ip+ua>`）。

加 4 个 regression test：
- 同 body 不同 caller → 不同 key
- 同 caller 同 body → 同 key（确认 cache 还能用）
- 空 callerKey 跟真实 callerKey 不撞
- 用 body 内字段伪造 scope 撞不出真 caller 的 key

### 修法二：conversation-pool checkout 删除-在-验证-之前（P1）

**根因**：`src/conversation-pool.js:checkout` 流程是

```js
const entry = _pool.get(fingerprint);
if (!entry) return null;
_pool.delete(fingerprint);          // ← 先删
if (entry.callerKey !== callerKey) return null;   // ← 再验
```

正常请求当然没事，但这种边缘场景下：

- 用户 Alice 的会话被 fingerprint A 缓存
- 某次 Bob 的请求碰巧 fingerprint 也是 A（极少但可能：相同 messages 历史 + 相同 model + 同 tools），但 callerKey 不同
- Bob 的 checkout 走进来，先 `_pool.delete(A)`，然后 callerKey 不匹配返回 null
- **Alice 的 cascade entry 没了**。Alice 下一轮请求 reuse miss，重新建 cascade，丢前面的 trajectory cache，cascade 上游要从头来

并不是数据泄漏（callerKey 不匹配确实拒了），是**误伤无辜方**——别人撞 fp 把你的会话顺路删了。

**修法**：把 `_pool.delete` 挪到所有验证通过之后，只在确认要 hand 给 caller 时才消费：

```js
if (entry.callerKey && callerKey && entry.callerKey !== callerKey) return null;  // 不删
if (Date.now() - entry.lastAccess > effectiveTtl(entry)) {
  _pool.delete(fingerprint);  // 过期才删
  return null;
}
if (expected) {
  if (expected.apiKey && entry.apiKey && expected.apiKey !== entry.apiKey) return null;  // 不删
  ...
}
_pool.delete(fingerprint);  // 验证通过 → 消费
return entry;
```

加 3 个 regression test：
- callerKey 错配后，原 owner 仍能 checkout 拿到 entry（**核心修复证明**）
- 一次成功 checkout 后第二次 miss（确认 one-shot 语义没破）
- expected.apiKey 错配同样不删 entry

### 修法三：4 个配置文件用 atomic JSON 写入（P1）

**根因**：

- `src/runtime-config.js:69` `writeFileSync(FILE, JSON.stringify(_state))`
- `src/dashboard/stats.js:35` 同上
- `src/dashboard/proxy-config.js:28` 同上
- `src/dashboard/model-access.js:29` 同上

`writeFileSync` 是 truncate + write 两步的非原子操作。如果在中间被 `kill -9` / OOM / `docker stop` SIGTERM 打断，文件留下空的或半截 JSON。下次启动 load() 里 `JSON.parse` 抛错，被 catch 块吞掉只 log 一行 warn，然后 `_state = DEFAULTS`——**用户所有设置静默归零**。

`accounts.json` (`src/auth.js`) 早就是 tmp+rename 模式（v2.0.9+ 修过），这次把同一模式提取出来：

`src/fs-atomic.js`（新文件）：

```js
export function writeJsonAtomic(targetPath, value, { spaces = 2 } = {}) {
  const tmp = `${targetPath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, spaces));
    renameSync(tmp, targetPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}
```

POSIX 上 `rename(2)` 是原子的；Windows 上 Node 的 `fs.renameSync` 文档保证替换已存在的目标。kill -9 在 writeFileSync 期间命中只丢 .tmp 文件，目标不动；命中在 renameSync 期间要么旧的还在要么新的就位，二选一不会半截。

stringify 抛出（比如循环引用）也会 unlink .tmp 不留垃圾在 DATA_DIR。

4 个文件全换成 `writeJsonAtomic`。

加 7 个 regression test：
- helper 自己：成功写、stringify 失败时清 tmp + 旧文件不动、覆写已有目标
- 4 个文件每个都静态校验 import 了 `writeJsonAtomic` 且没遗留对它原配置常量的 bare writeFileSync

### 数字

- **测试**：v2.0.41 是 443 → v2.0.42 是 **457** (+14 / 0 失败)
- **suites**：92 → **96** (+4)
- **代码改动**：
  - `src/fs-atomic.js`: 新文件，atomic JSON writer
  - `src/cache.js`: cacheKey 加 callerKey 维度
  - `src/conversation-pool.js`: checkout 验证后再删
  - `src/handlers/chat.js`: cacheKey 调用串 callerKey
  - `src/runtime-config.js` / `src/dashboard/{stats,proxy-config,model-access}.js`: 换 writeJsonAtomic
- **API 不变**：`cacheKey(body)` 旧调用不会崩（callerKey 默认 ''），但 chat.js 主路径已经传值了

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后：

- 同 body 跨用户的回复混淆不会再发生（cache 跨租户隔离）
- fingerprint 偶发碰撞不会再误删旁人的 cascade（pool 验证后再消费）
- 进程被强杀不会再丢 dashboard 设置 / proxy 配置 / model 黑白名单 / stats（atomic write）

### 后续审计 backlog

按照 codex 给的优先级排队，下面这些不在本次范围但记下了，按需逐次落地：

- **Dashboard backup/restore**: GET `/accounts/export` + POST `/accounts/import` (替代 scp accounts.json)
- **Runtime settings UI**: `DEFAULT_MODEL` / `MAX_TOKENS` / `LOG_LEVEL` / `ALLOW_PRIVATE_PROXY_HOSTS` 这些目前要改 .env + 重启的项目，dashboard 直接改
- **First-run setup wizard**: 替代 `setup.sh`
- **Persistent log download/clear**: 现在只能 tail，不能下载 / 清磁盘日志
- **Model catalog 手动 refresh**: 不重启服务的情况下重拉云端 catalog
- **Per-account discoveredFreeModels**: 现在是全局 Set，A 发现的 free 可用模型会显示给 B（小概率假可用）
- **proxyKey 包含 type/auth**: 当前只 hash host:port，相同 host 不同认证的两 proxy 共用同一个 LS spawn
- **getApiKey / acquireAccountByKey 返回结构化 reason**: null 既意味着"无可用账号"也意味着"模型不允许"也意味着"RPM 满"，调用方一律走 wait-and-retry，应当区分立即失败 vs 可等待
