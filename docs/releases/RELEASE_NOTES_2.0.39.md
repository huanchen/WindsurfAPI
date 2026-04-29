## v2.0.39 — `/auth/login` 邮箱密码模式恢复 + CheckUserLoginMethod 空响应回退

### 症状

VPS 实测 `/auth/login` 邮箱密码模式提交三个真实账号：

```
POST /auth/login
{ "accounts":[
  {"email":"qxl.n257570.722@gmail.com","password":"..."},
  {"email":"tc.vmb.7687617@gmail.com","password":"..."},
  {"email":"ge.jgpmnelfiyo9.15@gmail.com","password":"..."}
]}
```

返回：

```json
{
  "results": [
    {"email":"qxl....","error":"Direct email/password login is not supported. Use token-based auth..."},
    {"email":"tc....","error":"Direct email/password login is not supported. Use token-based auth..."},
    {"email":"ge....","error":"Direct email/password login is not supported. Use token-based auth..."}
  ],
  "total": 0, "active": 0, "error": 0
}
```

修完之后同样三个账号：

```json
{"results":[
  {"id":"4456bde1","email":"Joshua Robinson","status":"active"},
  {"id":"52a3446b","email":"Susan Roberts","status":"active"},
  {"id":"82564aa6","email":"Barbara King","status":"active"}
],"total":3,"active":3,"error":0}
```

### 根因 1：`addAccountByEmail` 长期被 stub 成 throw

`src/auth.js` 里 `addAccountByEmail(email, password)` 的整个函数体只有一行：

```js
throw new Error('Direct email/password login is not supported. Use token-based auth: get token from windsurf.com, then POST /auth/login {"token":"..."}');
```

但旁边 `src/dashboard/windsurf-login.js` 已经实现了完整的 Auth1/Firebase 双路径登录管线（`windsurfLogin`），dashboard 的 `processWindsurfLogin` 也在用，唯独 HTTP 路径上的 `/auth/login` 没接进去。

### 根因 2：`CheckUserLoginMethod` 偶发返回 `{}`

2026-04-26 Windsurf 把邮箱方法主探测搬到了 `_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod`，正常应该返回 `{userExists: true, hasPassword: true}`。

但 VPS 实测发现 Vercel edge 偶尔会返回完全空的 `{}`：

```bash
$ curl -X POST https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod \
    -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' \
    -d '{"email":"qxl.n257570.722@gmail.com"}'
{}
```

旧的 `fetchCheckUserLoginMethod` 把缺失字段当 false 处理：

```js
return {
  method: 'auth1',
  hasPassword: !!res.data.hasPassword,  // {} → undefined → false
};
```

→ `windsurfLogin` 看到 `method:'auth1', hasPassword:false` → 直接抛 `ERR_NO_PASSWORD_SET`，根本没尝试 `/_devin-auth/connections` 旧路径或 Firebase fallback。

而旧的 `/_devin-auth/connections` 实际上同一时间能正确返回：

```json
{
  "auth_method":{"method":"auth1","has_password":true,"sso_connections":null},
  "connections":[{"type":"email","enabled":true},...]
}
```

### 修法

**`src/auth.js` `addAccountByEmail`**：拆掉 stub，串起来现成的 windsurfLogin → `addAccountByKey` → `setAccountTokens` 流程，跟 dashboard 的 `processWindsurfLogin` 完全一致：

```js
export async function addAccountByEmail(email, password) {
  if (!email || !password) throw new Error('email and password required');
  const { windsurfLogin } = await import('./dashboard/windsurf-login.js');
  const result = await windsurfLogin(email, password, null);
  if (!result?.apiKey) throw new Error('Login succeeded but no apiKey returned');
  const account = addAccountByKey(result.apiKey, result.name || email);
  if (account.email !== (result.name || email)) account.email = result.name || email;
  account.method = 'email';
  if (result.apiServerUrl && !account.apiServerUrl) account.apiServerUrl = result.apiServerUrl;
  if (result.refreshToken || result.idToken) {
    setAccountTokens(account.id, {
      refreshToken: result.refreshToken || '',
      idToken: result.idToken || '',
    });
  }
  saveAccounts();
  return account;
}
```

`account.method='email'` 让前端 dashboard 能区分这是邮箱登录而不是 token/api_key 导入。

**`src/dashboard/windsurf-login.js` `fetchCheckUserLoginMethod`**：当响应体既没有 `userExists` 字段也没有 `hasPassword` 字段时（例如 `{}`），返回 null 触发 `/_devin-auth/connections` 回退：

```js
const hasUserField = Object.prototype.hasOwnProperty.call(res.data, 'userExists');
const hasPwField = Object.prototype.hasOwnProperty.call(res.data, 'hasPassword');
if (!hasUserField && !hasPwField) {
  log.warn(`CheckUserLoginMethod empty body for ${email}, falling back to /_devin-auth/connections`);
  return null;
}
```

注意保留了 `userExists:false` 的语义（用户不存在 → `method:null` → 走 Firebase fallback），也保留了 `hasPassword:false` 的语义（用户存在但只有 OAuth → 友好报错 "No password set. Please log in with Google or GitHub."）。仅当**完全没字段**时才回退。

### 测试

新增 `test/addaccount-by-email.test.js`：

- `addAccountByEmail` 函数体不再以 stub-throw 开头
- `addAccountByEmail` 调用 `windsurfLogin` + `addAccountByKey` + `setAccountTokens`
- 空 email/password 短路（避免向 Windsurf 发 `{email:"",password:""}`）
- `fetchCheckUserLoginMethod` 用 `hasOwnProperty.call` 显式检查两个字段
- 空 body → 返回 null（caller 回退）
- `hasPassword:false`（字段存在但 false）保留 ERR_NO_PASSWORD_SET 友好报错路径

VPS 实测 v2.0.39 三个账号 batch login → 三个全 active；用 sonnet-4.6 跑 chat → 正常返回 "pong"。

### 数字

- **测试**：v2.0.38 是 418 → v2.0.39 是 **423** (+5 / 0 失败)
- **suites**：83 → **85** (+2)
- **代码改动**：
  - `src/auth.js`: addAccountByEmail 接进 windsurfLogin 管线
  - `src/dashboard/windsurf-login.js`: fetchCheckUserLoginMethod 空响应回退
- **API 不变**：`/auth/login` 依然吃 `{email,password}` / `{token}` / `{api_key}` 三种 + `accounts:[...]` 批量

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后：

- 之前 dashboard UI 能登录但 `/auth/login` API 直接报 stub 错的，现在两条路径都走同一个真实管线
- CheckUserLoginMethod 偶发返回 `{}` 的场景下，自动降级到旧 `/_devin-auth/connections` 路径，不再被吞掉

如果客户端是用 `{api_key}` 或 `{token}` 模式，本次升级**无影响**。
