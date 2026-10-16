import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {WorkGraphView} from './work-graph';
import type {WorkGraph} from '@/lib/observatory/contracts';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('renders meaningful dependencies, selected-step artifacts and live structural changes',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
 const graph:WorkGraph={goal:'Owned instruction to verified effect',orientation:'horizontal',nodes:[{id:'fixture',title:'Reject foreign author binding',kind:'step',state:'active',evidence:[]},{id:'resolver',title:'Compose trusted resolver',kind:'step',state:'planned',evidence:[]}],edges:[{from:'fixture',to:'resolver'}]};
 const {rerender,container}=render(<WorkGraphView graph={graph} revision={1} onEvidence={id=><p>{id}</p>}/>);
 expect(screen.getByRole('heading',{name:graph.goal})).toBeTruthy();expect(screen.getByRole('button',{name:/Reject foreign author binding.*active/}).getAttribute('aria-pressed')).toBe('true');
 fireEvent.click(screen.getByRole('button',{name:/Compose trusted resolver.*planned/}));expect(screen.getByText('After Reject foreign author binding')).toBeTruthy();
 const updated:WorkGraph={...graph,orientation:'vertical',nodes:[{...graph.nodes[0],state:'completed',evidence:[{label:'Signed source',href:'https://example.test/commit/exact'}]},graph.nodes[1],{id:'acceptance',title:'Installed effect still unknown',kind:'result',state:'unknown',evidence:[]}],edges:[...graph.edges,{from:'resolver',to:'acceptance'}]};
 rerender(<WorkGraphView graph={updated} revision={2} onEvidence={id=><p>{id}</p>}/>);expect(screen.getByText('Agent revision 2')).toBeTruthy();expect(container.querySelector('.work-flow-vertical')).toBeTruthy();expect(screen.getByRole('button',{name:/Installed effect.*unknown/})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/Reject foreign.*completed/}));expect(screen.getByRole('link',{name:'Signed source'}).getAttribute('href')).toBe('https://example.test/commit/exact');
});
