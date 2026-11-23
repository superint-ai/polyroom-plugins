import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import snapshot

BRT = timezone(timedelta(hours=-3))
DAY = date(2026, 10, 17)
PRICES = {
    'claude-opus-5-5': (4.0, 5.0, 8.0, 0.20, 20.0),
    'claude-haiku-4-5': (1.0, 1.25, 2.0, 0.10, 5.0),
}


def at(hour, minute=0, second=0):
    return datetime(2026, 10, 17, hour, minute, second, tzinfo=BRT)


def usage_line(*, message_id, request_id, when, cwd, session='session-a', model='claude-opus-5-5', fresh=0, out=0, read=0, write=0, write_5m=0, write_1h=0):
    return json.dumps({
        'type': 'assistant',
        'cwd': cwd,
        'sessionId': session,
        'requestId': request_id,
        'timestamp': when.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'message': {
            'id': message_id,
            'role': 'assistant',
            'model': model,
            'usage': {
                'input_tokens': fresh,
                'output_tokens': out,
                'cache_read_input_tokens': read,
                'cache_creation_input_tokens': write,
                'cache_creation': {'ephemeral_5m_input_tokens': write_5m, 'ephemeral_1h_input_tokens': write_1h},
            },
        },
    })


class SnapshotTestCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.projects = root / 'projects'
        self.state = root / 'state'
        self.local_cwd = str(root)
        (self.projects / 'project').mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def write_transcript(self, name, lines):
        path = self.projects / 'project' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('\n'.join(lines) + '\n', encoding='utf-8')

    def write_samples(self, minutes, load=0.5, used=1000):
        self.state.mkdir(parents=True, exist_ok=True)
        with (self.state / snapshot.SAMPLES_FILE).open('a', encoding='utf-8') as handle:
            for minute in minutes:
                handle.write(json.dumps({'kind': 'sample', 'takenAt': snapshot.utc_text(minute + timedelta(seconds=2)), 'load': [load, 0, 0], 'memory': {'usedBytes': used, 'totalBytes': 8000}, 'cores': 4}) + '\n')

    def report(self, now=None, baseline=None):
        return snapshot.build_report(day=DAY, now=now or at(23, 59), projects_dir=self.projects, state_dir=self.state, prices=PRICES, agent='example-agent', hostname='box', baseline_override=baseline)


class CallAccountingTest(SnapshotTestCase):
    def test_repeated_message_and_request_counts_once_with_the_largest_values(self):
        self.write_transcript('a.jsonl', [
            usage_line(message_id='m1', request_id='r1', when=at(9, 0, 10), cwd=self.local_cwd, fresh=10, out=5),
            usage_line(message_id='m1', request_id='r1', when=at(9, 0, 20), cwd=self.local_cwd, fresh=10, out=40),
        ])
        self.write_transcript('subagents/b.jsonl', [usage_line(message_id='m1', request_id='r1', when=at(9, 0, 30), cwd=self.local_cwd, fresh=12, out=1)])

        report = self.report()

        self.assertEqual(report['rawUsageLines'], 3)
        self.assertEqual(report['uniqueCalls'], 1)
        self.assertEqual(report['totals']['inputTokens'], 12)
        self.assertEqual(report['totals']['outputTokens'], 40)

    def test_cache_write_split_is_reconciled_and_dated_model_names_find_their_price(self):
        self.write_transcript('a.jsonl', [
            usage_line(message_id='m1', request_id='r1', when=at(9), cwd=self.local_cwd, write=1_000_000, write_5m=400_000, write_1h=0),
            usage_line(message_id='m2', request_id='r2', when=at(9, 1), cwd=self.local_cwd, model='claude-haiku-4-5-20251001', fresh=1_000_000, out=1_000_000),
        ])

        report = self.report()

        self.assertAlmostEqual(report['totals']['costUsd'], 400_000 * 5.0 / 1e6 + 600_000 * 8.0 / 1e6 + 1.0 + 5.0, places=5)
        self.assertEqual(report['unpriced'], {})

    def test_an_unpriced_model_is_listed_with_its_calls_and_never_costs_zero(self):
        self.write_transcript('a.jsonl', [
            usage_line(message_id='m1', request_id='r1', when=at(9), cwd=self.local_cwd, out=1_000_000),
            usage_line(message_id='m2', request_id='r2', when=at(9, 1), cwd=self.local_cwd, model='claude-unknown-9', fresh=5),
            usage_line(message_id='m3', request_id='r3', when=at(9, 2), cwd=self.local_cwd, model='claude-unknown-9', fresh=5),
        ])

        report = self.report()
        rows = {row['model']: row for row in report['windows'][2]['usage']}

        self.assertEqual(report['unpriced'], {'claude-unknown-9': 2})
        self.assertEqual(report['windows'][2]['unpriced'], {'claude-unknown-9': 2})
        self.assertIsNone(rows['claude-unknown-9']['costUsd'])
        self.assertEqual(rows['claude-unknown-9']['unpricedCalls'], 2)
        self.assertEqual(report['totals']['unpricedCalls'], 2)
        self.assertAlmostEqual(report['totals']['costUsd'], 20.0, places=5)

    def test_prices_come_from_the_cost_table_file(self):
        prices = snapshot.load_prices(snapshot.DEFAULT_COST_TABLE)

        self.assertEqual(prices['claude-opus-5-5'], (4.0, 5.0, 8.0, 0.20, 20.0))


