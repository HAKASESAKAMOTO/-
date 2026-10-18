"""Explicit submit/status/download commands. No automatic paid resubmission."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
import time
import urllib.request
import uuid

BASE = 'https://api.hyper3d.com/api/v2'
PARAMS = {'tier': 'Gen-2', 'mesh_mode': 'Raw', 'quality': 'medium'}


def api_key():
    config = Path(__file__).resolve().parents[4] / '.local' / 'api-keys.json'
    config.parent.mkdir(parents=True, exist_ok=True)
    try:
        with config.open('x', encoding='utf-8') as stream:
            json.dump(dict.fromkeys(('DEEPSEEK_API_KEY', 'RODIN_API_KEY', 'QWEN_API_KEY'), ''), stream)
    except FileExistsError:
        pass
    try:
        value = json.loads(config.read_text(encoding='utf-8-sig'))['RODIN_API_KEY']
    except (ValueError, KeyError, TypeError):
        raise ValueError('Invalid .local/api-keys.json; check the local API settings') from None
    if not isinstance(value, str) or not value or len(value) > 4096 or any(c.isspace() for c in value):
        raise ValueError('Configure RODIN_API_KEY in api-keys.html')
    return value


def database(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, object_id TEXT, input_hash TEXT, state TEXT, task_uuid TEXT, subscription_key TEXT, asset_path TEXT)')
    return db


def request(endpoint, payload, content_type='application/json'):
    key = api_key()
    if isinstance(payload, dict):
        payload = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + endpoint, data=payload, headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': content_type})
    with urllib.request.urlopen(req, timeout=90) as response:
        result = json.load(response)
    if result.get('error'):
        raise RuntimeError('Provider error: ' + str(result['error']))
    return result


def submit(db, object_id, image, version, session):
    content = Path(image).read_bytes()
    if not content.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Use a PNG crop produced by prepare_photo.py')
    digest = hashlib.sha256(content).hexdigest()
    task_key = hashlib.sha256(json.dumps([session, object_id, version, digest, PARAMS], sort_keys=True).encode()).hexdigest()
    row = db.execute('SELECT * FROM jobs WHERE key=?', (task_key,)).fetchone()
    if row:
        return dict(row)
    api_key()  # Validate credentials before recording a potentially paid submission.
    boundary = '----life-' + uuid.uuid4().hex
    parts = []
    for name, value in PARAMS.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="images"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + content + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    # Commit BEFORE network I/O. A crash or ambiguous response must never trigger a second charge.
    db.execute('INSERT INTO jobs(key,object_id,input_hash,state) VALUES(?,?,?,?)',
               (task_key, object_id, digest, 'UNKNOWN_SUBMISSION'))
    db.commit()
    response = request('/rodin', b''.join(parts), 'multipart/form-data; boundary=' + boundary)
    task_id = response.get('uuid')
    subscription = response.get('jobs', {}).get('subscription_key')
    if not task_id or not subscription:
        raise RuntimeError('Ambiguous submission: inspect provider dashboard; do not resubmit')
    db.execute('UPDATE jobs SET state=?,task_uuid=?,subscription_key=? WHERE key=?',
               ('SUBMITTED', task_id, subscription, task_key))
    db.commit()
    return dict(db.execute('SELECT * FROM jobs WHERE key=?', (task_key,)).fetchone())


def status(db, key):
    row = db.execute('SELECT * FROM jobs WHERE key=?', (key,)).fetchone()
    if not row or not row['subscription_key']:
        raise ValueError('Unknown/unconfirmed submission; manually reconcile in provider dashboard')
    if row['state'] == 'DOWNLOADED':
        return dict(row)
    result = request('/status', {'subscription_key': row['subscription_key']})
    states = [job['status'] for job in result.get('jobs', [])]
    state = 'FAILED' if 'Failed' in states else 'GENERATED' if states and all(s == 'Done' for s in states) else 'RUNNING'
    db.execute('UPDATE jobs SET state=? WHERE key=?', (state, key)); db.commit()
    return dict(db.execute('SELECT * FROM jobs WHERE key=?', (key,)).fetchone())


def download(db, key, directory):
    row = status(db, key)
    if row['state'] == 'DOWNLOADED':
        if not Path(row['asset_path']).is_file():
            raise ValueError('Local asset missing; reconcile before downloading again')
        return row
    if row['state'] != 'GENERATED':
        raise ValueError('All provider jobs must be Done before download')
    result = request('/download', {'task_uuid': row['task_uuid']})
    entries = [f for f in result.get('list', []) if f.get('name', '').lower().endswith('.glb')]
    if not entries:
        raise ValueError('Provider returned no GLB; inspect results or use manual GLB import')
    url = entries[0]['url']
    if not url.startswith('https://'):
        raise ValueError('Expected HTTPS download')
    destination = Path(directory).resolve() / (key + '.glb')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_suffix('.part')
    with urllib.request.urlopen(url, timeout=120) as response, temp.open('wb') as out:
        size = 0
        while chunk := response.read(1024*1024):
            size += len(chunk)
            if size > 100*1024*1024:
                raise ValueError('Asset exceeds 100 MB input limit')
            out.write(chunk)
    with temp.open('rb') as f:
        header = f.read(12)
    if len(header) != 12 or struct.unpack('<4sII', header) != (b'glTF', 2, size):
        raise ValueError('Invalid GLB header/length')
    temp.replace(destination)
    # Downloaded is NOT geometry-validated. Blender import is the next stage.
    db.execute('UPDATE jobs SET state=?,asset_path=? WHERE key=?', ('DOWNLOADED', str(destination), key))
    db.commit()
    return {'key': key, 'state': 'DOWNLOADED', 'path': str(destination)}


def wait_and_download(db, key, directory, seconds):
    deadline = time.monotonic() + seconds
    delay = 5
    while time.monotonic() < deadline:
        row = status(db, key)
        if row['state'] in ('GENERATED', 'DOWNLOADED'):
            return download(db, key, directory)
        if row['state'] == 'FAILED':
            raise RuntimeError('Provider job failed; no new paid submission created')
        time.sleep(min(delay, max(0, deadline-time.monotonic())))
        delay = min(30, delay*1.5)
    return {'key': key, 'state': 'WAITING_IN_BACKGROUND', 'note': 'Provider task retained; use resume later'}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', default='data/jobs.sqlite3')
    sub = p.add_subparsers(dest='command', required=True)
    s = sub.add_parser('submit'); s.add_argument('--object-id', required=True)
    s.add_argument('--image', required=True); s.add_argument('--version', required=True)
    s.add_argument('--session', required=True)
    s.add_argument('--wait', type=int, default=0, help='Seconds to poll and automatically download; 0 submits only')
    s.add_argument('--out', default='data/assets')
    s = sub.add_parser('status'); s.add_argument('key')
    s = sub.add_parser('download'); s.add_argument('key'); s.add_argument('--out', default='data/assets')
    s = sub.add_parser('resume'); s.add_argument('key'); s.add_argument('--out', default='data/assets')
    s.add_argument('--wait', type=int, default=600)
    s = sub.add_parser('reconcile', help='Attach IDs verified manually in provider dashboard; does not submit')
    s.add_argument('key'); s.add_argument('--task-uuid', required=True); s.add_argument('--subscription-key', required=True)
    a = p.parse_args()
    with database(a.db) as db:
        if a.command == 'submit':
            result = submit(db, a.object_id, a.image, a.version, a.session)
            if a.wait:
                result = wait_and_download(db, result['key'], a.out, a.wait)
        elif a.command == 'status':
            result = status(db, a.key)
        elif a.command == 'resume':
            result = wait_and_download(db, a.key, a.out, a.wait)
        elif a.command == 'reconcile':
            changed = db.execute('UPDATE jobs SET task_uuid=?,subscription_key=?,state=? WHERE key=? AND state=?',
                                (a.task_uuid,a.subscription_key,'SUBMITTED',a.key,'UNKNOWN_SUBMISSION'))
            if changed.rowcount != 1:
                raise ValueError('Reconcile only supports an existing UNKNOWN_SUBMISSION record')
            db.commit()
            result = {'key':a.key,'state':'SUBMITTED'}
        else:
            result = download(db, a.key, a.out)
    # subscription_key is operational state, not console output.
    result.pop('subscription_key', None)
    print(json.dumps(result, ensure_ascii=False, indent=2))
