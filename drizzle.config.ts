import { defineConfig } from 'drizzle-kit';
import { join } from 'node:path';
if (!process.env.INBOX_DATA_DIR) throw new Error('INBOX_DATA_DIR required');
export default defineConfig({ dialect:'sqlite', schema:'./src/server/schema.ts', out:'./src/server/generated-migrations', dbCredentials:{url:join(process.env.INBOX_DATA_DIR,'inbox.sqlite')} });
