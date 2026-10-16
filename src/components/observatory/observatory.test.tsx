import { afterEach,describe,it,expect,vi } from 'vitest';
import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/react';
import { Observatory,toolLabel } from './observatory';
const inventory={hosts:[{id:'host',label:'Connected host',environmentId:'env',status:'online',threadCount:2,message:'Actual inventory'}],threads:[{id:'one',hostId:'host',title:'First agent',status:'running'},{id:'two',hostId:'host',title:'Second agent',status:'running'}],canvases:[],observedAt:'2026-10-15T20:00:00Z'};
const focus=(title:string)=>({hostId:'host',projection:{thread:{title,runtimeMode:'approval-required'},runs:[{id:'run',ordinal:1,activeAttemptId:'attempt',status:'running'}],turnItems:[{id:'todo',runId:'run',type:'todo_list',steps:[{step:'Completed bounded work',status:'completed'},{step:'Verify active behavior',status:'inProgress'}]},{id:'reason',type:'reasoning',text:'Should never appear as a tool'},{id:'command',type:'command_execution',title:'Actual command',input:'read-only command',status:'completed',outputOmitted:true}],runtimeRequests:[{id:'expired',kind:'approval',status:'expired'},{id:'pending',kind:'tool-approval',status:'pending'}],messages:[],plans:[],subagents:[],attempts:[]},canvases:[],history:[],observedAt:'2026-10-15T20:00:00Z',snapshotSequence:1});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('Observatory evidence boundary',()=>{
 it('shows actual native tasks, only pending approvals and explicit missing canvas; loads real omitted result',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>({ok:true,json:async()=>input.includes('itemId=')?{item:{output:'Persisted actual result'}}:input.includes('threadId=')?focus('First agent'):inventory})));
  render(<Observatory/>);fireEvent.click(await screen.findByRole('button',{name:/First agent/}));
  expect(await screen.findByText(/Verify active behavior/)).toBeTruthy();fireEvent.click(screen.getByText('Native events, approvals & history'));
  expect(screen.queryByText('Should never appear as a tool')).toBeNull();expect(screen.getByText('tool-approval · pending')).toBeTruthy();expect(screen.queryByText('approval · expired')).toBeNull();
  fireEvent.click(screen.getByText('read-only command',{selector:'summary span'}));fireEvent.click(screen.getByRole('button',{name:'Load actual result'}));expect(await screen.findByText(/Persisted actual result/)).toBeTruthy();expect(screen.queryByRole('heading',{name:/Raw chat/})).toBeNull();
 });
 it('does not allow a late response from a previously selected agent to replace current evidence',async()=>{
  let resolveFirst!:(value:unknown)=>void;
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>input.includes('threadId=one')?new Promise(resolve=>{resolveFirst=resolve;}):{ok:true,json:async()=>input.includes('threadId=two')?focus('Second evidence'):inventory}));
  render(<Observatory/>);fireEvent.click(await screen.findByRole('button',{name:/First agent/}));await waitFor(()=>expect(resolveFirst).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button',{name:'Select agent'}));fireEvent.click(screen.getByRole('button',{name:/Second agent/}));expect(await screen.findByRole('heading',{name:'Second evidence'})).toBeTruthy();
  resolveFirst({ok:true,json:async()=>focus('Stale first evidence')});await Promise.resolve();await Promise.resolve();expect(screen.queryByRole('heading',{name:'Stale first evidence'})).toBeNull();expect(screen.getByRole('heading',{name:'Second evidence'})).toBeTruthy();
 });
});

it('makes authored work and recorded changes primary while logs stay secondary',async()=>{
 const nativeFocus=focus('Current thread');
 const evidence={...nativeFocus,canvases:[{hostId:'host',threadId:'one',runId:'run',attemptId:'attempt',revision:2,publisherId:'producer',publishedAt:'2026-10-16T00:00:00Z',canvas:{title:'Agent work',summary:'One current summary only',status:'working',currentStep:'Verify actual admission',plan:[{id:'one',text:'Negative admission fixture',status:'active'}],checkpoints:[],layout:{columns:2,panels:['summary','plan','history'],accent:'blue'}}}]};
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>({ok:true,json:async()=>input.includes('threadId=')?evidence:inventory})));
 const {container}=render(<Observatory/>);fireEvent.click(await screen.findByRole('button',{name:/First agent/}));await screen.findByRole('heading',{name:'Agent work'});
 expect(screen.getByRole('region',{name:'Recorded agent work'})).toBeTruthy();
 expect(screen.getAllByText('One current summary only')).toHaveLength(1);
 expect(container.querySelector('.obs-runtime')?.hasAttribute('open')).toBe(false);
 fireEvent.click(screen.getByText('Native events, approvals & history'));
 expect(screen.getByRole('button',{name:'Load actual result'})).toBeTruthy();
});
it('uses actual tool names and bounded command previews for scanning',()=>{
 expect(toolLabel({type:'dynamic_tool',title:'dynamic_tool',toolName:'preview_snapshot'})).toBe('preview_snapshot');
 expect(toolLabel({type:'command_execution',input:'rg exact-pattern src\nsecond command'})).toBe('rg exact-pattern src');
 expect(toolLabel({type:'command_execution',input:{command:'x'.repeat(300)}})).toHaveLength(140);
});
