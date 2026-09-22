import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initLearning, setLearningMode, recordLearning, learningSummary, proposeLearning, applyLearning, replaceLearnedBlock, START, END, validateLearningConfig, validateLearningAssessment } from '../scripts/learning.mjs';
import { readLocal, writeLocal, bytesHash, claudeImportText } from '../scripts/project-files.mjs';
import { hostLabel, costSummary } from '../scripts/lib.mjs';
import { computeArtifactIdentity } from '../scripts/evaluation.mjs';
const NOW = Date.parse('2026-09-14T12:00:00Z');
const json = (file,value) => fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
function fixture(mode='propose') {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pi-learning-')),repo=path.join(base,'repo');fs.mkdirSync(repo);
  const original='# Human instructions\n\nDo not raise budgets or change providers.\n';fs.writeFileSync(path.join(repo,'AGENTS.md'),original);
  initLearning(repo,{mode});
  function make(n=1, {host='codex',task=`task-${n}`,outcome='useful',failure='none',model='fixture/model-v1',at='2026-09-10T10:01:00Z'}={}) {
    const out=path.join(base,`run-${n}`);fs.mkdirSync(out);
    const evaluation={agent_id:'review',role:'correctness-review',outcome,validation:'passed',evidence:['Synthetic test evidence reference; no inference occurred.'],failure_kind:failure,regression:'none-observed',rework:'none'};
    if(outcome==='inconclusive'){evaluation.validation='not-run';evaluation.evidence=[];}
    const a={id:'review',role:'reviewer',mode:'read',status:outcome==='inconclusive'?'error':'completed',elapsed_seconds:10,model:{provider:'openrouter',requested_model:model,resolved_model:model,canonical_slug:model,requested_effort:'xhigh',effective_pi_effort:'xhigh'},submission:{summary:'SYNTHETIC fixture',findings:[]},policy_violations:[]};
    // This synthetic fixture deliberately exercises the real-report schema; no live runs are claimed.
    const report={run_id:`run-${n}`,mode:'pi_sdk',created_at:'2026-09-10T10:00:00Z',finished_at:at,source_repo:repo,orchestrator:host,orchestrator_model:'fixture-host-v1',orchestrator_version:'fixture-1',skill_version:'1.2.0',sdk_version_target:'0.85.1',agents:[a]};
    const usage={requests:[{agent_id:'review',response_id:`synthetic-${n}`,provider:'openrouter',billed_model:model,response_model:model,upstream_provider:'fixture-provider',billed_usd:0.1}]};report.costs=costSummary(usage.requests);a.costs=report.costs;
    const assessment={run_id:report.run_id,assessed_by:hostLabel(host),overall_value:'Synthetic independently validated fixture',workers:[{agent_id:'review',usefulness_0_to_3:outcome==='useful'?2:0,reason:'Synthetic evaluation'}],decisions:[],learning:{task_id:task,task_type:'bugfix',scope:'src/api',complexity:'bounded',strategy:'single-review',strategy_version:'v1',workers:[evaluation]}};
    const plan={repo_root:repo,orchestrator:host,policy:{preferred_provider:'openrouter'},agents:[{id:'review',model,effort:'xhigh'}]};
    const snapshot={repo_root:repo,files:{}};
    const save=()=>{for(const [name,v] of Object.entries({report,usage,assessment,plan,snapshot}))json(path.join(out,`${name}.json`),v);};save();
    return {out,report,usage,assessment,plan,snapshot,save,record:(opts={})=>recordLearning(repo,out,undefined,opts)};
  }
  return {base,repo,original,make,read:()=>fs.readFileSync(path.join(repo,'AGENTS.md'),'utf8'),cleanup:()=>fs.rmSync(base,{recursive:true,force:true})};
}
function withFixture(fn,mode='propose'){const f=fixture(mode);try{return fn(f);}finally{f.cleanup();}}
const summary=f=>learningSummary(f.repo,NOW);
function fill(f){for(let i=1;i<=3;i++)f.make(i).record();}

