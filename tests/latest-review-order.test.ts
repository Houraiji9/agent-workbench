import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {latestReview} from '../src/core/latest-review.ts';

function fixture(reviews: Array<Record<string, unknown>>) {
  const schema = fs.readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  db.exec("INSERT INTO projects(id,data) VALUES ('P-test','{}'); INSERT INTO tasks(id,project_id,data) VALUES ('T-test','P-test','{}'); INSERT INTO runs(id,task_id,data) VALUES ('R-test','T-test','{}');");
  assert.deepEqual(db.prepare('PRAGMA table_info(reviews)').all().map(row => row.name), ['id', 'run_id', 'data']);
  const insert = db.prepare('INSERT INTO reviews (id,run_id,data) VALUES (?,?,?)');
  for (const review of reviews) insert.run(String(review.id), 'R-test', JSON.stringify({...review, run_id: 'R-test'}));
  return {db, wb: {db} as any};
}
const older = '2026-10-24T01:00:00.000Z', newer = '2026-10-25T01:00:00.000Z';

test('a later-inserted old pass cannot replace a newer failed review stored in JSON', () => {
  const f = fixture([{id:'new-fail',created_at:newer,verdict:'changes_requested'},{id:'old-pass',created_at:older,verdict:'passed'}]);
  try {assert.equal(latestReview(f.wb,'R-test')?.id,'new-fail');assert.equal(latestReview(f.wb,'R-test')?.verdict,'changes_requested');} finally {f.db.close();}
});
test('a later-inserted old review cannot replace the newer revoked decision', () => {
  const f = fixture([{id:'new-revoked',created_at:newer,verdict:'passed',revoked_at:newer},{id:'old-pass',created_at:older,verdict:'passed'}]);
  try {assert.equal(latestReview(f.wb,'R-test'),undefined);} finally {f.db.close();}
});
test('a newer legitimate pass wins over a later-inserted old failure', () => {
  const f = fixture([{id:'new-pass',created_at:newer,verdict:'passed'},{id:'old-fail',created_at:older,verdict:'changes_requested'}]);
  try {assert.equal(latestReview(f.wb,'R-test')?.id,'new-pass');} finally {f.db.close();}
});
test('only equal JSON timestamps use insertion order as the deciding tie-break', () => {
  const f = fixture([{id:'first-pass',created_at:newer,verdict:'passed'},{id:'second-fail',created_at:newer,verdict:'changes_requested'}]);
  try {assert.equal(latestReview(f.wb,'R-test')?.id,'second-fail');} finally {f.db.close();}
});
