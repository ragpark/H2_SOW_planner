import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, startServer } from './helpers.js';

let server;
let token;

before(async () => {
  server = await startServer();
  token = await signIn(server.call);
});

after(async () => { await server.close(); });

const call = (...args) => server.call(...args);

test('health check reports the subject the tool is configured for', async () => {
  const res = await call('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.subject, 'chemistry');
});

test('the api refuses anonymous access to the curriculum and to schemes', async () => {
  assert.equal((await call('GET', '/api/curriculum')).status, 401);
  assert.equal((await call('GET', '/api/schemes')).status, 401);
});

test('a local sign-in produces a usable session', async () => {
  const res = await call('GET', '/api/session', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.authenticated, true);
  assert.equal(res.body.session.user.displayName, 'Miss Hart');
  assert.equal(res.body.session.permissions.canEdit, true);
});

test('the curriculum library is served with units and statements', async () => {
  const res = await call('GET', '/api/curriculum', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.subject, 'chemistry');
  assert.ok(res.body.units.length >= 9);
  assert.ok(res.body.strands.some((s) => s.id === 'ws'));
  assert.ok(res.body.units[0].statementIds.length > 0);
});

test('a unit carries its misconceptions, practicals and lessons', async () => {
  const res = await call('GET', '/api/curriculum/units/u-acids', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Acids, Alkalis and Salts');
  assert.ok(res.body.misconceptions.length >= 3);
  assert.ok(res.body.practicals.every((p) => p.hazards.length && p.control.length));
  assert.equal(res.body.lessons.length, res.body.suggestedLessons);
  assert.ok(res.body.prerequisites.some((p) => p.id === 'u-reactions'));
});

test('an unknown unit or lesson is a 404', async () => {
  assert.equal((await call('GET', '/api/curriculum/units/nope', { token })).status, 404);
  assert.equal((await call('GET', '/api/curriculum/lessons/nope', { token })).status, 404);
});

test('creating a scheme with auto-plan produces a full, covered year', async () => {
  const res = await call('POST', '/api/schemes', {
    token,
    body: { title: 'Y9 Chemistry Set 2', autoPlan: true, lessonsPerWeek: 2, academicYear: '2026/27' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.scheme.title, 'Y9 Chemistry Set 2');
  assert.equal(res.body.stats.coveragePercent, 100);
  assert.ok(res.body.placements.length >= 9);
  assert.ok(res.body.timeline.weeks.length > 30);
  assert.equal(res.body.findings.filter((f) => f.severity === 'error').length, 0);
});

test('a scheme rejects nonsense configuration', async () => {
  const bad = await call('POST', '/api/schemes', { token, body: { lessonsPerWeek: 99 } });
  assert.equal(bad.status, 400);
  const badYear = await call('POST', '/api/schemes', { token, body: { yearGroup: 3 } });
  assert.equal(badYear.status, 400);
  const badTerms = await call('POST', '/api/schemes', { token, body: { terms: [{ name: 'x', weeks: 0 }] } });
  assert.equal(badTerms.status, 400);
});

test('units can be added, reordered, resized and removed', async () => {
  const created = await call('POST', '/api/schemes', { token, body: { title: 'Manual build' } });
  const id = created.body.scheme.id;
  assert.equal(created.body.placements.length, 0);

  await call('POST', `/api/schemes/${id}/units`, { token, body: { unitId: 'u-reactions' } });
  const two = await call('POST', `/api/schemes/${id}/units`, { token, body: { unitId: 'u-particles' } });
  assert.deepEqual(two.body.placements.map((p) => p.unitId), ['u-reactions', 'u-particles']);

  // Reactions before Particles trips the sequencing check.
  assert.ok(two.body.findings.some((f) => f.code === 'out-of-sequence' || f.code === 'missing-prerequisite'));

  const order = [two.body.placements[1].id, two.body.placements[0].id];
  const reordered = await call('POST', `/api/schemes/${id}/reorder`, { token, body: { order } });
  assert.deepEqual(reordered.body.placements.map((p) => p.unitId), ['u-particles', 'u-reactions']);

  const resized = await call('PATCH', `/api/schemes/${id}/units/${order[0]}`, {
    token,
    body: { lessonsAllocated: 10 }
  });
  assert.equal(resized.body.placements[0].lessonsAllocated, 10);

  const removed = await call('DELETE', `/api/schemes/${id}/units/${order[0]}`, { token });
  assert.equal(removed.body.placements.length, 1);
});

test('the same unit cannot be added twice', async () => {
  const created = await call('POST', '/api/schemes', { token, body: { title: 'Dupes' } });
  const id = created.body.scheme.id;
  await call('POST', `/api/schemes/${id}/units`, { token, body: { unitId: 'u-earth' } });
  const again = await call('POST', `/api/schemes/${id}/units`, { token, body: { unitId: 'u-earth' } });
  assert.equal(again.status, 409);
});

test('lesson notes are stored against the scheme and appear in the detail', async () => {
  const created = await call('POST', '/api/schemes', { token, body: { title: 'Notes', autoPlan: true } });
  const id = created.body.scheme.id;
  const saved = await call('PUT', `/api/schemes/${id}/lessons/u-acids.l3`, {
    token,
    body: { status: 'ready', notes: 'Pre-book the fume cupboard.' }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.note.status, 'ready');

  const detail = await call('GET', `/api/schemes/${id}`, { token });
  assert.equal(detail.body.lessonNotes['u-acids.l3'].notes, 'Pre-book the fume cupboard.');

  const badStatus = await call('PUT', `/api/schemes/${id}/lessons/u-acids.l3`, {
    token,
    body: { status: 'invented' }
  });
  assert.equal(badStatus.status, 400);
});

test('a scheme exports as markdown and as json', async () => {
  const created = await call('POST', '/api/schemes', { token, body: { title: 'Export me', autoPlan: true } });
  const id = created.body.scheme.id;

  const md = await call('GET', `/api/schemes/${id}/export`, { token });
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-disposition'), /export-me\.md/);
  assert.match(md.body, /# Export me/);
  assert.match(md.body, /## Long-term plan/);
  assert.match(md.body, /Common misconceptions/);
  assert.match(md.body, /not a risk assessment/i);

  const json = await call('GET', `/api/schemes/${id}/export?format=json`, { token });
  assert.equal(json.status, 200);
  assert.equal(json.body.scheme.title, 'Export me');
});

test('a single lesson exports as a one-page plan', async () => {
  const created = await call('POST', '/api/schemes', { token, body: { title: 'Plans', autoPlan: true } });
  const id = created.body.scheme.id;
  const res = await call('GET', `/api/schemes/${id}/lessons/u-periodic.l4/plan`, { token });
  assert.equal(res.status, 200);
  assert.match(res.body.markdown, /# Group 1: the alkali metals/);
  assert.match(res.body.markdown, /## Practical: Group 1 metals with water/);
  assert.match(res.body.markdown, /behind safety screens/);
});

test('one teacher cannot see or edit another teacher\'s scheme', async () => {
  const mine = await call('POST', '/api/schemes', { token, body: { title: 'Private' } });
  const otherToken = await signIn(call, 'Mr Okafor');

  assert.equal((await call('GET', `/api/schemes/${mine.body.scheme.id}`, { token: otherToken })).status, 404);
  assert.equal(
    (await call('PATCH', `/api/schemes/${mine.body.scheme.id}`, { token: otherToken, body: { title: 'Hijacked' } }))
      .status,
    404
  );
  assert.equal((await call('DELETE', `/api/schemes/${mine.body.scheme.id}`, { token: otherToken })).status, 404);

  const stillMine = await call('GET', `/api/schemes/${mine.body.scheme.id}`, { token });
  assert.equal(stillMine.body.scheme.title, 'Private');
});

test('a scheme can be duplicated and then deleted independently', async () => {
  const original = await call('POST', '/api/schemes', { token, body: { title: 'Master copy', autoPlan: true } });
  const copy = await call('POST', `/api/schemes/${original.body.scheme.id}/duplicate`, { token });
  assert.equal(copy.status, 201);
  assert.equal(copy.body.scheme.title, 'Master copy (copy)');
  assert.equal(copy.body.placements.length, original.body.placements.length);

  assert.equal((await call('DELETE', `/api/schemes/${copy.body.scheme.id}`, { token })).status, 204);
  assert.equal((await call('GET', `/api/schemes/${copy.body.scheme.id}`, { token })).status, 404);
  assert.equal((await call('GET', `/api/schemes/${original.body.scheme.id}`, { token })).status, 200);
});

test('changing the term structure reflows the plan', async () => {
  const created = await call('POST', '/api/schemes', { token, body: { title: 'Reflow', autoPlan: true } });
  const id = created.body.scheme.id;
  const shortened = await call('PATCH', `/api/schemes/${id}`, {
    token,
    body: { terms: [{ name: 'Single term', weeks: 6 }], lessonsPerWeek: 2 }
  });
  assert.equal(shortened.status, 200);
  assert.equal(shortened.body.stats.lessonsAvailable, 12);
  assert.ok(shortened.body.findings.some((f) => f.code === 'over-capacity'));
});

test('signing out invalidates the session', async () => {
  const temp = await signIn(call, 'Temp');
  assert.equal((await call('GET', '/api/schemes', { token: temp })).status, 200);
  assert.equal((await call('DELETE', '/api/session', { token: temp })).status, 204);
  assert.equal((await call('GET', '/api/schemes', { token: temp })).status, 401);
});
