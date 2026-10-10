import { sqliteTable, text, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const items = sqliteTable('items', {
  id: text('id').primaryKey(), externalId: text('external_id').notNull(),
  title: text('title').notNull(), kind: text('kind', { enum: ['briefing','alert'] }).notNull(),
  edition: text('edition', { enum: ['morning','evening'] }), publishedAt: text('published_at').notNull(),
  body: text('body').notNull(), summary: text('summary').notNull(),
  sources: text('sources', { mode: 'json' }).$type<{title:string;url:string}[]>().notNull(),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
  audioFile: text('audio_file'), audioDuration: real('audio_duration'),
  readAt: text('read_at'), archivedAt: text('archived_at'),
  provenance: text('provenance', { mode:'json' }).$type<Record<string,unknown>>().notNull(),
}, t => [uniqueIndex('items_external_id').on(t.externalId), index('items_order').on(t.publishedAt,t.id), index('items_view_order').on(t.archivedAt,t.readAt,t.publishedAt,t.id), index('items_kind_order').on(t.kind,t.publishedAt,t.id)]);
