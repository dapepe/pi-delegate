import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeArtifactIdentity, readArtifactIdentity, validateEvaluation } from '../scripts/evaluation.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

test('evaluation accepts bounded custom task types and rejects duplicate workers without a plan', () => {
  const evaluation = {
    schema_version: 1, task_id: 'task-1', task_type: 'data-contract', scope: 'src/api', complexity: 'complex',
    strategy: 'single-review', strategy_version: 'v1', focus: ['correctness', 'custom-focus'],
    workers: [
      { agent_id: 'worker-a', assignment_id: 'assignment-a', attempt_index: 1, criteria: [{ id: 'behavior', requirement: 'Check behavior.' }] }
    ]
  };
  assert.equal(validateEvaluation(evaluation).task_type, 'data-contract');
  assert.throws(() => validateEvaluation({ ...evaluation, workers: [...evaluation.workers, { ...evaluation.workers[0], assignment_id: 'assignment-b' }] }), /Duplicate evaluation worker/);
});

test('artifact identity round-trips add, modify, and delete changes against the saved snapshot', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-artifact-'));
  try {
    const run = path.join(base, 'run'), worker = path.join(run, 'worker'), candidate = path.join(worker, 'candidate', 'src');
    fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
    const snapshot = {
      repo_root: path.join(base, 'repo'),
      files: {
        'src/modify.txt': { sha256: hash('old'), bytes: 3, mode: 0o644 },
        'src/delete.txt': { sha256: hash('gone'), bytes: 4, mode: 0o644 }
      }
    };
    const plan = { agents: [{ id: 'worker', write_files: ['src/add.txt', 'src/modify.txt', 'src/delete.txt'] }] };
    const result = {
      submission: { summary: 'bounded synthetic submission' },
      changes: [
        { file: 'src/add.txt', action: 'add', before_sha256: null, after_sha256: hash('new') },
        { file: 'src/modify.txt', action: 'modify', before_sha256: hash('old'), after_sha256: hash('changed') },
        { file: 'src/delete.txt', action: 'delete', before_sha256: hash('gone'), after_sha256: null }
      ]
    };
    fs.mkdirSync(run, { recursive: true, mode: 0o700 });
    fs.mkdirSync(worker, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(candidate, 'add.txt'), 'new');
    fs.writeFileSync(path.join(candidate, 'modify.txt'), 'changed');
    json(path.join(run, 'plan.json'), plan);
    json(path.join(run, 'snapshot.json'), snapshot);
    json(path.join(worker, 'result.json'), result);
    const actual = readArtifactIdentity(run, 'worker');
    const expected = computeArtifactIdentity({
      submission: result.submission,
      manifest: [
        { path: 'src/add.txt', content: 'new' },
        { path: 'src/modify.txt', content: 'changed' },
        { path: 'src/delete.txt', sha256: hash('gone'), bytes: 4, deleted: true }
      ],
      snapshot
    });
    assert.deepEqual(actual, expected);
    assert.equal(actual.manifest.find(item => item.path === 'src/delete.txt').bytes, 4);

    fs.writeFileSync(path.join(candidate, 'modify.txt'), 'forged');
    assert.throws(() => readArtifactIdentity(run, 'worker'), /do not match saved change hash/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('artifact identity tolerates an authorized write with no candidate directory', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-artifact-empty-'));
  try {
    const run = path.join(base, 'run'), worker = path.join(run, 'worker');
    fs.mkdirSync(worker, { recursive: true, mode: 0o700 });
    json(path.join(run, 'plan.json'), { agents: [{ id: 'worker', write_files: ['src/new.txt'] }] });
    json(path.join(worker, 'result.json'), { submission: { summary: 'no candidate output' }, changes: [] });
    const identity = readArtifactIdentity(run, 'worker');
    assert.equal(identity.manifest.length, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
