/** Built-in Windows PowerShell helper. No profiles or persistent environment changes. */
import { execFileSync } from 'node:child_process';

export function runWindowsPowerShell(command, variables = {}) {
  const childEnv = { ...process.env, ...variables };
  // A PowerShell 7 parent can export its incompatible module paths to Windows
  // PowerShell 5.1. Let the child reconstruct its own built-in module locations.
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'psmodulepath') delete childEnv[key];
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'pipe', timeout: 15000, env: childEnv
  });
}