class WindowTest(SnapshotTestCase):
    def test_calls_fall_in_their_brasilia_window_with_session_agent_and_host(self):
        self.write_transcript('a.jsonl', [
            usage_line(message_id='m1', request_id='r1', when=at(5, 10), cwd=self.local_cwd, out=1),
            usage_line(message_id='m2', request_id='r2', when=at(5, 10, 40), cwd=self.local_cwd, session='session-b', out=1),
            usage_line(message_id='m3', request_id='r3', when=at(17, 59), cwd=self.local_cwd, out=1),
        ])

        windows = self.report()['windows']

        self.assertEqual([window['localStart'][11:16] for window in windows], ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'])
        self.assertEqual(windows[1]['totals']['calls'], 2)
        self.assertEqual(windows[1]['activeMinutes'], 1)
        self.assertEqual([(row['sessionId'], row['agent'], row['hostname']) for row in windows[1]['usage']], [('session-a', 'example-agent', 'box'), ('session-b', 'example-agent', 'box')])
        self.assertEqual(windows[4]['totals']['calls'], 1)

    def test_two_reports_at_the_same_instant_are_identical_even_after_new_calls(self):
        self.write_transcript('a.jsonl', [usage_line(message_id='m1', request_id='r1', when=at(9), cwd=self.local_cwd, out=3)])
        first = self.report(now=at(12))
        self.write_transcript('b.jsonl', [usage_line(message_id='m2', request_id='r2', when=at(12, 30), cwd=self.local_cwd, out=5)])

        self.assertEqual(first, self.report(now=at(12)))
        self.assertEqual(self.report(now=at(13))['totals']['outputTokens'], 8)


class BaselineTest(SnapshotTestCase):
    def test_calls_from_another_machine_before_the_first_local_call_are_left_out_and_the_baseline_is_kept(self):
        self.write_transcript('old.jsonl', [
            usage_line(message_id='old', request_id='r0', when=at(8), cwd='E:\\Projects\\example', out=99),
            usage_line(message_id='old-linux', request_id='r9', when=at(8, 30), cwd='/srv/another-machine/project', out=50),
        ])
        self.write_transcript('new.jsonl', [usage_line(message_id='new', request_id='r1', when=at(10), cwd=self.local_cwd, session='local', out=1)])

        report = self.report()
        stored = json.loads((self.state / snapshot.BASELINE_FILE).read_text(encoding='utf-8'))
        self.write_transcript('earlier.jsonl', [usage_line(message_id='earlier', request_id='r2', when=at(9), cwd=self.local_cwd, out=7)])

        self.assertEqual(report['totals']['outputTokens'], 1)
        self.assertEqual(report['baseline']['sessionId'], 'local')
        self.assertEqual(report['baseline']['source'], 'first-local-call')
        self.assertEqual(stored, report['baseline'])
        self.assertEqual(self.report()['baseline'], report['baseline'])
        self.assertEqual(self.report()['totals']['outputTokens'], 1)

    def test_calls_copied_from_a_windows_machine_after_the_baseline_are_left_out(self):
        self.write_transcript('new.jsonl', [usage_line(message_id='new', request_id='r1', when=at(10), cwd=self.local_cwd, out=1)])
        self.write_transcript('copied.jsonl', [usage_line(message_id='copied', request_id='r2', when=at(11), cwd='E:\\Projects\\example', out=40)])

        report = self.report()

        self.assertEqual(report['totals']['outputTokens'], 1)
        self.assertEqual(report['foreignUsageLines'], 1)


class SampleWindowTest(SnapshotTestCase):
    def test_a_window_with_missing_samples_reports_the_gap_and_never_zero(self):
        self.write_transcript('a.jsonl', [usage_line(message_id='m1', request_id='r1', when=at(4), cwd=self.local_cwd, out=1)])
        sampled = [at(4) + timedelta(minutes=offset) for offset in range(240) if not 60 <= offset < 90]
        self.write_samples(sampled[:10], load=0.5, used=1000)
        self.write_samples(sampled[10:], load=2.5, used=3000)

        windows = self.report()['windows']
        samples = windows[1]['samples']

        self.assertEqual(samples['expected'], 240)
        self.assertEqual(samples['received'], 210)
        self.assertEqual(samples['gaps'], [{'start': snapshot.utc_text(at(5)), 'end': snapshot.utc_text(at(5, 30)), 'minutes': 30}])
        self.assertEqual(samples['load1']['peak'], 2.5)
        self.assertAlmostEqual(samples['load1']['average'], (10 * 0.5 + 200 * 2.5) / 210, places=3)
        self.assertEqual(samples['memoryUsedBytes']['peak'], 3000)
        self.assertEqual(windows[2]['samples']['received'], 0)
        self.assertEqual(windows[2]['samples']['gaps'][0]['minutes'], 240)
        self.assertIsNone(windows[2]['samples']['load1'])
        self.assertIsNone(windows[2]['samples']['memoryUsedBytes'])

    def test_minutes_before_the_baseline_and_after_now_are_not_expected(self):
        self.write_transcript('a.jsonl', [usage_line(message_id='m1', request_id='r1', when=at(5, 30), cwd=self.local_cwd, out=1)])

        windows = self.report(now=at(6, 0, 30))['windows']

        self.assertEqual(windows[0]['samples']['expected'], 0)
        self.assertEqual(windows[1]['samples']['expected'], 30)
        self.assertFalse(windows[1]['complete'])


class SampleCommandTest(SnapshotTestCase):
    def test_sample_records_the_docker_failure_in_the_line_instead_of_failing(self):
        exit_code = snapshot.main(['--state-dir', str(self.state), '--agent', 'example-agent', 'sample', '--docker-command', str(self.state / 'missing-docker')])

        line = json.loads((self.state / snapshot.SAMPLES_FILE).read_text(encoding='utf-8'))
        self.assertEqual(exit_code, 0)
        self.assertIsNone(line['docker'])
        self.assertEqual([error['probe'] for error in line['errors']], ['docker'])
        self.assertEqual(line['agent'], 'example-agent')
        self.assertGreater(line['memory']['totalBytes'], 0)

    def test_docker_sizes_are_read_in_bytes(self):
        self.assertEqual(snapshot.size_bytes('7.75MiB'), int(7.75 * 1024**2))
        self.assertEqual(snapshot.size_bytes('1.6kB'), 1600)
        self.assertIsNone(snapshot.size_bytes('n/a'))

    def test_report_prints_one_json_line(self):
        output = io.StringIO()
        with redirect_stdout(output):
            snapshot.main(['--state-dir', str(self.state), '--agent', 'example-agent', 'report', '--projects-dir', str(self.projects), '--day', DAY.isoformat(), '--now', at(12).isoformat()])

        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])['day'], DAY.isoformat())


if __name__ == '__main__':
    unittest.main()
