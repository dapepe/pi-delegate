import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeSupported, installedPackage, credentialStatus, readCredentialFile, keyFor, scrub } from '../scripts/environment.mjs';
import { releaseFiles } from '../scripts/release-files.mjs';
import { install } from '../scripts/install.mjs';
function temp(){const base=fs.mkdtempSync(path.join(os.tmpdir(),'pi-setup-'));return {base,cleanup:()=>fs.rmSync(base,{recursive:true,force:true})};}
test('runtime check rejects Node versions below the pinned SDK minimum',()=>{
  for(const v of ['20.19.0','22.16.0','22.18.9'])assert.equal(nodeSupported(v),false);
  for(const v of ['22.19.0','22.20.0','24.0.0'])assert.equal(nodeSupported(v),true);
});
test('installed metadata resolves from exported entry, not an unexported package.json',()=>{
  const t=temp();try{fs.mkdirSync(path.join(t.base,'dist'));fs.writeFileSync(path.join(t.base,'package.json'),JSON.stringify({name:'example-package',version:'1.2.3',exports:{'.':'./dist/index.js'}}));fs.writeFileSync(path.join(t.base,'dist/index.js'),'');
    assert.equal(installedPackage('example-package',()=>pathToFileURL(path.join(t.base,'dist/index.js')).href).version,'1.2.3');
  }finally{t.cleanup();}
});
test('credential resolution prefers environment and status never exposes values',()=>{
  const t=temp();try{const file=path.join(t.base,'credentials.json');fs.writeFileSync(file,JSON.stringify({openrouter:'private-key-fixture'}),{mode:0o600});
    assert.equal(keyFor('openrouter',{OPENROUTER_API_KEY:' environment-fixture '},file),'environment-fixture');
    assert.equal(keyFor('openrouter',{},file),'private-key-fixture');
    assert.equal(credentialStatus('openrouter',{},file).source,'private_file');
    assert.equal(JSON.stringify(credentialStatus('openrouter',{},file)).includes('private-key-fixture'),false);
    assert.equal(scrub(new Error('environment-fixture private-key-fixture')),'[REDACTED] [REDACTED]');
  }finally{t.cleanup();}
});
test('private credential files reject broad POSIX access and invalid entries',{skip:process.platform==='win32'},()=>{
  const t=temp();try{const file=path.join(t.base,'credentials.json');fs.writeFileSync(file,'{"openrouter":"fixture"}',{mode:0o600});fs.chmodSync(file,0o644);assert.throws(()=>readCredentialFile(file));fs.chmodSync(file,0o600);fs.writeFileSync(file,'{"unknown":"fixture"}');assert.throws(()=>readCredentialFile(file));
  }finally{t.cleanup();}
});
test('missing credentials fail without falling back to repository files',()=>{
  const t=temp();try{assert.throws(()=>keyFor('openrouter',{},path.join(t.base,'missing')));assert.equal(credentialStatus('openrouter',{},path.join(t.base,'missing')).present,false);}finally{t.cleanup();}
});
test('release allowlist excludes root secrets, runtime artifacts, dependencies, and VCS',()=>{
  const t=temp();try{for(const dir of ['scripts','node_modules','.git','dist'])fs.mkdirSync(path.join(t.base,dir));
    for(const f of ['SKILL.md','README.md','.env','credentials.json','private.txt','scripts/x.mjs','dist/pi.zip','node_modules/key','package-lock.json'])fs.writeFileSync(path.join(t.base,f),'fixture');
    assert.deepEqual(releaseFiles(t.base),['README.md','SKILL.md','package-lock.json','scripts/x.mjs']);
  }finally{t.cleanup();}
});
test('release packaging refuses secrets accidentally placed inside distributable folders',()=>{
  const t=temp();try{fs.mkdirSync(path.join(t.base,'docs'));fs.writeFileSync(path.join(t.base,'docs/credentials.json'),'secret');assert.throws(()=>releaseFiles(t.base));}finally{t.cleanup();}
});
test('installer copies source, never dependencies, and refuses to overwrite',()=>{
  const t=temp();try{const src=path.join(t.base,'source'),dest=path.join(t.base,'installed');fs.mkdirSync(src);fs.writeFileSync(path.join(src,'SKILL.md'),'name: pi');fs.mkdirSync(path.join(src,'node_modules'));
    assert.equal(install(src,dest).copied_files,1);assert.equal(fs.existsSync(path.join(dest,'node_modules')),false);
    fs.writeFileSync(path.join(dest,'user-customization'),'preserve');assert.throws(()=>install(src,dest));assert.equal(fs.readFileSync(path.join(dest,'user-customization'),'utf8'),'preserve');
    assert.equal(install(src,src).already_in_place,true);
  }finally{t.cleanup();}
});

