import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('producer_delivery', Path(__file__).parents[2] / 'scripts' / 'deliver-result.py')
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)

class Response:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return b'{"item":{"id":"received-item"},"created":true}'

class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.token = self.root / 'token'
        self.token.write_text('test-only-credential')
        self.token.chmod(0o600)
        self.config = self.root / 'config.json'
        self.config.write_text(json.dumps({'endpoint':'https://inbox.example.test/api/results','host':'test-host','tokenFile':str(self.token)}))
        self.config.chmod(0o600)
        self.input = self.root / 'result.json'
        self.input.write_text(json.dumps({'deliveryId':'stable-result','title':'Completed result','body':'Actual completed outcome','origin':{'project':'Test'}}))
    def tearDown(self): self.temp.cleanup()
    def test_final_text_and_receipt_do_not_expose_content_or_credential(self):
        with patch.object(producer.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = Response()
            receipt = producer.deliver(self.config,self.input)
            request = opener.return_value.open.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual(payload['phase'],'final')
        self.assertEqual(payload['origin']['host'],'test-host')
        self.assertEqual(receipt,{'delivered':True,'itemId':'received-item','created':True})
        self.assertNotIn('credential',json.dumps(receipt))
        self.assertNotIn('Actual completed',json.dumps(receipt))
    def test_intermediate_and_mismatched_origin_never_reach_network(self):
        for metadata in [{'deliveryId':'id','phase':'progress'}, {'deliveryId':'id','origin':{'host':'another-host'}}]:
            self.input.write_text(json.dumps(metadata))
            with patch.object(producer.urllib.request,'build_opener') as opener:
                with self.assertRaises(ValueError): producer.deliver(self.config,self.input)
                opener.assert_not_called()
    def test_public_or_symlinked_token_and_insecure_endpoint_rejected(self):
        self.token.chmod(0o644)
        with self.assertRaises(ValueError): producer.deliver(self.config,self.input)
        self.token.chmod(0o600)
        link = self.root/'linked-token';link.symlink_to(self.token)
        cfg=json.loads(self.config.read_text());cfg['tokenFile']=str(link);self.config.write_text(json.dumps(cfg))
        with self.assertRaises(ValueError): producer.deliver(self.config,self.input)
        cfg['endpoint']='http://inbox.example.test/api/results';self.config.write_text(json.dumps(cfg))
        with self.assertRaises(ValueError): producer.deliver(self.config,self.input)
    def test_audio_upload_keeps_stable_id_and_redacts_local_filename(self):
        audio=self.root/'private-recording-name.mp3';audio.write_bytes(b'ID3test-only')
        with patch.object(producer.urllib.request,'build_opener') as opener:
            opener.return_value.open.return_value=Response()
            producer.deliver(self.config,self.input,audio)
            request=opener.return_value.open.call_args.args[0]
        self.assertIn(b'stable-result',request.data)
        self.assertIn(b'filename="recording.mp3"',request.data)
        self.assertNotIn(str(audio).encode(),request.data)
        self.assertIn(b'ID3test-only',request.data)
    def test_redirect_handler_refuses_token_forwarding(self):
        with patch.object(producer.urllib.request,'build_opener') as opener:
            opener.return_value.open.return_value=Response()
            producer.deliver(self.config,self.input)
            handler=opener.call_args.args[0]
        self.assertIsNone(handler.redirect_request(None,None,307,'redirect',{},'https://other.example.test/api/results'))

if __name__=='__main__': unittest.main()
