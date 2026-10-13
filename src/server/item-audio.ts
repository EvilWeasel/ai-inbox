import { createHash } from 'node:crypto';
import type { InboxDatabase } from './db';
import { ApiError, detail, getRow } from './items';
import { eventHub } from './events';

export const ITEM_AUDIO_PROFILE = 'google/gemini-3.8-flash-tts:Kore:v1';
export function itemAudioJobId(itemId: string, bodySha256: string) {
  return createHash('sha256').update(JSON.stringify([itemId,bodySha256,ITEM_AUDIO_PROFILE])).digest('hex');
}

/** A browser may request generation, but cannot choose a provider or prompt.
 * The immediate transaction serializes simultaneous clicks across connections. */
export function requestItemAudio(db: InboxDatabase, itemId: string) {
  const result = db.sqlite.transaction(() => {
    const row = getRow(db,itemId);
    if (!row) throw new ApiError(404,'Item not found');
    if (row.audioFile) return {item:detail(db,itemId),status:200};
    const bodySha = createHash('sha256').update(row.body,'utf8').digest('hex');
    const id = itemAudioJobId(itemId,bodySha);
    const at = new Date().toISOString();
    db.sqlite.prepare(`UPDATE item_audio_jobs SET state='superseded',safe_error_code=NULL,updated_at=?
      WHERE item_id=? AND body_sha256<>? AND state<>'superseded'`).run(at,itemId,bodySha);
    // Do not reset terminal states: uncertain paid calls require human review.
    db.sqlite.prepare(`INSERT OR IGNORE INTO item_audio_jobs
      (id,item_id,body_sha256,state,created_at,updated_at) VALUES(?,?,?,'queued',?,?)`).run(id,itemId,bodySha,at,at);
    const item = detail(db,itemId);
    return {item,status:item.audioStatus === 'ready' ? 200 : 202};
  }).immediate();
  eventHub(db).notifyCommit();
  return result;
}
