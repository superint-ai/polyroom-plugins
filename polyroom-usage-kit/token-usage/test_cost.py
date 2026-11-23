import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('cost.py')


def call(message_id, model):
    return json.dumps({'timestamp': '2026-11-20T12:00:00Z', 'requestId': f'request-{message_id}', 'message': {
        'id': message_id, 'role': 'assistant', 'model': model,
        'usage': {'input_tokens': 100, 'output_tokens': 1000, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0}}})


class CostTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)

    def cost(self, calls, *arguments):
        (self.root / 'project').mkdir(exist_ok=True)
        (self.root / 'project' / 'session.jsonl').write_text('\n'.join(calls) + '\n', encoding='utf-8')
        return subprocess.run([sys.executable, '-I', str(SCRIPT), '2026-11-20T00:00:00+00:00', '2026-11-21T00:00:00+00:00', '--root', f'main={self.root}', *arguments],
                              capture_output=True, text=True, check=True, timeout=60).stdout

    def test_the_buckets_count_calls_without_a_price_apart_and_say_the_total_leaves_them_out(self):
        unknown = call('a', 'claude-unknown-9')
        known = call('b', 'claude-opus-5-5')
        for name, calls, priced, unpriced in [
            ('unknown only', [unknown], 'priced calls 0', 'unpriced calls 1 (claude-unknown-9 1): no price in the table, so the total leaves them out'),
            ('mixed', [unknown, known], 'priced calls 1', 'unpriced calls 1 (claude-unknown-9 1): no price in the table, so the total leaves them out'),
            ('known only', [known], 'priced calls 1', None),
        ]:
            with self.subTest(name):
                output = self.cost(calls, '--buckets').splitlines()
                self.assertTrue(any(line.endswith(priced) for line in output), output)
                if unpriced:
                    self.assertIn(unpriced, output)
                else:
                    self.assertFalse(any(line.startswith('unpriced') for line in output), output)

    def test_the_daily_rows_list_calls_without_a_price_and_never_cost_them_zero(self):
        report = json.loads(self.cost([call('a', 'claude-unknown-9'), call('b', 'claude-opus-5-5')]))
        self.assertEqual(report['unpriced'], {'claude-unknown-9': 1})
        self.assertEqual(report['rows'][0]['calls'], 2)
        self.assertAlmostEqual(report['rows'][0]['cost'], (100 * 4.0 + 1000 * 20.0) / 1_000_000)


if __name__ == '__main__':
    unittest.main()
