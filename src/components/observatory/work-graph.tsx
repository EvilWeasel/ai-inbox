'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowRight,CheckCircle2,Circle,LoaderCircle,PauseCircle,TriangleAlert,ExternalLink} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import type {WorkGraph} from '@/lib/observatory/contracts';
import {dependencyRoute,routePath} from './work-graph-routing';

const icons={planned:Circle,active:LoaderCircle,completed:CheckCircle2,waiting:PauseCircle,blocked:TriangleAlert,unknown:Circle};
export function WorkGraphView({graph,revision,onEvidence,previous=false,title}:{graph:WorkGraph;revision:number;title?:string;previous?:boolean;onEvidence:(id:string)=>React.ReactNode}){
 const [selected,setSelected]=useState(()=>graph.nodes.find(n=>n.state==='active'&&n.kind!=='goal')?.id??graph.nodes.find(n=>n.state==='active')?.id??graph.nodes[0].id);
 const root=useRef<HTMLDivElement>(null),[paths,setPaths]=useState<{key:string;from:string;to:string;d:string;label?:string}[]>([]);
 useEffect(()=>{if(!graph.nodes.some(n=>n.id===selected))setSelected(graph.nodes.find(n=>n.state==='active'&&n.kind!=='goal')?.id??graph.nodes.find(n=>n.state==='active')?.id??graph.nodes[0].id);},[graph,selected]);
 const depth=new Map(graph.nodes.map(n=>[n.id,0]));
 for(let pass=0;pass<graph.nodes.length;pass++)for(const edge of graph.edges)depth.set(edge.to,Math.max(depth.get(edge.to)!,depth.get(edge.from)!+1));
 const levels=Array.from({length:Math.max(...depth.values())+1},(_,index)=>graph.nodes.filter(n=>depth.get(n.id)===index));
 useLayoutEffect(()=>{
  const element=root.current;if(!element)return;
  const measure=()=>{
   const origin=element.getBoundingClientRect(),rects=new Map([...element.querySelectorAll<HTMLElement>('[data-work-node]')].map(e=>[e.dataset.workNode!,e.getBoundingClientRect()]));
   const vertical=getComputedStyle(element).flexDirection==='column';
   const relative=(r:DOMRect)=>({left:r.left-origin.left,right:r.right-origin.left,top:r.top-origin.top,bottom:r.bottom-origin.top});
   const boxes=[...rects.values()].map(relative);
   setPaths(graph.edges.flatMap((edge,index)=>{const a=rects.get(edge.from),b=rects.get(edge.to);if(!a||!b)return[];
    return[{key:JSON.stringify([edge.from,edge.to]),from:edge.from,to:edge.to,d:routePath(dependencyRoute(relative(a),relative(b),boxes,vertical,index)),label:edge.label}];}));
  };
  const observer=new ResizeObserver(measure);observer.observe(element);element.querySelectorAll('[data-work-node]').forEach(node=>observer.observe(node));measure();return()=>observer.disconnect();
 },[graph]);
 useEffect(()=>{const timer=setTimeout(()=>{const element=root.current,scroll=element?.parentElement,target=element&&[...element.querySelectorAll<HTMLElement>('[data-work-node]')].find(e=>e.dataset.workNode===selected);if(scroll&&target){scroll.scrollTop=Math.max(0,target.offsetTop-(scroll.clientHeight-target.offsetHeight)/2);scroll.scrollLeft=Math.max(0,target.offsetLeft-(scroll.clientWidth-target.offsetWidth)/2);}},0);return()=>clearTimeout(timer);},[selected,graph.orientation]);
 const node=graph.nodes.find(n=>n.id===selected)??graph.nodes[0];
 return <section className="work-space" aria-label="Agent work graph">
  <header className="work-goal"><div><span className="work-kicker">Workflow</span><h2>{title??graph.goal}</h2>{title&&<details><summary>Outcome details</summary><p>{graph.goal}</p></details>}</div><Badge variant="outline">{previous?'Previous run · ':''}Agent revision {revision}</Badge></header>
  <div className="work-graph-scroll" role="region" aria-label="Work dependencies" tabIndex={0}>
   <div className={`work-flow work-flow-${graph.orientation}`} ref={root}>
    <svg className="work-edges" aria-hidden="true"><defs><marker id="work-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z"/></marker></defs>{paths.map(path=><g key={path.key} data-edge-from={path.from} data-edge-to={path.to} className={path.from===selected||path.to===selected?'work-edge-selected':'work-edge-muted'}><path d={path.d} markerEnd="url(#work-arrow)"/>{path.label&&<title>{path.label}</title>}</g>)}</svg>
    {levels.map((level,index)=><div className="work-level" key={index}>{level.map(n=>{const Icon=icons[n.state];return <Button variant="outline" key={n.id} data-work-node={n.id} aria-label={`${n.title} · ${n.state}`} aria-pressed={selected===n.id} className={`work-node work-node-${n.state}`} onClick={()=>setSelected(n.id)}><span className="work-node-state"><Icon size={18} aria-hidden="true"/>{n.state}</span><strong>{n.title}</strong><span className="work-node-kind">{n.kind}{n.evidence.length>0&&` · ${n.evidence.length} linked evidence`}</span></Button>;})}</div>)}
   </div>
  </div>
  <article className="work-node-detail" aria-label="Selected work step"><header><h3>{node.title}</h3><Badge variant="outline">{node.state}</Badge></header>{node.summary&&<p>{node.summary}</p>}
   <div className="work-dependency-labels">{graph.edges.filter(e=>e.to===node.id).map(e=><span key={`from:${e.from}`}>After {graph.nodes.find(n=>n.id===e.from)?.title}<ArrowRight size={13} aria-hidden="true"/></span>)}{graph.edges.filter(e=>e.from===node.id).map(e=><span key={`to:${e.to}`}>Next {graph.nodes.find(n=>n.id===e.to)?.title}<ArrowRight size={13} aria-hidden="true"/></span>)}</div>
   {node.agentThreadId&&<a href={`t3-thread://v1/${node.agentThreadId}`}>Open responsible agent <ExternalLink size={14}/></a>}
   {node.evidence.map((e,index)=><div className="work-evidence" key={index}>{e.href?<a href={e.href} target="_blank" rel="noopener noreferrer">{e.label} <ExternalLink size={14}/></a>:<strong>{e.label}</strong>}{e.itemId&&<details><summary>Recorded evidence</summary>{onEvidence(e.itemId)}</details>}{e.messageId&&<span className="work-source-ref">Message {e.messageId}</span>}</div>)}
  </article>
 </section>;
}
