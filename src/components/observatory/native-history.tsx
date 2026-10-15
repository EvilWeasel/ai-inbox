import { useEffect,useRef,useState } from 'react';
import type { HistoryCoverage,HistoryPage,HistoryRow } from '@/lib/observatory/contracts';
export function NativeHistory({hostId,threadId,coverage,snapshotSequence}:{hostId:string;threadId:string;coverage?:HistoryCoverage;snapshotSequence:number}) {
 const [pages,setPages]=useState<HistoryPage[]>([]),[cursor,setCursor]=useState(coverage?.historyCursor??null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const busy=useRef(false),controller=useRef<AbortController|null>(null),seen=useRef(new Set<string>());
 useEffect(()=>()=>{controller.current?.abort();},[]);
 // Live snapshot cursors contain a changing sequence even when the timeline
 // anchor is unchanged. Once reading starts, preserve that historical chain.
 useEffect(()=>{if(pages.length===0&&!busy.current)setCursor(coverage?.historyCursor??null);},[coverage?.historyCursor,pages.length]);
 function restart(){controller.current?.abort();controller.current=null;busy.current=false;seen.current.clear();setPages([]);setCursor(coverage?.historyCursor??null);setError('');setLoading(false);}
 async function older(){
  if(!cursor||busy.current||pages.length>=10)return;
  busy.current=true;const abort=new AbortController();controller.current=abort;setLoading(true);setError('');
  try {
   const response=await fetch(`/api/observatory/actions/read?${new URLSearchParams({hostId,threadId,cursor})}`,{cache:'no-store',signal:abort.signal});
   if(!response.ok)throw new Error('Older history unavailable. Loaded evidence and cursor are retained; retry is explicit.');
   const page:HistoryPage=await response.json();if(abort.signal.aborted)return;
   if(page.hostId!==hostId||page.threadId!==threadId||!Array.isArray(page.items)||typeof page.hasMoreHistory!=='boolean'||page.hasMoreHistory!==(page.nextCursor!==null)||page.nextCursor===cursor||page.nextCursor!==null&&seen.current.has(page.nextCursor))throw new Error('Invalid history page. Coverage remains partial.');
   seen.current.add(cursor);setPages(previous=>[page,...previous]);setCursor(page.nextCursor);
  }catch(e){if(!abort.signal.aborted)setError((e as Error).message);}finally{if(controller.current===abort){busy.current=false;if(!abort.signal.aborted)setLoading(false);}}
 }
 const unique=new Map<string,HistoryRow>();for(const page of pages)for(const row of page.items)unique.set(JSON.stringify([row.visibility,row.sourceThreadId,row.sourceItemId]),row);
 return <article className="obs-panel"><h3>Native history coverage</h3><p>{!coverage?'Coverage metadata unavailable; completeness is unknown.':cursor?'Partial timeline: older native history remains.':pages.length?'End of source history reached for this cursor chain; live evidence remains separate above.':'Native source reports no older timeline rows for this bounded snapshot.'}</p><p className="obs-muted">Live snapshot {snapshotSequence} · latest local turn {coverage?.latestLocalTurnOrdinal??'unknown'} · {unique.size} older rows loaded across {pages.length} pages. Older pages never replace current run or attempt.</p>{coverage?.payloadBudgetExceeded&&<p>Native payload exceeds its usual budget. This is not a guarantee of complete history or full tool output.</p>}
 {coverage&&<details><summary>Coverage cursor & page snapshots</summary><pre className="obs-evidence">{JSON.stringify({historyCursor:coverage.historyCursor,nextCursor:cursor,hasMoreHistory:cursor!==null,pageSnapshots:pages.map(page=>page.snapshotSequence)},null,2)}</pre></details>}
 {cursor&&pages.length<10&&<button disabled={loading} onClick={()=>void older()}>{loading?'Loading older history…':error?'Retry older history':'Load older history'}</button>}{(pages.length>0||error)&&<button onClick={restart}>Restart history from current window</button>}{pages.length>=10&&cursor&&<p>Browser retention limit reached (10 pages). Older history remains unloaded; restart history to use the current bounded window.</p>}{error&&<p role="alert">{error}</p>}
 {[...unique.values()].map(row=><details key={JSON.stringify([row.visibility,row.sourceThreadId,row.sourceItemId])}><summary>{typeof row.item.title==='string'?row.item.title:String(row.item.type)} · {row.visibility} · source {row.sourceThreadId}</summary><p className="obs-muted">Source item {row.sourceItemId} · position {row.position}. Historical evidence; full outputs may be omitted by the native source.</p><pre className="obs-evidence">{JSON.stringify(row.item,null,2)}</pre></details>)}
 </article>;
}
