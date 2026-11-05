#!/usr/bin/env python3
"""Run the existing APIBlock deployer and report only its real, curated stages."""
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

CONFIG = Path('/etc/apiblock/health.json')
DEPLOYER = '/usr/local/sbin/apiblock-deploy'


class Reporter:
    def __init__(self, endpoint, token, action):
        self.endpoint, self.token, self.action = endpoint, token, action
        self.events = queue.Queue(maxsize=128)
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.run_id = str(uuid.uuid4())
        self.seq = 0
        self.current = None
        self.started = False
        self.failed = False
        self.sender = threading.Thread(target=self.send, daemon=True)
        self.sender.start()
        self.heartbeat = threading.Thread(target=self.keepalive, daemon=True)
        self.heartbeat.start()

    def emit(self, kind, **values):
        with self.lock:
            if self.failed or self.events.full():
                self.failed = True
                return
            self.seq += 1
            self.events.put_nowait(dict(project='apiblock', environment='production',
                                        runId=self.run_id, seq=self.seq, type=kind, **values))

    def start(self, commit):
        if self.started:
            return
        self.started = True
        stages = ['prepare', 'validate', 'switch', 'verify'] if self.action == 'deploy' else ['prepare', 'switch', 'verify']
        self.emit('start', action=self.action, commit=commit, stages=stages)
        self.stage('prepare')

    def stage(self, stage):
        if not self.started or self.current == stage:
            return
        if self.current:
            self.emit('stage', stage=self.current, state='complete')
        self.current = stage
        self.emit('stage', stage=stage, state='running')

    def keepalive(self):
        while not self.stop.wait(15):
            if self.started:
                self.emit('heartbeat')

    def send(self):
        while True:
            event = self.events.get()
            try:
                if event is None:
                    return
                payload = json.dumps(event).encode()
                delivered = False
                for attempt in range(4):
                    req = urllib.request.Request(self.endpoint, data=payload, method='POST',
                        headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
                    try:
                        with urllib.request.urlopen(req, timeout=2) as response:
                            delivered = bool(json.load(response).get('ok'))
                        if delivered:
                            break
                    except urllib.error.HTTPError as error:
                        if error.code in (400, 401, 403, 409, 413):
                            break
                    except (OSError, ValueError):
                        pass
                    if attempt < 3:
                        time.sleep(.25 * 2 ** attempt)
                if not delivered:
                    self.failed = True
                    print('[health] Event stream disconnected; deployment continues.', file=sys.stderr, flush=True)
                    return
            finally:
                self.events.task_done()

    def finish(self, status):
        self.stop.set()
        self.heartbeat.join(timeout=1)
        if self.started:
            if status == 'success' and self.current:
                self.emit('stage', stage=self.current, state='complete')
            self.emit('finish', status=status)
        try:
            self.events.put_nowait(None)
        except queue.Full:
            self.failed = True
        self.sender.join(timeout=8)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'activate'
    if mode not in ('activate', 'rollback'):
        os.execv(DEPLOYER, [DEPLOYER, *sys.argv[1:]])
    try:
        config = json.loads(CONFIG.read_text())
        endpoint, token = config['url'], config['token']
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != 'https' or parsed.hostname != 'health.perricheno.com' or parsed.path != '/api/deployments/ingest' or parsed.query or parsed.username or parsed.password or not re.fullmatch(r'[a-zA-Z0-9_-]{32,256}', token):
            raise ValueError('invalid configuration')
    except (OSError, ValueError, KeyError, TypeError):
        os.execv(DEPLOYER, [DEPLOYER, *sys.argv[1:]])

    reporter = Reporter(endpoint, token, 'deploy' if mode == 'activate' else 'rollback')
    child = subprocess.Popen([DEPLOYER, *sys.argv[1:]], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, bufsize=1)
    previous = {}
    def forward(signum, _frame):
        if child.poll() is None:
            child.send_signal(signum)
    for sig in (signal.SIGTERM, signal.SIGINT):
        previous[sig] = signal.signal(sig, forward)
    try:
        for line in child.stdout:
            print(line, end='', flush=True)
            match = re.search(r'apiblock-deploy: validating ([a-f0-9]{40})', line)
            if match:
                reporter.start(match.group(1))
                reporter.stage('validate')
            elif 'apiblock-deploy: health telemetry rollback target ' in line:
                match = re.search(r'target ([a-f0-9]{40})', line)
                if match:
                    reporter.start(match.group(1))
            elif 'apiblock-deploy: health telemetry switching' in line:
                reporter.stage('switch')
            elif 'apiblock-deploy: health telemetry verifying' in line:
                reporter.stage('verify')
        code = child.wait()
        reporter.finish('success' if code == 0 else 'cancelled' if code == 75 or code < 0 or code in (130, 143) else 'failure')
        return code if code >= 0 else 128 - code
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    raise SystemExit(main())
