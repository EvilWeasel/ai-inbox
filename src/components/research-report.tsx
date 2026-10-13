"use client";

import { useRef, useState } from 'react';
import { Button } from '@openai/apps-sdk-ui/components/Button';
import { Badge } from '@openai/apps-sdk-ui/components/Badge';
import { ArrowUpRight, BookOpen, ChartNoAxesCombined, FileText } from 'lucide-react';
import { reportSchema, type ResearchReport as Report } from '@/lib/report';

export function ResearchReport({ report, original }: { report: Report; original: React.ReactNode }) {
  const checked = reportSchema.safeParse(report);
  if (!checked.success) return <><p role="alert">Report view unavailable. The original text is available below.</p>{original}</>;
  return <ReportView report={checked.data} original={original} />;
}

function ReportView({ report, original }: { report: Report; original: React.ReactNode }) {
  const [view, setView] = useState<'visual' | 'original'>('visual');
  const [active, setActive] = useState(report.sections[0].id);
  const [source, setSource] = useState<Report['sources'][number] | null>(null);
  const sourcePanel = useRef<HTMLDivElement>(null);
  const sourceTrigger = useRef<HTMLButtonElement | null>(null);
  function openSource(id: string, trigger: HTMLButtonElement) {
    sourceTrigger.current = trigger;
    setSource(report.sources.find(s => s.id === id) ?? null);
    requestAnimationFrame(() => { sourcePanel.current?.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' }); sourcePanel.current?.focus(); });
  }
  function references(ids: string[]) {
    return ids.length > 0 && <span className="report-refs" aria-label="Supporting sources">{ids.map(id => <Button key={id} color="secondary" variant="ghost" size="xs" onClick={event => openSource(id, event.currentTarget)} aria-label={`Source: ${report.sources.find(s => s.id === id)?.title}`}><BookOpen size={12} />{report.sources.findIndex(s => s.id === id) + 1}</Button>)}</span>;
  }
  const section = report.sections.find(s => s.id === active) ?? report.sections[0];
  return <div className="research-report">
    <div className="report-toolbar" role="group" aria-label="Report view">
      <Button color="secondary" variant={view === 'visual' ? 'solid' : 'ghost'} size="lg" aria-pressed={view === 'visual'} onClick={() => setView('visual')}><ChartNoAxesCombined size={16} />Report</Button>
      <Button color="secondary" variant={view === 'original' ? 'solid' : 'ghost'} size="lg" aria-pressed={view === 'original'} onClick={() => setView('original')}><FileText size={16} />Original text</Button>
      <Badge color="info" pill>{report.sources.length} {report.sources.length === 1 ? "source" : "sources"}</Badge>
    </div>
    {view === 'original' ? original : <>
      {report.subtitle && <p className="report-subtitle">{report.subtitle}</p>}
      <nav className="report-nav" aria-label="Report sections">{report.sections.map((s, i) => <Button key={s.id} color="secondary" variant={s.id === section.id ? 'soft' : 'ghost'} size="lg" aria-current={s.id === section.id ? 'true' : undefined} onClick={() => { setActive(s.id); setSource(null); }}><span className="report-nav-index" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>{s.title}</Button>)}</nav>
      <section className="report-section" aria-labelledby="report-section-heading" key={section.id}>
        <div className="report-section-heading"><span className="report-eyebrow">{String(report.sections.indexOf(section) + 1).padStart(2, '0')} / {String(report.sections.length).padStart(2, '0')}</span><h3 id="report-section-heading">{section.title}</h3>{section.summary && <p>{section.summary}</p>}</div>
        {section.blocks.map((block, i) => <div className={`report-block report-${block.type}`} key={i}>
          {block.type === 'text' && <><p>{block.text}</p>{references(block.sourceIds)}</>}
          {block.type === 'metrics' && <dl>{block.items.map((item, j) => <div key={j}><dt>{item.label}</dt><dd>{item.value}</dd>{item.detail && <p>{item.detail}</p>}{references(item.sourceIds)}</div>)}</dl>}
          {block.type === 'comparison' && <table><caption className="sr-only">{section.title} comparison</caption><thead><tr><th scope="col">Topic</th>{block.columns.map((c, j) => <th scope="col" key={j}>{c}</th>)}</tr></thead><tbody>{block.rows.map((row, j) => <tr key={j}><th scope="row">{row.label}{references(row.sourceIds)}</th>{row.cells.map((cell, k) => <td key={k} data-label={block.columns[k]}>{cell}</td>)}</tr>)}</tbody></table>}
          {block.type === 'bars' && <figure><figcaption>{block.unit || 'Comparison'}</figcaption><ul>{block.items.map((item, j) => <li key={j}><div className="report-bar-label"><strong>{item.label}</strong><span>{item.value.toLocaleString()} {block.unit}</span></div><div className="report-bar-track" aria-hidden="true"><span style={{width: `${item.value / (Math.max(...block.items.map(v => v.value)) || 1) * 100}%`}} /></div>{item.detail && <p>{item.detail}</p>}{references(item.sourceIds)}</li>)}</ul></figure>}
          {block.type === 'steps' && <ol>{block.items.map((item, j) => <li key={j}><span className="report-step-number">{j + 1}</span><div><h4>{item.title}</h4><p>{item.detail}</p>{references(item.sourceIds)}</div></li>)}</ol>}
        </div>)}
      </section>
      {source && <div className="report-source-detail" ref={sourcePanel} tabIndex={-1} role="region" aria-label="Source details"><div className="report-source-top"><Badge color="info">Source {report.sources.indexOf(source) + 1}</Badge><Button color="secondary" variant="ghost" size="sm" onClick={() => { setSource(null); sourceTrigger.current?.focus(); }}>Close source</Button></div><h4>{source.title}</h4><p className="report-source-meta">{source.publisher || new URL(source.url).hostname}{source.date && ` · ${source.date}`}</p>{source.excerpt && <blockquote>{source.excerpt}</blockquote>}<a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Read source <ArrowUpRight size={15}/><span className="sr-only"> (opens in new tab)</span></a></div>}
      <details className="report-source-index"><summary>All sources <span>{report.sources.length}</span></summary><ol>{report.sources.map((s, i) => <li key={s.id}><button onClick={event => openSource(s.id, event.currentTarget)}><span>{i + 1}</span><span>{s.title}<small>{s.publisher || new URL(s.url).hostname}</small></span><BookOpen size={15} /></button></li>)}</ol></details>
    </>}
  </div>;
}
