#!/usr/bin/env python3
"""Install the optional reporter while holding the APIBlock deployment lock."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

deployer = Path('/usr/local/sbin/apiblock-deploy')
source = Path(__file__).with_name('apiblock-health-reporter.py')
target = Path('/usr/local/sbin/apiblock-health-reporter.py')
dropin = Path('/etc/systemd/system/apiblock-deploy.service.d/health.conf')
original = deployer.read_text()
edited = original
changes = [
    ('    atomic_link "$release" "$CURRENT"\n    if restart_services && health_check; then',
     '    log "health telemetry switching"\n    atomic_link "$release" "$CURRENT"\n    if restart_services && { log "health telemetry verifying"; health_check; }; then'),
    ('    current_target=$([[ -L "$CURRENT" ]] && readlink -f -- "$CURRENT" 2>/dev/null || true)\n    atomic_link "$target" "$CURRENT"\n    restart_services\n    if health_check; then',
     '    current_target=$([[ -L "$CURRENT" ]] && readlink -f -- "$CURRENT" 2>/dev/null || true)\n    log "health telemetry rollback target $(basename -- "$target")"\n    log "health telemetry switching"\n    atomic_link "$target" "$CURRENT"\n    restart_services\n    log "health telemetry verifying"\n    if health_check; then'),
]
for before, after in changes:
    if after in edited:
        continue
    if edited.count(before) != 1:
        raise SystemExit('Deployer changed unexpectedly; installation aborted')
    edited = edited.replace(before, after, 1)

with tempfile.NamedTemporaryFile('w', dir=deployer.parent, delete=False) as tmp:
    tmp.write(edited)
    tmp_path = Path(tmp.name)
try:
    os.chmod(tmp_path, deployer.stat().st_mode & 0o777)
    subprocess.run(['bash', '-n', str(tmp_path)], check=True)
    shutil.copy2(deployer, deployer.with_name('apiblock-deploy.pre-health'))
    os.replace(tmp_path, deployer)
finally:
    tmp_path.unlink(missing_ok=True)

shutil.copyfile(source, target)
os.chmod(target, 0o755)
dropin.parent.mkdir(parents=True, exist_ok=True)
dropin.write_text('[Service]\nExecStart=\nExecStart=/usr/bin/python3 /usr/local/sbin/apiblock-health-reporter.py activate\n')
subprocess.run(['systemctl', 'daemon-reload'], check=True)
print('Reporter installed; APIBlock deploys normally until /etc/apiblock/health.json is configured.')
