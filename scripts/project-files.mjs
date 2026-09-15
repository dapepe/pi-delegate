/** Small, bounded project-file operations. Trusted host only, never exposed to Pi workers. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { assert, cleanRel, sha256 } from './lib.mjs';
const decoder = new TextDecoder('utf8', { fatal: true, ignoreBOM: true });
export const bytesHash = value => value === null ? null : sha256(value);
export function projectRoot(repo) { const root = fs.realpathSync(repo); assert(fs.statSync(root).isDirectory(), 'Project must be a directory'); return root; }
export function localPath(root, rel) {
  cleanRel(rel);
  let current = root;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    assert(!stat.isSymbolicLink(), `Refusing symlink: ${rel}`);
    assert(i === parts.length - 1 || stat.isDirectory(), `Non-directory parent: ${rel}`);
    if (i === parts.length - 1 && stat.isFile()) assert(stat.nlink === 1, `Refusing hardlinked file: ${rel}`);
  }
  return current;
}
export function readLocal(root, rel, maxBytes = 8 * 1024 * 1024) {
  const file = localPath(root, rel);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= maxBytes, `Not a bounded regular file: ${rel}`);
    const buffer = Buffer.alloc(maxBytes + 1); let length = 0, n;
    while (length < buffer.length && (n = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += n;
    const data = buffer.subarray(0, length);
    assert(length <= maxBytes && !data.includes(0), `Oversized or binary file: ${rel}`);
    return decoder.decode(data);
  } finally { fs.closeSync(fd); }
}
export function writeLocal(root, rel, value, expectedHash, mode = 0o600) {
  assert(typeof value === 'string' && Buffer.byteLength(value) <= 8 * 1024 * 1024, 'Write exceeds local state limit');
  const file = localPath(root, rel), previous = readLocal(root, rel);
  assert(bytesHash(previous) === expectedHash, `Stale file; regenerate the proposal: ${rel}`);
  if (value === previous) return false;
  const previousMode = previous === null ? mode : fs.statSync(file).mode & 0o777;
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, value, { mode: previousMode, flag: 'wx' });
  try {
    assert(bytesHash(readLocal(root, rel)) === expectedHash, `Concurrent edit; retry after review: ${rel}`);
    // For a new file, linking is exclusive: a concurrently created file is never overwritten.
    if (expectedHash === null) { fs.linkSync(temp, file); fs.unlinkSync(temp); }
    else fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return true;
}
export const jsonText = value => JSON.stringify(value, null, 2) + '\n';
export function loadJson(root, rel, fallback = null) { const raw = readLocal(root, rel); return raw === null ? fallback : JSON.parse(raw); }
export function ensureState(root) {
  for (const rel of ['.pi', '.pi/learning']) {
    const target = localPath(root, rel);
    try { fs.mkdirSync(target, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    assert(fs.lstatSync(localPath(root, rel)).isDirectory(), `Not a directory: ${rel}`);
  }
  if (readLocal(root, '.pi/learning/.gitignore') === null) writeLocal(root, '.pi/learning/.gitignore', '# Private telemetry and local opt-in; share only reviewed AGENTS.md guidance.\n*\n', null);
}
export function withLock(root, fn) {
  const lock = localPath(root, '.pi/learning/.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Learning is locked by another operation. After verifying no operation is active, remove .pi/learning/.lock manually.'); throw e; }
  try { return fn(); } finally { fs.rmdirSync(lock); }
}
/** Find special lines outside fenced code. Suspicious/partial markers fail closed. */
export function plainLines(value) {
  const result = []; let fence = null, offset = 0;
  for (const chunk of value.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const line = chunk.replace(/\r?\n$/, '');
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (match) {
      if (!fence) fence = { char: match[1][0], length: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null;
    } else if (!fence) result.push({ line, start: offset, end: offset + chunk.length });
    offset += chunk.length;
  }
  assert(!fence, 'Unclosed Markdown code fence; resolve it before editing project instructions');
  return result;
}
export function claudeImportText(value = '') {
  if (plainLines(value).some(x => /^\s*@(?:\.\/)?AGENTS\.md\s*$/.test(x.line))) return value;
  const nl = value.includes('\r\n') ? '\r\n' : '\n';
  return value + (value && !value.endsWith('\n') ? nl : '') + (value ? nl : '') + `@AGENTS.md${nl}`;
}
