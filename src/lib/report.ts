import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const sourceIds = z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).max(30).default([]);
const fact = z.object({ label: text, value: text, detail: z.string().max(2000).optional(), sourceIds }).strict();
const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(12000), sourceIds }).strict(),
  z.object({ type: z.literal('metrics'), items: z.array(fact).min(1).max(12) }).strict(),
  z.object({ type: z.literal('comparison'), columns: z.array(text).min(2).max(8), rows: z.array(z.object({ label: text, cells: z.array(z.string().max(2000)).max(8), sourceIds }).strict()).min(1).max(60) }).strict(),
  z.object({ type: z.literal('bars'), unit: z.string().max(80).default(''), items: z.array(z.object({ label: text, value: z.number().finite().nonnegative().max(1e12), detail: z.string().max(2000).optional(), sourceIds }).strict()).min(1).max(30) }).strict(),
  z.object({ type: z.literal('steps'), items: z.array(z.object({ title: text, detail: z.string().max(4000), sourceIds }).strict()).min(1).max(20) }).strict(),
]);
export const reportSchema = z.object({
  version: z.literal(1), title: text, subtitle: z.string().max(2000).optional(),
  sections: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: text, summary: z.string().max(2000).optional(), blocks: z.array(block).min(1).max(30) }).strict()).min(1).max(30),
  sources: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: text, url: z.string().url().max(4096).refine(v => { const u = new URL(v); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password; }), publisher: z.string().max(500).optional(), date: z.string().max(80).optional(), excerpt: z.string().max(4000).optional() }).strict()).max(300),
}).strict().superRefine((report, ctx) => {
  const ids = new Set(report.sources.map(s => s.id));
  if (ids.size !== report.sources.length || new Set(report.sections.map(s => s.id)).size !== report.sections.length) ctx.addIssue({ code: 'custom', message: 'Unique section and source IDs required' });
  for (const section of report.sections) for (const b of section.blocks) {
    if (b.type === 'comparison' && b.rows.some(r => r.cells.length !== b.columns.length)) ctx.addIssue({ code: 'custom', message: 'Comparison cells must match columns' });
    const refs = 'sourceIds' in b ? b.sourceIds : b.type === 'comparison' ? b.rows.flatMap(r => r.sourceIds) : b.items.flatMap(i => i.sourceIds);
    if (refs.some(id => !ids.has(id))) ctx.addIssue({ code: 'custom', message: 'Unknown source reference' });
  }
});
export type ResearchReport = z.infer<typeof reportSchema>;
