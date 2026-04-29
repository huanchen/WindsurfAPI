import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { promisify } from 'node:util';

const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);
const access = promisify(fs.access);
const copyFile = promisify(fs.copyFile);
const unlink = promisify(fs.unlink);

const STATE_DB_REL = path.join('User', 'globalStorage', 'state.vscdb');
const STATE_KEY = 'windsurfAuthStatus';

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

let cachedSqlite = undefined;
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

export async function extractFromStateDb(dbPath) {
  if (!(await fileExists(dbPath))) return { ok: false, reason: 'not_found', dbPath };
  const sqlite = await tryLoadSqlite();
  if (!sqlite) {
    return { ok: false, reason: 'sqlite_unavailable', dbPath };
  }
  const tmpCopy = path.join(os.tmpdir(), `windsurf-state-${process.pid}-${Date.now()}.vscdb`);
  try {
    await copyFile(dbPath, tmpCopy);
  } catch (e) {
    return { ok: false, reason: 'copy_failed', dbPath, error: e.message };
  }
  try {
    const db = new sqlite.DatabaseSync(tmpCopy, { readOnly: true });
    const rows = db.prepare(`SELECT key, value FROM ItemTable WHERE key LIKE 'windsurfAuth%' OR key = ? OR key LIKE 'codeium%'`).all(STATE_KEY);
    db.close();
    const accounts = [];
    const seen = new Set();
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.value); } catch { continue; }
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const acc = normalizeAccount(item, `state.vscdb:${row.key}`);
          if (acc && !seen.has(acc.apiKey)) { seen.add(acc.apiKey); accounts.push(acc); }
        }
      } else {
        const acc = normalizeAccount(parsed, `state.vscdb:${row.key}`);
        if (acc && !seen.has(acc.apiKey)) { seen.add(acc.apiKey); accounts.push(acc); }
      }
    }
    return { ok: true, dbPath, accounts };
  } catch (e) {
    return { ok: false, reason: 'read_failed', dbPath, error: e.message };
  } finally {
    try { await unlink(tmpCopy); } catch {}
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
  const sources = [];
  const accounts = [];
  const seenKeys = new Set();

  for (const dbPath of getCandidateStateDbPaths()) {
    const result = await extractFromStateDb(dbPath);
    sources.push(result);
    if (result.ok) {
      for (const a of result.accounts) {
        if (!seenKeys.has(a.apiKey)) { seenKeys.add(a.apiKey); accounts.push(a); }
      }
    }
  }

  const cfgResult = await extractFromCodeiumConfig();
  sources.push(cfgResult);
  if (cfgResult.ok) {
    for (const a of cfgResult.accounts) {
      if (!seenKeys.has(a.apiKey)) { seenKeys.add(a.apiKey); accounts.push(a); }
    }
  }

  const sqliteOk = await tryLoadSqlite();
  return {
    accounts,
    sources: sources.map(s => ({
      path: s.dbPath,
      ok: s.ok,
      reason: s.reason || null,
      accountCount: s.ok ? s.accounts.length : 0,
    })),
    sqliteSupport: sqliteOk ? 'available' : 'unavailable',
    platform: process.platform,
  };
}

export function isLoopbackAddress(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase();
  if (a === '127.0.0.1' || a === '::1') return true;
  if (a === '::ffff:127.0.0.1') return true;
  if (a.startsWith('127.') && /^127\.\d+\.\d+\.\d+$/.test(a)) return true;
  if (a.startsWith('::ffff:127.')) return true;
  return false;
}
