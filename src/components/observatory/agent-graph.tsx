import { useRef } from 'react';
import type { NativeThread } from '@/lib/observatory/contracts';
import { agentGraph,agentKey } from '@/lib/observatory/graph';
export function AgentGraph({threads,selected,onSelect}:{threads:NativeThread[];selected:{hostId:string;threadId:string}|null;onSelect:(thread:NativeThread)=>void}) {
  const graph=agentGraph(threads),buttons=useRef(new Map<string,HTMLButtonElement>());
  const positions=new Map(graph.nodes.map((node,index)=>[node.key,{x:node.depth*320,y:index*146}]));
  const width=Math.max(300,...graph.nodes.map(node=>node.depth*320+300)),height=graph.nodes.length*146;
  return <><p className="obs-muted" id="obs-graph-help">Parent → child connections from native lineage within each host. Tab to a node; arrow right focuses its first child, left its parent, up/down adjacent nodes. Enter selects. Scroll to explore.</p><div className="obs-graph-scroll" role="region" aria-label="Agent parent and child graph" aria-describedby="obs-graph-help" tabIndex={0}><div className="obs-graph" style={{width,height}}>
    <svg width={width} height={height} aria-hidden="true">{graph.edges.map(edge=>{const from=positions.get(edge.parent)!,to=positions.get(edge.child)!;return <path key={edge.child} data-parent={edge.parent} data-child={edge.child} d={`M ${from.x+285} ${from.y+60} H ${from.x+305} V ${to.y+60} H ${to.x+5}`} markerEnd="url(#obs-arrow)"/>;})}<defs><marker id="obs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs></svg>
    {graph.nodes.map((node,index)=>{const {thread,key}=node,point=positions.get(key)!,parent=graph.parentByChild.get(key),parentThread=parent&&graph.nodes.find(n=>n.key===parent)?.thread;return <button key={key} ref={element=>{if(element)buttons.current.set(key,element);else buttons.current.delete(key);}} className="obs-graph-node" style={{left:point.x,top:point.y}} aria-pressed={selected!==null&&agentKey(selected.hostId,selected.threadId)===key} onClick={()=>onSelect(thread)} onKeyDown={event=>{
      const target=event.key==='ArrowLeft'?parent:event.key==='ArrowRight'?graph.children.get(key)?.[0]:event.key==='ArrowUp'?graph.nodes[index-1]?.key:event.key==='ArrowDown'?graph.nodes[index+1]?.key:event.key==='Home'?graph.nodes[0]?.key:event.key==='End'?graph.nodes.at(-1)?.key:undefined;
      if(target){event.preventDefault();buttons.current.get(target)?.focus();}
    }}><strong>{thread.title}</strong><span>{thread.hostId} · {thread.status}</span><small>{parentThread?`Child of ${parentThread.title}`:thread.parentThreadId?`Parent outside view: ${thread.parentThreadId}`:'Root · no parent recorded'}{node.cycle?' · source lineage cycle':''}</small><small>{thread.id} · {graph.children.get(key)?.length??0} visible children</small></button>;})}
  </div></div></>;
}