test('learning initialization is opt-in and leaves project instructions alone by default',()=>withFixture(f=>{assert.equal(f.read(),f.original);assert.equal(fs.existsSync(path.join(f.repo,'CLAUDE.md')),false);assert.match(fs.readFileSync(path.join(f.repo,'.pi/learning/.gitignore'),'utf8'),/\*\n/);assert.equal(summary(f).mode,'propose');}));
test('uninitialized summary is read-only and does not create memory',()=>{const base=fs.mkdtempSync(path.join(os.tmpdir(),'pi-empty-'));try{assert.equal(learningSummary(base).initialized,false);assert.deepEqual(fs.readdirSync(base),[]);}finally{fs.rmSync(base,{recursive:true});}});
test('Claude import is explicit, idempotent and preserves existing instructions',()=>withFixture(f=>{fs.writeFileSync(path.join(f.repo,'CLAUDE.md'),'# Claude-specific\r\nKeep this.\r\n');initLearning(f.repo,{claudeImport:true});const first=fs.readFileSync(path.join(f.repo,'CLAUDE.md'),'utf8');assert.equal(first,'# Claude-specific\r\nKeep this.\r\n\r\n@AGENTS.md\r\n');initLearning(f.repo,{claudeImport:true});assert.equal(fs.readFileSync(path.join(f.repo,'CLAUDE.md'),'utf8'),first);assert.equal(f.read(),f.original);}));
test('a fenced import example does not count as an active import',()=>{const old='```md\n@AGENTS.md\n```\n';assert.equal(claudeImportText(old),old+'\n@AGENTS.md\n');assert.equal(claudeImportText('@./AGENTS.md\n'),'@./AGENTS.md\n');});
test('initializing a missing shared AGENTS.md creates it only for the explicit Claude bridge',()=>{const b=fs.mkdtempSync(path.join(os.tmpdir(),'pi-bridge-'));try{initLearning(b,{claudeImport:true});assert.equal(fs.readFileSync(path.join(b,'CLAUDE.md'),'utf8'),'@AGENTS.md\n');assert.match(fs.readFileSync(path.join(b,'AGENTS.md'),'utf8'),/Project instructions/);}finally{fs.rmSync(b,{recursive:true});}});
test('existing learning mode cannot be silently overwritten by init',()=>withFixture(f=>{assert.throws(()=>initLearning(f.repo,{mode:'auto'}));setLearningMode(f.repo,'auto');assert.equal(summary(f).mode,'auto');}));
test('record is idempotent and never edits AGENTS.md',()=>withFixture(f=>{const r=f.make();assert.equal(r.record().recorded,true);assert.equal(r.record().duplicate,true);assert.equal(summary(f).profiles[0].attempts,1);assert.equal(f.read(),f.original);}));
test('propose mode never writes AGENTS.md and needs explicit approval to apply',()=>withFixture(f=>{fill(f);const proposal=proposeLearning(f.repo,{now:NOW});assert.equal(proposal.profile_ids.length,1);assert.equal(f.read(),f.original);assert.throws(()=>applyLearning(f.repo,{reviewedBy:'codex',now:NOW}),/approve/);assert.equal(applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW}).changed,true);assert.ok(f.read().startsWith(f.original));assert.match(f.read(),/3\/3 distinct evaluated tasks useful/);}));
test('auto mode still requires a fresh explicit host-reviewed apply operation',()=>withFixture(f=>{fill(f);assert.equal(f.read(),f.original);proposeLearning(f.repo,{now:NOW});assert.throws(()=>applyLearning(f.repo,{now:NOW}));assert.equal(applyLearning(f.repo,{reviewedBy:'claude-code',now:NOW}).reviewed_by,'Claude Code');},'auto'));
test('worker names cannot authorize memory promotion',()=>withFixture(f=>{proposeLearning(f.repo,{now:NOW});assert.throws(()=>applyLearning(f.repo,{reviewedBy:'worker',approve:true,now:NOW}));}));
test('fewer than three distinct useful tasks cannot become a model preference',()=>withFixture(f=>{f.make().record();const p=summary(f).profiles[0];assert.equal(p.promotable,false);assert.equal(proposeLearning(f.repo,{now:NOW}).profile_ids.length,0);assert.throws(()=>proposeLearning(f.repo,{profiles:[p.profile_id],now:NOW}));}));
test('retries on the same task do not inflate success sample size but all costs count',()=>withFixture(f=>{for(let i=1;i<=4;i++)f.make(i,{task:'same-task'}).record();const p=summary(f).profiles[0];assert.equal(p.attempts,4);assert.equal(p.distinct_tasks,1);assert.equal(p.useful_tasks,1);assert.equal(p.costs.reported_usd,0.4);assert.equal(p.promotable,false);}));
test('bounded-loop observations keep cycles as one task and remain separate from sequence evidence',()=>withFixture(f=>{
  for(let i=1;i<=4;i++){const r=f.make(i,{task:'same-loop-task'});r.assessment.learning.strategy='bounded-loop';r.save();r.record();}
  const sequence=f.make(5,{task:'same-loop-task'});sequence.assessment.learning.strategy='sequence';sequence.save();sequence.record();
  const profiles=summary(f).profiles;assert.equal(profiles.length,2);
  const loop=profiles.find(p=>p.profile.strategy==='bounded-loop');assert.equal(loop.attempts,4);assert.equal(loop.distinct_tasks,1);assert.equal(loop.useful_tasks,1);assert.equal(loop.costs.reported_usd,0.4);assert.equal(loop.promotable,false);
}));
test('host and host-model changes keep observational profiles separate',()=>withFixture(f=>{f.make(1).record();f.make(2,{host:'claude-code'}).record();const r=f.make(3);r.report.orchestrator_model='other-host';r.save();r.record();assert.equal(summary(f).profiles.length,3);}));
test('model-version changes are not pooled under a moving alias',()=>withFixture(f=>{for(let i=1;i<=2;i++){const r=f.make(i);r.report.agents[0].model.requested_model='fixture/latest';r.report.agents[0].model.catalog_alias_target={slug:`fixture/version-${i}`};r.usage.requests[0].billed_model=`fixture/version-${i}`;r.save();r.record();}assert.equal(summary(f).profiles.length,2);}));
test('task class, scope, strategy version, role, effort, access and upstream stay separate',()=>withFixture(f=>{f.make(1).record();const changes=[r=>r.assessment.learning.task_type='architecture',r=>r.assessment.learning.scope='src/cli',r=>r.assessment.learning.strategy_version='v2',r=>r.assessment.learning.workers[0].role='test-review',r=>r.report.agents[0].model.effective_pi_effort='max',r=>r.report.agents[0].mode='write',r=>r.usage.requests[0].upstream_provider='other-provider'];changes.forEach((fn,i)=>{const r=f.make(i+2);fn(r);r.save();r.record();});assert.equal(summary(f).profiles.length,8);}));
test('operational failures do not count as model-quality failures',()=>withFixture(f=>{fill(f);f.make(4,{outcome:'inconclusive',failure:'provider'}).record();const p=summary(f).profiles[0];assert.equal(p.harmful_tasks,0);assert.equal(p.operational_failures,1);assert.equal(p.quality_evaluated_tasks,3);assert.equal(p.promotable,true);}));
test('validated harmful outcome blocks promotion despite previous useful outcomes',()=>withFixture(f=>{fill(f);f.make(4,{outcome:'harmful',failure:'model'}).record();const p=summary(f).profiles[0];assert.equal(p.harmful_tasks,1);assert.equal(p.promotable,false);assert.equal(proposeLearning(f.repo,{now:NOW}).profile_ids.length,0);}));
test('late regression revisions preserve audit history and demote prior preferences',()=>withFixture(f=>{const first=f.make(1);first.record();f.make(2).record();f.make(3).record();proposeLearning(f.repo,{now:NOW});applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW});first.assessment.learning.workers[0].outcome='harmful';first.assessment.learning.workers[0].regression='confirmed';first.assessment.learning.workers[0].failure_kind='model';first.assessment.workers[0].usefulness_0_to_3=0;first.save();assert.throws(()=>first.record(),/revise/);first.record({revise:true});assert.equal(summary(f).profiles[0].promotable,false);const h=JSON.parse(fs.readFileSync(path.join(f.repo,'.pi/learning/history.json')));assert.equal(h.runs[0].revisions.length,1);proposeLearning(f.repo,{now:NOW});applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW});assert.match(f.read(),/No promoted preference/);}));
test('revisions cannot change the task id to manufacture an independent observation',()=>withFixture(f=>{const r=f.make();r.record();r.assessment.learning.task_id='new-task';r.save();assert.throws(()=>r.record({revise:true}),/independent sample/);}));
test('stale observations expire instead of becoming permanent model rankings',()=>withFixture(f=>{for(let i=1;i<=3;i++)f.make(i,{at:'2026-01-01T00:00:00Z'}).record();assert.equal(summary(f).profiles.length,0);assert.equal(summary(f).expired_observations,3);}));
test('unknown and estimated costs are distinct and revise does not double-count late billing',()=>withFixture(f=>{const r=f.make();delete r.usage.requests[0].billed_usd;r.usage.requests[0].estimate_usd=0.2;r.usage.requests.push({agent_id:'review',provider:'openrouter'});r.save();r.record();let c=summary(f).profiles[0].costs;assert.equal(c.reported_usd,0);assert.equal(c.estimated_unreconciled_usd,0.2);assert.equal(c.unpriced_requests,1);r.usage.requests[0].billed_usd=0.15;r.save();r.record({revise:true});c=summary(f).profiles[0].costs;assert.equal(c.reported_usd,0.15);assert.equal(c.estimated_unreconciled_usd,0);assert.equal(summary(f).profiles[0].attempts,1);}));
test('unverified praise and self-ratings cannot create positive learning evidence',()=>withFixture(f=>{for(const edit of [r=>r.assessment.assessed_by='worker',r=>r.assessment.learning.workers[0].validation='not-run',r=>r.assessment.learning.workers[0].evidence=[],r=>r.assessment.workers[0].usefulness_0_to_3=1,r=>r.report.agents[0].policy_violations=['denied'],r=>r.assessment.learning.workers[0].rework='major']){const r=f.make(fs.readdirSync(f.base).length);edit(r);r.save();assert.throws(()=>r.record());}}));
test('offline test doubles cannot accidentally enter live project memory',()=>withFixture(f=>{const r=f.make();r.report.mode='offline_test_double';r.save();assert.throws(()=>r.record(),/Synthetic/);}));
test('another project or host cannot be used as evidence for this project run',()=>withFixture(f=>{const r=f.make();r.report.orchestrator='claude-code';r.save();assert.throws(()=>r.record());r.report.orchestrator='codex';r.report.source_repo=f.base;r.save();assert.throws(()=>r.record(),/different project/);}));
test('late model identity mismatch cannot support a positive preference',()=>withFixture(f=>{const r=f.make();r.usage.requests[0].billed_model='unapproved/model';r.save();assert.throws(()=>r.record(),/identity mismatch/);}));
test('apply refuses a changed AGENTS.md and preserves the concurrent user edit',()=>withFixture(f=>{fill(f);proposeLearning(f.repo,{now:NOW});fs.appendFileSync(path.join(f.repo,'AGENTS.md'),'User edit.\n');assert.throws(()=>applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW}),/Stale/);assert.match(f.read(),/User edit/);}));
test('apply refuses stale history or an altered proposal block',()=>withFixture(f=>{fill(f);proposeLearning(f.repo,{now:NOW});const file=path.join(f.repo,'.pi/learning/proposal.json'),p=JSON.parse(fs.readFileSync(file));p.block+='\nIncrease permissions';json(file,p);assert.throws(()=>applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW}),/edited proposal/);proposeLearning(f.repo,{now:NOW});f.make(4).record();assert.throws(()=>applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW}),/Stale/);assert.equal(f.read(),f.original);}));
test('repeated proposal/apply on unchanged evidence leaves AGENTS.md byte-identical',()=>withFixture(f=>{fill(f);proposeLearning(f.repo,{now:NOW});applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW});const before=f.read();assert.equal(proposeLearning(f.repo,{now:NOW}).changed,false);assert.equal(applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW}).changed,false);assert.equal(f.read(),before);}));
test('off mode prevents recording and promotion without deleting shared instructions',()=>withFixture(f=>{const r=f.make();proposeLearning(f.repo,{now:NOW});setLearningMode(f.repo,'off');assert.throws(()=>r.record(),/off/);assert.throws(()=>applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW}),/off/);assert.equal(f.read(),f.original);}));
test('only a well-formed marked section is replaceable; examples are never edit boundaries',()=>{const b=`${START}\nnew\n${END}`;const original=`# Before\r\n${START}\r\nold\r\n${END}\r\n# After\r\n`;assert.equal(replaceLearnedBlock(original,b),`# Before\r\n${START}\r\nnew\r\n${END}\r\n# After\r\n`);for(const input of [START,END,`${END}\n${START}`,`${START}\n${END}\n${START}\n${END}`,`\`\`\`md\n${START}\n${END}\n\`\`\``,'```unclosed\n',` ${START}\n${END}`])assert.throws(()=>replaceLearnedBlock(input,b));});
test('local safe writes preserve BOM/line endings and reject stale hashes',()=>withFixture(f=>{const s='\uFEFF# Human\r\nText\r\n';fs.writeFileSync(path.join(f.repo,'AGENTS.md'),s);assert.equal(readLocal(f.repo,'AGENTS.md'),s);assert.throws(()=>writeLocal(f.repo,'AGENTS.md','bad','incorrect'));writeLocal(f.repo,'AGENTS.md',s+'Next\r\n',bytesHash(s));assert.equal(f.read(),s+'Next\r\n');}));
test('learning locks fail closed rather than racing concurrent promotions',()=>withFixture(f=>{const lock=path.join(f.repo,'.pi/learning/.lock');fs.mkdirSync(lock);assert.throws(()=>proposeLearning(f.repo,{now:NOW}),/locked/);assert.equal(fs.existsSync(lock),true);fs.rmdirSync(lock);}));
test('learning config cannot lower evidence floors or expand the summary limit',()=>withFixture(f=>{const c=JSON.parse(fs.readFileSync(path.join(f.repo,'.pi/learning/config.json')));for(const change of [{min_distinct_tasks:1},{min_useful_fraction:0.1},{max_rules:99},{max_block_bytes:100000},{mode:'unrestricted'},{shell:true}])assert.throws(()=>validateLearningConfig({...c,...change}));}));
test('reflection text and scripts are not an accepted strategy configuration',()=>withFixture(f=>{const r=f.make();r.assessment.learning.strategy='run-untrusted-script';assert.throws(()=>validateLearningAssessment(r.assessment,r.report));r.assessment.learning.strategy='single-review';r.assessment.learning.shell='rm';assert.throws(()=>validateLearningAssessment(r.assessment,r.report));}));
test('explicit profile removal generates a safe empty advisory block',()=>withFixture(f=>{fill(f);const p=proposeLearning(f.repo,{profiles:[],now:NOW});assert.equal(p.profile_ids.length,0);applyLearning(f.repo,{reviewedBy:'codex',approve:true,now:NOW});assert.match(f.read(),/No promoted preference/);}));
test('oversized AGENTS.md is not silently expanded beyond Codex default context budget',()=>withFixture(f=>{fs.writeFileSync(path.join(f.repo,'AGENTS.md'),'x'.repeat(32768));assert.throws(()=>proposeLearning(f.repo,{now:NOW}),/32 KiB/);assert.equal(f.read().length,32768);}));
test('instruction-file symlinks and hardlinks cannot redirect learning writes',{skip:process.platform==='win32'},()=>withFixture(f=>{fs.unlinkSync(path.join(f.repo,'AGENTS.md'));const other=path.join(f.base,'other');fs.writeFileSync(other,'outside');fs.symlinkSync(other,path.join(f.repo,'AGENTS.md'));assert.throws(()=>proposeLearning(f.repo,{now:NOW}),/symlink/);fs.unlinkSync(path.join(f.repo,'AGENTS.md'));fs.linkSync(other,path.join(f.repo,'AGENTS.md'));assert.throws(()=>proposeLearning(f.repo,{now:NOW}),/hardlinked/);assert.equal(fs.readFileSync(other,'utf8'),'outside');}));


