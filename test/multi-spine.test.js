import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load a second, synthetic curriculum alongside chemistry so the paths that
// only exist with more than one installed are exercised for real.
process.env.CURRICULUM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'spines');

const { startServer, signIn } = await import('./helpers.js');
const { registry } = await import('../src/curriculum/index.js');
registry.reload();

let server;
let token;

before(async () => {
  server = await startServer();
  token = await signIn(server.call);
});

after(async () => {
  await server.close();
});

const call = (...args) => server.call(...args);

test('both curricula are offered, across subject and key stage', async () => {
  const res = await call('GET', '/api/subjects', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.subjects, ['chemistry', 'fixtures']);
  assert.deepEqual(res.body.keyStages, ['KS3', 'KS4']);
  // With two installed, neither is the default — the teacher must choose.
  assert.equal(res.body.default, null);
  assert.deepEqual(res.body.spines.map((s) => s.id).sort(), ['chemistry-ks3', 'fixtures-ks4']);
});

test('a scheme must say which curriculum it is for when more than one exists', async () => {
  const res = await call('POST', '/api/schemes', { token, body: { title: 'Ambiguous' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /subject and keyStage are required/);
});

test('a scheme is created against the named subject and key stage', async () => {
  const res = await call('POST', '/api/schemes', {
    token,
    body: { title: 'KS4 Fixtures', subject: 'fixtures', keyStage: 'KS4', autoPlan: true,
            terms: [{ name: 'Term', weeks: 4 }], lessonsPerWeek: 1 }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.scheme.subject, 'fixtures');
  assert.equal(res.body.scheme.keyStage, 'KS4');
  assert.equal(res.body.scheme.spineId, 'fixtures-ks4');
  assert.equal(res.body.scheme.yearGroup, 10, 'the year group defaults from the spine');
  assert.deepEqual(res.body.placements.map((p) => p.unitId), ['fx-first', 'fx-second']);
  // Coverage is measured against the fixture statements, not chemistry's.
  assert.ok(res.body.coverage.strands.some((s) => s.id === 'alpha'));
  assert.ok(!res.body.coverage.strands.some((s) => s.id === 'pnm'));
});

test('a scheme cannot take a unit from a different curriculum', async () => {
  const created = await call('POST', '/api/schemes', {
    token,
    body: { title: 'Fixture scheme', subject: 'fixtures', keyStage: 'KS4' }
  });
  const id = created.body.scheme.id;

  const wrongSubject = await call('POST', `/api/schemes/${id}/units`, {
    token,
    body: { unitId: 'u-acids' }
  });
  assert.equal(wrongSubject.status, 409);
  assert.match(wrongSubject.body.error, /belongs to Key stage 3 Chemistry/);

  const unknown = await call('POST', `/api/schemes/${id}/units`, { token, body: { unitId: 'nope' } });
  assert.equal(unknown.status, 404);

  const right = await call('POST', `/api/schemes/${id}/units`, { token, body: { unitId: 'fx-first' } });
  assert.equal(right.status, 200);
  assert.deepEqual(right.body.placements.map((p) => p.unitId), ['fx-first']);
});

test('a lesson note must belong to the scheme\'s own curriculum', async () => {
  const created = await call('POST', '/api/schemes', {
    token,
    body: { title: 'Notes scope', subject: 'fixtures', keyStage: 'KS4', autoPlan: true,
            terms: [{ name: 'Term', weeks: 4 }], lessonsPerWeek: 1 }
  });
  const id = created.body.scheme.id;

  const foreign = await call('PUT', `/api/schemes/${id}/lessons/u-acids.l3`, {
    token, body: { status: 'ready' }
  });
  assert.equal(foreign.status, 404);
  assert.match(foreign.body.error, /Key stage 4 Fixtures/);

  const own = await call('PUT', `/api/schemes/${id}/lessons/fx-first.l1`, {
    token, body: { status: 'ready', notes: 'Fixture note' }
  });
  assert.equal(own.status, 200);
  assert.equal(own.body.note.status, 'ready');
});

test('the library can be requested per curriculum', async () => {
  const bySpine = await call('GET', '/api/curriculum?spine=fixtures-ks4', { token });
  assert.equal(bySpine.status, 200);
  assert.equal(bySpine.body.id, 'fixtures-ks4');
  assert.equal(bySpine.body.unitCount, 2);

  const byPair = await call('GET', '/api/curriculum?subject=chemistry&keyStage=KS3', { token });
  assert.equal(byPair.body.id, 'chemistry-ks3');
  assert.equal(byPair.body.unitCount, 9);

  // Ambiguous with two installed and nothing specified.
  const ambiguous = await call('GET', '/api/curriculum', { token });
  assert.equal(ambiguous.status, 400);
  assert.match(ambiguous.body.error, /specify which curriculum/);
  assert.deepEqual(ambiguous.body.installed.sort(), ['chemistry-ks3', 'fixtures-ks4']);
});

test('asking for a curriculum that is not installed says so, and names what is', async () => {
  // Distinct from not asking at all: this is a wrong answer, not a missing one.
  const unknownId = await call('GET', '/api/curriculum?spine=physics-ks3', { token });
  assert.equal(unknownId.status, 404);
  assert.match(unknownId.body.error, /no curriculum "physics-ks3" is installed/);
  assert.ok(unknownId.body.installed.includes('chemistry-ks3'));

  const unknownPair = await call('GET', '/api/curriculum?subject=physics&keyStage=KS3', { token });
  assert.equal(unknownPair.status, 404);
  assert.match(unknownPair.body.error, /no curriculum is installed for physics at KS3/);
});

test('a unit or lesson resolves to its owning curriculum without being told', async () => {
  const unit = await call('GET', '/api/curriculum/units/fx-first', { token });
  assert.equal(unit.status, 200);
  assert.equal(unit.body.spineId, 'fixtures-ks4');

  const lesson = await call('GET', '/api/curriculum/lessons/u-acids.l3', { token });
  assert.equal(lesson.status, 200);
  assert.equal(lesson.body.spineId, 'chemistry-ks3');
});

test('schemes from different curricula coexist and each reports its own', async () => {
  await call('POST', '/api/schemes', {
    token, body: { title: 'Chem side', subject: 'chemistry', keyStage: 'KS3', autoPlan: true }
  });
  const list = await call('GET', '/api/schemes', { token });
  const byTitle = Object.fromEntries(list.body.schemes.map((s) => [s.title, s]));
  assert.equal(byTitle['Chem side'].spineId, 'chemistry-ks3');
  assert.equal(byTitle['Chem side'].spineTitle, 'Key stage 3 Chemistry');
  assert.equal(byTitle['KS4 Fixtures'].spineId, 'fixtures-ks4');
  assert.equal(byTitle['Chem side'].stats.coveragePercent, 100);
});

test('an export names the curriculum it was planned against', async () => {
  const created = await call('POST', '/api/schemes', {
    token,
    body: { title: 'Fixture export', subject: 'fixtures', keyStage: 'KS4', autoPlan: true,
            terms: [{ name: 'Term', weeks: 4 }], lessonsPerWeek: 1 }
  });
  const md = await call('GET', `/api/schemes/${created.body.scheme.id}/export`, { token });
  assert.equal(md.status, 200);
  assert.match(md.body, /\*\*Year 10 Fixtures\*\* · Key stage 4/);
  assert.match(md.body, /Key stage 4 Fixtures statements/);
  assert.match(md.body, /First Fixture Unit/);
  assert.doesNotMatch(md.body, /chemistry/i);
});
