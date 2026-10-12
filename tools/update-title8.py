#!/usr/bin/env python3
"""Check OLRC, then build an isolated corrected Title 8 candidate."""
import argparse
import json
import os
from pathlib import Path
import sys
from title8_update.pipeline import check, build, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    checker = commands.add_parser('check')
    checker.add_argument('--output', type=Path, required=True)
    checker.add_argument('--zip', type=Path, help='Offline replay of an official captured ZIP')
    checker.add_argument('--release', help='Required only for offline replay')
    builder = commands.add_parser('build')
    builder.add_argument('--check-dir', type=Path, required=True)
    builder.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        report = check(args.output, zip_path=args.zip, release=args.release) if args.command == 'check' else build(args.check_dir, args.output)
    except Exception as error:
        if args.command == 'check':
            args.output.mkdir(parents=True, exist_ok=True)
            write_json(args.output / 'report.json', {'schemaVersion': 1, 'status': 'unavailable', 'changed': False, 'error': str(error)})
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    if args.command == 'check' and os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write('changed=' + str(report['changed']).lower() + '\n')
    return 0


if __name__ == '__main__': sys.exit(main())