test('newer failures cannot extend the refresh date of older supporting observations',()=>withFixture(f=>{fill(f);f.make(4,{at:'2026-09-14T10:00:00Z',outcome:'inconclusive',failure:'provider'}).record();const p=summary(f).profiles[0];assert.equal(p.revalidate_after,new Date(Date.parse('2026-09-10T10:01:00Z')+90*86400000).toISOString());}));
test('useful evidence requires captured requests and resolved configuration',()=>withFixture(f=>{for(const edit of [r=>r.usage.requests=[],r=>delete r.report.agents[0].model.resolved_model,r=>delete r.report.agents[0].model.effective_pi_effort]){const r=f.make(fs.readdirSync(f.base).length);edit(r);r.save();assert.throws(()=>r.record(),/captured request/);}}));
test('a changed companion model does not pool an ensemble contribution',()=>withFixture(f=>{for(let i=1;i<=2;i++){const r=f.make(i),other=structuredClone(r.report.agents[0]);other.id='companion';other.model.requested_model=other.model.resolved_model=other.model.canonical_slug=`fixture/companion-${i}`;r.report.agents.push(other);r.plan.agents.push({id:'companion',model:other.model.resolved_model,effort:'xhigh'});r.usage.requests.push({...r.usage.requests[0],agent_id:'companion',billed_model:other.model.resolved_model,response_model:other.model.resolved_model});r.assessment.workers.push({...r.assessment.workers[0],agent_id:'companion'});r.assessment.learning.workers.push({...r.assessment.learning.workers[0],agent_id:'companion',role:'test-review'});r.assessment.learning.strategy='parallel-independent';r.save();r.record();}assert.equal(summary(f).profiles.filter(p=>p.profile.role==='correctness-review').length,2);}));
test('the public learn CLI supports local Claude setup and rejects unused flags without inference',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pi-cli-learning-')),cli=fileURLToPath(new URL('../scripts/pi.mjs',import.meta.url));
  const run=(...args)=>spawnSync(process.execPath,[cli,'learn',...args],{encoding:'utf8',env:{...process.env,OPENROUTER_API_KEY:''}});
  try{let r=run('init','--repo',base,'--mode','auto','--claude-import');assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).mode,'auto');assert.equal(fs.readFileSync(path.join(base,'CLAUDE.md'),'utf8'),'@AGENTS.md\n');r=run('summary','--repo',base);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout).profiles,[]);r=run('summary','--repo',base,'--approve');assert.equal(r.status,1);assert.match(r.stderr,/not used/);}finally{fs.rmSync(base,{recursive:true});}
});

