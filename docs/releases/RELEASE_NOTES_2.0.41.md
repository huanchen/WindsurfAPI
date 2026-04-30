## v2.0.41 — LS 更新 file-busy 修复 + Docker 一键自更新

### 你看到的报错

升完 v2.0.40 第一时间点"更新 LS"按钮：

```
LS 更新失败：
#=#=# Warning: Failed to open the file /opt/windsurf/language_server_linux_x64: Text Warning: file busy
curl: (23) Failure writing output to destination
```

### 根因：ETXTBSY

`install-ls.sh` 之前用 `curl -o "$TARGET"` 直接覆写 `/opt/windsurf/language_server_linux_x64`。Linux 内核对**正在被 exec 的 ELF 文件**做 `open(O_WRONLY|O_TRUNC)` 会拒，errno 是 ETXTBSY（"Text file busy" — `text` 在这里指 process text segment，不是文本文件）。

容器里检查正好印证：

```bash
$ ls -la /proc/*/exe | grep language_server
lrwxrwxrwx 1 root root 0 /proc/25/exe -> /opt/windsurf/language_server_linux_x64
lrwxrwxrwx 1 root root 0 /proc/38/exe -> /opt/windsurf/language_server_linux_x64
```

LS 进程 (PID 25, 38) 正在跑这个 binary。curl 想覆写就被 ETXTBSY 顶回去了。

### 修法：原子 rename

`install-ls.sh` 改成下载到 `${TARGET}.new.$$` 兄弟文件，写完 chmod +x，然后 `mv -f` 原子替换：

```bash
TMP_TARGET="${TARGET}.new.$$"
trap 'rm -f "$TMP_TARGET"' EXIT

# 下面所有 curl/cp 都换成 $TMP_TARGET
curl -fL --progress-bar -o "$TMP_TARGET" "$url"
# ...
chmod +x "$TMP_TARGET"
mv -f "$TMP_TARGET" "$TARGET"
trap - EXIT
```

`rename(2)` 只换 dirent 指向的 inode，**正在跑的进程继续用它持有的旧 inode**（已被 unlink 但内核保留直到进程退出），新 exec 走新 inode 加载新 binary。零停机时间，无 ETXTBSY。

dashboard `restartLsForProxy` 序列正好衔接：mv 完成后逐个 kill 老 LS、spawn 新 LS，新进程 exec 时拿到新 binary。

加 3 个 regression test 锁定：
- 所有 curl -o / cp -f 都写 `$TMP_TARGET` 不写 `$TARGET`
- chmod 在 mv 之前，且 mv 是 `mv -f $TMP_TARGET $TARGET` 一步替换
- trap EXIT 注册 + 最后 trap - EXIT 解除，避免成功后误删

### 你说的"为什么 docker 不支持更新 支持呗"

之前 `/self-update/check` 在 docker 部署下识别到没有 git binary / 没有 `.git`，直接报 `ERR_SELF_UPDATE_UNAVAILABLE` reason=`docker`，前端弹"请手动跑 `docker compose pull && up -d`"。

理由是：容器内没有 docker CLI，也不能假定挂了 docker.sock，硬上有安全风险。

**v2.0.41 加了一条 opt-in 的 docker 自更新路径**。流程：

1. 用户在 `docker-compose.yml` 里给 `windsurf-api` 服务加挂 `/var/run/docker.sock:/var/run/docker.sock`（默认是注释掉的，需要主动取消注释）
2. dashboard `/self-update/check` 检测到 git 不可用就 fallthrough 到 docker 路径
3. `detectDockerSelfUpdate()` 通过 docker.sock 直接走 HTTP 调 docker API：
   - 从 `/etc/hostname` 或 `/proc/self/cgroup` 拿到自己容器 ID
   - GET `/containers/{id}/json` 拿到 `Config.Image` + `Config.Labels['com.docker.compose.project']` + `com.docker.compose.project.working_dir`
