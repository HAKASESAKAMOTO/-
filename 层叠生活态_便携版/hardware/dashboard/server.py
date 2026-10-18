"""Local-only read-only UART bridge for the GPIO HTML dashboard."""
import json
import threading
import time
import math
import argparse
import socket
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import serial
from serial.tools import list_ports
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from angle_decoder import AngleDecoder

ROOT = Path(__file__).resolve().parent
LOCK = threading.Lock()
CHANGED = threading.Condition(LOCK)
STATE = dict(service='layered-life-serial', connected=False, port=None, latest=None, received=None, error='等待设备连接')
HISTORY = deque(maxlen=600)
FW = 'S3_GPIO45_INPUT_V2'
CONTROL = dict(enabled=True, selected='auto', generation=0)
ANGLE = AngleDecoder()
SETTINGS = ROOT / 'angle_settings.json'
if SETTINGS.exists():
    saved = json.loads(SETTINGS.read_text(encoding='utf-8'))
    if not (type(saved.get('steps_per_turn')) in (int,float) and math.isfinite(saved['steps_per_turn']) and 0<saved['steps_per_turn']<=1000000 and saved.get('sign') in (-1,1) and saved.get('transitions') in (2,4)):
        raise ValueError('Invalid angle_settings.json')
    ANGLE.steps_per_turn=saved['steps_per_turn']
    ANGLE.sign=saved['sign']
    ANGLE.transitions=saved['transitions']

