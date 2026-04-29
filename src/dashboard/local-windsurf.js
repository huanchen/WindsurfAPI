import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { promisify } from 'node:util';

const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);
const access = promisify(fs.access);
const copyFile = promisify(fs.copyFile);
const mkdtemp = promisify(fs.mkdtemp);
const rm = promisify(fs.rm);

const STATE_DB_REL = path.join('User', 'globalStorage', 'state.vscdb');
const STATE_KEY = 'windsurfAuthStatus';
const TMP_STATE_DIR_PREFIX = path.join(os.tmpdir(), 'windsurf-state-');
const MAX_STATE_DB_BYTES = 24 * 1024 * 1024;
const MAX_STATE_ROWS_PER_DB = 200;
const MAX_STATE_VALUE_BYTES = 128 * 1024;
const DISCOVER_CACHE_TTL_MS = 4000;

let cachedSqlite = undefined;
let discoverCache = null;
let discoverInFlight = null;

export function getCandidateStateDbPaths() {
  const home = os.homedir();
  const flavors = ['Windsurf', 'Windsurf - Next', 'Windsurf-Next', 'Windsurf Insiders'];
  const paths = [];
  if (process.platform === 'darwin') {
    for (const f of flavors) {
      paths.push(path.join(home, 'Library', 'Application Support', f, STATE_DB_REL));
    }
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const f of flavors) {
      paths.push(path.join(appData, f, STATE_DB_REL));
    }
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const f of flavors) {
      paths.push(path.join(xdg, f, STATE_DB_REL));
    }
  }
  return paths;
}

export function getCodeiumConfigPath() {
  const home = os.homedir();
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) return path.join(xdgData, '.codeium', 'config.json');
  return path.join(home, '.codeium', 'config.json');
}