4. 不是 compose 起的（拿不到 label）→ 报 `no-compose-labels`，不动手（手撕重建会丢 env/mounts/network）
5. 都齐了 → dashboard UI 显示"Docker 模式已就绪 / 镜像 / Compose 项目"，apply 按钮可点
6. 点 apply → 后端：
   - POST `/images/create?fromImage=<image>` 拉新镜像（阻塞直到拉完）
   - POST `/containers/create` 起一个**一次性 deployer 边车容器**，镜像 `docker:24-cli`，cmd `sleep 8 && docker compose -p <project> --project-directory <workdir> up -d`
   - POST `/containers/{deployer-id}/start` 拉起边车，`AutoRemove:true` 跑完自删
7. dashboard HTTP 响应回到浏览器，前端弹"deployer 边车 abc123 已启动，将在约 8 秒后重建容器"，`setTimeout(reload, 12s)` 自动刷新
8. 8 秒后 deployer 跑 `docker compose up -d`，docker 看到 image 跟 manifest 不一致 → stop 老容器 → start 新容器（新 image，同名同配置同卷）
9. 浏览器自动刷新连上新容器

不需要在我们镜像里装 docker CLI（我们走 raw HTTP API 跟 docker daemon 说话），保持镜像 size 不变。

**安全边界**：

- docker.sock 默认**不挂**，注释里明确说了"挂上等于把宿主机 root 给容器"
- 用户主动开启 → 必须配 `DASHBOARD_PASSWORD` 或 `API_KEY`（dashboard auth 已经强制了）
- 边车镜像写死 `docker:24-cli`（官方），不让用户传任意镜像
- compose 项目名 + working_dir 注入边车 cmd 时用 `shellQuote()` 单引号包裹，防 label 异常字符破坏 sh -c

加 8 个 regression test：
- `install-ls.sh` 原子 rename 三件事
- `detectDockerSelfUpdate` 在没 docker.sock 时返回结构化 `{available:false, reason:'no-docker-sock'}` 不崩
- `readSelfContainerId` 返回 12-64 hex 或 null
- 模块用 `socketPath` 不依赖 docker CLI
- 边车 cmd 含 `docker compose -p ... up -d` + `AutoRemove:true`
- 边车有 `sleep DEPLOYER_DELAY_SECONDS` 让 HTTP 响应先回去
- compose label 缺失时报 `no-compose-labels`
- `/self-update/check` 和 `/self-update` POST 都 fallthrough 到 `detectDockerSelfUpdate` / `runDockerSelfUpdate`

### 数字

- **测试**：v2.0.40 是 431 → v2.0.41 是 **443** (+12 / 0 失败)
- **suites**：88 → **92** (+4)
- **代码改动**：
  - `install-ls.sh`: 临时文件 + 原子 mv（fix ETXTBSY）
  - `src/dashboard/docker-self-update.js`: 新模块（detectDockerSelfUpdate / runDockerSelfUpdate / readSelfContainerId / shellQuote）
  - `src/dashboard/api.js`: import + `/self-update/check` 和 POST 都加 docker fallthrough
  - `src/dashboard/index.html`: applyUpdate 处理 `mode:docker` 响应、checkUpdate 渲染 docker 模式 ready 状态、showSelfUpdateUnavailable 加细节提示
  - `src/dashboard/i18n/zh-CN.json` & `en.json`: 6 条新 key
  - `docker-compose.yml`: 加 `/var/run/docker.sock` 注释模板 + 安全说明
- **API 不变**：`/self-update/check` 和 `/self-update` 在 git 模式下行为完全一样

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后：

- **LS 更新**：dashboard → Language Server → "更新 LS"按钮，不会再报 file busy
- **想用 docker 自更新**：编辑 `docker-compose.yml`，把 `/var/run/docker.sock` 那行的 `#` 去掉 → `docker compose up -d` → 之后 dashboard "检查更新" 按钮就能直接用了。**注意安全说明**：开了等于把宿主机 root 交给容器
- **不想开**：dashboard "检查更新" 报错时会继续提示手动跑命令，但同时多带一行说明告诉你怎么开 docker 自更新（如果你愿意）
