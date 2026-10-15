import importlib.util,json,pathlib,sqlite3,tempfile,types,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('ranking',pathlib.Path(__file__).resolve().parents[2]/'scripts/rank-inbox.py')
ranking=importlib.util.module_from_spec(spec);spec.loader.exec_module(ranking)

class RankingTests(unittest.TestCase):
 def test_atomic_snapshot_publication_and_failure_preserves_previous_scores(self):
  with tempfile.TemporaryDirectory() as root:
   root=pathlib.Path(root);config=root/'config.json';config.write_text('{}');config.chmod(0o600)
   db=sqlite3.connect(root/'inbox.sqlite')
   db.executescript("""CREATE TABLE items(id TEXT PRIMARY KEY,title TEXT,body TEXT,summary TEXT,kind TEXT,published_at TEXT,archived_at TEXT);
    CREATE TABLE ranking_runs(id TEXT PRIMARY KEY,state TEXT,created_at TEXT,completed_at TEXT,error TEXT,context_info TEXT);
    CREATE TABLE item_rankings(item_id TEXT PRIMARY KEY,run_id TEXT,content_sha256 TEXT,score INTEGER,reason TEXT,ranked_at TEXT);
    INSERT INTO items VALUES('a','Research','body','','result','2026-01-01',NULL);
    INSERT INTO items VALUES('b','Changed','body','','result','2026-01-01',NULL);
    INSERT INTO ranking_runs VALUES('one','running','2026-01-01',NULL,NULL,NULL);""");db.commit()
   args=types.SimpleNamespace(config=str(config),data_dir=str(root),run_id='one')
   def inference(*_):
    db.execute("UPDATE items SET body='edited while ranking' WHERE id='b'");db.commit()
    return [{'id':'a','score':91,'reason':'Relevant research'},{'id':'b','score':20,'reason':'Old content'}]
   with patch.object(ranking.decision,'_supports_exec_options'),patch.object(ranking,'context',return_value=([{'at':'2026-01-01'}],[{}])),patch.object(ranking,'infer',side_effect=inference):ranking.run(args)
   self.assertEqual(db.execute('SELECT item_id,score FROM item_rankings').fetchall(),[('a',91)])
   self.assertEqual(db.execute('SELECT state FROM ranking_runs').fetchone()[0],'ready')
   db.execute("INSERT INTO ranking_runs VALUES('two','running','2026-01-02',NULL,NULL,NULL)");db.commit();args.run_id='two'
   with patch.object(ranking.decision,'_supports_exec_options'),patch.object(ranking,'context',return_value=([{'at':'2026-01-01'}],[{}])),patch.object(ranking,'infer',side_effect=ValueError('failed')):
    with self.assertRaises(ValueError):ranking.run(args)
   self.assertEqual(db.execute('SELECT item_id,score FROM item_rankings').fetchall(),[('a',91)])
   self.assertEqual(db.execute("SELECT state FROM ranking_runs WHERE id='two'").fetchone()[0],'failed');db.close()

 def test_context_only_authentic_personal_user_messages(self):
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'context.sqlite';db=sqlite3.connect(path)
   db.executescript('CREATE TABLE orchestration_v2_projection_messages(payload_json TEXT,thread_id TEXT,role TEXT,created_at TEXT);CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,title TEXT,deleted_at TEXT);CREATE TABLE orchestration_v2_projection_subagents(child_thread_id TEXT);')
   db.executemany('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,NULL)',[('root','Personal'),('child','Child')]);db.execute("INSERT INTO orchestration_v2_projection_subagents VALUES('child')")
   for thread,creator,source,text in [('root','user','web','real preference'),('root','user','server','synthetic handoff'),('child','user','web','delegated prompt')]:
    db.execute('INSERT INTO orchestration_v2_projection_messages VALUES(?,?,?,?)',(json.dumps({'createdBy':creator,'creationSource':source,'text':text}),thread,'user',ranking.stamp()))
   db.commit();db.close();records,_=ranking.context({'contextDatabases':[str(path)]})
   self.assertEqual([r['text'] for r in records],['real preference'])
