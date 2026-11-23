import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).with_name('usage-check.py')
NOW = 1_800_000_000.0
WEEK_RESET = 1_800_259_200
ROOM = '11111111-2222-4333-8444-555555555555'
POSTING = ('--room', ROOM, '--mention-handle', 'bot')


class UsageCheckTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home, True)
        with mock.patch.dict(os.environ, {'HOME': str(self.home)}):
            spec = importlib.util.spec_from_file_location('usage_check', SCRIPT)
            self.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.module)
        self.state = self.home / '.claude-monitor'

    def capture(self, *, context_tokens=0, week=10.0, week_reset=NOW + 24 * 3600, captured_at=NOW, monitor_at=None):
        (self.state / 'context').mkdir(parents=True, exist_ok=True)
        (self.state / 'statusline').mkdir(parents=True, exist_ok=True)
        context = {'session_id': 's1', 'captured_at_epoch': captured_at, 'context_window': {'context_window_size': 1_000_000, 'current_usage': {'input_tokens': context_tokens}}}
        monitor = {'captured_at_epoch': captured_at if monitor_at is None else monitor_at, 'rate_limits': {
            'five_hour': {'used_percentage': 10.0, 'resets_at': NOW + 3600},
            'seven_day': {'used_percentage': week, 'resets_at': week_reset}}}
        (self.state / 'context' / 'latest.json').write_text(json.dumps(context), encoding='utf-8')
        (self.state / 'statusline' / 'latest.json').write_text(json.dumps(monitor), encoding='utf-8')

    def check(self, *arguments, now=NOW):
        with mock.patch.object(sys, 'argv', ['usage-check.py', *arguments]), mock.patch.object(self.module.time, 'time', return_value=now), redirect_stdout(io.StringIO()):
            return self.module.main()

    def last(self):
        return json.loads((self.state / 'usage-check-history.jsonl').read_text(encoding='utf-8').splitlines()[-1])

    def test_a_context_level_comes_back_only_after_the_context_drops_below_it_and_a_jump_shows_the_highest_level(self):
        shown = []
        for tokens in (450_000, 650_000, 450_000, 350_000, 450_000):
            self.capture(context_tokens=tokens)
            self.check()
            shown.append(self.last()['newAlerts'])
        self.assertEqual(shown, [['context>=400000:s1'], ['context>=600000:s1'], [], [], ['context>=400000:s1']])
        self.capture(context_tokens=0)
        self.check()
        self.capture(context_tokens=650_000)
        self.check()
        self.assertEqual(self.last()['newAlerts'], ['context>=600000:s1'])
        self.assertIn('context>=400000:s1', self.last()['activeAlerts'])

    def test_recent_readings_raise_no_readout_alert(self):
        self.capture()
        self.check()
        self.assertEqual(self.last()['newAlerts'], [])

    def test_readings_older_than_the_limit_alert_once_and_never_show_the_old_limits_as_current(self):
        self.capture(context_tokens=650_000, week=99.0, captured_at=NOW - 86_400)
        self.check()
        self.assertEqual(self.last()['newAlerts'], ['readout-stale:context'])
        self.assertIsNone(self.last()['weekPercent'])
        self.check(now=NOW + 900)
        self.assertEqual(self.last()['newAlerts'], [])

    def test_a_monitor_reading_behind_the_session_is_reported(self):
        self.capture(monitor_at=NOW - 3600)
        self.check()
        self.assertEqual(self.last()['newAlerts'], ['readout-missing:monitor'])

    def test_a_limit_alert_survives_a_stale_reading_without_being_posted_again(self):
        self.capture(week=75.0)
        self.check()
        self.assertEqual([key.split(':')[0] for key in self.last()['newAlerts']], ['week>=70'])
        self.capture(week=75.0, captured_at=NOW - 86_400)
        self.check()
        self.assertEqual(self.last()['newAlerts'], ['readout-stale:context'])
        self.capture(week=75.0, captured_at=NOW + 1800)
        self.check(now=NOW + 1800)
        self.assertEqual(self.last()['newAlerts'], [])

    def seed_history(self, *samples):
        self.state.mkdir(parents=True, exist_ok=True)
        lines = [json.dumps({'at': datetime.fromtimestamp(at, timezone.utc).isoformat(timespec='seconds'), 'weekResetsAt': WEEK_RESET, 'weekPercent': percent}) for at, percent in samples]
        (self.state / 'usage-check-history.jsonl').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    def test_a_projection_alert_is_posted_once_and_a_run_without_enough_history_keeps_it(self):
        projection = f'week-projection>=90:{WEEK_RESET}'
        self.seed_history((NOW - 5.5 * 3600, 52.0))
        for offset, history in ((0, None), (900, None), (1800, (NOW + 1200, 58.0)), (2700, (NOW + 2700 - 5.5 * 3600, 52.0))):
            if history:
                self.seed_history(history)
            self.capture(week=58.0, week_reset=WEEK_RESET, captured_at=NOW + offset)
            self.check(now=NOW + offset)
            with self.subTest(offset=offset):
                self.assertEqual(self.last()['newAlerts'], [projection] if offset == 0 else [])
                self.assertIn(projection, self.last()['activeAlerts'])
            self.assertEqual(self.last()['weekProjectedPercent'] is None, offset == 1800)

    def post_with_lost_answers(self, lost):
        calls = []
        stored = {}

        def post(session, arguments, content, client_id):
            calls.append((client_id, content))
            stored.setdefault(client_id, content)
            if len(calls) in lost:
                raise TimeoutError('the answer was lost')
            return f'message-{len(stored)}'
        patches = [mock.patch.object(self.module, 'mcp_session', return_value='session'), mock.patch.object(self.module, 'bot_handle', return_value='bot'), mock.patch.object(self.module, 'post_alert', side_effect=post)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        return calls, stored

    def test_a_post_whose_answer_was_lost_is_retried_with_the_same_id_and_text(self):
        calls, stored = self.post_with_lost_answers({1})
        self.capture(context_tokens=450_000)
        codes = [self.check(*POSTING, now=NOW + offset) for offset in (0, 900, 1800)]
        self.assertEqual(codes, [1, 2, 0])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(len(stored), 1)

    def test_a_new_crossing_after_the_alert_cleared_is_a_new_message(self):
        calls, stored = self.post_with_lost_answers({1})
        for tokens, offset in ((450_000, 0), (350_000, 900), (450_000, 1800)):
            self.capture(context_tokens=tokens)
            self.check(*POSTING, now=NOW + offset)
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0][0], calls[1][0])
        self.assertEqual(len(stored), 2)


if __name__ == '__main__':
    unittest.main()
