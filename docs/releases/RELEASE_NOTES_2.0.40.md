## v2.0.40 — Probe lock 假阳性 + Dashboard 一键更新 LS Binary

### #follow-up：截图里 "Account not found" 是假的（P0）

**症状**：dashboard 打开账号管理，三个账号同时点"探测"。第一个返回正常 capabilities，剩下两个直接弹 toast "Account not found"——但账号实实在在还在列表里、`active` 状态、KEY 完整。VPS 截图复现。

**根因**：`src/auth.js` 里 probe 用了**全局** `_probeInFlight = false/true` 布尔锁。当任何一次 probe 在跑，后续别的 id 进来全被 `return null` 顶回去：

```js
if (_probeInFlight) {
  log.info(`Probe skipped for ${id}: another probe is already running`);
  return null;
}
```

而 dashboard handler 把 null 一律视为"账号不存在"：

```js
const result = await probeAccount(accountProbe[1]);
if (!result) return json(res, 404, { error: 'Account not found' });
```

→ 用户看到的就是"账号没了"，但其实只是被锁挡住了。

**修法**：换成 per-account `Map<id, Promise>` 去重。同一 id 重复调用就 await 同一个 promise；不同 id 各跑各的。`return null` 只保留给"账号真的找不到"那一种。

```js
const _probeInFlight = new Map();
export async function probeAccount(id) {
  const existing = _probeInFlight.get(id);
  if (existing) return existing;
  const account = accounts.find(a => a.id === id);
  if (!account) return null;
  const promise = _probeAccountImpl(account).finally(() => {
    _probeInFlight.delete(id);
  });
  _probeInFlight.set(id, promise);
  return promise;
}
```

加 3 个 regression test 锁住：
- 全局布尔锁不存在
- 用 Map + `existing ? return existing` + `Map.delete(id)` 清理
- 整个 `probeAccount` 只能有 **1** 处 `return null`，那处必须是 `if (!account) return null`

### #7 / #10 / #49 / #87：Dashboard 一键更新 LS Binary

**背景**：长期以来 LS binary 怎么获取/更新一直是一类小痛点：

- #7 errie-error：`language_server_linux_x64文件如何得到`
- #10 CaiJingLong：linux server 下载链接是哪里
- #49 Bespertrijun：1c1g 部署 LS 启动失败
- #87 wnfilm：docker 部署"检查更新"报错（v2.0.32 已修代码自更新，但 LS 二进制更新还是要 docker exec 进容器跑 install-ls.sh）

仓库里早就有 `install-ls.sh`（auto-detect 平台、先试我们 GitHub release，fallback Exafunction），docker 镜像里也烤进去了，缺的就是个 dashboard 入口。

**实现**：

新增两个 endpoint：

```
GET  /dashboard/api/langserver/binary  → { path, sizeBytes, mtime, sha256 }
POST /dashboard/api/langserver/update  → 执行 install-ls.sh + 重启所有 LS pool 实例
```

**`GET /langserver/binary`**：直接 stat + sha256 当前 binary，dashboard LS 卡片下面显示"`/opt/windsurf/language_server_linux_x64` · 158.3 MB · sha256:abcd1234efgh5678 · 21 天前安装"。

**`POST /langserver/update`**：

1. spawn `bash install-ls.sh` 子进程，用 `LS_INSTALL_PATH=config.lsBinaryPath` 指向当前 binary
2. 可选 `body.url` 自定义下载源（**只允许 https + 白名单 host**：github.com / objects.githubusercontent.com / release-assets.githubusercontent.com / api.github.com，防止有人绕过 dashboard auth 后写任意字节到可执行的 LS binary）
3. install-ls.sh 退出非 0 → 返回 `stdout/stderr` tail
4. 成功 → 用新加的 `_poolKeys()` + `getProxyByKey()` 遍历整个 LS pool，逐个 `restartLsForProxy(proxy)` 拉起新进程加载新 binary
5. 返回 `{ok, restarted: N, restartErrors: [...]}`

Dashboard UI：LS 卡片 header 加一颗"更新 LS"按钮（在"重启"旁边），点击 → confirm 弹窗 → toast 进度 → 完成后自动刷新 binary 信息显示新 sha256。

i18n 全套加到 zh-CN 和 en（`action.updateLsBinary` / `confirm.updateLsTitle/Desc/Button` / `toast.lsBinaryUpdating/Updated/Failed/Stat/...`）。

加 5 个 regression test：
- `GET /langserver/binary` 返回 size/mtime/sha256，用 node:crypto 不 shell 出去
- `POST /langserver/update` spawn install-ls.sh + 设 LS_INSTALL_PATH
- 自定义 url 必须 https + 白名单 host
- 成功后用 `_poolKeys` 遍历 + `restartLsForProxy` 重启
- `langserver.js` 导出了 `_poolKeys` + `getProxyByKey`

### 数字

- **测试**：v2.0.39 是 423 → v2.0.40 是 **431** (+8 / 0 失败)
- **suites**：85 → **88** (+3)
- **代码改动**：
  - `src/auth.js`: probe 锁 global → per-account Map
  - `src/langserver.js`: 新增 `_poolKeys` / `getProxyByKey` 导出
  - `src/dashboard/api.js`: 新增 GET/POST `/langserver/binary` + `/langserver/update`
  - `src/dashboard/index.html`: LS 卡片加"更新 LS"按钮 + binary 信息显示 + JS handlers
  - `src/dashboard/i18n/zh-CN.json` & `en.json`: 8 条新 key
- **API 不变**：旧 dashboard / chat / auth API 全部兼容

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后：

- **多账号 dashboard 用户**：再点 "探测全部" / 多个账号同时刷新 capabilities，不会再出现假的 "Account not found" toast
- **想升级 LS binary 的用户**：dashboard → Language Server 卡片 → 点"更新 LS"按钮，自动从 GitHub release 拉最新 binary（约 150MB，几分钟）+ 自动重启 LS pool。不再需要 docker exec 进容器手跑脚本

### 关于"宝贵的东西"——free 账号国产模型 (#42 #81 #86)

代码里其实**已经实现了** free 账号动态发现 GLM/Kimi/SWE 模型的基础设施（`registerDiscoveredFreeModel` + `MODEL_TIER_ACCESS.free` 动态 getter + `probeAccount` 里 step 3 cloud probe 跑 10 个候选）。

下一阶段的工作是**产品化验证**：跑端到端真实 free 账号 → probe → /v1/models 看到 GLM-4.7 / Kimi-K2 / SWE-1.5 → chat 能正常 tool-call。会单独提一个 v2.0.41 跟 free 账号社区用户一起对齐 cloud probe 默认模型集和 dashboard 显示 cloud_probe vs user_status 的 reason。
