#!/usr/bin/env python3
"""Set a client's release metadata before bundling, including its update channel."""
import argparse
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', type=Path, default=Path('app'))
parser.add_argument('--version', required=True)
parser.add_argument('--build', type=int, required=True)
parser.add_argument('--channel', choices=['direct', 'store'], default='direct')
args = parser.parse_args()
if not re.fullmatch(r'\d+\.\d+\.\d+', args.version) or args.build < 3:
    parser.error('use a stable semantic version and a build greater than the existing Store build 2')
path = args.app / 'nsh.json'
config = json.loads(path.read_text())
config.update(id='dev.noop.app', version=args.version, build=args.build)
config['updater'].pop('url', None)
config['updater'].pop('publicKey', None)
config['updater']['github'] = 'huacnlee/noop'
if args.channel == 'store':
    config['id'] = 'dev.huacnlee.noop'
    config['updater'].pop('github')
    config['updater'].update(
        url='https://github.com/huacnlee/noop/releases/latest/download/store-latest.json',
        publicKey='th7UtLhBOa73Bx2s+DZlmlH4EhKcxk5YLYHZQxSgb6I=',
    )
path.write_text(json.dumps(config, indent=2) + '\n')
(args.app / 'version.ts').write_text(f'export const CLIENT_VERSION = "{args.version}";\n')
