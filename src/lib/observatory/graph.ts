import type { NativeThread } from './contracts';
export const agentKey=(hostId:string,threadId:string)=>JSON.stringify([hostId,threadId]);
export function agentGraph(threads:NativeThread[]) {
  const byKey=new Map(threads.map(thread=>[agentKey(thread.hostId,thread.id),thread]));
  const edges=threads.flatMap(child=>{
    const parent=child.parentThreadId&&byKey.get(agentKey(child.hostId,child.parentThreadId));
    return parent&&parent.id!==child.id?[{parent:agentKey(parent.hostId,parent.id),child:agentKey(child.hostId,child.id)}]:[];
  });
  const parentByChild=new Map(edges.map(edge=>[edge.child,edge.parent]));
  const children=new Map<string,string[]>();
  for(const edge of edges)children.set(edge.parent,[...(children.get(edge.parent)??[]),edge.child]);
  const visited=new Set<string>();const nodes:{key:string;thread:NativeThread;depth:number;cycle:boolean}[]=[];
  function visit(key:string,depth:number,ancestors:Set<string>) {
    if(visited.has(key))return;visited.add(key);
    const lineage=new Set(ancestors);lineage.add(key);
    nodes.push({key,thread:byKey.get(key)!,depth,cycle:(children.get(key)??[]).some(child=>lineage.has(child))});
    for(const child of children.get(key)??[])visit(child,depth+1,lineage);
  }
  for(const key of byKey.keys())if(!parentByChild.has(key))visit(key,0,new Set());
  // Malformed source cycles remain visible; traversal is finite and edges retain source authority.
  for(const key of byKey.keys())visit(key,0,new Set());
  return {nodes,edges,parentByChild,children};
}
