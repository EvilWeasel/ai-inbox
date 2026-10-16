export type NodeBox={left:number;right:number;top:number;bottom:number};
export type Point={x:number;y:number};

/** Route through the gutters, never through an unrelated work card. */
export function dependencyRoute(from:NodeBox,to:NodeBox,boxes:NodeBox[],vertical:boolean,index:number):Point[]{
 if(vertical){
  const lane=Math.min(...boxes.map(box=>box.left))-12-(index%8)*4;
  const start={x:from.left,y:(from.top+from.bottom)/2},end={x:to.left,y:(to.top+to.bottom)/2};
  return [start,{x:lane,y:start.y},{x:lane,y:end.y},end];
 }
 const lane=Math.min(...boxes.map(box=>box.top))-12-(index%8)*4;
 const start={x:from.right,y:(from.top+from.bottom)/2},end={x:to.left,y:(to.top+to.bottom)/2};
 return [start,{x:start.x+16,y:start.y},{x:start.x+16,y:lane},{x:end.x-16,y:lane},{x:end.x-16,y:end.y},end];
}
export function routePath(points:Point[]){return points.map((p,index)=>`${index?'L':'M'}${p.x},${p.y}`).join(' ');}
