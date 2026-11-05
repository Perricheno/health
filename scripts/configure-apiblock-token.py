#!/usr/bin/env python3
"""Issue an APIBlock-only Health token and store it on the deployment server."""
import getpass
import http.cookiejar
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

origin = 'https://health.perricheno.com'
destination = Path('/etc/apiblock/health.json')
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def post(path, body):
    request = urllib.request.Request(origin + path, data=json.dumps(body).encode(), method='POST',
        headers={'Origin': origin, 'Content-Type': 'application/json', 'User-Agent': 'Perricheno-Health-Deploy/1.0'})
    with opener.open(request, timeout=10) as response:
        return json.load(response)


try:
    if destination.exists():
        raise SystemExit('Token configuration already exists; refusing to rotate it.')
    if os.geteuid() != 0:
        raise SystemExit('Run as root so the token remains private.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Reserve a private destination before issuing a token, so a write failure is
    # detected before the server invalidates an existing token for this project.
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        pin = getpass.getpass('Health admin PIN: ')
        post('/api/admin/login', {'pin': pin})
        issued = post('/api/admin/deploy-token', {'project': 'apiblock'})
        with os.fdopen(fd, 'w') as out:
            fd = None
            json.dump({'url': origin + '/api/deployments/ingest', 'token': issued['token']}, out)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
    except BaseException:
        if fd is not None:
            os.close(fd)
        destination.unlink(missing_ok=True)
        raise
    print('APIBlock token saved privately to /etc/apiblock/health.json.')
    ping = urllib.request.Request(origin + '/api/deployments/ingest',
        data=json.dumps({'project': 'apiblock', 'type': 'ping'}).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + issued['token'], 'Content-Type': 'application/json',
                 'User-Agent': 'Perricheno-Health-Deploy/1.0'})
    with opener.open(ping, timeout=10) as response:
        if not json.load(response).get('ok'):
            raise ValueError('ping rejected')
    print('Health accepted the APIBlock token; no deployment event was created.')
except urllib.error.HTTPError as error:
    print(f'Health rejected the request (HTTP {error.code}). Publish Health with the APIBlock project first and check the admin PIN.')
    raise SystemExit(1)
except (OSError, KeyError, ValueError) as error:
    print(f'Could not configure the token: {type(error).__name__}')
    raise SystemExit(1)
