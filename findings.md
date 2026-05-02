# Findings

## Deployment Notes
- User requested sing-box listening on `127.0.0.1:7891`.
- Remote nodes provided: one hysteria2 node and one vless node, both targeting `216.36.107.196:443` with TLS SNI `www.intel.com`.
- `sing-box` is not currently available in PATH.
- Host is Linux x86_64 and current user is root.
- PID 1 is `bwrap`; prefer project-local process deployment over systemd.
- Official docs checked for mixed inbound, hysteria2 outbound, vless outbound, selector outbound, TLS options, and route final fields.
- Official install script at `https://sing-box.app/install.sh` is reachable and shows Debian package asset naming as `sing-box_<version>_linux_<arch>.deb`.
- Direct GitHub release download is too slow/unstable in this environment; the 1.13.11 amd64 deb timed out after about 1.1 MB.
- Official APT repository candidate version is `1.13.11`.
- sing-box 1.13.11 rejects legacy inbound sniff fields; route action sniff validates.
- `windsurf-sing-box.service` is active and enabled under systemd.
- `ss -ltnp` confirms `sing-box` is listening on `127.0.0.1:7891`.
- Proxy validation through `http://127.0.0.1:7891` to `https://www.gstatic.com/generate_204` returned HTTP 204.

## WindsurfAPI Deployment
- Project is a Node.js ESM app with no npm dependencies.
- `package.json` requires Node >=20; host Node is v24.14.1.
- `.env` is present and uses `PORT=3003`, `LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64`, and `LS_PORT=42100`.
- Language Server binary is missing at `/opt/windsurf/language_server_linux_x64`.
- No current WindsurfAPI `node src/index.js` process found before deployment.
- Direct public release URL for `language-server-v2.12.5/language_server_linux_x64` downloaded successfully through the proxy.
- Installed Language Server at `/opt/windsurf/language_server_linux_x64`, size about 169M, sha256 `7c658d6d8eb94b254eaaacd6c50375c1c37604e44cea89197a428d246c789373`.
- `windsurf-api.service` is active and enabled.
- WindsurfAPI listens on `0.0.0.0:3003`; LS listens on `127.0.0.1:42100`.
- `/health` returns HTTP 200 with version `2.0.4`; `/v1/models` returns a model list; `/dashboard` returns HTTP 200.
- Service environment includes `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` pointing to `http://127.0.0.1:7891`.
- Persisted global proxy config in `data/proxy.json` points to `127.0.0.1:7891`.
- There are currently no Windsurf accounts configured: health reports `accounts.total=0`.

## Login Troubleshooting
- Browser-side Google/GitHub buttons use Firebase SDK with project `exa2-fb170` and API key `AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY`.
- Firebase rejects Dashboard origin `http://10.66.23.236:3003` because that referer is not allowlisted for the API key.
- The built-in proxy test rejected `127.0.0.1:7891` with `ERR_PROXY_PRIVATE_IP`; this was a dashboard-side guard, not a sing-box connectivity failure.
- Patched proxy test to allow loopback proxy hosts and continue blocking non-loopback private ranges.
- After restart, `/dashboard/api/test-proxy` with `127.0.0.1:7891` returns `ok=true`, egress IP `216.36.107.196`, latency about 456ms.
