#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const suite = process.argv[2] ?? 'tests';
if (!['tests', 'tests-sdk'].includes(suite)) throw new Error('Expected tests or tests-sdk.');
const folder = path.join(root, suite);
const files = fs.readdirSync(folder).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(folder, name));
if (!files.length) throw new Error(`No test files in ${suite}.`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
