#!/usr/bin/env node
/** Explicitly opt-in paid smoke test; sends only the public fixture below. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { executeJob } from './pi.mjs';
import { scrub } from './environment.mjs';
const args=process.argv.slice(2);
if (args.length!==1 || args[0]!=='--allow-paid') {
  console.error('Usage: node scripts/smoke.mjs --allow-paid\nThis sends a tiny public fixture to OpenRouter. Soft budget: $0.25. Actual billing and in-flight overshoot remain possible. No real repository is read.');
  process.exitCode=1;
} else {
  const base=path.join(os.homedir(),'.cache','pi-smoke',crypto.randomUUID()),repo=path.join(base,'fixture');
  fs.mkdirSync(repo,{recursive:true,mode:0o700});fs.writeFileSync(path.join(repo,'add.js'),'// Public synthetic smoke-test fixture; no confidential source.\nexport function add(a, b) { return a - b; }\n',{mode:0o600});
  const plan={repo_root:repo,objective:'Validate a single read-only Pi worker and cost reporting',context:'This is a public synthetic fixture. Inspect the implementation against the name add. Report one finding with exact line evidence. Do not write or execute anything.',read_files:['add.js'],policy:{max_agents:1,max_parallel:1,max_turns:4,max_tool_calls:6,max_output_tokens:8192,timeout_seconds:120,per_agent_budget_usd:0.25,session_budget_usd:0.25},agents:[{id:'smoke',role:'read-only reviewer',model:'google/gemini-3.8-flash',mode:'read',effort:'xhigh',selection_reason:'User-approved single-model smoke test on public code',task:'Read add.js and report the mismatch between the intended addition and implementation. Use submit_result, include exact line evidence, and label tests as proposed.'}]};
  try {
    const result=await executeJob(plan,path.join(base,'run'),{onProgress:e=>console.error(JSON.stringify(e))});
    console.log(JSON.stringify({run_directory:result.out,status:result.report.agents[0].status,costs:result.report.costs,note:'This checks transport, tool use and reporting; it is not a comprehensive safety or model-quality evaluation.'},null,2));
    if(result.report.agents[0].status!=='completed')process.exitCode=2;
  }catch(e){console.error(scrub(e));process.exitCode=1;}
}