async function fileExists(p) {
  try {
    await access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSourcePath(value) {
  if (typeof value !== 'string') return '';
  return path.basename(value);
}

function isIpv4(addr) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return false;
  const parts = addr.split('.');
  return parts[0] === '127'
    && parts.every((p) => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
}

function isIpv4MappedIpv6(addr) {
  const lower = String(addr).toLowerCase();
  if (!lower.startsWith('::ffff:')) return false;
  const tail = lower.slice(7).split('%')[0];
  if (tail.includes('.')) return isIpv4(tail);
  if (!/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(tail)) return false;
  const first = Number.parseInt(tail.split(':')[0], 16);
  return Number.isInteger(first) && first >= 0x7f00 && first <= 0x7fff;
}

function sanitizeLoopbackAddress(addr) {
  if (typeof addr !== 'string') return '';
  const trimmed = addr.trim();
  if (!trimmed) return '';
  if (trimmed[0] === '[' && trimmed.at(-1) === ']') return trimmed.slice(1, -1);
  return trimmed;
}

async function tryLoadSqlite() {
  if (cachedSqlite !== undefined) return cachedSqlite;
  try {
    const mod = await import('node:sqlite');
    cachedSqlite = mod?.DatabaseSync ? mod : null;
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite;
}

function maskKey(k) {
  if (!k || typeof k !== 'string') return '';
  if (k.length <= 12) return k.slice(0, 4) + '***';
  return k.slice(0, 8) + '...' + k.slice(-4);
}

function normalizeAccount(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const apiKey = raw.apiKey || raw.api_key || raw.accessToken;
  if (!apiKey || typeof apiKey !== 'string') return null;
  const email = raw.email || raw.account?.email || null;
  const name = raw.name || raw.account?.name || null;
  return {
    method: 'api_key',
    apiKey,
    apiKeyMasked: maskKey(apiKey),
    email,
    name,
    apiServerUrl: raw.apiServerUrl || raw.account?.apiServerUrl || null,
    label: email || name || 'Imported from Windsurf',
    source,
  };
}

function getCachedResult() {
  if (!discoverCache) return null;
  if (Date.now() - discoverCache.timestamp >= DISCOVER_CACHE_TTL_MS) return null;
  return structuredClone(discoverCache.value);
}

export async function extractFromStateDb(dbPath) {
  if (!(await fileExists(dbPath))) return { ok: false, reason: 'not_found', dbPath };
  const sqlite = await tryLoadSqlite();
  if (!sqlite) {
    return { ok: false, reason: 'sqlite_unavailable', dbPath };
  }

  let db = null;
  let tmpDir = null;
  let tmpCopy = null;

  try {
    const info = await stat(dbPath);
    if (info.size > MAX_STATE_DB_BYTES) {
      return {
        ok: false,
        reason: 'size_limit_exceeded',
        dbPath,
        error: `state DB exceeds limit (${MAX_STATE_DB_BYTES} bytes)`,
      };
    }

    tmpDir = await mkdtemp(TMP_STATE_DIR_PREFIX);
    tmpCopy = path.join(tmpDir, 'state.vscdb');
    await copyFile(dbPath, tmpCopy);

    db = new sqlite.DatabaseSync(tmpCopy, { readOnly: true });
    const rows = db.prepare(
      `SELECT key, value FROM ItemTable WHERE key LIKE 'windsurfAuth%' OR key = ? OR key LIKE 'codeium%' LIMIT ${MAX_STATE_ROWS_PER_DB}`
    ).all(STATE_KEY);
    const accounts = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row || typeof row.value !== 'string' || row.value.length > MAX_STATE_VALUE_BYTES) continue;
      if (seen.size >= MAX_STATE_ROWS_PER_DB) break;
      let parsed;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue;
      }

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const acc = normalizeAccount(item, `state.vscdb:${row.key}`);
          if (acc && !seen.has(acc.apiKey)) {
            seen.add(acc.apiKey);
            accounts.push(acc);
          }
          if (accounts.length >= MAX_STATE_ROWS_PER_DB) break;
        }
      } else {
        const acc = normalizeAccount(parsed, `state.vscdb:${row.key}`);
        if (acc && !seen.has(acc.apiKey)) {
          seen.add(acc.apiKey);
          accounts.push(acc);
        }
      }
    }

    return { ok: true, dbPath, accounts };
  } catch (e) {
    if (!tmpCopy) return { ok: false, reason: 'copy_failed', dbPath, error: e.message };
    return { ok: false, reason: 'read_failed', dbPath, error: e.message };
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
    if (tmpDir) {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

export async function extractFromCodeiumConfig() {
  const cfgPath = getCodeiumConfigPath();
  if (!(await fileExists(cfgPath))) return { ok: false, reason: 'not_found', dbPath: cfgPath };
  try {
    const content = await readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(content);
    const acc = normalizeAccount(parsed, 'codeium-config');
    return { ok: true, dbPath: cfgPath, accounts: acc ? [acc] : [] };
  } catch (e) {
    return { ok: false, reason: 'parse_failed', dbPath: cfgPath, error: e.message };
  }
}

export async function discoverWindsurfCredentials() {
  const cached = getCachedResult();
  if (cached) return cached;
  if (discoverInFlight) return discoverInFlight;

  discoverInFlight = (async () => {
    const sources = [];
    const accounts = [];
    const seenKeys = new Set();

    for (const dbPath of getCandidateStateDbPaths()) {
      const result = await extractFromStateDb(dbPath);
      sources.push(result);
      if (result.ok) {
        for (const a of result.accounts) {
          if (!seenKeys.has(a.apiKey)) {
            seenKeys.add(a.apiKey);
            accounts.push(a);
          }
        }
      }
    }

    const cfgResult = await extractFromCodeiumConfig();
    sources.push(cfgResult);
    if (cfgResult.ok) {
      for (const a of cfgResult.accounts) {
        if (!seenKeys.has(a.apiKey)) {
          seenKeys.add(a.apiKey);
          accounts.push(a);
        }
      }
    }

    const sqliteOk = await tryLoadSqlite();
    const result = {
      accounts,
      sources: sources.map(s => ({
        path: sanitizeSourcePath(s.dbPath),
        ok: s.ok,
        reason: s.reason || null,
        accountCount: s.ok ? s.accounts.length : 0,
      })),
      sqliteSupport: sqliteOk ? 'available' : 'unavailable',
      platform: process.platform,
    };
    discoverCache = { timestamp: Date.now(), value: structuredClone(result) };
    return result;
  })();

  try {
    return await discoverInFlight;
  } finally {
    discoverInFlight = null;
  }
}

export function isLoopbackAddress(addr) {
  const normalized = sanitizeLoopbackAddress(addr).toLowerCase().split('%')[0];
  if (!normalized) return false;
  if (normalized === '::1') return true;
  if (isIpv4(normalized)) return true;
  if (isIpv4MappedIpv6(normalized)) return true;
  return false;
}
