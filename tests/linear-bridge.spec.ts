/** Exercise the private GraphQL bridge without posting to Linear. */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('retries writes once per outbound ID, verifies authorship and scope, and never echoes credentials', () => {
  const code = String.raw`
import argparse, runpy, tempfile, urllib.error, unittest.mock as mock
from pathlib import Path
m = runpy.run_path(${JSON.stringify(join(import.meta.dirname, '..', 'scripts', 'linear-source'))})
run, own_reply, comment_id, Error = [m[k] for k in ['run', 'own_reply', 'comment_id', 'BridgeError']]
class Fake:
    def __init__(self): self.writes = []; self.comments = {}; self.moved = False
    def query(self, query, variables=None):
        v = variables or {}
        if 'commentCreate' in query:
            item = dict(v['input']); self.writes.append(item); self.comments[item['id']] = item
            return {'commentCreate': {'success': True, 'comment': {'id': item['id']}}}
        if 'comments(first: 1,' in query:
            item = self.comments.get(v['id']['id']['eq'])
            return {'comments': {'nodes': [{'id': item['id'], 'body': item['body'], 'issue': {'id': item['issueId']}}] if item else []}}
        if 'issue(id:' in query:
            return {'issue': {'id': 'issue', 'team': {'id': 'other' if self.moved else 'team'}, 'project': None}}
        self.last = v
        if 'viewer { id }' in query:
            return {'viewer': {'id': 'user'}, 'comments': {'nodes': [], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}}
        return {'issues': {'nodes': [], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}}
args = argparse.Namespace(operation='reply', issue='issue', team='team', project='', key='message-1', text='Ready')
c = Fake()
assert run(c, args) == {'sent': True}
assert run(c, args) == {'sent': True} and len(c.writes) == 1
assert c.writes[0]['id'] == comment_id('message-1')
record = {'id': comment_id('message-1'), 'body': c.writes[0]['body'], 'user': {'id': 'user'}}
assert own_reply(record, 'user')
assert not own_reply({**record, 'id': 'ordinary-comment'}, 'user')
assert not own_reply({**record, 'user': {'id': 'other'}}, 'user')
c.moved = True
try: run(c, args); raise AssertionError('cross-team reply accepted')
except Error as e: assert e.code == 410
assert len(c.writes) == 1
args = argparse.Namespace(operation='issues', team='team', project='project', label='superagent', states='Todo, Ready', after='cursor')
run(c, args)
assert c.last['filter'] == {'team': {'id': {'eq': 'team'}}, 'project': {'id': {'eq': 'project'}}, 'labels': {'name': {'eq': 'superagent'}}, 'state': {'name': {'in': ['Todo', 'Ready']}}}
args.operation = 'comments'; args.since = '2026-11-02T00:00:00Z'
run(c, args)
assert c.last['filter']['issue']['team']['id']['eq'] == 'team'
assert 'state' not in c.last['filter']['issue']
assert c.last['filter']['updatedAt']['gte'] == args.since
with tempfile.TemporaryDirectory() as d:
    p = Path(d) / 'credential'; p.write_text('lin_api_PRIVATE_TEST_VALUE')
    client = m['Client'](p)
    with mock.patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError('https://api.linear.app/graphql', 401, 'lin_api_PRIVATE_TEST_VALUE', {}, None)):
        try: client.query('query { viewer { id } }'); raise AssertionError('request unexpectedly succeeded')
        except Error as e: assert 'PRIVATE_TEST_VALUE' not in str(e) and e.code == 401
print('bridge behavior verified')
`
  expect(execFileSync('python3', ['-c', code], { encoding: 'utf8' })).toContain('bridge behavior verified')
})
