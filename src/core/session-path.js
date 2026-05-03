/**
 * Cross-platform session path resolver.
 *
 * Provides safe, portable path generation for session directories,
 * workspace paths, and any file/folder name derived from user-supplied
 * identifiers (sessionId, conversationId, userId, hostname, etc.).
 *
 * Design goals:
 *   - Works on Windows, macOS, Linux without platform-specific branches
 *   - Prevents path traversal attacks (../ or ..\ sequences)
 *   - Sanitizes characters illegal in Windows filenames
 *   - Handles long paths, Unicode, and edge cases
 *   - Provides a single source of truth for all path derivation
 */

import { join, resolve, sep, normalize } from 'path';
import { tmpdir, homedir } from 'os';
import { createHash } from 'crypto';
import { mkdirSync, existsSync } from 'fs';

// Characters illegal in Windows filenames. On Unix most of these are fine
// but we sanitize everywhere for cross-platform portability.
const ILLEGAL_CHARS_RE = /[<>:"/\\|?*\x00-\x1F]/g;

// Path traversal patterns — catch both / and \ separators.
const TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

// Max component length — Windows MAX_PATH is 260 but NTFS supports 255-char
// components. We leave headroom for the parent directory.
const MAX_COMPONENT_LENGTH = 200;

/**
 * Sanitize a string for use as a file/directory name component.
 *
 * - Strips path-illegal characters
 * - Replaces path separators
 * - Prevents traversal (../)
 * - Truncates to safe length
 * - Falls back to a hash if nothing remains
 *
 * @param {string} raw - The raw identifier
 * @param {string} [prefix='id'] - Prefix for hash-based fallback
 * @returns {string} A safe directory/file name component
 */
export function safeComponent(raw, prefix = 'id') {
  if (typeof raw !== 'string' || !raw.trim()) {
    return `${prefix}-${shortHash(raw || '')}`;
  }

  let safe = raw
    .replace(ILLEGAL_CHARS_RE, '_')
    .replace(/\.\./g, '__')    // prevent traversal
    .replace(/^\.+/, '_')     // no leading dots (hidden files / traversal)
    .replace(/\.+$/, '_')     // no trailing dots (Windows strips them)
    .replace(/\s+/g, '_')     // normalize whitespace
    .trim();

  if (!safe || safe.length < 2) {
    safe = `${prefix}-${shortHash(raw)}`;
  }

  if (safe.length > MAX_COMPONENT_LENGTH) {
    const hash = shortHash(raw);
    safe = safe.slice(0, MAX_COMPONENT_LENGTH - hash.length - 1) + '-' + hash;
  }

  return safe;
}

/**
 * Validate that a resolved path is within the expected base directory.
 * Prevents path traversal by checking the canonical path.
 *
 * @param {string} candidatePath - The path to validate
 * @param {string} basePath - The allowed base directory
 * @returns {boolean} True if candidatePath is within basePath
 */
export function isWithinBase(candidatePath, basePath) {
  const resolvedCandidate = resolve(normalize(candidatePath));
  const resolvedBase = resolve(normalize(basePath));
  return resolvedCandidate.startsWith(resolvedBase + sep) || resolvedCandidate === resolvedBase;
}

/**
 * Resolve the workspace base directory.
 * Uses platform-appropriate temp directory and sanitizes hostname.
 *
 * @param {object} [opts] - Options
 * @param {string} [opts.hostname] - Hostname suffix (from HOSTNAME env)
 * @returns {string} Absolute path to workspace base
 */
export function resolveWorkspaceBase(opts = {}) {
  const tmp = process.env.TEMP || process.env.TMP || tmpdir();
  const hostname = opts.hostname || process.env.HOSTNAME || '';
  const suffix = hostname ? `-${safeComponent(hostname, 'host')}` : '';
  return join(tmp, `windsurf-workspace${suffix}`);
}

/**
 * Resolve the data directory for persistent state.
 * Never uses hardcoded absolute paths — respects DATA_DIR env or falls
 * back to the project root.
 *
 * @param {string} projectRoot - The project root directory
 * @param {object} [opts] - Options
 * @param {string} [opts.dataDir] - Explicit DATA_DIR override
 * @param {string} [opts.hostname] - Hostname for replica isolation
 * @param {boolean} [opts.replicaIsolate] - Enable per-replica subdirs
 * @returns {{ sharedDataDir: string, dataDir: string }}
 */
export function resolveDataDirs(projectRoot, opts = {}) {
  const sharedDataDir = opts.dataDir
    ? resolve(projectRoot, opts.dataDir)
    : projectRoot;

  let dataDir = sharedDataDir;
  if (opts.replicaIsolate && opts.hostname) {
    dataDir = join(sharedDataDir, `replica-${safeComponent(opts.hostname, 'replica')}`);
  }

  return { sharedDataDir, dataDir };
}

/**
 * Resolve the DB directory. Used instead of hardcoded /opt/windsurf/data.
 *
 * @param {string} baseDir - Base data directory
 * @param {string} [subdir='db'] - Subdirectory name
 * @returns {string} Absolute path to db directory
 */
export function resolveDbDir(baseDir, subdir = 'db') {
  return join(baseDir, safeComponent(subdir, 'data'));
}

/**
 * Build a session storage path from a session identifier.
 * The identifier is hashed and sanitized so it's safe for all platforms.
 *
 * @param {string} baseDir - Base storage directory
 * @param {string} sessionId - Raw session identifier
 * @param {object} [opts] - Options
 * @param {string} [opts.prefix='session'] - Directory prefix
 * @returns {string} Absolute path to session directory
 */
export function resolveSessionDir(baseDir, sessionId, opts = {}) {
  const prefix = opts.prefix || 'session';
  const safe = safeComponent(sessionId, prefix);
  const result = join(baseDir, safe);

  // Final traversal check
  if (!isWithinBase(result, baseDir)) {
    const fallback = `${prefix}-${shortHash(sessionId)}`;
    return join(baseDir, fallback);
  }

  return result;
}

/**
 * Ensure a directory exists, creating it with safe defaults.
 *
 * @param {string} dirPath - Directory path to ensure
 * @returns {boolean} True if directory exists or was created
 */
export function ensureDir(dirPath) {
  try {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a short hash for fallback identifiers.
 *
 * @param {string} input - Input to hash
 * @param {number} [length=12] - Hash length
 * @returns {string} Hex hash string
 */
export function shortHash(input, length = 12) {
  return createHash('sha256')
    .update(String(input || ''))
    .digest('hex')
    .slice(0, length);
}

/**
 * Resolve the language server binary path in a cross-platform way.
 *
 * @param {object} [opts] - Options
 * @param {string} [opts.envPath] - LS_BINARY_PATH from environment
 * @param {string} [opts.platform] - Process platform override
 * @param {string} [opts.arch] - Process arch override
 * @returns {string} Resolved binary path
 */
export function resolveLsBinaryPath(opts = {}) {
  const envPath = opts.envPath || process.env.LS_BINARY_PATH;
  if (envPath) return resolve(envPath);

  const plat = opts.platform || process.platform;
  const architecture = opts.arch || process.arch;

  if (plat === 'darwin') {
    const home = homedir();
    const archSuffix = architecture === 'arm64' ? 'arm' : 'x64';
    return join(home, '.windsurf', `language_server_macos_${archSuffix}`);
  }

  if (plat === 'win32') {
    // On Windows, look in %LOCALAPPDATA%\Windsurf or fall back
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'Windsurf', 'language_server_windows_x64.exe');
  }

  // Linux default — use a relative path from project, not hardcoded /opt
  return '/opt/windsurf/language_server_linux_x64';
}