test('limit failures stay operational rather than negative model-quality evidence',()=>withFixture(f=>{
  fill(f);const r=f.make(4,{outcome:'inconclusive',failure:'limit'});r.report.agents[0].status='turn_limit';r.save();r.record();
  const p=summary(f).profiles[0];assert.equal(p.operational_failures,1);assert.equal(p.quality_evaluated_tasks,3);assert.equal(p.harmful_tasks,0);
}));
test('different runtime allocations cannot be pooled as the same model strategy',()=>withFixture(f=>{
  for(let i=1;i<=2;i++){const r=f.make(i);r.plan.policy.max_turns=i===1?12:32;r.plan.policy.timeout_seconds=i===1?600:1800;r.save();r.record();}
  const profiles=summary(f).profiles;assert.equal(profiles.length,2);assert.equal(profiles[0].distinct_tasks,1);assert.equal(profiles[1].distinct_tasks,1);
}));
test('promoted guidance shows the recorded allocation without granting a larger one',()=>withFixture(f=>{
  for(let i=1;i<=3;i++){const r=f.make(i);r.plan.policy.max_turns=32;r.plan.policy.timeout_seconds=1800;r.save();r.record();}
  const proposal=proposeLearning(f.repo,{now:NOW});assert.match(proposal.block,/32 requests/);assert.match(proposal.block,/1800 worker seconds/);assert.match(proposal.block,/not permission to increase/);
}));
test('a partial worker result keeps its stop diagnostic in the observation',()=>withFixture(f=>{
  const r=f.make(1,{outcome:'inconclusive',failure:'limit'});
  r.report.agents[0].status='partial';
  r.report.agents[0].stop_diagnostic={layer:'partial',advice:'Review remaining_work.'};
  r.report.agents[0].failure_class='partial';
  r.report.agents[0].limit_usage={requests:9,tool_calls:41,elapsed_seconds:512,completion_repairs:1};
  r.report.agents[0].recovery_events=[{type:'completion_repair',trigger:'missing_submission',mode:'bounded_continuation'}];
  r.save();r.record();
  const history=JSON.parse(fs.readFileSync(path.join(f.repo,'.pi/learning/history.json'),'utf8'));
  const observation=history.runs.at(-1).current.observations.at(-1);
  assert.equal(observation.stop_diagnostic.layer,'partial');
  assert.equal(observation.failure_class,'partial');
  assert.equal(observation.limit_usage.completion_repairs,1);
  assert.equal(observation.recovery_events[0].mode,'bounded_continuation');
}));

