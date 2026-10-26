#!/usr/bin/env python3
"""Stage host guest-egress settings from SANDBOX_PROXY_URL; never load other app secrets."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
from urllib.parse import urlsplit
import zipfile

VERSION = '0.8.6'
RELEASES = {
    'x86_64': ('x86_64-unknown-linux-musl', '5fce5f420c5f1194df07307f6861cf613273e69aa30649919ce1b05de4798bb7'),
    'aarch64': ('aarch64-unknown-linux-gnu', '8dca73e3945b931882467cfcadc2a82018ece78a28f25d6d4d1e7613c266b493'),
}



def proxy_setting(env_file: str) -> str:
    value = os.environ.get('SANDBOX_PROXY_URL')
    if value is None and Path(env_file).is_file():
        for line in Path(env_file).read_text().splitlines():
            match = re.match(r'^\s*(?:export\s+)?SANDBOX_PROXY_URL\s*=(.*)$', line)
            if match:
                parts = shlex.split(match[1], comments=True)
                if len(parts) > 1:
                    raise ValueError('Invalid SANDBOX_PROXY_URL assignment')
                value = parts[0] if parts else ''
    value = (value or '').strip()
    if not value:
        return ''
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValueError('Invalid SANDBOX_PROXY_URL') from None
    if (len(value) > 2000 or parsed.scheme != 'http' or not parsed.hostname or not port or not re.fullmatch(r'[A-Za-z0-9_.:-]+', parsed.hostname)
            or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('SANDBOX_PROXY_URL must be a credential-free http://host:port proxy URL')
    return value


def stage(env_file: str, target: str) -> None:
    proxy = proxy_setting(env_file)
    output = Path(target)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    (output / 'proxy.json').write_text(json.dumps({'proxyUrl': proxy}) + '\n')
    (output / 'proxy.json').chmod(0o600)
    if not proxy:
        print('direct')
        return
    tun = os.environ.get('TUN2PROXY_BINARY') or shutil.which('tun2proxy') or '/usr/local/libexec/trinity-tun2proxy'
    if Path(tun).is_file():
        version = subprocess.check_output([tun, '--version'], text=True, timeout=5)
        if not version.startswith('tun2proxy ' + VERSION + ' '):
            raise ValueError('Unsupported tun2proxy version; expected ' + VERSION)
        shutil.copyfile(tun, output / 'tun2proxy')
    else:
        architecture, digest = RELEASES[platform.machine()]
        archive = output / 'tun2proxy.zip'
        subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
                        '--connect-timeout', '10', '--max-time', '120', '--max-filesize', '80000000',
                        '--proxy', proxy, '--noproxy', '', '--output', str(archive),
                        f'https://github.com/tun2proxy/tun2proxy/releases/download/v{VERSION}/tun2proxy-{architecture}.zip'], check=True)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
            raise ValueError('tun2proxy archive checksum mismatch')
        with zipfile.ZipFile(archive) as bundle:
            binary = bundle.getinfo('tun2proxy-bin')
            if binary.file_size > 80_000_000 or (binary.external_attr >> 16) & 0o170000 not in (0, 0o100000):
                raise ValueError('Invalid tun2proxy release artifact')
            (output / 'tun2proxy').write_bytes(bundle.read(binary))
    (output / 'tun2proxy').chmod(0o755)
    version = subprocess.check_output([str(output / 'tun2proxy'), '--version'], text=True, timeout=5)
    if not version.startswith('tun2proxy ' + VERSION + ' '):
        raise ValueError('Unexpected tun2proxy release version')
    print('proxy')


def run() -> None:
    proxy = json.loads(Path('/etc/trinity/sandbox-egress/proxy.json').read_text())['proxyUrl']
    if not proxy:
        raise ValueError('Sandbox proxy is disabled')
    os.execv('/usr/local/libexec/trinity-tun2proxy', ['trinity-tun2proxy', '--tun', 'guest-egress0',
             '--proxy', proxy, '--dns', 'virtual', '--dns-addr', '192.0.2.53', '--virtual-dns-pool', '198.19.0.0/16', '--mtu', '1500', '--verbosity', 'off', '--exit-on-fatal-error'])


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2 and sys.argv[1] == 'run':
            run()
        elif len(sys.argv) == 4 and sys.argv[1] == 'stage':
            stage(sys.argv[2], sys.argv[3])
        else:
            raise ValueError('Usage: sandbox-egress-config.py stage <env-file> <directory> | run')
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        raise SystemExit('Sandbox egress setup failed (' + type(error).__name__ + '): ' +
                         (str(error) if isinstance(error, ValueError) else 'check host dependencies and configuration')) from None
