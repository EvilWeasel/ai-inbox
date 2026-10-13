#!/usr/bin/env python3
"""Single-consumer Gemini/Kore worker for explicitly requested Inbox audio.

Configuration and credentials stay outside the checkout. A paid call is claimed
durably before sending; ambiguous failures require review and are never retried.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

MODEL = 'google/gemini-3.8-flash-tts'
VOICE = 'Kore'
MAX_CHUNK = 1800


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def spoken_version(title, body, kind='result'):
    """Preserve prose and conclusions; move visual/code details out of speech."""
    body = re.sub(r'<oai-mem-citation>.*?</oai-mem-citation>', '', body, flags=re.S)
    body = re.sub(r'```[^\n]*\n.*?```', '\nDen zugehörigen Code findest du in der schriftlichen Fassung.\n', body, flags=re.S)
    body = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', body)
    body = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', body)
    body = re.sub(r'https?://\S+', '', body)
    body = re.sub(r'<[^>]+>', '', body)
    body = html.unescape(body)
    body = re.sub(r'\[(?:sigh|sighing|laugh|laughing|chuckle|whisper|whispering|pause|short pause|seufzen|lachen|flüstern)\]', '', body, flags=re.I)
    lines = []
    table_headers = None
    for line in body.splitlines():
        line = line.strip()
        if re.match(r'^\|?[\s:|-]+\|[\s:|-]*$', line):
            continue
        if line.startswith('|') and line.endswith('|'):
            cells = [cell.strip() for cell in line.strip('|').split('|')]
            if table_headers is None:
                table_headers = cells
                continue
            line = '. '.join(f'{table_headers[i]}: {cell}' if i < len(table_headers) else cell
                             for i, cell in enumerate(cells) if cell)
        else:
            table_headers = None
        heading = bool(re.match(r'^#{1,6}\s+', line))
        line = re.sub(r'^#{1,6}\s+', '', line)
        line = re.sub(r'^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)', '', line)
        line = re.sub(r'\[([ xX])\]\s*', '', line)
        line = line.replace('**', '').replace('__', '').replace('`', '')
        line = re.sub(r'(?<!\w)\*(.*?)\*(?!\w)', r'\1', line)
        if heading and line and line[-1] not in '.?!:':
            line += '.'
        if line:
            lines.append(line)
        elif lines and lines[-1]:
            lines.append('')
    text = '\n'.join(lines).strip()
    intro = re.sub(r'[#*`]', '', title).strip()
    if intro and not text.startswith(intro):
        text = intro.rstrip('.!?') + '.\n\n' + text
    if not text:
        raise ValueError('empty_spoken_text')
    style = ('warm, clear and conversational; thoughtful, restrained emphasis for research conclusions; '
             'calm and precise for technical findings, uncertainties and costs')
    if any(word in (title + ' ' + body[:800]).lower() for word in ('comedy', 'satire', 'witz')):
        style = 'warm and conversational, understated dry humor; short natural pauses before punchlines, no forced laughter'
    instructions = (f'Read the input verbatim in its original language. Voice: a natural adult female speaker. Delivery: {style}. '
                    'Speak at a comfortable normal pace. Use natural sentence and paragraph pauses, gentle emphasis on important '
                    'results, and empathetic but restrained tone where appropriate. Keep factual caveats audible. Do not add facts, '
                    'greetings, commentary, laughter, or sound effects. Do not read these instructions aloud. '
                    'Do not rush the ending; read every sentence to completion. This is a continuous report, not an advertisement.')
    return text, instructions


def split_text(text, limit=MAX_CHUNK):
    chunks, current = [], ''
    # Sentence boundaries retain punctuation. Very long sentences split at words.
    units = re.split(r'(?<=[.!?])\s+|\n\n+', text)
    for unit in units:
        for word in unit.split():
            if len(word) > limit:
                raise ValueError('unreadable_long_token')
            if current and len(current) + len(word) + 1 > limit:
                chunks.append(current)
                current = ''
            current += (' ' if current else '') + word
        # Prefer sentence boundaries for natural joins without tiny chunks.
        if len(current) > limit * .65:
            chunks.append(current)
            current = ''
        elif current:
            current += '\n'
    if current.strip():
        chunks.append(current.strip())
    return chunks


class Worker:
    def __init__(self, config):
        self.config = config
        self.data = Path(config['dataDir'])
        self.state = Path(config['stateDir'])
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        for directory in (self.data, self.state):
            info = directory.stat()
            if directory.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError('worker_directory_not_private')
        if not math.isfinite(config.get('dailyBudgetUsd', 5)) or not 0 < config.get('dailyBudgetUsd', 5) <= 100:
            raise ValueError('invalid_audio_budget')
        self.key = os.environ.get('OPENROUTER_API_KEY')

    @contextmanager
    def database(self):
        with open(self.config['deployLockPath'], 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            db = sqlite3.connect(self.data / 'inbox.sqlite', timeout=30)
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            try:
                with db:
                    yield db
            finally:
                db.close()

    def mark(self, job_id, state, error=None):
        with self.database() as db:
            db.execute("UPDATE item_audio_jobs SET state=?,safe_error_code=?,updated_at=? WHERE id=? AND state='generating'",
                       (state, error, now(), job_id))

    def claim(self):
        with self.database() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT j.*,i.title,i.body,i.kind,i.audio_file FROM item_audio_jobs j JOIN items i ON i.id=j.item_id WHERE j.state='queued' ORDER BY j.created_at,j.id LIMIT 1").fetchone()
            if not row:
                return None
            row = dict(row)
            if row['audio_file'] or digest(row['body']) != row['body_sha256']:
                db.execute("UPDATE item_audio_jobs SET state='superseded',updated_at=? WHERE id=?", (now(), row['id']))
                return None
            text, instructions = spoken_version(row['title'], row['body'], row['kind'])
            db.execute("UPDATE item_audio_jobs SET state='generating',spoken_text=?,instructions=?,updated_at=? WHERE id=? AND state='queued'",
                       (text, instructions, now(), row['id']))
            row.update(spoken_text=text, instructions=instructions)
            return row

    def live(self, row):
        with self.database() as db:
            current = db.execute('SELECT j.state,i.body,i.audio_file FROM item_audio_jobs j JOIN items i ON i.id=j.item_id WHERE j.id=?', (row['id'],)).fetchone()
            return bool(current and current['state'] == 'generating' and not current['audio_file']
                        and digest(current['body']) == row['body_sha256'])

    def daily_spend(self):
        total = 0
        today = now()[:10]
        for path in self.state.glob('*/*.receipt.json'):
            try:
                receipt = json.loads(path.read_text())
                value = receipt.get('costUsd') if receipt.get('costUsd') is not None else receipt['reserveUsd']
                if not math.isfinite(value) or value < 0:
                    raise ValueError('invalid_cost')
                if receipt.get('startedAt', '').startswith(today):
                    total += value
            except (ValueError, TypeError, KeyError, OSError):
                raise ValueError('audio_cost_receipt_requires_review') from None
        return total

    def reconcile_costs(self):
        """Provider usage can appear after audio is ready; reads never synthesize."""
        if not self.key:
            return
        folders = set()
        for path in self.state.glob('*/*.receipt.json'):
            try:
                receipt = json.loads(path.read_text())
            except (ValueError, OSError):
                continue
            if receipt.get('state') != 'complete' or receipt.get('costUsd') is not None or not receipt.get('generationId'):
                continue
            try:
                age = time.time() - datetime.fromisoformat(receipt['startedAt']).timestamp()
                if age < 15:
                    continue
                query = urllib.request.Request('https://openrouter.ai/api/v1/generation?' + urllib.parse.urlencode({'id': receipt['generationId']}),
                                               headers={'Authorization': 'Bearer ' + self.key})
                with urllib.request.urlopen(query, timeout=15) as response:
                    cost = float(json.load(response)['data']['total_cost'])
                if not math.isfinite(cost) or cost < 0:
                    continue
                receipt['costUsd'] = cost
                atomic_json(path, receipt)
                folders.add(path.parent)
            except Exception:
                continue
        for folder in folders:
            final = folder / 'final.json'
            if not final.exists():
                continue
            receipt = json.loads(final.read_text())
            parts = [json.loads((folder / f'{i:04}.receipt.json').read_text()) for i in range(receipt['parts'])]
            if any(part.get('costUsd') is None for part in parts):
                continue
            receipt['costUsd'] = sum(part['costUsd'] for part in parts)
            atomic_json(final, receipt)
            with self.database() as db:
                db.execute("UPDATE item_audio_jobs SET cost_usd=? WHERE id=? AND state='ready'", (receipt['costUsd'], folder.name))

    def render(self, text, instructions, folder, index):
        payload = {'model': MODEL, 'voice': VOICE, 'input': text, 'instructions': instructions, 'response_format': 'pcm'}
        request_hash = digest(json.dumps(payload, sort_keys=True))
        receipt_path = folder / f'{index:04}.receipt.json'
        pcm = folder / f'{index:04}.pcm'
        if receipt_path.exists():
            prior = json.loads(receipt_path.read_text())
            if (prior.get('state') == 'complete' and prior.get('requestSha256') == request_hash
                    and pcm.exists() and digest(pcm.read_bytes()) == prior['sha256']):
                return pcm, prior
            raise ValueError('previous_paid_attempt_requires_review')
        if not self.key or self.key.startswith('pass://'):
            raise ValueError('provider_key_unavailable')
        reserve = max(.04, len(text.encode()) / 866 * .01488 * 1.6)
        if self.daily_spend() + reserve > self.config.get('dailyBudgetUsd', 5):
            raise ValueError('daily_audio_budget_reached')
        receipt = {'state': 'started', 'startedAt': now(), 'requestSha256': request_hash, 'reserveUsd': reserve}
        atomic_json(receipt_path, receipt)
        request = urllib.request.Request('https://openrouter.ai/api/v1/audio/speech', data=json.dumps(payload).encode(),
                                        headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=240) as response:
                raw = response.read(32 * 1024 * 1024 + 1)
                content_type = response.headers.get('Content-Type', '')
                generation = response.headers.get('X-Generation-Id')
            if not content_type.startswith('audio/') or not 1000 < len(raw) <= 32 * 1024 * 1024:
                raise ValueError('invalid_provider_audio')
            if raw[:4] == b'RIFF':
                wav = folder / f'{index:04}.wav'
                wav.write_bytes(raw)
                wav.chmod(0o600)
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav), '-ar', '24000', '-ac', '1', '-f', 's16le', str(pcm)], check=True, capture_output=True)
                raw = pcm.read_bytes()
            elif content_type.split(';')[0].lower() in {'audio/pcm', 'audio/x-pcm', 'audio/raw'}:
                pcm.write_bytes(raw)
            else:
                raise ValueError('unexpected_audio_format')
            pcm.chmod(0o600)
            seconds = len(raw) / 48000
            if len(raw) % 2 or seconds < max(1, len(text.split()) * .16) or seconds > 900:
                raise ValueError('audio_length_requires_review')
            cost = None
            if generation:
                query = urllib.request.Request('https://openrouter.ai/api/v1/generation?' + urllib.parse.urlencode({'id': generation}),
                                               headers={'Authorization': 'Bearer ' + self.key})
                for _ in range(3):
                    try:
                        with urllib.request.urlopen(query, timeout=20) as response:
                            value = float(json.load(response)['data']['total_cost'])
                            if not math.isfinite(value) or value < 0:
                                raise ValueError('invalid_provider_cost')
                            cost = value
                        break
                    except Exception:
                        time.sleep(1)
            receipt.update(state='complete', generationId=generation, costUsd=cost, seconds=seconds, sha256=digest(raw))
            atomic_json(receipt_path, receipt)
            return pcm, receipt
        except Exception as error:
            receipt.update(state='needs_review', errorType=type(error).__name__)
            if isinstance(error, urllib.error.HTTPError):
                receipt['httpStatus'] = error.code
            atomic_json(receipt_path, receipt)
            raise ValueError('provider_attempt_requires_review') from None

    def attach(self, row, output, duration, cost):
        media = self.data / 'media'
        media.mkdir(mode=0o700, exist_ok=True)
        raw = output.read_bytes()
        checksum = digest(raw)
        name = checksum + '.mp3'
        with self.database() as db:
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT j.state,i.body,i.audio_file FROM item_audio_jobs j JOIN items i ON i.id=j.item_id WHERE j.id=?', (row['id'],)).fetchone()
            if not current or current['state'] != 'generating' or current['audio_file'] or digest(current['body']) != row['body_sha256']:
                db.execute("UPDATE item_audio_jobs SET state='superseded',updated_at=? WHERE id=? AND state='generating'", (now(), row['id']))
                return False
            target = media / name
            if target.exists():
                if target.is_symlink() or digest(target.read_bytes()) != checksum:
                    raise ValueError('media_conflict')
            else:
                temp = media / ('.demand-' + row['id'] + '.tmp')
                with open(temp, 'wb') as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                temp.chmod(0o600)
                os.replace(temp, target)
            db.execute('UPDATE items SET audio_file=?,audio_duration=? WHERE id=? AND audio_file IS NULL', (name, duration, row['item_id']))
            db.execute("UPDATE item_audio_jobs SET state='ready',media_sha256=?,duration=?,cost_usd=?,safe_error_code=NULL,updated_at=? WHERE id=? AND state='generating'",
                       (checksum, duration, cost, now(), row['id']))
            return True

    def process(self, row):
        folder = self.state / row['id']
        folder.mkdir(mode=0o700, exist_ok=True)
        atomic_json(folder / 'script.json', {'spokenText': row['spoken_text'], 'instructions': row['instructions'], 'model': MODEL, 'voice': VOICE})
        parts, receipts = [], []
        for index, text in enumerate(split_text(row['spoken_text'])):
            if not self.live(row):
                return False
            part, receipt = self.render(text, row['instructions'], folder, index)
            parts.append(part)
            receipts.append(receipt)
        joined = folder / 'joined.pcm'
        with open(joined, 'wb') as stream:
            for index, part in enumerate(parts):
                if index:
                    stream.write(b'\0' * 16800)  # 350 ms natural boundary pause.
                stream.write(part.read_bytes())
        joined.chmod(0o600)
        output = folder / 'final.mp3'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', str(joined), '-codec:a', 'libmp3lame', '-b:a', '96k', str(output)], check=True, capture_output=True)
        output.chmod(0o600)
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], check=True, capture_output=True)
        duration = float(json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(output)]))['format']['duration'])
        costs = [receipt['costUsd'] for receipt in receipts]
        cost = sum(costs) if all(value is not None for value in costs) else None
        atomic_json(folder / 'final.json', {'sha256': digest(output.read_bytes()), 'duration': duration, 'costUsd': cost, 'parts': len(parts)})
        return self.attach(row, output, duration, cost)

    def recover(self):
        # After obtaining the consumer lock, prior generating claims cannot be
        # active elsewhere. Reconcile durable finished audio without another call.
        with self.database() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM item_audio_jobs WHERE state='generating'")]
        for row in rows:
            folder = self.state / row['id']
            final = folder / 'final.json'
            output = folder / 'final.mp3'
            try:
                if final.exists() and output.exists():
                    receipt = json.loads(final.read_text())
                    if (digest(output.read_bytes()) == receipt['sha256']
                            and math.isfinite(receipt['duration']) and 0 < receipt['duration'] < 86400
                            and (receipt['costUsd'] is None or (math.isfinite(receipt['costUsd']) and receipt['costUsd'] >= 0))):
                        self.attach(row, output, receipt['duration'], receipt['costUsd'])
                        continue
                # A stopped consumer can safely continue between paid calls,
                # reusing only verified completed parts. Started/unknown parts
                # still fail closed; render also checks the exact request hash.
                prior = [json.loads(path.read_text()) for path in folder.glob('*.receipt.json')]
                if prior and all(part.get('state') == 'complete' for part in prior):
                    self.process(row)
                    continue
            except (OSError, ValueError, KeyError, TypeError):
                pass
            self.mark(row['id'], 'needs_review', 'worker_interrupted')

    def once(self):
        self.reconcile_costs()
        try:
            self.daily_spend()
        except ValueError:
            if not getattr(self, '_budget_block_reported', False):
                print(json.dumps({'state': 'needs_review', 'code': 'audio_cost_receipt_requires_review'}), flush=True)
                self._budget_block_reported = True
            return False
        self._budget_block_reported = False
        row = self.claim()
        if not row:
            return False
        try:
            attached = self.process(row)
            print(json.dumps({'jobId': row['id'], 'ready': attached}), flush=True)
        except Exception as error:
            code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z_]{1,63}', str(error)) else 'audio_worker_failed'
            self.mark(row['id'], 'needs_review', code)
            print(json.dumps({'jobId': row['id'], 'state': 'needs_review', 'code': code}), flush=True)
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--loop', action='store_true')
    parser.add_argument('--reconcile-costs-only', action='store_true')
    args = parser.parse_args()
    if args.config.is_symlink() or args.config.stat().st_mode & 0o077:
        raise SystemExit('Worker configuration must be private')
    config = json.loads(args.config.read_text())
    worker = Worker(config)
    if args.reconcile_costs_only:
        worker.reconcile_costs()
        return
    with open(worker.state / 'consumer.lock', 'a') as lock:
        os.chmod(worker.state / 'consumer.lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        worker.recover()
        while True:
            worked = worker.once()
            if not args.loop:
                break
            if not worked:
                time.sleep(2)


if __name__ == '__main__':
    main()
