import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectDirFor, newestTranscript, parseArgs, USAGE } from '../src/cli.js';

test('projectDirFor turns cwd slashes into dashes', () => {
  assert.match(projectDirFor('/home/me/proj'), /projects[\\/]-home-me-proj$/);
});

test('newestTranscript returns null for a missing directory instead of throwing', () => {
  assert.equal(newestTranscript('/definitely/not/here'), null);
});

test('parseArgs understands value options and bare switches', () => {
  const args = parseArgs(['report', '--transcript', '/tmp/a.jsonl', '--reset-config']);
  assert.deepEqual(args._, ['report']);
  assert.equal(args.transcript, '/tmp/a.jsonl');
  assert.equal(args['reset-config'], true);
});

test('USAGE mentions remote-refresh and the price config migration', () => {
  assert.match(USAGE, /remote-refresh/);
  assert.match(USAGE, /providers/);
});
