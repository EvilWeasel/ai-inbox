import { afterEach,it,expect,vi } from 'vitest';
import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/react';
import { NativeHistory } from './native-history';
const coverage={historyCursor:'first opaque+/= cursor',hasMoreHistory:true,latestLocalTurnOrdinal:40,payloadBudgetExceeded:false};
const row={position:1,visibility:'inherited',sourceThreadId:'parent',sourceItemId:'marker',item:{id:'marker',type:'context_compaction',runId:'old-run',text:'Actual compaction marker'}};
const page=(nextCursor:string|null)=>({hostId:'host',threadId:'thread',snapshotSequence:8,items:[row],nextCursor,hasMoreHistory:nextCursor!==null,observedAt:'2026-10-16T00:00:00Z'});
const props={hostId:'host',threadId:'thread',coverage,snapshotSequence:9};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('keeps opaque cursors on failure, loads compaction provenance, and reaches source end only on a successful page',async()=>{
 let calls=0;const requested:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{requested.push(new URL(input,'https://inbox.example.test').searchParams.get('cursor')!);calls++;return {ok:calls!==2,json:async()=>page(calls===1?'next cursor':null)};}));
 render(<NativeHistory {...props}/>);expect(screen.getByText(/Partial timeline/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Load older history'}));expect(await screen.findByText(/context_compaction · inherited/)).toBeTruthy();
 expect(screen.getByText(/Source item marker/).textContent).toContain('Historical evidence');
 fireEvent.click(screen.getByRole('button',{name:'Load older history'}));expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText(/End of source history reached/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Retry older history'}));expect(await screen.findByText(/End of source history reached/)).toBeTruthy();
 expect(requested).toEqual([coverage.historyCursor,'next cursor','next cursor']);expect(screen.getAllByText(/context_compaction · inherited/)).toHaveLength(1);
});
it('aborts an old selection and ignores its late history response; a changed cursor starts fresh',async()=>{
 let resolve!:(value:unknown)=>void;let signal:AbortSignal|undefined;
 vi.stubGlobal('fetch',vi.fn(async(_input:string,options:{signal:AbortSignal})=>{signal=options.signal;return new Promise(value=>{resolve=value;});}));
 const {rerender}=render(<NativeHistory key="host-thread-first" {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Load older history'}));await waitFor(()=>expect(resolve).toBeTypeOf('function'));
 rerender(<NativeHistory key="host-other-second" {...props} threadId="other" coverage={{...coverage,historyCursor:'new cursor'}}/>);expect(signal?.aborted).toBe(true);
 resolve({ok:true,json:async()=>page(null)});await Promise.resolve();await Promise.resolve();expect(screen.queryByText(/Actual compaction marker/)).toBeNull();expect(screen.getByText(/Partial timeline/)).toBeTruthy();expect(screen.getByRole('button',{name:'Load older history'})).toBeTruthy();
});
it('retains partial coverage when the source returns a repeated cursor',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>page(coverage.historyCursor)})));
 render(<NativeHistory {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Load older history'}));expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText(/End of source history reached/)).toBeNull();expect(screen.getByRole('button',{name:'Retry older history'})).toBeTruthy();
});
