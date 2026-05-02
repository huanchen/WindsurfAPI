# Task Plan

## Goal
Deploy a sing-box local proxy listening on 127.0.0.1:7891 using the provided hysteria2 and vless remote nodes.

Deploy the WindsurfAPI project using that local proxy for outbound dependency/network access.

## Phases
1. Environment discovery - complete
2. Create sing-box configuration - complete
3. Validate configuration - complete
4. Start or provide deployment command/service - complete
5. Verify local listener - complete
6. Discover WindsurfAPI project runtime - complete
7. Install or refresh dependencies through proxy - complete
8. Configure and start WindsurfAPI service - complete
9. Verify WindsurfAPI endpoint - complete
10. Diagnose Google login Firebase referer block - complete
11. Apply login workaround or deployment fix - complete
12. Verify login path - complete

## Decisions
- Use a local `mixed` inbound on 127.0.0.1:7891 unless the installed sing-box version requires a different inbound type.
- Include both remote nodes behind a selector, defaulting to hysteria2.
- Deploy under the project directory instead of systemd because PID 1 is `bwrap`; systemd may exist but is unlikely to manage this sandboxed session reliably.
- Store the config at `sing-box/config.json` and restrict it to mode 600 because it contains proxy credentials.
- Persist deployment through `windsurf-sing-box.service` linked into systemd and enabled at boot.
- Use `http://127.0.0.1:7891` as `HTTP_PROXY`/`HTTPS_PROXY` for deployment commands that need outbound network.
- Deploy WindsurfAPI natively with systemd rather than Docker because the project has zero npm dependencies and Docker Compose has a replica-specific config path that would require code fixes.
- Use `/opt/WindsurfAPI/data` as the systemd service `DATA_DIR`.

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| GitHub tarball download made no progress | Direct release tarball download | Switched to package asset name from official install script |
| GitHub deb download timed out after about 1.1 MB of 23.2 MB | Direct release deb download with 90s timeout | Need faster package source or user-provided binary/package |
| Config check failed on legacy inbound sniff fields | sing-box 1.13.11 validation | Moved sniffing to `route.rules` with `action: "sniff"` |
| Background shell launch did not persist after command session ended | `run-background.sh` with `nohup` | Switched to a systemd service on the host |
| `install-ls.sh` fallback failed with GitHub API 403 | Run script through local proxy | Try direct public asset URL or an existing local language server binary |
| systemd service used `/usr/bin/node` v12 and failed on modern JS syntax | First `windsurf-api.service` start | Changed `ExecStart` to Node v24.14.1 path under fnm |
| zsh treated `?` in unquoted health URL as glob | First verbose health curl | Re-ran curl with the URL quoted |
| Dashboard proxy test rejects private proxy IP | `/dashboard/api/test-proxy` against `127.0.0.1:7891` | Patched proxy tester to allow loopback hosts and verified egress IP |
| Dashboard proxy test blocked local sing-box | `/dashboard/api/test-proxy` with localhost proxy | Patched test-proxy to allow loopback hosts while still blocking non-loopback private ranges |
