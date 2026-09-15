/** Shared allowlist for install and packaging. Never copy dependencies, runs, or arbitrary files. */
import fs from 'node:fs';
import path from 'node:path';
import { assert } from './lib.mjs';
export const ROOT_FILES = new Set(['SKILL.md', 'README.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'NOTICE.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'defaults.json', '.gitignore', '.gitattributes', '.editorconfig']);
export const ROOT_DIRS = new Set(['agents', 'scripts', 'templates', 'tests', 'tests-sdk', 'references', 'docs', 'examples', '.github']);
export function releaseFiles(root) {
  const files = [];
  function visit(dir, rel = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (!rel && !ROOT_FILES.has(entry.name) && !ROOT_DIRS.has(entry.name)) continue;
      assert(!entry.isSymbolicLink(), `Refusing to distribute symlink ${entry.name}`);
      assert(!['node_modules', '.git', 'dist', 'runs', '.pi', '.claude', '.agents', '.codex', 'auth.json', 'credentials.json', '.env', '.npmrc'].includes(entry.name.toLowerCase()) && !entry.name.toLowerCase().startsWith('.env.'), `Private/runtime file in release tree: ${entry.name}`);
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative);
      else { assert(entry.isFile(), `Not a regular release file: ${relative}`); files.push(relative); }
    }
  }
  visit(root); return files.sort();
}
