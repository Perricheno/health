"""Create a local DPAPI-protected release credential and configure its hash.

Run on the Windows machine of the Penall owner. The high-entropy secret is
never written into this checkout; only its SHA-256 verifier is published.
"""
import hashlib
import os
from pathlib import Path
import re
import secrets
import sys


def main():
    import win32crypt
    base = Path(os.environ['LOCALAPPDATA']) / 'RetailFlowDeploy'
    target = base / 'health-release-secret.dat'
    base.mkdir(parents=True, exist_ok=True)
    if target.exists():
        _, raw = win32crypt.CryptUnprotectData(target.read_bytes(), None, None, None, 0)
        secret = raw.decode('ascii')
    else:
        secret = secrets.token_urlsafe(32)
        raw = win32crypt.CryptProtectData(secret.encode('ascii'), 'Penall release credential', None, None, None, 0)
        with target.open('xb') as file:
            file.write(raw)
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', secret):
        raise RuntimeError('Existing protected credential has an unexpected format')
    verifier = hashlib.sha256(secret.encode('ascii')).hexdigest()
    config = Path(__file__).resolve().parents[1] / 'wrangler.jsonc'
    text = config.read_text(encoding='utf-8')
    if '"PENALL_APPROVAL_HASH"' in text:
        text, count = re.subn(r'("PENALL_APPROVAL_HASH"\s*:\s*")[a-f0-9]{64}(")', r'\g<1>' + verifier + r'\2', text)
    else:
        if '"vars"' in text:
            raise RuntimeError('Merge the verifier into existing vars manually')
        text, count = re.subn(r'("keep_vars"\s*:\s*true\s*,)', r'\1\n  "vars": { "PENALL_APPROVAL_HASH": "' + verifier + '" },', text, count=1)
    if count != 1:
        raise RuntimeError('Cannot update the verifier in wrangler.jsonc')
    config.write_text(text, encoding='utf-8')
    print('Release credential protected for this Windows user; verifier configured.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Preparation failed:', type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