def reader():
    logfile = ROOT / ('uart_' + datetime.now().strftime('%Y%m%d_%H%M%S') + '.jsonl')
    with logfile.open('a', encoding='utf-8', buffering=1) as log:
        while True:
            with LOCK:
                control = dict(CONTROL)
            if not control['enabled']:
                time.sleep(0.1)
                continue
            available = list(list_ports.comports())
            if control['selected'] == 'auto':
                preferred = [p.device for p in available if p.vid in (0x1A86, 0x10C4, 0x303A, 0x0403)]
                ports = preferred if preferred else [p.device for p in available if p.vid is not None]
            else:
                ports = [p.device for p in available if p.device == control['selected']]
            if len(ports) != 1:
                with LOCK:
                    STATE.update(connected=False, port=None, latest=None, received=None, error='检测到多个设备，请选择 COM 端口' if len(ports)>1 else '等待设备连接')
                    HISTORY.clear()
                time.sleep(0.4)
                continue
            s = serial.Serial(port=None, baudrate=115200, timeout=0.3)
            s.port = ports[0]
            s.dtr = s.rts = False
            try:
                s.open()
                with LOCK:
                    STATE.update(connected=True, port=s.port, latest=None, received=None, error='等待纯输入固件数据')
                    HISTORY.clear()
                    ANGLE.reset()
                while True:
                    with LOCK:
                        if CONTROL['generation'] != control['generation']:
                            break
                    raw = s.readline(16384)
                    with LOCK:
                        if CONTROL['generation'] != control['generation']:
                            break
                    if not raw:
                        continue
                    try:
                        data = json.loads(raw)
                        valid = (data.get('fw') in (FW, 'S3_GPIO45_EVENTS_V3', 'S3_GPIO45_RAW_TIME_V4') and data.get('mode') == 'INPUT_NO_PULL'
                                 and all(type(data.get(k)) is int and data[k] in (0, 1) for k in ('gpio4', 'gpio5'))
                                 and all(type(data.get(k)) is int and data[k] >= 0 for k in ('ms', 'edges4', 'edges5')))
                        if not valid:
                            raise ValueError('unsupported packet')
                        if data['fw'] in ('S3_GPIO45_EVENTS_V3','S3_GPIO45_RAW_TIME_V4'):
                            timed=data['fw']=='S3_GPIO45_RAW_TIME_V4'
                            if timed and not (type(data.get('boot_id')) is int and data['boot_id']>=0):
                                raise ValueError('Invalid boot ID')
                            if not (all(type(data.get(k)) is int and data[k]>=0 for k in ('seq','lost','start'))
                                    and data['start'] in range(4) and isinstance(data.get('events'),list)
                                    and len(data['events'])<=255):
                                raise ValueError('Invalid event packet')
                            if timed:
                                if not all(isinstance(x,list) and len(x)==2 and type(x[0]) is int and x[0]>=0 and type(x[1]) is int and x[1] in range(4) for x in data['events']):
                                    raise ValueError('Invalid timed event')
                                if any(a[0]>b[0] for a,b in zip(data['events'],data['events'][1:])):
                                    raise ValueError('Timestamp order invalid')
                            elif not all(type(x) is int and x in range(4) for x in data['events']):
                                raise ValueError('Invalid event')
                    except (ValueError, AttributeError, UnicodeDecodeError):
                        text = raw.decode('utf-8', errors='replace').strip()
                        log.write(json.dumps(dict(received=time.time(), raw=text), ensure_ascii=False) + '\n')
                        with LOCK:
                            STATE['error'] = '等待纯输入固件数据；串口输出：' + text[:180]
                        continue
                    now = time.time()
                    entry = dict(data, received=now)
                    with LOCK:
                        if STATE['latest'] and data['ms'] < STATE['latest']['ms']:
                            HISTORY.clear()
                            ANGLE.reset()
                        if data['fw'] in ('S3_GPIO45_EVENTS_V3','S3_GPIO45_RAW_TIME_V4'):
                            ANGLE.packet(data)
                            entry['angle'] = ANGLE.snapshot()
                        STATE.update(latest=data, received=now, error=None)
                        HISTORY.append(entry)
                        CHANGED.notify_all()
                    log.write(json.dumps(entry) + '\n')
            except (OSError, serial.SerialException) as error:
                with LOCK:
                    STATE.update(connected=False, latest=None, received=None, error=str(error))
                    HISTORY.clear()
                time.sleep(0.5)
            finally:
                s.close()

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        port = self.server.server_address[1]
        if (self.headers.get('Origin') not in (f'http://127.0.0.1:{port}', f'http://localhost:{port}')
                or self.headers.get('X-GPIO-UI') != '1'):
            self.send_error(403)
            return
        route = urlsplit(self.path).path
        if route not in ('/api/connection','/api/angle'):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 512:
                raise ValueError('Invalid size')
            request = json.loads(self.rfile.read(length))
            if route == '/api/angle':
                with LOCK:
                    transitions = request.get('transitions',ANGLE.transitions)
                    sign = request.get('sign',ANGLE.sign)
                    per_turn = request.get('steps_per_turn',ANGLE.steps_per_turn)
                    if type(transitions) is not int or transitions not in (2,4) or type(sign) is not int or sign not in (-1,1):
                        raise ValueError('Invalid angle configuration')
                    if type(per_turn) not in (int,float) or not math.isfinite(per_turn) or not 0<per_turn<=1000000:
                        raise ValueError('Invalid steps per turn')
                    temp=SETTINGS.with_suffix('.tmp')
                    temp.write_text(json.dumps(dict(steps_per_turn=per_turn,sign=sign,transitions=transitions),indent=2),encoding='utf-8')
                    temp.replace(SETTINGS)
                    reset_needed = transitions!=ANGLE.transitions or request.get('zero') is True
                    ANGLE.transitions, ANGLE.sign, ANGLE.steps_per_turn = transitions, sign, per_turn
                    if reset_needed: ANGLE.reset()
                self.send_response(204)
                self.send_header('Content-Length','0')
                self.end_headers()
                return
            enabled, selected = request['enabled'], request.get('port', 'auto')
            if type(enabled) is not bool or not isinstance(selected, str):
                raise ValueError('Invalid selection')
            if enabled and selected != 'auto' and selected not in [p.device for p in list_ports.comports()]:
                raise ValueError('串口不存在，请刷新列表')
        except (ValueError, KeyError, TypeError):
            self.send_error(400, 'Invalid or unavailable port')
            return
        with LOCK:
            CONTROL.update(enabled=enabled, selected=selected, generation=CONTROL['generation'] + 1)
            STATE.update(connected=False, port=None, latest=None, received=None, error='正在连接所选串口' if enabled else '已手动断开')
            HISTORY.clear()
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            previous = None
            sent = 0
            try:
                while True:
                    with LOCK:
                        data = dict(STATE, angle=ANGLE.snapshot())
                    now = time.monotonic()
                    key = (data['received'], data['connected'], data['error'], json.dumps(data['angle']))
                    if key != previous or now-sent > .25:
                        data['age_ms'] = None if data['received'] is None else round((time.time()-data['received'])*1000)
                        self.wfile.write(('data: '+json.dumps(data)+'\n\n').encode())
                        self.wfile.flush()
                        previous, sent = key, now
                    with CHANGED:
                        CHANGED.wait_for(lambda: STATE['received'] != data['received'] or STATE['connected'] != data['connected'], timeout=.25)
            except (OSError, ConnectionError):
                pass
            return
        if path == '/api/state':
            with LOCK:
                data = dict(STATE, history=list(HISTORY), control=dict(CONTROL), angle=ANGLE.snapshot())
            data['age_ms'] = None if data['received'] is None else round((time.time() - data['received']) * 1000)
            body = json.dumps(data).encode()
            mime = 'application/json; charset=utf-8'
        elif path == '/api/ports':
            body = json.dumps([dict(port=p.device, description=p.description) for p in list_ports.comports()]).encode()
            mime = 'application/json; charset=utf-8'
        elif path in ('/', '/index.html'):
            body = (ROOT / 'index.html').read_bytes()
            mime = 'text/html; charset=utf-8'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

class BridgeServer(ThreadingHTTPServer):
    # Windows must not silently share an occupied port with another HTTP service.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    server = BridgeServer(('127.0.0.1', args.port), Handler)
    threading.Thread(target=reader, daemon=True).start()
    print(json.dumps(dict(service='layered-life-serial', port=server.server_port)), flush=True)
    server.serve_forever()
