import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { ResearchReport } from './research-report';
import { reportSchema } from '../lib/report';

afterEach(cleanup);
const report = reportSchema.parse({version:1,title:'Report',sections:[{id:'compare',title:'Compare',blocks:[{type:'comparison',columns:['Approach','Evidence'],rows:[{label:'Durability',cells:['Persistent','Verified'],sourceIds:['paper']}]},{type:'bars',unit:'ms',items:[{label:'Latency',value:25,sourceIds:['paper']}]}]},{id:'next',title:'Next steps',blocks:[{type:'steps',items:[{title:'Evaluate',detail:'Measure actual outcomes'}]}]}],sources:[{id:'paper',title:'Primary paper',url:'https://example.test/paper',excerpt:'Supporting evidence'}]});

describe('research reports', () => {
  it('navigates sections, drills into evidence, and preserves original text', async () => {
    const user = userEvent.setup();
    render(<ResearchReport report={report} original={<p>Complete original research</p>} />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('25 ms')).toBeTruthy();
    const citation = screen.getAllByRole('button', {name:'Source: Primary paper'})[0];
    await user.click(citation);
    expect(screen.getByRole('region', {name:'Source details'})).toBeTruthy();
    expect(screen.getByText('Supporting evidence')).toBeTruthy();
    expect(screen.getByRole('link', {name:/Read source/}).getAttribute('rel')).toBe('noopener noreferrer');
    await user.click(screen.getByRole('button', {name:'Close source'}));
    expect(document.activeElement).toBe(citation);
    await user.click(screen.getByRole('button', {name:"Next steps"}));
    expect(screen.getByText('Measure actual outcomes')).toBeTruthy();
    expect(screen.queryByRole('region', {name:'Source details'})).toBeNull();
    await user.click(screen.getByRole('button', {name:'Original text'}));
    expect(screen.getByText('Complete original research')).toBeTruthy();
    expect(screen.queryByText('Measure actual outcomes')).toBeNull();
  });
  it('renders producer text as escaped content and rejects unsafe report links', () => {
    const malicious = structuredClone(report);
    malicious.sections[0].blocks = [{type:'text',text:'<script>alert(1)</script><img src="https://tracker.test">',sourceIds:[]}];
    const {container} = render(<ResearchReport report={malicious} original={<p>Original</p>} />);
    expect(container.querySelector('script, img, iframe')).toBeNull();
    cleanup();
    malicious.sources[0].url='javascript:alert(1)';
    render(<ResearchReport report={malicious} original={<p>Readable original</p>} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Readable original')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
