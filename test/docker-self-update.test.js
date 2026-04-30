// Docker self-update endpoint behavior.
//
// User report (2026-04-29): "为什么docker不支持更新 支持呗。。。" — i.e.,
// the dashboard's existing self-update path bails on docker
// deployments with a hint to run `docker compose pull && up -d`
// manually. v2.0.41 wires an opt-in path that uses /var/run/docker.sock
// + a one-shot deployer sidecar to recreate the container in-place.
//
// We can't actually exercise the docker daemon in unit tests (no
// socket on Windows / CI runners), so static-validate the module
// shape and the api.js wiring.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectDockerSelfUpdate, readSelfContainerId } from '../src/dashboard/docker-self-update.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOD = readFileSync(join(__dirname, '..', 'src/dashboard/docker-self-update.js'), 'utf8');
const API = readFileSync(join(__dirname, '..', 'src/dashboard/api.js'), 'utf8');

describe('docker self-update detection', () => {
  test('reports no-docker-sock when /var/run/docker.sock is absent', async () => {
    // On the test runner there's no docker.sock (Windows) — verify
    // the module returns the structured "not available" shape rather
    // than crashing.
    const r = await detectDockerSelfUpdate();
    assert.equal(r.available, false);
    // The reason should be one of the expected enum values; on a
    // Windows runner it will be no-docker-sock, on Linux without
    // docker the same. Don't pin the exact value because Linux CI
    // boxes might have a different shape.
    assert.match(r.reason, /no-docker-sock|no-self-id|docker-api-unreachable|no-compose-labels/);
  });

  test('readSelfContainerId returns a hex id or null', () => {
    const id = readSelfContainerId();
    if (id !== null) {
      assert.match(id, /^[0-9a-f]{12,64}$/,
        'container id format should be 12-64 hex chars (docker convention)');
    }
  });
});

describe('docker self-update module shape', () => {
  test('uses /var/run/docker.sock unix socket, not a TCP daemon URL', () => {
    assert.match(MOD, /'\/var\/run\/docker\.sock'/,
      'must hardcode /var/run/docker.sock as the daemon socket');
    assert.match(MOD, /socketPath:/,
      'must use http.request with socketPath option (no docker CLI dependency)');
  });

  test('spawns a deployer sidecar that runs docker compose up -d', () => {
    assert.match(MOD, /docker compose -p/,
      'sidecar command must use docker compose -p with the project name');
    assert.match(MOD, /up -d/,
      'sidecar must run `up -d` to recreate the container with the pulled image');
    assert.match(MOD, /AutoRemove: true/,
      'sidecar must auto-remove after exit so we do not leak deployer containers');
  });

  test('the sidecar sleeps before tearing us down', () => {
    // If the sidecar's compose-up runs immediately, the dashboard's
    // HTTP response gets killed before reaching the browser, leaving
    // a confusing "request failed" toast. The sleep buys time.
    assert.match(MOD, /DEPLOYER_DELAY_SECONDS/,
      'must define a delay constant');
    assert.match(MOD, /sleep \$\{DEPLOYER_DELAY_SECONDS\}/,
      'sidecar Cmd must sleep for DEPLOYER_DELAY_SECONDS before pulling/recreating');
  });

  test('shell-quotes the project name and working dir', () => {
    // Both come from compose container labels which we don't fully
    // control — defensive single-quote-wrap so a malformed label
    // can't break out of the `sh -c "..."` payload.
    assert.match(MOD, /shellQuote\(/);
    assert.match(MOD, /function shellQuote/);
  });

  test('aborts when running container has no compose labels', () => {
    // Hand-managed `docker run` containers can't be safely recreated
    // by `docker compose up -d`; we'd lose env / mounts / network.
    // Bail with a clear reason instead.
    assert.match(MOD, /no-compose-labels/,
      'must report no-compose-labels reason when container was not started by compose');
  });
});

describe('docker self-update wired into /self-update', () => {
  test('/self-update/check falls back to docker when git is unavailable', () => {
    const m = API.match(/subpath === '\/self-update\/check'[\s\S]+?\n  \}/);
    assert.ok(m);
    const route = m[0];
    assert.match(route, /detectDockerSelfUpdate\(\)/,
      'must consult docker mode when git mode reports unavailable');
    assert.match(route, /mode: 'docker'/,
      'must label the response so the dashboard can switch UI flows');
  });

  test('/self-update POST falls back to docker when git is unavailable', () => {
    const m = API.match(/subpath === '\/self-update' && method === 'POST'[\s\S]+?\n  \}/);
    assert.ok(m);
    const route = m[0];
    assert.match(route, /runDockerSelfUpdate\(\)/,
      'POST /self-update must call runDockerSelfUpdate when docker mode is available');
  });
});
