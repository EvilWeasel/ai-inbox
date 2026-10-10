import { z } from 'zod';

export const sourceSchema = z.object({ title: z.string().max(1000), url: z.string().url().max(4096).refine(v => /^https?:\/\//i.test(v), 'HTTP(S) URL required') }).strict();
export const kindSchema = z.enum(['briefing', 'alert', 'result']);
export const resultTypeSchema = z.enum(['research','implementation','report']);
export const originSchema = z.object({
  host: z.string().trim().min(1).max(255), project: z.string().max(500).optional(),
  threadId: z.string().max(500).optional(), runId: z.string().max(500).optional(),
  model: z.string().max(500).optional(), threadUrl: z.string().url().max(4096).refine(v => {
    const url = new URL(v);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:' || url.protocol === 'http:') return Boolean(url.hostname);
    return url.protocol === 't3-thread:' && url.hostname === 'v1' && !url.port && !url.search && !url.hash && /^\/[A-Za-z0-9_-]+$/.test(url.pathname);
  }, 'HTTP(S) or a T3 thread link required').optional(),
}).strict();
export const itemSchema = z.object({
  id: z.string(), title: z.string(), kind: kindSchema,
  resultType: resultTypeSchema.nullable(), origin: originSchema.nullable(),
  edition: z.enum(['morning', 'evening']).nullable(), publishedAt: z.string(),
  body: z.string(), summary: z.string(), sources: z.array(sourceSchema),
  audioAvailable: z.boolean(), audioDuration: z.number().nullable(),
  readAt: z.string().nullable(), archivedAt: z.string().nullable(), tags: z.array(z.string()),
});
export type InboxItem = z.infer<typeof itemSchema>;
export type ItemKind = InboxItem['kind'];
export type ItemView = 'inbox' | 'unread' | 'archive' | 'all';
export interface ItemList { items: InboxItem[]; nextCursor: string | null; counts: { inbox: number; unread: number; archive: number }; total: number }
export const patchSchema = z.object({ read: z.boolean().optional(), archived: z.boolean().optional() }).strict().refine(v => v.read !== undefined || v.archived !== undefined, 'At least one field required');
export const querySchema = z.object({ view: z.enum(['inbox','unread','archive','all']).default('inbox'), kind: kindSchema.optional(), q: z.string().trim().max(300).default(''), cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();
export const ingestSchema = z.object({
  externalId: z.string().min(1).max(1000), title: z.string().trim().min(1).max(2000), kind: kindSchema,
  edition: z.enum(['morning','evening']).nullable().default(null),
  publishedAt: z.string().datetime({ offset: true }).transform(v => new Date(v).toISOString()),
  body: z.string().min(1).max(2_000_000), summary: z.string().max(4000).default(''),
  sources: z.array(sourceSchema).max(500).default([]), tags: z.array(z.string().max(200)).max(100).default([]),
  audioDuration: z.number().finite().nonnegative().nullable().default(null),
  provenance: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type IngestItem = z.infer<typeof ingestSchema>;

export const resultMetadataSchema = z.object({
  deliveryId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(2000), body: z.string().min(1).max(2_000_000),
  summary: z.string().max(4000).optional(), sources: z.array(sourceSchema).max(500).optional(),
  tags: z.array(z.string().max(200)).max(100).optional(),
  resultType: resultTypeSchema, origin: originSchema,
  publishedAt: z.string().datetime({offset:true}), phase: z.literal('final'),
  audioDuration: z.number().finite().nonnegative().optional(),
}).strict();
export type ResultMetadata = z.infer<typeof resultMetadataSchema>;
