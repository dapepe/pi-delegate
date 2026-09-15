import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, cleanRel, mergePolicy, validatePlan, captureSnapshot, createCapabilities, budgetBasis, reserveEstimate, openRouterModel, validateSubmission, costSummary } from '../scripts/lib.mjs';
import { executeJob } from '../scripts/pi.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaults = JSON.parse(fs.readFileSync(path.join(root,'defaults.json')));
function fixture() {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pi-audit-')), repo=path.join(base,'repo'), out=path.join(base,'run');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo,'a.js'),'export const n = 1;\n');
  const plan={repo_root:repo, objective:'Review the source', read_files:['a.js'], agents:[{id:'review',role:'reviewer',task:'Inspect n',model:defaults.preferred_models[1],mode:'read',selection_reason:'Independent evidence'}]};
  return {repo,out,plan,cleanup:()=>fs.rmSync(base,{recursive:true,force:true})};
}
const submission=()=>({summary:'Review complete',findings:[],proposed_tests:['Run tests in Codex'],open_questions:[]});
const invoke=(caps,name,args)=>caps.tools.find(t=>t.name===name).execute('test',args,new AbortController().signal);
const usage={input:10,output:5,cacheRead:0,cacheWrite:0,reasoning:2,totalTokens:15,cost:{input:0.00001,output:0.00001,cacheRead:0,cacheWrite:0,total:0.00002}};
function dependencies(plan, behavior, extra={}) {
  const id=plan.agents[0].model;
  const model=openRouterModel({id,reasoning:{supported_efforts:['high','max']},pricing:{prompt:'0.000001',completion:'0.000002'},context_length:128000,top_provider:{max_completion_tokens:32768}}, defaults.openrouter_routing);
  class FixtureAgent {
    constructor(options){this.o=options;this.listeners=[];}
    subscribe(fn){this.listeners.push(fn);}
    async emit(e){for(const fn of this.listeners) await fn(e);}
    abort(){this.aborted=true;}
    async prompt(){await behavior(this);}
    async request(){return this.o.streamFn(model,{messages:[],systemPrompt:'test'},{});}
    async finish(extra={}){await this.emit({type:'message_end',message:{role:'assistant',stopReason:'toolUse',responseId:'gen-fixture',usage,...extra}});}
    async submit(){await this.o.initialState.tools.find(t=>t.name==='submit_result').execute('s',submission());}
  }
  return {Agent:FixtureAgent,keyFor:()=> 'OFFLINE_KEY',resolve:async a=>({model, metadata:{provider:'openrouter',requested_model:a.model,resolved_model:id,requested_effort:'xhigh',effective_pi_effort:'max',configured_provider_effort:'max',max_output_tokens:1000}}),adapter:()=>({streamSimple:()=>undefined}),fetchGeneration:async()=>({data:{total_cost:0.00003,model:id}}),createPatch:()=>'',...extra};
}
test('containment handles filesystem roots and sibling prefix tricks',()=>{
  const root=path.parse(os.tmpdir()).root;
  assert.equal(inside(root,os.tmpdir()),true);
  assert.equal(inside(path.join(root,'a'),path.join(root,'ab')),false);
});
test('portable paths reject devices, trailing dots, and Windows wildcard names',()=>{
  for(const p of ['CON','aux.txt','src/Lpt1.js','a.','a ','src/a?.js','a*','foo:bar']) assert.throws(()=>cleanRel(p));
  assert.equal(cleanRel('src/console.ts'),'src/console.ts');
});
test('nested policy objects cannot be arrays or null and route price limits are validated',()=>{
  for(const x of [{model_aliases:[]},{model_aliases:null},{openrouter_routing:[]},{openrouter_routing:{max_price:{completion:-1}}},{openrouter_routing:{max_price:{unknown:1}}}]) assert.throws(()=>mergePolicy(defaults,x));
  assert.equal(mergePolicy(defaults,{openrouter_routing:{max_price:{completion:10}}}).openrouter_routing.max_price.completion,10);
});
test('provider exceptions need an explicit policy grant and a nonempty reason',()=>{
  const f=fixture();try {
    f.plan.agents[0].provider='openai'; assert.throws(()=>validatePlan(f.plan,defaults));
    f.plan.policy={allow_model_exceptions:true};f.plan.agents[0].model_exception_reason=' ';assert.throws(()=>validatePlan(f.plan,defaults));
    f.plan.agents[0].model_exception_reason='User explicitly approved a native-provider experiment';assert.equal(validatePlan(f.plan,defaults).agents[0].provider,'openai');
  }finally{f.cleanup();}
});
test('plans reject case, Unicode, and file/directory path grant collisions',()=>{
  const f=fixture();try {
    for(const paths of [['A.js','a.js'],['caf\u00e9.js','cafe\u0301.js'],['a','a/b.js']]) {
      f.plan.read_files=paths;assert.throws(()=>validatePlan(f.plan,defaults));
    }
  }finally{f.cleanup();}
});
test('plan field types, bounded lists, and output worker names fail closed',()=>{
  const f=fixture();try {
    for(const patch of [{context:[]},{policy_sources:'AGENTS.md'},{read_files:['a.js',...Array(256).fill('a.js')]},{agents:[null]}]) assert.throws(()=>validatePlan({...f.plan,...patch},defaults));
    f.plan.agents[0].id='con';assert.throws(()=>validatePlan(f.plan,defaults));
  }finally{f.cleanup();}
});
test('uncreated candidate paths cannot be cited as evidence',()=>{
  const value=submission();value.findings=[{id:'F1',title:'Bad code',severity:'high',confidence:'high',file:'not-created.js',line:1,evidence:'invented',recommendation:'fix'}];
  assert.throws(()=>validateSubmission(value,new Map([['not-created.js',null]])));
});
test('source read/search coverage is recorded without claiming comprehension',async()=>{
  const f=fixture();try {
    const p=validatePlan(f.plan,defaults),caps=createCapabilities(p.agents[0],captureSnapshot(p),p.policy);
    await invoke(caps,'read_file',{path:'a.js',start_line:1,line_count:1});await invoke(caps,'search_files',{query:'n ='});
    assert.deepEqual(caps.state.reads,[{file:'a.js',start_line:1,line_count:1}]);assert.deepEqual(caps.state.searches[0].files_searched,['a.js']);
    assert.equal('comprehension' in caps.state,false);
  }finally{f.cleanup();}
});
test('reservations cover unpriced/in-flight requests but are never reported as billing',()=>{
  const rows=[{billed_usd:0.1,estimate_usd:0.2,reserved_usd:1},{billed_usd:null,estimate_usd:0.3,reserved_usd:1},{reserved_usd:2}];
  assert.equal(budgetBasis(rows),2.4);assert.equal(costSummary(rows).provider_reported_usd,0.1);assert.equal(costSummary(rows).unpriced_request_count,1);
  assert.equal(reserveEstimate({cost:{input:1,output:2,cacheRead:3,cacheWrite:4}},100,200),0.0008);
});
test('synthetic error after a completed response does not erase its usage or charge',async()=>{
  const f=fixture();try {
    const d=dependencies(f.plan,async a=>{await a.request();await a.finish();await a.emit({type:'message_end',message:{role:'assistant',stopReason:'error',usage:{totalTokens:0,cost:{total:0}},errorMessage:'Later guard failure'}});});
    const {report}=await executeJob(f.plan,f.out,d);const rows=JSON.parse(fs.readFileSync(path.join(f.out,'usage.json'))).requests;
    assert.equal(rows.length,1);assert.deepEqual(rows[0].usage,usage);assert.equal(rows[0].billed_usd,0.00003);assert.equal(report.agents[0].status,'error');
  }finally{f.cleanup();}
});
test('zero-filled successful usage remains unknown when billing lookup fails',async()=>{
  const f=fixture();try {
    const d=dependencies(f.plan,async a=>{await a.request();await a.finish({usage:{totalTokens:0,cost:{total:0}}});await a.submit();},{fetchGeneration:async()=>{throw new Error('Unavailable');}});
    const {report}=await executeJob(f.plan,f.out,d);assert.equal(report.costs.unpriced_request_count,1);assert.equal(report.costs.estimated_unreconciled_usd,0);assert.equal(report.costs.all_requests_reconciled,false);
  }finally{f.cleanup();}
});
test('an interrupted stream retains generation identity and reconciles its charge',async()=>{
  const f=fixture();try {
    const d=dependencies(f.plan,async a=>{await a.request();await a.emit({type:'message_update',message:{responseId:'gen-interrupted'}});throw new Error('Connection ended');});
    const {report}=await executeJob(f.plan,f.out,d);const row=JSON.parse(fs.readFileSync(path.join(f.out,'usage.json'))).requests[0];
    assert.equal(row.response_id,'gen-interrupted');assert.equal(row.status,'error');assert.equal(report.costs.provider_reported_usd,0.00003);
  }finally{f.cleanup();}
});
test('known canonical model identities are accepted and unrelated identities stop tool use',async()=>{
  const f=fixture();try {
    let d=dependencies(f.plan,async a=>{await a.request();await a.finish({responseModel:'canonical/model'});await a.submit();},{fetchGeneration:async()=>({data:{total_cost:0.00003,model:'canonical/model'}})});
    const resolve=d.resolve;d.resolve=async a=>{const r=await resolve(a);r.metadata.canonical_slug='canonical/model';return r;};
    assert.equal((await executeJob(f.plan,f.out,d)).report.agents[0].status,'completed');
    fs.rmSync(f.out,{recursive:true});d=dependencies(f.plan,async a=>{await a.request();await a.finish({responseModel:'unexpected/model'});await assert.rejects(a.submit());});
    const {report}=await executeJob(f.plan,f.out,d);assert.equal(report.agents[0].status,'model_mismatch');assert.equal(report.agents[0].submission,null);
  }finally{f.cleanup();}
});
test('concurrent workers cannot each reserve the same remaining soft budget',async()=>{
  const f=fixture();try {
    f.plan.agents.push({...f.plan.agents[0],id:'second'});f.plan.policy={session_budget_usd:0.003,per_agent_budget_usd:0.003};let calls=0;
    const d=dependencies(f.plan,async a=>{await a.request();await new Promise(r=>setTimeout(r,15));await a.finish();await a.submit();},{adapter:()=>({streamSimple:()=>{calls++;}})});
    const {report}=await executeJob(f.plan,f.out,d);assert.equal(calls,1);assert.ok(report.agents.some(a=>a.status==='budget_reservation_limit'));
    assert.equal(report.costs.request_count,1);
  }finally{f.cleanup();}
});
test('progress and persisted reports do not include credentials or full transcripts',async()=>{
  const f=fixture();try {
    const events=[];const d=dependencies(f.plan,async a=>{await a.request();await a.finish();await a.submit();},{onProgress:e=>events.push(e)});
    await executeJob(f.plan,f.out,d);assert.ok(events.some(x=>x.type==='request_started'));assert.ok(events.some(x=>x.type==='worker_finished'));
    const persisted=fs.readFileSync(path.join(f.out,'report.json'),'utf8')+fs.readFileSync(path.join(f.out,'report.md'),'utf8')+JSON.stringify(events);
    assert.equal(persisted.includes('OFFLINE_KEY'),false);assert.match(persisted,/Not assessed by Codex/);
  }finally{f.cleanup();}
});