test('schema-2 learning keeps sanitized assignment and quality metadata with a versioned dated-model profile',()=>withFixture(f=>{
  const r=f.make(20);
  const artifact=computeArtifactIdentity({submission:r.report.agents[0].submission,manifest:[],snapshot:r.snapshot}).artifact_sha256;
  r.report.evaluation={schema_version:1,task_id:'task-20',task_type:'bugfix',scope:'src/api',complexity:'bounded',strategy:'single-review',strategy_version:'v1',focus:['correctness','security'],workers:[{agent_id:'review',assignment_id:'assignment-20',attempt_index:1,criteria:[{id:'behavior',requirement:'Synthetic criterion.'}]}]};
  r.plan.evaluation=structuredClone(r.report.evaluation);
  r.report.agents[0].artifact_identity={schema_version:1,artifact_sha256:artifact};
  r.report.agents[0].model.catalog_alias_target={slug:'provider/model-latest',canonical_slug:'provider/model-20260901'};
  r.assessment.schema_version=2;
  r.assessment.workers[0].quality_0_to_3=2;
  r.assessment.workers[0].quality_reason='Synthetic host quality reason must not be persisted.';
  r.assessment.workers[0].criterion_results=[{id:'behavior',result:'passed',evidence:['Synthetic evidence reference.']}];
  r.assessment.workers[0].artifact_sha256=artifact;
  r.assessment.workers[0].integration_status='accepted_unmodified';
  r.assessment.learning.task_id='task-20';
  r.assessment.learning.focus=['correctness','security'];
  r.assessment.learning.task_type='bugfix';
  r.save();
  fs.mkdirSync(path.join(r.out,'review'),{mode:0o700});
  json(path.join(r.out,'review','result.json'),{submission:r.report.agents[0].submission,changes:[]});
  r.record();
  const history=JSON.parse(fs.readFileSync(path.join(f.repo,'.pi/learning/history.json'),'utf8'));
  const observation=history.runs.at(-1).current.observations[0];
  assert.equal(observation.profile.profile_schema_version,2);
  assert.equal(observation.profile.model_identity,'provider/model-20260901');
  assert.deepEqual(observation.evaluation_metadata,{schema_version:2,focus:['correctness','security'],assignment_id:'assignment-20',attempt_index:1,criteria:[{id:'behavior',result:'passed',evidence_count:1}],quality_0_to_3:2,artifact_sha256:artifact,integration_status:'accepted_unmodified'});
  assert.equal('quality_reason' in observation,false);
  assert.equal(JSON.stringify(observation).includes('Synthetic host quality reason must not be persisted.'),false);
  assert.equal(learningSummary(f.repo,NOW).profiles[0].profile_schema_version,2);
}));
