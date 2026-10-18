"""Bind explicit Rodin task keys to a scene input; never guesses by filename order."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3


def bind(source, destination, database):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    scene = json.loads(source.read_text(encoding='utf-8-sig'))
    scene['template'] = str((source.parent/scene['template']).resolve())
    with closing(sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        for item in scene['objects']:
            key = item.get('rodinJobKey')
            if key:
                job = db.execute('SELECT * FROM jobs WHERE key=?',(key,)).fetchone()
                if not job or job['object_id'] != item['id']:
                    raise ValueError('Task/object mismatch: '+item['id'])
                if job['state'] != 'DOWNLOADED' or not job['asset_path'] or not Path(job['asset_path']).is_file():
                    raise ValueError('Task asset not downloaded: '+item['id'])
                item.update(asset=job['asset_path'], origin='generated', allowProxy=False)
            elif item.get('asset'):
                item['asset'] = str((source.parent/item['asset']).resolve())
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(scene,ensure_ascii=False,indent=2),encoding='utf-8')
    return destination


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source'); p.add_argument('destination'); p.add_argument('--db',default='data/jobs.sqlite3')
    a = p.parse_args()
    print(bind(a.source,a.destination,a.db))
