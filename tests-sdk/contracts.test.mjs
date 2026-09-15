/** Installed SDK, synthetic SSE transport. No account, network, or paid inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import { getSupportedThinkingLevels, validateToolCall } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { createTwoFilesPatch } from 'diff';
import { openRouterModel, validatePlan, captureSnapshot, createCapabilities } from '../scripts/lib.mjs';
import { executeJob } from '../scripts/pi.mjs';
import { installedPackage, nodeSupported } from '../scripts/environment.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaults=JSON.parse(fs.readFileSync(path.join(root,'defaults.json')));
const model=openRouterModel({id:defaults.preferred_models[1],reasoning:{supported_efforts:['high','max']},pricing:{prompt:'0.000001',completion:'0.000002'},context_length:128000,top_provider:{max_completion_tokens:32768}},defaults.openrouter_routing);
// A dropped per-request fetch override must fail, not fall through to a live endpoint.
globalThis.fetch=async()=>{throw new Error('Unexpected external fetch in installed-SDK tests');};
function sse(id,delta,finish='stop') {
  const base={id,model:model.id,object:'chat.completion.chunk',created:1};
  const chunks=[{...base,choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,completion_tokens_details:{reasoning_tokens:2}}}];
  return new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join('')+'data: [DONE]\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}});
}
function toolDelta(name,args,id='call-1'){return {tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]};}
test('installed SDK version and exact reasoning-map contract',()=>{
  assert.ok(nodeSupported(),'Node >=22.19.0 required');
  for(const name of ['@earendil-works/pi-agent-core','@earendil-works/pi-ai'])assert.equal(installedPackage(name).version,'0.85.1');
  assert.ok(getSupportedThinkingLevels(model).includes('max'));assert.ok(!getSupportedThinkingLevels(model).includes('xhigh'));
});
test('real OpenRouter adapter serializes max effort and maps reasoning usage once', {timeout:10000}, async()=>{
  let captured;
  const stream=openrouterProvider().streamSimple(model,{systemPrompt:'Test only',messages:[{role:'user',content:'Say OK',timestamp:1}]},{apiKey:'fixture-key-not-real',reasoning:'max',maxTokens:1000,maxRetries:0,fetch:async(input,init)=>{captured=JSON.parse(await new Request(input,init).text());return sse('gen-serialization',{content:'OK'});}});
  const message=await stream.result();assert.equal(message.stopReason,'stop',message.errorMessage);assert.equal(captured.reasoning.effort,'max');assert.equal(captured.model,model.id);assert.equal(captured.models,undefined);assert.equal(captured.max_tokens,1000);assert.equal(message.responseId,'gen-serialization');assert.equal(message.usage.output,5);assert.equal(message.usage.reasoning,2);assert.equal(message.usage.totalTokens,15);
});
test('real Agent validates tools, exports a candidate, and stops after submission', {timeout:20000}, async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pi-sdk-')),repo=path.join(base,'repo');fs.mkdirSync(repo);fs.writeFileSync(path.join(repo,'a.js'),'export const n = 1;\n');
  try {
    const input={repo_root:repo,objective:'Synthetic tool contract test',read_files:['a.js'],agents:[{id:'worker',role:'candidate implementer',task:'Stage n=2',model:model.id,mode:'write',write_files:['a.js'],selection_reason:'SDK transport fixture'}]};
    const p=validatePlan(input,defaults),caps=createCapabilities(p.agents[0],captureSnapshot(p),p.policy);
    assert.doesNotThrow(()=>validateToolCall(caps.tools,{type:'toolCall',id:'r',name:'read_file',arguments:{path:'a.js'}}));
    assert.throws(()=>validateToolCall(caps.tools,{type:'toolCall',id:'bad',name:'read_file',arguments:{path:'a.js',unexpected:true}}));
    const calls=[['read_file',{path:'a.js'}],['write_file',{path:'a.js',content:'export const n = 2;\n'}],['submit_result',{summary:'Candidate staged; tests not run',findings:[],proposed_tests:['Codex should validate n'],open_questions:[]}]];
    let count=0;const provider=openrouterProvider();
    const {out,report}=await executeJob(input,path.join(base,'run'),{Agent,runtimeLabel:'installed_sdk_mock_transport',keyFor:()=> 'fixture-key-not-real',createPatch:createTwoFilesPatch,
      resolve:async()=>({model,metadata:{provider:'openrouter',requested_model:model.id,resolved_model:model.id,requested_effort:'xhigh',effective_pi_effort:'max',configured_provider_effort:'max',max_output_tokens:1000}}),
      adapter:()=>({streamSimple:(selected,context,options)=>provider.streamSimple(selected,context,{...options,fetch:async(input,init)=>{
        const payload=JSON.parse(await new Request(input,init).text());assert.equal(payload.reasoning.effort,'max');assert.equal(payload.provider.require_parameters,true);
        assert.ok(count<calls.length,'No inference should follow submit_result');const [name,args]=calls[count++];return sse(`gen-${count}`,toolDelta(name,args,`call-${count}`),'tool_calls');
      }})}),fetchGeneration:async()=>({data:{total_cost:0.00003,model:model.id,provider_name:'synthetic'}})});
    assert.equal(count,3);assert.equal(report.agents[0].status,'completed');assert.equal(report.costs.request_count,3);assert.equal(report.agents[0].coverage.reads.length,1);
    assert.equal(fs.readFileSync(path.join(repo,'a.js'),'utf8'),'export const n = 1;\n');assert.equal(fs.readFileSync(path.join(out,'worker/candidate/a.js'),'utf8'),'export const n = 2;\n');
    assert.match(fs.readFileSync(path.join(out,'worker/candidate.patch'),'utf8'),/\+export const n = 2;/);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});
