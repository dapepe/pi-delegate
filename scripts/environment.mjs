/** Local setup only. No model tool can invoke these helpers or read credentials. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { assert } from './lib.mjs';

export const CREDENTIAL_FILE = path.join(os.homedir(), '.config', 'pi', 'credentials.json');
export const KEY_NAMES = Object.freeze({
  openrouter: ['OPENROUTER_API_KEY'], openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'], google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
});
export const SECRET_VALUES = new Set();
export const nodeSupported = (version = process.versions.node) => {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
};
export function installedPackage(name, resolver = import.meta.resolve) {
  // pi-ai deliberately does not export package.json. Walk from its exported entry instead.
  let dir = path.dirname(fileURLToPath(resolver(name)));
  while (true) {
    const filename = path.join(dir, 'package.json');
    if (fs.existsSync(filename)) {
      const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (pkg.name === name) return { name, version: pkg.version, root: dir };
    }
    const next = path.dirname(dir);
    assert(next !== dir, `Cannot locate installed metadata for ${name}`);
    dir = next;
  }
}
export function credentialStatus(provider = 'openrouter', env = process.env, filename = CREDENTIAL_FILE) {
  assert(KEY_NAMES[provider], `Unsupported credential provider: ${provider}`);
  const variable = KEY_NAMES[provider].find(k => env[k]?.trim());
  if (variable) return { present: true, source: 'environment', variable };
  try {
    const data = readCredentialFile(filename);
    return { present: Boolean(data[provider]), source: data[provider] ? 'private_file' : null, path: filename };
  } catch (e) { return { present: false, source: null, error: e.message }; }
}
export function readCredentialFile(filename = CREDENTIAL_FILE) {
  if (!fs.existsSync(filename)) return {};
  const stat = fs.lstatSync(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32768, 'Invalid private credential file');
  if (process.platform !== 'win32') {
    assert((stat.mode & 0o077) === 0, 'Credential file must be owner-only: chmod 600 the file');
    assert(!process.getuid || stat.uid === process.getuid(), 'Credential file must be owned by the current user');
  }
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Invalid private credential format');
  for (const [key, value] of Object.entries(parsed)) {
    assert(KEY_NAMES[key] && typeof value === 'string' && value.trim().length > 0 && value.length <= 8192, 'Invalid credential entry');
  }
  return parsed;
}
export function keyFor(provider, env = process.env, filename = CREDENTIAL_FILE) {
  assert(KEY_NAMES[provider], `Unsupported credential provider: ${provider}`);
  const key = KEY_NAMES[provider].map(k => env[k]?.trim()).find(Boolean) || readCredentialFile(filename)[provider]?.trim();
  assert(key, `Missing ${KEY_NAMES[provider].join(' or ')}. For OpenRouter run: node scripts/pi.mjs auth. Never put credentials in chat or plans.`);
  SECRET_VALUES.add(key);
  return key;
}
export function scrub(error, secrets = []) {
  let s = String(error?.message || error).slice(0, 8000);
  for (const secret of [...SECRET_VALUES, ...secrets]) if (secret) s = s.split(secret).join('[REDACTED]');
  return s.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]').slice(0, 2000);
}
function readHidden(prompt) {
  assert(process.stdin.isTTY && process.stdout.isTTY, 'Run auth yourself in an interactive terminal, not through an AI host or a pipe');
  process.stdout.write(prompt);
  readline.emitKeypressEvents(process.stdin);
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.removeListener('keypress', handler);
      process.stdin.setRawMode(Boolean(previousRaw)); process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value.trim());
    };
    const handler = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled; no credential was written'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { value = value.slice(0, -1); return; }
      if (!key.ctrl && !key.meta && str && !/[\x00-\x1f\x7f]/.test(str)) {
        value += str;
        if (value.length > 8192) finish(new Error('Credential too long'));
      }
    };
    process.stdin.on('keypress', handler);
  });
}
export async function authenticate() {
  console.log('Store an OpenRouter API key locally for this skill. The key is plaintext, not encrypted, in your private user configuration. Environment credentials take precedence.');
  console.log(`Location: ${CREDENTIAL_FILE}`);
  const key = await readHidden('Paste OpenRouter API key (hidden; Ctrl+C cancels): ');
  assert(key && !/\s/.test(key), 'Expected a nonempty API key without whitespace');
  SECRET_VALUES.add(key);
  const directory = path.dirname(CREDENTIAL_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert(!fs.lstatSync(directory).isSymbolicLink(), 'Credential directory must not be a symlink');
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const data = readCredentialFile(); data.openrouter = key;
  const temporary = `${CREDENTIAL_FILE}.${process.pid}.tmp`;
  try {
    // On Windows tighten the directory ACL BEFORE any secret bytes are written.
    if (process.platform === 'win32') {
      // Construct a NEW protected ACL, not an incremental grant that could retain other users.
      const command = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:PI_CREDENTIAL_DIRECTORY -AclObject $acl`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe', env: { ...process.env, PI_CREDENTIAL_DIRECTORY: directory } });
    }
    fs.writeFileSync(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, CREDENTIAL_FILE);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  console.log('Credential stored. Its value was not printed. Run doctor from a task in the current host to check access without revealing it.');
}
export function doctor(skillDir) {
  const checks = [{ name: 'Node >=22.19.0', ok: nodeSupported(), actual: process.versions.node }];
  for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'diff']) {
    try {
      const pkg = installedPackage(name);
      const expected = name === 'diff' ? '8.0.4' : '0.85.1';
      checks.push({ name, ok: pkg.version === expected, actual: pkg.version, expected });
    } catch { checks.push({ name, ok: false, remedy: 'Run npm install in the installed skill folder, or npm ci when a lockfile is present' }); }
  }
  const credential = credentialStatus();
  checks.push({ name: 'OpenRouter credential accessible', ok: credential.present, ...credential });
  return {
    skill: 'pi', skill_directory: skillDir, ready_for_sdk_check: checks.slice(0, -1).every(x => x.ok),
    ready_for_live_preflight: checks.every(x => x.ok), checks,
    credential_note: 'Presence only; this does not validate the key, credits, routing, or endpoint access. No inference or network request was made.'
  };
}
