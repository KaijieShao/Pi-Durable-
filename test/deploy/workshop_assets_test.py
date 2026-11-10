"""Offline tests only: no gcloud, service operations, real credentials or pollers."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'deploy/gcp/workshop'
spec = importlib.util.spec_from_file_location('workshop_manager', ASSETS / 'manage.py')
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)
MANIFEST = json.loads((ASSETS / 'manifest.json').read_text())


def fixture_values():
    values = {key: 'fixture' for key in MANIFEST['bindings']}
    values['SOURCE_SHA'] = 'a' * 40
    for key in values:
        if key.endswith('_ENV_1') or key.endswith('_ENV_2'):
            values[key] = 'FIXTURE_FLAG=present'
    return values


def fixture_report(texts):
    artifacts = {}
    for file in MANIFEST['files']:
        text = texts[file['template']]
        if file['kind'] == 'systemd':
            text = manager.canonical_unit(text)
        artifacts[file['template']] = {'sha256': hashlib.sha256(text.encode()).hexdigest(), 'mode': file['mode']}
    observed = {'artifacts': artifacts, 'environment_files': {'fixture.env': {'sha256': 'fixture', 'mode': '0o600'}},
                'runtime_source_sha': 'a' * 40, 'observed_at_ms': 1,
                'protected_general_tasks_sha256': 'fixture', 'checks': {'one_vm_bot_poller': True}}
    expected = {'artifacts': artifacts, 'environment_files': observed['environment_files'], 'runtime_source_sha': 'a' * 40}
    return expected, observed


class WorkshopAssets(unittest.TestCase):
    def test_templates_render_to_valid_inert_scripts_and_preserve_security_directives(self):
        texts = manager.rendered(MANIFEST, fixture_values())
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / 'rendered'
            manager.write_rendered(MANIFEST, texts, dest)
            for file in MANIFEST['files']:
                path = dest / Path(file['target']).relative_to('/')
                self.assertEqual(path.stat().st_mode & 0o777, int(file['mode'], 8))
                if path.name == 'start-workshop.mjs':
                    subprocess.run(['node', '--check', str(path)], check=True, capture_output=True)
                if path.name == 'docker-scoped':
                    subprocess.run(['sh', '-n', str(path)], check=True, capture_output=True)
                if path.suffix == '.py':
                    compile(path.read_text(), str(path), 'exec')
            self.assertEqual(dest.stat().st_mode & 0o777, 0o700)
        coordinator = texts['systemd/pi-durable-workshop-coordinator.service.in']
        watchdog = texts['systemd/pi-durable-workshop-watchdog.service.in']
        for needed in ['ExecStartPre=/usr/bin/python3 /opt/pi-durable-workshop/require-exclusive.py',
                       'Restart=always', 'ConditionPathIsMountPoint=/mnt/pi-durable-workshop',
                       'Conflicts=pi-durable-coordinator.service', 'InaccessiblePaths=/var/lib/pi-durable']:
            self.assertIn(needed, coordinator)
        for needed in ['RestrictAddressFamilies=AF_UNIX', 'IPAddressDeny=any', 'ProtectSystem=strict',
                       'CapabilityBoundingSet=CAP_KILL', 'NoNewPrivileges=yes']:
            self.assertIn(needed, watchdog)
        self.assertNotIn('PartOf=', watchdog)
        self.assertNotIn('BindsTo=pi-durable-workshop-coordinator', watchdog)

    def test_bindings_cannot_inject_unit_lines_or_shell_words(self):
        for kind in ['word', 'unit']:
            with self.assertRaises(ValueError):
                manager.render_text('{{' + kind + ':KEY}}', {'KEY': 'fixture\nExecStart=/bad'})
        hostile = '"; globalThis.unsafe = true; //\n'
        escaped = manager.render_text('{{json:KEY}}', {'KEY': hostile})
        self.assertEqual(json.loads(escaped), hostile)
        with self.assertRaises(ValueError):
            manager.render_text('{{missing:KEY}}', {})

    def test_private_outputs_and_bindings_cannot_land_in_checkout(self):
        with self.assertRaises(ValueError):
            manager.private_path(ROOT / '.context/rendered-config')
        with tempfile.TemporaryDirectory() as temp:
            binding = Path(temp) / 'bindings.json'
            binding.write_text(json.dumps(fixture_values()))
            binding.chmod(0o644)
            with self.assertRaises(ValueError):
                manager.read_bindings(binding, MANIFEST)
            binding.chmod(0o600)
            self.assertEqual(manager.read_bindings(binding, MANIFEST), fixture_values())
            values = fixture_values()
            values['GITHUB_SECRET'] = 'github_pat_' + 'X' * 50
            binding.write_text(json.dumps(values))
            with self.assertRaises(ValueError):
                manager.read_bindings(binding, MANIFEST)

    def test_all_directives_including_resets_are_compared_and_drift_is_rejected(self):
        texts = manager.rendered(MANIFEST, fixture_values())
        expected, observed = fixture_report(texts)
        self.assertTrue(manager.compare(MANIFEST, expected, texts, observed)['ok'])
        for target in ['script', 'env', 'mode', 'poller']:
            changed = copy.deepcopy(observed)
            if target == 'script': changed['artifacts']['start-workshop.mjs.in']['sha256'] = 'changed'
            if target == 'env': changed['environment_files']['fixture.env']['sha256'] = 'changed'
            if target == 'mode': changed['artifacts']['start-workshop.mjs.in']['mode'] = '0o666'
            if target == 'poller': changed['checks']['one_vm_bot_poller'] = False
            self.assertFalse(manager.compare(MANIFEST, expected, texts, changed)['ok'])
        self.assertEqual(manager.canonical_unit('# note\n[Service]\nExecStart=\nExecStart=/good\n'),
                         '[Service]\nExecStart=\nExecStart=/good\n')
        self.assertNotEqual(manager.canonical_unit('[Service]\nExecStart=/good\n'),
                            manager.canonical_unit('[Service]\nExecStart=/bad\n'))

    def test_management_has_no_mutation_command_and_probe_never_writes(self):
        result = subprocess.run(['python3', '-B', str(ASSETS / 'manage.py'), 'restart'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('invalid choice', result.stderr)
        probe = (ASSETS / 'probe.py').read_text()
        for forbidden in ['write_text(', 'write_bytes(', '.unlink(', "'terraform'", 'secretmanager.googleapis.com',
                          '"stop"', '"start"', '"restart"', '"enable"', '"disable"']:
            self.assertNotIn(forbidden, probe)
        self.assertIn('PRAGMA query_only=ON', probe)
        self.assertIn('?mode=ro', probe)
        start = (ASSETS / 'start-workshop.mjs.in').read_text()
        self.assertIn('coordinatorEnvironment(process.env)', start)
        self.assertIn('credential values and raw errors suppressed', start)
        self.assertNotIn('writeFile', start)
        used = {match.group(2) for f in MANIFEST['files']
                for match in manager.MARKER.finditer((ASSETS / f['template']).read_text())}
        self.assertEqual(used, set(MANIFEST['bindings']))



if __name__ == '__main__':
    unittest.main()
