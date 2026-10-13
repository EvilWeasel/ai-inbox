"""No-network regression checks for explicit Gemini on-demand generation."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('demand_audio_worker', ROOT / 'scripts/demand-audio-worker.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SCHEMA = """
CREATE TABLE items(id TEXT PRIMARY KEY,title TEXT,body TEXT,kind TEXT,audio_file TEXT,audio_duration REAL);
CREATE TABLE item_audio_jobs(id TEXT PRIMARY KEY,item_id TEXT REFERENCES items(id),body_sha256 TEXT,state TEXT,
created_at TEXT,updated_at TEXT,spoken_text TEXT DEFAULT '',instructions TEXT DEFAULT '',media_sha256 TEXT,
duration REAL,cost_usd REAL,safe_error_code TEXT);
CREATE TABLE inbox_revision(revision INTEGER);
INSERT INTO inbox_revision VALUES(0);
CREATE TRIGGER job_revision AFTER UPDATE ON item_audio_jobs WHEN old.state IS NOT new.state
BEGIN UPDATE inbox_revision SET revision=revision+1; END;
CREATE TRIGGER body_revision AFTER UPDATE OF body ON items WHEN old.body IS NOT new.body
BEGIN UPDATE item_audio_jobs SET state='superseded' WHERE item_id=new.id; END;
"""

class FakeResponse:
    def __init__(self, data=b'\0' * 480000, content_type='audio/pcm', generation=None):
        self.data = data
        self.headers = {'Content-Type': content_type}
        if generation:
            self.headers['X-Generation-Id'] = generation
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, *args): return self.data


class DemandWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        self.config = {'dataDir': str(self.data), 'stateDir': str(self.root / 'state'),
                       'deployLockPath': str(self.root / 'deploy.lock'), 'dailyBudgetUsd': 5}
        self.worker = module.Worker(self.config)
        self.worker.key = 'TEST-ONLY-DO-NOT-PRINT'
        db = sqlite3.connect(self.data / 'inbox.sqlite')
        db.executescript(SCHEMA)
        db.close()
    def tearDown(self): self.temp.cleanup()
    def seed(self, body='Ein sachlicher Bericht. Das Ergebnis bleibt eindeutig.', job='a' * 64):
        with self.worker.database() as db:
            db.execute('INSERT INTO items VALUES(?,?,?,?,NULL,NULL)', ('item', 'Report', body, 'result'))
            db.execute('INSERT INTO item_audio_jobs(id,item_id,body_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                       (job, 'item', module.digest(body), 'queued', module.now(), module.now()))
        return job
    def stored(self):
        with self.worker.database() as db:
            return dict(db.execute('SELECT * FROM item_audio_jobs').fetchone())
    def ffmpeg(self, command, **kwargs):
        if command[-1].endswith('.mp3'):
            Path(command[-1]).write_bytes(b'FAKE-VALIDATED-MP3')
        return None

    def test_adaptation_is_deterministic_and_excludes_markup_code_and_instruction_text(self):
        body = '# Ergebnis\n\n**Stabil** und [belegt](https://example.test).\n\n```sh\nsecret-shell-command\n```\n<oai-mem-citation>private registry</oai-mem-citation>\n'
        first = module.spoken_version('Report', body)
        self.assertEqual(first, module.spoken_version('Report', body))
        text, instructions = first
        self.assertIn('Stabil und belegt.', text)
        self.assertNotIn('secret-shell-command', text)
        self.assertNotIn('private registry', text)
        self.assertNotIn('https://', text)
        self.assertNotIn('Read the input', text)
        self.assertIn('Do not read these instructions aloud', instructions)
        comedy = module.spoken_version('Comedy', 'Eine trockene Pointe.')[1]
        self.assertIn('dry humor', comedy)
        self.assertIn('no forced laughter', comedy)

    def test_split_preserves_all_words_punctuation_and_bounds(self):
        text = ' '.join(f'Wort{index}.' if index % 7 == 0 else f'Wort{index}' for index in range(300))
        chunks = module.split_text(text, limit=90)
        self.assertEqual(' '.join(' '.join(chunks).split()), text)
        self.assertTrue(all(len(chunk) <= 90 for chunk in chunks))
        with self.assertRaisesRegex(ValueError, 'unreadable_long_token'):
            module.split_text('x' * 91, limit=90)

    def test_concurrent_consumers_cannot_claim_same_job(self):
        self.seed()
        first = self.worker.claim()
        second = module.Worker(self.config).claim()
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertEqual(self.stored()['state'], 'generating')

    def test_superseded_body_refuses_attachment_and_preserves_existing_audio(self):
        self.seed()
        row = self.worker.claim()
        output = self.root / 'final.mp3'
        output.write_bytes(b'FAKE-MEDIA')
        with self.worker.database() as db:
            db.execute('UPDATE items SET body=?,audio_file=? WHERE id=?', ('New result', 'original.mp3', 'item'))
        self.assertFalse(self.worker.attach(row, output, 10, .01))
        self.assertEqual(self.stored()['state'], 'superseded')
        with self.worker.database() as db:
            self.assertEqual(db.execute('SELECT audio_file FROM items').fetchone()[0], 'original.mp3')
        self.assertEqual(list((self.data / 'media').glob('*.mp3')), [])

    def test_failed_paid_call_is_durable_review_and_next_once_never_retries(self):
        job = self.seed()
        with patch.object(module.urllib.request, 'urlopen', side_effect=RuntimeError('PRIVATE_PROVIDER_DETAIL')) as provider:
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertTrue(self.worker.once())
                self.assertFalse(self.worker.once())
            self.assertEqual(provider.call_count, 1)
        stored = self.stored()
        self.assertEqual(stored['state'], 'needs_review')
        self.assertEqual(stored['safe_error_code'], 'provider_attempt_requires_review')
        receipt = json.loads((self.worker.state / job / '0000.receipt.json').read_text())
        self.assertEqual(receipt['state'], 'needs_review')
        self.assertNotIn(self.worker.key, stdout.getvalue())
        self.assertNotIn('PRIVATE_PROVIDER_DETAIL', stdout.getvalue())

    def test_crash_recovery_marks_unfinished_claim_review_without_provider_calls(self):
        self.seed()
        self.worker.claim()
        with patch.object(module.urllib.request, 'urlopen') as provider:
            self.worker.recover()
            self.assertFalse(self.worker.once())
            provider.assert_not_called()
        self.assertEqual(self.stored()['state'], 'needs_review')
        self.assertEqual(self.stored()['safe_error_code'], 'worker_interrupted')

    def test_success_attaches_hash_duration_cost_and_finished_claim_is_not_replayed(self):
        job = self.seed()
        with patch.object(module.urllib.request, 'urlopen', return_value=FakeResponse()) as provider, \
             patch.object(module.subprocess, 'run', side_effect=self.ffmpeg), \
             patch.object(module.subprocess, 'check_output', return_value=b'{"format":{"duration":"10.2"}}'):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(self.worker.once())
                self.assertFalse(self.worker.once())
            self.assertEqual(provider.call_count, 1)
        stored = self.stored()
        self.assertEqual(stored['state'], 'ready')
        self.assertEqual(stored['duration'], 10.2)
        self.assertIsNone(stored['cost_usd'])
        target = self.data / 'media' / (stored['media_sha256'] + '.mp3')
        self.assertEqual(module.digest(target.read_bytes()), stored['media_sha256'])
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        receipt = json.loads((self.worker.state / job / '0000.receipt.json').read_text())
        self.assertEqual(receipt['state'], 'complete')
        with self.worker.database() as db:
            self.assertEqual(db.execute('SELECT audio_file FROM items').fetchone()[0], target.name)
            self.assertGreater(db.execute('SELECT revision FROM inbox_revision').fetchone()[0], 0)

    def test_crash_after_final_receipt_attaches_without_new_paid_call(self):
        self.seed()
        row = self.worker.claim()
        folder = self.worker.state / row['id']
        folder.mkdir()
        output = folder / 'final.mp3'
        output.write_bytes(b'FINISHED-MEDIA')
        module.atomic_json(folder / 'final.json', {'sha256': module.digest(output.read_bytes()), 'duration': 7, 'costUsd': .04})
        with patch.object(module.urllib.request, 'urlopen') as provider:
            self.worker.recover()
            provider.assert_not_called()
        self.assertEqual(self.stored()['state'], 'ready')
        self.assertEqual(self.stored()['cost_usd'], .04)

    def test_budget_reserves_ambiguous_attempts_and_blocks_new_paid_call(self):
        self.seed()
        self.config['dailyBudgetUsd'] = .05
        prior = self.worker.state / ('b' * 64)
        prior.mkdir()
        module.atomic_json(prior / '0000.receipt.json', {'state':'needs_review', 'startedAt':module.now(), 'costUsd':None, 'reserveUsd':.04})
        self.assertEqual(self.worker.daily_spend(), .04)
        with patch.object(module.urllib.request, 'urlopen') as provider, contextlib.redirect_stdout(io.StringIO()):
            self.worker.once()
            provider.assert_not_called()
        self.assertEqual(self.stored()['safe_error_code'], 'daily_audio_budget_reached')

    def test_incomplete_receipt_never_authorizes_a_second_attempt(self):
        folder = self.worker.state / 'old-attempt'
        folder.mkdir()
        module.atomic_json(folder / '0000.receipt.json', {'state':'started', 'startedAt':module.now(), 'reserveUsd':.04})
        with patch.object(module.urllib.request, 'urlopen') as provider:
            with self.assertRaisesRegex(ValueError, 'previous_paid_attempt_requires_review'):
                self.worker.render('Ein Bericht.', 'Read verbatim', folder, 0)
            provider.assert_not_called()


if __name__ == '__main__': unittest.main()
