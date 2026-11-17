import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('prepare-client-release.py')
CONFIG = SCRIPT.parent.parent / 'app/nsh.json'

class ReleaseMetadataTest(unittest.TestCase):
    def test_channels_preserve_capabilities_and_trust(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            original = json.loads(CONFIG.read_text())
            (app / 'nsh.json').write_text(json.dumps(original))
            for channel, app_id in [('store', 'dev.huacnlee.noop'), ('direct', 'dev.noop.app')]:
                subprocess.run(['python3', str(SCRIPT), '--app', directory, '--version', '1.0.1', '--build', '3', '--channel', channel], check=True)
                config = json.loads((app / 'nsh.json').read_text())
                self.assertEqual((config['id'], config['version'], config['build']), (app_id, '1.0.1', 3))
                self.assertEqual(config['capabilities'], original['capabilities'])
                self.assertEqual(config['updater']['packages'], original['updater']['packages'])
                self.assertEqual('github' in config['updater'], channel == 'direct')
                self.assertEqual('publicKey' in config['updater'], channel == 'store')
                self.assertIn('"1.0.1"', (app / 'version.ts').read_text())

    def test_bad_metadata_does_not_mutate_files(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            (app / 'nsh.json').write_text(CONFIG.read_text())
            for version, build in [('1.0.1', '2'), ('dev', '3')]:
                result = subprocess.run(['python3', str(SCRIPT), '--app', directory, '--version', version, '--build', build], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((app / 'nsh.json').read_text(), CONFIG.read_text())

if __name__ == '__main__':
    unittest.main()
