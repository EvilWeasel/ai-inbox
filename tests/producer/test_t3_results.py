import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('t3_results', Path(__file__).parents[2] / 'scripts' / 't3-results.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def projection(status='running', completed=False, streaming=True, child_status=None):
    run = {
        'id': 'run-current', 'threadId': 'thread-selected', 'ordinal': 8, 'status': status,
        'completedAt': '2026-10-10T10:00:00Z' if completed else None,
        'rootNodeId': 'root', 'delegatedCompletion': None,
    }
    root = {'id': 'root', 'kind': 'root_turn', 'status': 'completed' if completed else 'running',
            'completedAt': '2026-10-10T10:00:00Z' if completed else None, 'rootNodeId': 'root'}
    assistant = {'id': 'assistant-node', 'kind': 'assistant_message', 'status': 'completed' if completed else 'running',
                 'completedAt': '2026-10-10T10:00:00Z' if completed else None, 'parentNodeId': 'root', 'rootNodeId': 'root'}
    return {
        'thread': {'id': 'thread-selected', 'createdBy': 'user', 'creationSource': 'personal'}, 'runs': [run], 'nodes': [root, assistant],
        'messages': [{'id': 'message-final', 'threadId': 'thread-selected', 'runId': 'run-current', 'nodeId': 'assistant-node',
                      'role': 'assistant', 'text': 'Finished answer', 'streaming': streaming,
                      'createdAt': '2026-10-10T09:59:00Z', 'updatedAt': '2026-10-10T10:00:00Z'}],
        'subagents': ([{'id': 'child', 'threadId': 'thread-selected', 'runId': 'run-current', 'parentNodeId': 'root',
                        'childThreadId': 'child-thread', 'status': child_status,
                        'completionWake': None, 'completionDelivery': None}] if child_status else []),
    }


class T3ResultsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.audio_root = self.root / 'audio'
        self.audio_root.mkdir()
        self.outbox = self.root / 'outbox'
        self.token = self.private('t3-token', b'test-only-token')
        self.producer_config = self.private('producer-config.json', b'{}')
        self.config_path = self.private('bridge-config.json', json.dumps({
            't3Origin': 'http://localhost:3773', 't3TokenFile': str(self.token),
            'producerConfigFile': str(self.producer_config), 'outboxDir': str(self.outbox),
            'allowedAudioRoots': [str(self.audio_root)], 'pollIntervalSeconds': 5,
        }).encode())
        self.input = self.private('final.json', json.dumps({
            'title': 'Completed result', 'body': 'Finished markdown answer', 'summary': 'Short summary',
            'phase': 'final', 'resultType': 'report', 'publishedAt': '2026-10-10T10:00:00Z',
            'origin': {'host': 'personal-host', 'project': 'Test'}, 'sources': [], 'tags': [],
        }).encode())
        self.audio = self.audio_root / 'selected-original.mp3'
        self.audio.write_bytes(b'ID3 original audio bytes')

    def tearDown(self):
        self.temp.cleanup()

    def private(self, name, content):
        path = self.root / name
        path.write_bytes(content)
        path.chmod(0o600)
        return path

    def stage(self):
        with patch.object(bridge, 'fetch_snapshot', return_value={'projection': projection()}):
            return bridge.stage(self.config_path, 'thread-selected', self.input, self.audio, True)

    def cfg(self):
        return bridge.load_config(self.config_path)

    def row(self):
        db = bridge.connect_db(self.cfg())
        try:
            return db.execute('SELECT * FROM deliveries').fetchone()
        finally:
            db.close()

    def test_stage_requires_meaningful_confirmation_and_copies_selected_audio_private(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.stage(self.config_path, 'thread-selected', self.input, self.audio, False)
        result = self.stage()
        row = self.row()
        self.assertEqual(row['run_id'], 'run-current')
        self.assertEqual(row['thread_id'], 'thread-selected')
        staged_audio = Path(row['audio_file'])
        self.assertNotEqual(staged_audio, self.audio)
        self.assertEqual(staged_audio.read_bytes(), self.audio.read_bytes())
        self.assertEqual(staged_audio.stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(row['stage_dir']).stat().st_mode & 0o777, 0o700)
        self.assertEqual(result['deliveryId'], row['delivery_id'])

    def test_current_run_uses_unique_maximum_ordinal_on_projected_thread(self):
        p = projection()
        p['runs'].extend([
            {'id': 'old', 'threadId': 'thread-selected', 'ordinal': 7, 'status': 'completed'},
            {'id': 'other-thread', 'threadId': 'another-thread', 'ordinal': 99, 'status': 'running'},
        ])
        self.assertEqual(bridge.current_run(p)['id'], 'run-current')
        p['runs'].append({'id': 'ambiguous', 'threadId': 'thread-selected', 'ordinal': 8, 'status': 'running'})
        self.assertIsNone(bridge.current_run(p))
        p['runs'].pop()
        p['runs'].append({'id': 'run-current', 'threadId': 'thread-selected', 'ordinal': 9, 'status': 'running'})
        self.assertIsNone(bridge.current_run(p))
        p['runs'].pop()
        p['runs'][0]['ordinal'] = '8'
        self.assertIsNone(bridge.current_run(p))

    def test_retrying_stage_is_idempotent_and_authored_revision_reuses_delivery(self):
        first = self.stage()
        second = self.stage()
        self.assertEqual(first['stageId'], second['stageId'])
        self.assertEqual(first['deliveryId'], second['deliveryId'])
        db = bridge.connect_db(self.cfg())
        try:
            self.assertEqual(len(db.execute('SELECT * FROM deliveries').fetchall()), 1)
        finally:
            db.close()
        db = bridge.connect_db(self.cfg())
        try:
            with db:
                db.execute("UPDATE deliveries SET state='delivered',receipt_json=?", (json.dumps({'delivered': True}),))
        finally:
            db.close()
        payload = json.loads(self.input.read_text())
        payload['body'] = 'Edited final markdown answer'
        self.input.write_text(json.dumps(payload))
        self.input.chmod(0o600)
        edited = self.stage()
        row = self.row()
        self.assertTrue(edited['updated'])
        self.assertEqual(edited['stageId'], first['stageId'])
        self.assertEqual(edited['deliveryId'], first['deliveryId'])
        self.assertEqual(json.loads((Path(row['stage_dir']) / 'result.json').read_text())['body'], payload['body'])
        self.assertEqual(row['state'], 'pending')
        self.assertIsNone(row['receipt_json'])
        db = bridge.connect_db(self.cfg())
        try:
            self.assertEqual(len(db.execute('SELECT * FROM deliveries').fetchall()), 1)
        finally:
            db.close()

    def test_no_early_send_from_progress_or_incomplete_projection(self):
        self.stage()
        with patch.object(bridge, 'fetch_snapshot', return_value={'projection': projection('running')}), \
             patch.object(bridge, 'load_sender') as sender:
            counts = bridge.process(self.cfg())
        self.assertEqual(counts, {'delivered': 0, 'pending': 1, 'blocked': 0})
        sender.assert_not_called()
        self.assertEqual(self.row()['state'], 'pending')

    def test_nonstreaming_completed_root_assistant_is_required(self):
        p = projection('completed', completed=True, streaming=True)
        message, reason = bridge.find_final(p, 'run-current')
        self.assertIsNone(message)
        self.assertIn('non-streaming', reason)
        p = projection('completed', completed=True, streaming=False)
        message, reason = bridge.find_final(p, 'run-current')
        self.assertEqual(message['id'], 'message-final')
        self.assertEqual(reason, '')

    def test_failed_and_cancelled_runs_are_blocked_with_diagnostic(self):
        self.stage()
        p = projection('failed')
        with patch.object(bridge, 'fetch_snapshot', return_value={'projection': p}), patch.object(bridge, 'load_sender') as sender:
            counts = bridge.process(self.cfg())
        self.assertEqual(counts['blocked'], 1)
        sender.assert_not_called()
        row = self.row()
        self.assertEqual(row['state'], 'blocked')
        self.assertIn('failed', row['diagnostic'])

    def test_live_child_blocks_until_settled(self):
        p = projection('completed', completed=True, streaming=False, child_status='running')
        _, reason = bridge.find_final(p, 'run-current')
        self.assertEqual(reason, 'live child task remains unsettled')
        p['subagents'][0]['status'] = 'completed'
        self.assertEqual(bridge.find_final(p, 'run-current')[1], '')

    def test_actual_open_cohort_wake_policy_and_acknowledged_delivery(self):
        p = projection('completed', completed=True, streaming=False, child_status='completed')
        p['runs'][0]['delegatedCompletion'] = {'disposition': 'open', 'nextGeneration': 2, 'delivery': None}
        p['subagents'][0]['completionWake'] = 'always'
        p['subagents'][0]['completionDelivery'] = {'state': 'acknowledged', 'observedByRunId': 'run-current'}
        self.assertEqual(bridge.find_final(p, 'run-current')[1], '')
        for state in ['pending', 'claimed']:
            p['subagents'][0]['completionDelivery']['state'] = state
            self.assertEqual(bridge.find_final(p, 'run-current')[1], 'delegated child result has not been incorporated')
        p['subagents'][0]['completionDelivery']['state'] = 'disposed'
        self.assertEqual(bridge.find_final(p, 'run-current')[1], '')
        p['subagents'][0]['completionWake'] = {'state': 'completed'}
        self.assertEqual(bridge.find_final(p, 'run-current')[1], 'delegated child wake policy is unknown')

    def test_actual_cohort_delivery_references_acknowledged_child_tasks(self):
        p = projection('completed', completed=True, streaming=False, child_status='completed')
        p['subagents'][0]['completionDelivery'] = {'state': 'delivered', 'observedByRunId': None}
        p['runs'][0]['delegatedCompletion'] = {'disposition': 'open', 'nextGeneration': 3,
            'delivery': {'generation': 2, 'messageId': 'wake-message', 'taskIds': ['child']}}
        self.assertEqual(bridge.find_final(p, 'run-current')[1], '')
        p['runs'][0]['delegatedCompletion']['delivery']['taskIds'] = ['missing-child']
        self.assertEqual(bridge.find_final(p, 'run-current')[1], 'delegated completion task reference is unknown')

    def test_open_project_plan_is_not_active_execution(self):
        p = projection('completed', completed=True, streaming=False)
        p['nodes'].append({'id': 'ongoing-plan', 'kind': 'todo_list', 'rootNodeId': 'root', 'status': 'running', 'countsForRun': False})
        self.assertEqual(bridge.find_final(p, 'run-current')[1], '')
        p['nodes'].append({'id': 'active-command', 'kind': 'tool_call', 'rootNodeId': 'root', 'status': 'running'})
        self.assertEqual(bridge.find_final(p, 'run-current')[1], 'run still has active execution nodes')

    def test_unknown_child_completion_state_fails_closed(self):
        p = projection('completed', completed=True, streaming=False, child_status='completed')
        p['subagents'][0]['completionDelivery'] = {'futureField': True}
        self.assertEqual(bridge.find_final(p, 'run-current')[1], 'delegated child completion state is unknown')
        p = projection('completed', completed=True, streaming=False)
        p['nodes'].append({'id': 'future-node', 'rootNodeId': 'root', 'status': 'future-state'})
        self.assertEqual(bridge.find_final(p, 'run-current')[1], 'execution node completion state is unknown')

    def test_one_thread_fetch_failure_does_not_stop_other_rows(self):
        self.stage()
        second = projection()
        second['thread']['id'] = 'thread-second'
        second['runs'][0]['threadId'] = 'thread-second'
        with patch.object(bridge, 'fetch_snapshot', return_value={'projection': second}):
            bridge.stage(self.config_path, 'thread-second', self.input, self.audio, True)
        complete_projection = projection('completed', completed=True, streaming=False)
        complete_projection['thread']['id'] = 'thread-second'
        complete_projection['runs'][0]['threadId'] = 'thread-second'
        complete = {'projection': complete_projection}
        with patch.object(bridge, 'fetch_snapshot', side_effect=[bridge.BridgeError('private remote content'), complete]), \
             patch.object(bridge, 'load_sender', return_value=type('Sender', (), {'deliver': lambda *args: {'delivered': True}})()):
            counts = bridge.process(self.cfg(), force=True)
        self.assertEqual(counts['pending'], 1)
        self.assertEqual(counts['delivered'], 1)
        db = bridge.connect_db(self.cfg())
        try:
            diagnostics = [row['diagnostic'] for row in db.execute('SELECT diagnostic FROM deliveries ORDER BY created_at')]
        finally:
            db.close()
        self.assertEqual(diagnostics[0], 'BridgeError')
        self.assertIsNone(diagnostics[1])

    def test_uncertain_delivery_retries_same_id_and_acknowledges_after_receipt(self):
        self.stage()
        successful = {'delivered': True, 'itemId': 'inbox-item', 'created': True}
        class Sender:
            calls = []
            def deliver(self, config, input_path, audio_path=None):
                metadata = json.loads(Path(input_path).read_text())
                self.calls.append(metadata['deliveryId'])
                if len(self.calls) == 1:
                    raise TimeoutError('response may have been lost')
                return successful
        sender = Sender()
        final = {'projection': projection('completed', completed=True, streaming=False)}
        with patch.object(bridge, 'fetch_snapshot', return_value=final), patch.object(bridge, 'load_sender', return_value=sender):
            first = bridge.process(self.cfg())
            row_after_first = self.row()
            self.assertEqual(row_after_first['state'], 'pending')
            self.assertTrue(row_after_first['next_attempt'] > time.time())
            second = bridge.process(self.cfg(), force=True)
        self.assertEqual(first['pending'], 1)
        self.assertEqual(second['delivered'], 1)
        self.assertEqual(sender.calls[0], sender.calls[1])
        self.assertEqual(self.row()['receipt_json'], json.dumps(successful, separators=(',', ':')))

    def test_audio_rejects_paths_outside_allowlist_and_symlinks(self):
        outside = self.root / 'outside.mp3'
        outside.write_bytes(b'ID3outside')
        with self.assertRaises(bridge.BridgeError):
            bridge.validate_audio(outside, [self.audio_root])
        link = self.audio_root / 'linked.mp3'
        link.symlink_to(self.audio)
        with self.assertRaises(bridge.BridgeError):
            bridge.validate_audio(link, [self.audio_root])

    def test_http_origin_must_be_loopback_and_redirects_are_refused(self):
        config = json.loads(self.config_path.read_text())
        config['t3Origin'] = 'http://example.test'
        self.config_path.write_text(json.dumps(config))
        with self.assertRaises(bridge.BridgeError):
            bridge.load_config(self.config_path)
        self.config_path.write_text(json.dumps({**config, 't3Origin': 'http://localhost:3773'}))
        handler = bridge.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 307, 'redirect', {}, 'https://other.example.test'))


if __name__ == '__main__':
    unittest.main()