test('installer parses explicit hosts and preserves Codex as the legacy default',async()=>{
  const {parseInstallArgs}=await import('../scripts/install.mjs');
  assert.equal(parseInstallArgs([]).host,'codex');assert.equal(parseInstallArgs(['--host','claude']).host,'claude-code');assert.equal(parseInstallArgs(['--host','both']).host,'both');
  for(const args of [['--host','other'],['--host'],['--force'],['--host','codex','--host','both'],['--repo']])assert.throws(()=>parseInstallArgs(args));
});
test('personal destinations support both documented layouts and custom Claude config roots',async()=>{
  const {destinations}=await import('../scripts/install.mjs'),t=temp();try{
    const real=fs.realpathSync(t.base);const d=destinations({host:'both'},t.base,{});assert.equal(d[0].destination,path.join(real,'.agents/skills/pi'));assert.equal(d[1].destination,path.join(real,'.claude/skills/pi'));
    const custom=path.join(t.base,'custom-claude');assert.equal(destinations({host:'claude-code'},t.base,{CLAUDE_CONFIG_DIR:custom})[0].destination,path.join(custom,'skills/pi'));
  }finally{t.cleanup();}
});
test('repository installations use repository layouts rather than a personal Claude override',async()=>{
  const {destinations}=await import('../scripts/install.mjs'),t=temp();try{
    const real=fs.realpathSync(t.base);assert.deepEqual(destinations({host:'both',repo:t.base},os.homedir(),{CLAUDE_CONFIG_DIR:'/unused'}).map(x=>x.destination),[path.join(real,'.agents/skills/pi'),path.join(real,'.claude/skills/pi')]);
  }finally{t.cleanup();}
});
test('both-host installer preflights conflicts before creating either destination',async()=>{
  const {installMany}=await import('../scripts/install.mjs'),t=temp();try{
    const src=path.join(t.base,'source'),first=path.join(t.base,'codex'),second=path.join(t.base,'claude');fs.mkdirSync(src);fs.writeFileSync(path.join(src,'SKILL.md'),'name: pi');fs.mkdirSync(second);fs.writeFileSync(path.join(second,'user'),'keep');
    assert.throws(()=>installMany(src,[{destination:first},{destination:second}]));assert.equal(fs.existsSync(first),false);assert.equal(fs.readFileSync(path.join(second,'user'),'utf8'),'keep');
  }finally{t.cleanup();}
});
test('both-host copies remain complete and never edit repository instruction files',async()=>{
  const {installMany,destinations}=await import('../scripts/install.mjs'),t=temp();try{
    const src=path.join(t.base,'source'),repo=path.join(t.base,'repo');fs.mkdirSync(src);fs.mkdirSync(repo);fs.writeFileSync(path.join(src,'SKILL.md'),'name: pi');fs.writeFileSync(path.join(src,'CLAUDE.md'),'@AGENTS.md\n');
    for(const f of ['AGENTS.md','CLAUDE.md'])fs.writeFileSync(path.join(repo,f),'existing instructions');
    const installed=installMany(src,destinations({host:'both',repo},t.base,{}));assert.equal(installed.length,2);for(const i of installed)assert.equal(fs.readFileSync(path.join(i.destination,'SKILL.md'),'utf8'),'name: pi');
    for(const f of ['AGENTS.md','CLAUDE.md'])assert.equal(fs.readFileSync(path.join(repo,f),'utf8'),'existing instructions');
  }finally{t.cleanup();}
});
test('installer rejects dangling symlink destinations without following or deleting them',{skip:process.platform==='win32'},async()=>{
  const t=temp();try{const src=path.join(t.base,'source'),dest=path.join(t.base,'dest');fs.mkdirSync(src);fs.writeFileSync(path.join(src,'SKILL.md'),'name: pi');fs.symlinkSync(path.join(t.base,'nonexistent'),dest);assert.throws(()=>install(src,dest));assert.equal(fs.lstatSync(dest).isSymbolicLink(),true);}finally{t.cleanup();}
});

test('release packaging rejects nested learning or host state and case-varied credential files',()=>{
  for(const name of ['.pi','.claude','.agents','.codex','Credentials.JSON','Auth.JSON']){const t=temp();try{fs.mkdirSync(path.join(t.base,'docs'));if(name.startsWith('.')){fs.mkdirSync(path.join(t.base,'docs',name));fs.writeFileSync(path.join(t.base,'docs',name,'private-history.json'),'private fixture');}else fs.writeFileSync(path.join(t.base,'docs',name),'private fixture');assert.throws(()=>releaseFiles(t.base),/Private\/runtime/);}finally{t.cleanup();}}
});
