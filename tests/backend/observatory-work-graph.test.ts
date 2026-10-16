import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workGraphSchema} from '../../src/lib/observatory/contracts';
import {openObservatory,publish,history} from '../../src/server/observatory/store';
const graph={goal:'Actual fixture goal',orientation:'horizontal',nodes:[{id:'fixture',title:'Negative admission fixture',kind:'step',state:'active',evidence:[]},{id:'compose',title:'Trusted resolver composition',kind:'step',state:'planned',evidence:[]}],edges:[{from:'fixture',to:'compose'}]};
test('work dependency contract rejects cycles, dangling edges, unsafe links and unsupported completed claims',()=>{
 assert.equal(workGraphSchema.safeParse(graph).success,true);
 for(const invalid of [
  {...graph,edges:[...graph.edges,{from:'compose',to:'fixture'}]},
  {...graph,edges:[{from:'missing',to:'compose'}]},
  {...graph,nodes:[graph.nodes[0],graph.nodes[0]]},
  {...graph,nodes:[{...graph.nodes[0],state:'completed'}]},
  {...graph,nodes:[{...graph.nodes[0],evidence:[{label:'bad',href:'javascript:alert(1)'}]}]},
  {...graph,nodes:[{...graph.nodes[0],evidence:[{label:'bad',href:'https://user:secret@example.test/'}]}]},
 ])assert.equal(workGraphSchema.safeParse(invalid).success,false);
});
test('same durable canvas CAS preserves actual graph structure revisions and explicit unknown states',()=>{
 const directory=mkdtempSync(join(tmpdir(),'obs-work-'));const db=openObservatory(directory);
 const canvas={title:'Work',summary:'Fixture only',status:'working',currentStep:'Verify',plan:[],layout:{columns:2,panels:['summary'],accent:'blue'},workGraph:graph};
 const identity={hostId:'host',threadId:'thread',runId:'run',attemptId:'attempt'};
 try{
  publish(db,{...identity,expectedRevision:0,canvas},'producer');
  const changed={...graph,orientation:'vertical',nodes:[...graph.nodes,{id:'effect',title:'Installed effect acceptance',kind:'result',state:'unknown',evidence:[]}],edges:[...graph.edges,{from:'compose',to:'effect'}]};
  publish(db,{...identity,expectedRevision:1,canvas:{...canvas,workGraph:changed}},'producer');
  assert.throws(()=>publish(db,{...identity,expectedRevision:1,canvas},'producer'),/Stale revision/);
  const revisions=history(db,identity);assert.equal(revisions[0].canvas.workGraph?.nodes.length,3);assert.equal(revisions[1].canvas.workGraph?.nodes.length,2);assert.equal(revisions[0].canvas.workGraph?.nodes[2].state,'unknown');
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
