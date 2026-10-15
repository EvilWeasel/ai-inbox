import { afterEach,it,expect,vi } from 'vitest';
import { render,screen,fireEvent,cleanup } from '@testing-library/react';
import { AgentGraph } from './agent-graph';
import type { NativeThread } from '@/lib/observatory/contracts';
const thread=(hostId:string,id:string,title:string,parentThreadId:string|null):NativeThread=>({hostId,id,title,parentThreadId,status:'running',runId:null,updatedAt:null});
afterEach(cleanup);
it('renders connected lineage with exact host selection and keyboard parent/child focus',()=>{
 const choose=vi.fn();const threads=[thread('host-a','parent','Parent A',null),thread('host-b','parent','Parent B',null),thread('host-a','child','Child A','parent')];
 const {container}=render(<AgentGraph threads={threads} selected={{hostId:'host-b',threadId:'parent'}} onSelect={choose}/>);
 const a=screen.getByRole('button',{name:/Parent A.*Root/}),b=screen.getByRole('button',{name:/Parent B.*Root/}),child=screen.getByRole('button',{name:/Child A/});
 expect(b.getAttribute('aria-pressed')).toBe('true');expect(a.getAttribute('aria-pressed')).toBe('false');expect(container.querySelectorAll('svg>path')).toHaveLength(1);
 a.focus();fireEvent.keyDown(a,{key:'ArrowRight'});expect(document.activeElement).toBe(child);fireEvent.keyDown(child,{key:'ArrowLeft'});expect(document.activeElement).toBe(a);fireEvent.click(child);expect(choose).toHaveBeenCalledWith(threads[2]);
});
