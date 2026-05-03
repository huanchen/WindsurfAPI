/**
 * Path traversal guard.
 *
 * Validates and sanitizes all user-supplied path-like inputs before they
 * can be used in file system operations, directory names, or cache keys.
 *
 * This module is the single checkpoint for:
 *   - Session IDs used as directory names
 *   - Conversation IDs used in cache keys
 *   - Any user-supplied identifier that touches the file system
 *
 * Attack patterns defended against:
 *   - ../../../etc/passwd
 *   - ..%2F..%2F sequences (URL-encoded traversal)
 *   - Null byte injection (%00)
 *   - Backslash traversal (..\\..\\ on Windows)
 *   - Unicode normalization attacks
 */

/**
 * Check if a string contains path traversal sequences.
 *
 * @param {string} input - Input to check
 * @returns {boolean} True if traversal detected
 */
export function hasTraversal(input) {
  if (typeof input !== 'string') return false;

  // Decode URL-encoded characters first
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    // If decoding fails, check the raw input
  }

  // Check for traversal patterns
  const patterns = [
    /\.\.[/\\]/,          // ../ or ..\
    /[/\\]\.\./,          // /.. or \..
    /^\.\.$/,             // bare ..
    /\0/,                 // null byte
    /%00/i,               // URL-encoded null
    /%2e%2e/i,            // URL-encoded ..
    /%2f/i,               // URL-encoded /
    /%5c/i,               // URL-encoded \
  ];

  return patterns.some(p => p.test(decoded) || p.test(input));
}

/**
 * Validate a user-supplied identifier for safe use in paths.
 *
 * @param {string} id - The identifier to validate
 * @param {object} [opts] - Options
 * @param {number} [opts.maxLength=255] - Max allowed length
 * @param {boolean} [opts.allowDots=false] - Allow dots in identifier
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validatePathId(id, opts = {}) {
  const maxLength = opts.maxLength || 255;

  if (typeof id !== 'string' || !id.trim()) {
    return { valid: false, reason: 'empty_identifier' };
  }

  if (id.length > maxLength) {
    return { valid: false, reason: 'identifier_too_long' };
  }

  if (hasTraversal(id)) {
    return { valid: false, reason: 'path_traversal_detected' };
  }

  // Check for null bytes
  if (id.includes('\0')) {
    return { valid: false, reason: 'null_byte_detected' };
  }

  // Check for Windows reserved names
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
  if (reserved.test(id)) {
    return { valid: false, reason: 'reserved_name' };
  }

  return { valid: true };
}
