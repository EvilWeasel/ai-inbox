import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('retention keeps code for every retained snapshot and prunes expired pairs',()=>{
  const root=mkdtempSync(join(tmpdir(),'inbox-retention-'));
  try {
    mkdirSync(join(root,'releases'));mkdirSync(join(root,'backups'));
    const names=Array.from({length:10},(_,i)=>(i+1).toString(16).padStart(40,'0'));
    names.forEach((name,i)=>{const release=join(root,'releases',name);mkdirSync(release);utimesSync(release,i+1,i+1);
      const backup=join(root,'backups',name);mkdirSync(backup);writeFileSync(join(backup,'previous-release'),i?join(root,'releases',names[i-1]):'');utimesSync(backup,i+1,i+1);});
    symlinkSync(join(root,'releases',names.at(-1)!),join(root,'current'));
    execFileSync('python3',['scripts/retention.py',root,'5','7',join(root,'releases',names.at(-2)!)]);
    assert.equal(readdirSync(join(root,'backups')).length,7);
    for(const name of readdirSync(join(root,'backups'))) {const previous=readFileSync(join(root,'backups',name,'previous-release'),'utf8');if(previous)assert.ok(existsSync(previous));}
    assert.ok(existsSync(join(root,'releases',names.at(-1)!)));
    assert.ok(!existsSync(join(root,'releases',names[0])));
  } finally {rmSync(root,{recursive:true,force:true});}
});