test('startup failure preserves unstarted authorized workers in the report', async () => {
  const f=fixture(); try {
    f.plan.policy={max_parallel:1};
    f.plan.agents.push({...f.plan.agents[0],id:'second'});
    const d=dependencies(f.plan,async()=>{}, {Agent:class {constructor(){throw new Error('Synthetic constructor failure');}}});
    const {report}=await executeJob(f.plan,f.out,d);
    assert.equal(report.agents.length,2);
    assert.equal(report.agents.find(a=>a.id==='review').status,'orchestration_error');
    assert.equal(report.agents.find(a=>a.id==='second').status,'not_started');
    assert.equal(report.costs.request_count,0);
    assert.equal(report.agents.find(a=>a.id==='second').costs.request_count,0);
  } finally {f.cleanup();}
});

test('instruction and learning paths are never delegable, even for candidate writes',()=>{
  const f=fixture();try{
    for(const file of ['AGENTS.md','src/AGENTS.override.md','CLAUDE.md','CLAUDE.local.md','.pi/learning/history.json','.claude/skills/pi/SKILL.md']){
      const input=structuredClone(f.plan);input.read_files=[file];assert.throws(()=>validatePlan(input,defaults));input.read_files=['a.js'];input.agents[0].mode='write';input.agents[0].write_files=[file];assert.throws(()=>validatePlan(input,defaults));
    }
  }finally{f.cleanup();}
});
test('Claude Code is propagated through worker prompt, results, and host-only authority',async()=>{
  const f=fixture();try{
    f.plan.orchestrator='claude-code';f.plan.orchestrator_model='fixture-claude';
    const d=dependencies(f.plan,async a=>{
      assert.match(a.o.initialState.systemPrompt,/reporting to Claude Code/);assert.doesNotMatch(a.o.initialState.systemPrompt,/reporting to Codex/);
      await a.request();await a.finish();const tool=a.o.initialState.tools.find(t=>t.name==='submit_result');assert.match(tool.description,/Claude Code/);const result=await tool.execute('s',submission());assert.match(result.content[0].text,/Claude Code only/);
    });
    const {report}=await executeJob(f.plan,f.out,d);assert.equal(report.orchestrator,'claude-code');assert.equal(report.orchestrator_model,'fixture-claude');assert.match(report.integration_authority,/Claude Code only/);assert.match(fs.readFileSync(path.join(f.out,'report.md'),'utf8'),/excludes Claude Code/);
  }finally{f.cleanup();}
});
test('plans validate explicit host identity and reject unknown host metadata',()=>{
  const f=fixture();try{assert.equal(validatePlan(f.plan,defaults).orchestrator,'codex');assert.throws(()=>validatePlan({...f.plan,orchestrator:'worker'},defaults));assert.throws(()=>validatePlan({...f.plan,orchestrator_model:[]},defaults));assert.equal(validatePlan({...f.plan,orchestrator:'claude-code'},defaults).orchestrator,'claude-code');}finally{f.cleanup();}
});
