import { afterEach,describe,it,expect,vi } from 'vitest';
import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/react';
import { Observatory } from './observatory';
const inventory={hosts:[{id:'host',label:'Connected host',environmentId:'env',status:'online',threadCount:2,message:'Actual inventory'}],threads:[{id:'one',hostId:'host',title:'First agent',status:'running'},{id:'two',hostId:'host',title:'Second agent',status:'running'}],canvases:[],observedAt:'2026-10-15T20:00:00Z'};
const focus=(title:string)=>({hostId:'host',projection:{thread:{title,runtimeMode:'approval-required'},runs:[{id:'run',ordinal:1,activeAttemptId:'attempt',status:'running'}],turnItems:[{id:'todo',runId:'run',type:'todo_list',steps:[{step:'Completed bounded work',status:'completed'},{step:'Verify active behavior',status:'inProgress'}]},{id:'reason',type:'reasoning',text:'Should never appear as a tool'},{id:'command',type:'command_execution',title:'Actual command',input:'read-only command',status:'completed',outputOmitted:true}],runtimeRequests:[{id:'expired',kind:'approval',status:'expired'},{id:'pending',kind:'tool-approval',status:'pending'}],messages:[],plans:[],subagents:[],attempts:[]},canvases:[],history:[],observedAt:'2026-10-15T20:00:00Z',snapshotSequence:1});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('Observatory evidence boundary',()=>{
 it('shows actual native tasks, only pending approvals and explicit missing canvas; loads real omitted result',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>({ok:true,json:async()=>input.includes('itemId=')?{item:{output:'Persisted actual result'}}:input.includes('threadId=')?focus('First agent'):inventory})));
  render(<Observatory/>);fireEvent.click(await screen.findByRole('button',{name:/First agent/}));
  expect((await screen.findAllByText('Verify active behavior')).length).toBe(2);expect(screen.getByText(/No agent-authored canvas/)).toBeTruthy();
  expect(screen.queryByText('Should never appear as a tool')).toBeNull();expect(screen.getByText('tool-approval · pending')).toBeTruthy();expect(screen.queryByText('approval · expired')).toBeNull();
  fireEvent.click(screen.getByText('Actual command'));fireEvent.click(screen.getByRole('button',{name:'Load actual result'}));expect(await screen.findByText(/Persisted actual result/)).toBeTruthy();expect(screen.queryByRole('heading',{name:/Raw chat/})).toBeNull();
 });
 it('does not allow a late response from a previously selected agent to replace current evidence',async()=>{
  let resolveFirst!:(value:unknown)=>void;
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>input.includes('threadId=one')?new Promise(resolve=>{resolveFirst=resolve;}):{ok:true,json:async()=>input.includes('threadId=two')?focus('Second evidence'):inventory}));
  render(<Observatory/>);fireEvent.click(await screen.findByRole('button',{name:/First agent/}));await waitFor(()=>expect(resolveFirst).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button',{name:'Select agent'}));fireEvent.click(screen.getByRole('button',{name:/Second agent/}));expect(await screen.findByRole('heading',{name:'Second evidence'})).toBeTruthy();
  resolveFirst({ok:true,json:async()=>focus('Stale first evidence')});await Promise.resolve();await Promise.resolve();expect(screen.queryByRole('heading',{name:'Stale first evidence'})).toBeNull();expect(screen.getByRole('heading',{name:'Second evidence'})).toBeTruthy();
 });
});
