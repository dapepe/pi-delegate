#!/usr/bin/env node
/** Offline, no-overwrite installation for Codex and/or Claude Code. Never edits task-project instructions. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { assert } from './lib.mjs';
import { releaseFiles } from './release-files.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export function parseInstallArgs(args) {
  const o = { host: 'codex' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true };
    assert(['--host', '--repo'].includes(args[i]), `Unknown option ${args[i]}`);
    const key = args[i].slice(2);
    assert(!Object.hasOwn(o, `seen_${key}`), `Duplicate option --${key}`);
    o[`seen_${key}`] = true;
    assert(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value for --${key}`);
    o[key] = args[++i];
  }
  if (o.host === 'claude') o.host = 'claude-code';
  assert(['codex', 'claude-code', 'both'].includes(o.host), 'host must be codex, claude-code (or claude), or both');
  return { host: o.host, ...(o.repo ? { repo: o.repo } : {}) };
}
export function destinations(options, home = os.homedir(), env = process.env) {
  const base = fs.realpathSync(options.repo || home);
  assert(fs.statSync(base).isDirectory(), 'Installation base must be a directory');
  // Explicit CLAUDE_CONFIG_DIR is honored only for a personal Claude installation.
  const claude = options.repo ? path.join(base, '.claude') : env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(base, '.claude');
  return (options.host === 'both' ? ['codex', 'claude-code'] : [options.host || 'codex']).map(host => {
    assert(['codex', 'claude-code'].includes(host), 'Unknown host');
    return { host, destination: path.join(host === 'codex' ? path.join(base, '.agents') : claude, 'skills', 'pi') };
  });
}
export function installMany(source, targets) {
  const src = fs.realpathSync(source), files = releaseFiles(src), seen = new Set();
  const plans = targets.map(item => {
    const dest = path.resolve(item.destination);
    assert(!seen.has(dest), 'Duplicate installation destination'); seen.add(dest);
    const inPlace = exists(dest) && !fs.lstatSync(dest).isSymbolicLink() && fs.realpathSync(dest) === src;
    assert(inPlace || !exists(dest), `Destination already exists: ${dest}. Move the previous installation outside all skills folders first; it will not be overwritten.`);
    return { ...item, destination: dest, already_in_place: inPlace };
  });
  const created = [];
  try {
    for (const p of plans) {
      if (p.already_in_place) continue;
      fs.mkdirSync(path.dirname(p.destination), { recursive: true });
      // An exclusive mkdir closes the race between preflight and creation; never remove another install.
      fs.mkdirSync(p.destination); created.push(p.destination);
      for (const file of files) {
        const to = path.join(p.destination, ...file.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(src, ...file.split('/')), to, fs.constants.COPYFILE_EXCL);
      }
      p.copied_files = files.length;
    }
  } catch (e) {
    for (const dest of created.reverse()) fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  return plans;
}
export function install(source, destination) { return installMany(source, [{ destination }])[0]; }
function main() {
  const options = parseInstallArgs(process.argv.slice(2));
  if (options.help) { console.log('Usage: node scripts/install.mjs [--host codex|claude-code|both] [--repo /path/to/repository]\nDefault: personal Codex. Alias: --host claude. No npm, network, credentials, or project-instruction edits.'); return; }
  console.log(JSON.stringify({ installations: installMany(ROOT, destinations(options)), next: [
    'In EACH destination: npm install --ignore-scripts (npm ci --ignore-scripts if a lockfile exists)',
    'In EACH destination: npm run check:sdk && npm test && npm run test:sdk',
    'Configure OPENROUTER_API_KEY or run node scripts/pi.mjs auth yourself; credentials are shared by these skill copies',
    'Codex: select pi from Skills. Claude Code: /pi. Restart the host if the skill is not discovered.',
    'Optional per-project learning: node /absolute/skill/path/scripts/pi.mjs learn init --repo /path/to/project --mode propose --claude-import'
  ] }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
