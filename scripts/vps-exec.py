#!/usr/bin/env python3
"""Execute a command on a VPS via SSH.

Required environment variables:
  WINDSURFAPI_VPS_HOST
  WINDSURFAPI_VPS_USER

Authentication:
  WINDSURFAPI_VPS_PASS, or WINDSURFAPI_VPS_KEY pointing at a private key file.
"""
import os
import sys

import paramiko

os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')


def _env(name, required=True):
    value = os.environ.get(name, '').strip()
    if required and not value:
        raise SystemExit(f'Missing required environment variable: {name}')
    return value


def run(cmd, timeout=600):
    host = _env('WINDSURFAPI_VPS_HOST')
    user = _env('WINDSURFAPI_VPS_USER')
    password = _env('WINDSURFAPI_VPS_PASS', required=False)
    key_path = _env('WINDSURFAPI_VPS_KEY', required=False)
    if not password and not key_path:
        raise SystemExit('Set WINDSURFAPI_VPS_PASS or WINDSURFAPI_VPS_KEY before running this helper')

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connect_kwargs = {
        'hostname': host,
        'username': user,
        'timeout': 10,
    }
    if key_path:
        connect_kwargs['key_filename'] = key_path
    else:
        connect_kwargs['password'] = password
    client.connect(**connect_kwargs)
    try:
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode('utf-8', errors='replace')
        err = stderr.read().decode('utf-8', errors='replace')
        code = stdout.channel.recv_exit_status()
        return out, err, code
    finally:
        client.close()


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else 'echo hello'
    out, err, code = run(command)
    if out:
        print(out, end='')
    if err:
        print(err, end='', file=sys.stderr)
    sys.exit(code)
