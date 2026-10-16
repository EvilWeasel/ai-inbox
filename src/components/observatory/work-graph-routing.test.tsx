import {expect,it} from 'vitest';
import {dependencyRoute,type NodeBox,type Point} from './work-graph-routing';

function crosses(a:Point,b:Point,r:NodeBox){
 if(a.x===b.x)return a.x>r.left&&a.x<r.right&&Math.max(a.y,b.y)>r.top&&Math.min(a.y,b.y)<r.bottom;
 return a.y>r.top&&a.y<r.bottom&&Math.max(a.x,b.x)>r.left&&Math.min(a.x,b.x)<r.right;
}
it('keeps a mobile skip dependency outside intermediate cards instead of implying adjacency',()=>{
 const boxes=[0,1,2,3].map(index=>({left:56,right:316,top:12+index*180,bottom:128+index*180}));
 const points=dependencyRoute(boxes[0],boxes[3],boxes,true,7);
 for(let index=1;index<points.length;index++)for(const box of boxes)expect(crosses(points[index-1],points[index],box)).toBe(false);
 expect(points.at(-1)).toEqual({x:56,y:610});
 expect(Math.min(...points.map(p=>p.x))).toBeGreaterThanOrEqual(0);
});
it('routes desktop dependencies around intermediate levels and parallel work cards',()=>{
 const boxes=[{left:12,right:272,top:200,bottom:316},{left:348,right:608,top:56,bottom:172},{left:348,right:608,top:200,bottom:316},{left:684,right:944,top:200,bottom:316}];
 const points=dependencyRoute(boxes[0],boxes[3],boxes,false,7);
 for(let index=1;index<points.length;index++)for(const box of boxes)expect(crosses(points[index-1],points[index],box)).toBe(false);
 expect(Math.min(...points.map(p=>p.y))).toBeGreaterThanOrEqual(0);
});
