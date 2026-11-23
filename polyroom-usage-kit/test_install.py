import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('install.sh')
ROOM = '11111111-2222-4333-8444-555555555555'
PERSON = '66666666-7777-4888-9999-000000000000'
STUBS = {
    'id': '#!/bin/sh\necho 0\n',
    'crontab': '#!/bin/sh\nif [ "$1" = -l ]; then cat "$CRONTAB_FILE" 2>/dev/null || exit 1; else cat > "$CRONTAB_FILE.new" && mv "$CRONTAB_FILE.new" "$CRONTAB_FILE"; fi\n',
    'apt-get': '#!/bin/sh\ntouch "$APT_MARKER"\nexit 1\n',
    'docker': '#!/bin/sh\nexit 1\n',
}


def executable(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding='utf-8')
    path.chmod(0o755)


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        for name, body in STUBS.items():
            executable(self.base / 'bin' / name, body)
        executable(self.base / 'venv' / 'bin' / 'claude-monitor', '#!/bin/sh\necho claude-monitor 4.0.0\n')
        self.kit = self.base / 'kit'
        self.settings = self.base / 'home' / '.claude' / 'settings.json'
        self.settings.parent.mkdir(parents=True)
        self.crontab = self.base / 'crontab'
        self.apt_marker = self.base / 'apt-called'
        self.env = {'PATH': f"{self.base / 'bin'}:/usr/bin:/bin", 'HOME': str(self.base / 'home'), 'CRONTAB_FILE': str(self.crontab), 'APT_MARKER': str(self.apt_marker), 'LANG': 'C.UTF-8'}

    def install(self, *arguments):
        return subprocess.run(['bash', str(SCRIPT), '--kit-dir', str(self.kit), '--venv', str(self.base / 'venv'), *arguments], env=self.env, capture_output=True, text=True, timeout=120)

    def test_an_argument_that_would_turn_into_code_in_the_root_crontab_is_refused_before_anything_changes(self):
        for arguments in [
            ['--room', f'{ROOM}; printf INJECTED; #', '--mention-handle', 'bot'],
            ['--room', '$(touch injected)', '--mention-handle', 'bot'],
            ['--room', ROOM, '--mention-handle', 'bot%x'],
            ['--room', ROOM, '--mention-handle', 'bot\nrm'],
            ['--room', ROOM, '--mention-person', f"{PERSON}'; touch injected; '"],
            ['--room', ROOM, '--mention-handle', 'bot', '--kit-dir', str(self.base / 'kit dir')],
            ['--room', ROOM, '--mention-handle', 'bot', '--kit-dir', str(self.base / "kit'dir")],
            ['--room', ROOM, '--mention-handle', 'bot', '--venv', 'relative/venv'],
            ['--room', ROOM, '--mention-handle', 'bot', '--compact-model', 'model;x'],
            ['--room', ROOM, '--mention-handle', 'bot', '--auto-compact-window', '1e5'],
        ]:
            with self.subTest(arguments=arguments):
                result = self.install(*arguments)
                self.assertEqual(result.returncode, 64, result.stderr)
                self.assertIn('refused', result.stderr)
                for path in (self.crontab, self.settings, self.apt_marker, self.kit):
                    self.assertFalse(path.exists(), f'{path.name} changed')

    def test_the_cron_lines_carry_the_arguments_as_plain_words_and_a_new_install_replaces_only_them(self):
        self.crontab.write_text('0 3 * * * /usr/local/bin/backup # other\n', encoding='utf-8')
        for _ in range(2):
            result = self.install('--room', ROOM, '--mention-handle', '@bot-1', '--mention-person', PERSON)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.crontab.read_text(encoding='utf-8').splitlines(), [
            '0 3 * * * /usr/local/bin/backup # other',
            f'* * * * * PATH=/usr/local/bin:/usr/bin:/bin python3 {self.kit}/token-usage/snapshot.py sample >> /var/log/polyroom-cost-sample.log 2>&1 # polyroom-cost-sample',
            f'7,22,37,52 * * * * PATH=/usr/local/bin:/usr/bin:/bin python3 {self.kit}/usage-check.py --room {ROOM} --mention-handle @bot-1 --mention-person {PERSON} >> /var/log/polyroom-usage-check.log 2>&1 # polyroom-usage-check',
        ])
        self.assertEqual(os.readlink(self.kit / 'claude-monitor'), str(self.base / 'venv' / 'bin' / 'claude-monitor'))
        self.assertFalse(self.apt_marker.exists())

    def test_the_settings_keep_their_mode_and_first_backup_and_a_failed_edit_leaves_them_as_they_were(self):
        original = {'statusLine': {'type': 'command', 'command': 'old'}, 'theme': 'dark'}
        self.settings.write_text(json.dumps(original), encoding='utf-8')
        self.settings.chmod(0o600)
        for _ in range(2):
            result = self.install('--room', ROOM, '--mention-handle', 'bot')
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(self.settings.stat().st_mode), 0o600)
        written = json.loads(self.settings.read_text(encoding='utf-8'))
        self.assertEqual(written['statusLine'], {'type': 'command', 'command': f'{self.kit}/statusline-capture.sh'})
        self.assertEqual(written['theme'], 'dark')
        self.assertNotIn('disableClaudeAiConnectors', written)
        self.assertEqual(json.loads(Path(f'{self.settings}.before-usage-kit').read_text(encoding='utf-8')), original)

        self.settings.write_text('{broken', encoding='utf-8')
        result = self.install('--room', ROOM, '--mention-handle', 'bot', '--disable-claude-ai-connectors')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.settings.read_text(encoding='utf-8'), '{broken')
        self.assertEqual(sorted(path.name for path in self.settings.parent.iterdir()), ['settings.json', 'settings.json.before-usage-kit'])


if __name__ == '__main__':
    unittest.main()
