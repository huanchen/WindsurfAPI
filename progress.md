# Progress

## 2026-04-29
- Initialized planning files for sing-box deployment.
- Completed environment discovery. `sing-box` is missing; systemd is not a reliable target inside this session.
- Created `sing-box/config.json` plus foreground/background/stop scripts. Config defaults to hysteria2 and includes vless as a selector option.
- Attempted official GitHub release downloads. Network was available only after escalation, but GitHub transfer was too slow and timed out before completion.
- Downloaded `sing-box` 1.13.11 from the official APT repository into `/tmp`, extracted the binary to `sing-box/bin/sing-box`, and validated `sing-box/config.json` successfully.
- Added and linked `sing-box/windsurf-sing-box.service`, enabled and started it with systemd.
- Verified active service, local listener on `127.0.0.1:7891`, and successful proxy request returning HTTP 204.
- Removed stale PID file from the earlier non-persistent background launch attempt.
- Started WindsurfAPI deployment request using the existing local sing-box proxy.
- Discovered native Node deployment path. Node is available and no npm install is required, but the Windsurf language server binary must be installed.
- `install-ls.sh` ran through the proxy but failed on the Exafunction GitHub API fallback with HTTP 403.
- Downloaded Language Server through the proxy using the direct Exafunction release URL and set executable permissions.
- Created `windsurf-api.service` with proxy environment variables and project-local data/log paths.
- First service start failed because `/usr/bin/node` is v12.22.9 while the shell Node is v24.14.1. Updated the service to use the v24 binary path.
- Linked, enabled, and started `windsurf-api.service`.
- Verified `/health`, `/v1/models`, `/dashboard`, service active/enabled status, 3003 listener, and LS 42100 listener.
- Wrote WindsurfAPI global proxy config to use local sing-box at `127.0.0.1:7891`.
- Began diagnosing Dashboard Google login failure: Firebase blocked requests from `http://10.66.23.236:3003` referer.
- Patched `src/dashboard/api.js` so the Dashboard proxy tester allows localhost/127.x/::1 proxy hosts.
- Restarted `windsurf-api.service` and verified the Dashboard proxy tester succeeds through local sing-box.
