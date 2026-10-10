#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/server/db';
import { collectArtifacts, importRecords, ingestExplicit } from '../src/server/importer';

function main() {
  const {values} = parseArgs({options:{source:{type:'string'},'data-dir':{type:'string'},json:{type:'string'},text:{type:'string'},media:{type:'string'},help:{type:'boolean'}},strict:true});
  if (values.help) { console.log('Usage: import --source PROJECT_OR_BRIEFING_DIR [--data-dir DIR]\n       import --json ITEM.json [--text BODY.md] [--media AUDIO.mp3] [--data-dir DIR]\nINBOX_DATA_DIR can replace --data-dir. Local CLI only; no ingestion HTTP endpoint.'); return; }
  if ((!values.source && !values.json) || (values.source && values.json) || (values.source && (values.text || values.media))) throw new Error('Choose exactly one of --source or --json; --text/--media apply only to --json');
  const collected = values.source ? collectArtifacts(values.source) : {records:[ingestExplicit(values.json!,values.text,values.media)],warnings:[]};
  const db = openDatabase(values['data-dir']??process.env.INBOX_DATA_DIR);
  try { const imported = importRecords(db,collected.records); console.log(JSON.stringify({imported,warnings:collected.warnings})); }
  finally { db.close(); }
}
try { main(); } catch (error) {
  // Avoid dumping document bodies, credentials, or source metadata from validation exceptions.
  console.error(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Import validation failed'); process.exitCode = 1;
}
