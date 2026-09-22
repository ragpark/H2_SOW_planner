import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TERMS,
  autoPlan,
  buildCalendar,
  buildTimeline,
  computeCoverage,
  reviewScheme,
  schemeStats
} from '../src/services/planner.js';
import { curriculum, validateCurriculum } from '../src/curriculum/index.js';

const scheme = (over = {}) => ({ terms: DEFAULT_TERMS, lessonsPerWeek: 2, ...over });
const withIds = (placements) => placements.map((p, i) => ({ ...p, id: `p${i}` }));

test('bundled curriculum content is referentially sound', () => {
  assert.deepEqual(validateCurriculum(), []);
  assert.ok(curriculum.units.length >= 9);
  assert.ok(curriculum.totalLessons() >= 50);
});

test('calendar expands terms into weeks and lesson slots', () => {
  const cal = buildCalendar([{ name: 'A', weeks: 2 }, { name: 'B', weeks: 3 }], 3);
  assert.equal(cal.totalWeeks, 5);
  assert.equal(cal.totalLessonSlots, 15);
  assert.equal(cal.weeks[0].globalWeek, 1);
  assert.equal(cal.weeks[4].termName, 'B');
  assert.equal(cal.weeks[4].weekInTerm, 3);
});

test('auto-plan lays the default sequence out inside a normal school year', () => {
  const plan = autoPlan({ lessonsPerWeek: 2 });
  assert.equal(plan.unplaced.length, 0);
  assert.equal(plan.placements.length, curriculum.units.length);
  assert.ok(plan.lessonsAllocated <= plan.lessonsAvailable);
  // The suggested order is followed.
  const expected = [...curriculum.units].sort((a, b) => a.suggestedPosition - b.suggestedPosition).map((u) => u.id);
  assert.deepEqual(plan.placements.map((p) => p.unitId), expected);
});

test('auto-plan reports units that do not fit rather than truncating them', () => {
  // Four lesson slots: the first unit (7 lessons) does not fit whole, and no
  // unit is silently cut down to size.
  const plan = autoPlan({ terms: [{ name: 'Short', weeks: 2 }], lessonsPerWeek: 2 });
  assert.equal(plan.lessonsAvailable, 4);
  assert.equal(plan.placements.length, 0);
  assert.equal(plan.unplaced.length, curriculum.units.length);
  assert.equal(plan.lessonsAllocated, 0);
});

test('auto-plan fills what it can and reports the rest', () => {
  const plan = autoPlan({
    terms: [{ name: 'Short', weeks: 3 }],
    lessonsPerWeek: 2,
    unitIds: ['u-materials', 'u-particles']
  });
  assert.deepEqual(plan.placements.map((p) => p.unitId), ['u-materials']);
  assert.deepEqual(plan.unplaced.map((p) => p.unitId), ['u-particles']);
});

test('the default plan covers the whole key stage 3 chemistry programme of study', () => {
  const coverage = computeCoverage(autoPlan({}).placements);
  assert.equal(coverage.percent, 100);
  assert.deepEqual(coverage.gaps, []);
});

test('coverage reports gaps when units are missing', () => {
  const coverage = computeCoverage([{ unitId: 'u-particles' }]);
  assert.ok(coverage.percent < 100);
  assert.ok(coverage.gaps.some((g) => g.id.startsWith('ea.')));
  const pis = coverage.strands.find((s) => s.id === 'pis');
  assert.equal(pis.covered, pis.total);
});

test('timeline distributes a unit lesson by lesson across the weeks it occupies', () => {
  const s = scheme();
  const placements = withIds([
    { unitId: 'u-particles', position: 0, termIndex: 0, weekInTerm: 1, lessonsAllocated: 7 }
  ]);
  const timeline = buildTimeline(s, placements);
  const taught = timeline.weeks.filter((w) => w.entries.length);
  assert.equal(taught.length, 4); // 7 lessons at 2 a week
  assert.equal(taught[0].entries[0].lessons.length, 2);
  assert.equal(taught[3].entries[0].lessons.length, 1);
  const titles = taught.flatMap((w) => w.entries.flatMap((e) => e.lessons.map((l) => l.title)));
  assert.equal(titles.length, 7);
  assert.equal(titles[0], 'Rebuilding the particle model');
});

test('timeline marks capacity beyond a unit\'s own lessons as spare', () => {
  const placements = withIds([
    { unitId: 'u-materials', position: 0, termIndex: 0, weekInTerm: 1, lessonsAllocated: 8 }
  ]);
  const timeline = buildTimeline(scheme(), placements);
  const spare = timeline.weeks.reduce((n, w) => n + w.entries.reduce((m, e) => m + e.spareLessons, 0), 0);
  assert.equal(spare, 4); // the unit defines 4 lessons, 8 were allocated
});

test('review flags a scheme that needs more lessons than the year has', () => {
  const s = scheme({ terms: [{ name: 'Only term', weeks: 4 }] });
  const placements = withIds([
    { unitId: 'u-particles', position: 0, termIndex: 0, weekInTerm: 1, lessonsAllocated: 20 }
  ]);
  const { findings } = reviewScheme(s, placements);
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes('over-capacity'));
  assert.equal(findings[0].severity, 'error');
});

test('review flags a unit taught before its prerequisite', () => {
  const placements = withIds([
    { unitId: 'u-acids', position: 0, termIndex: 0, weekInTerm: 1, lessonsAllocated: 7 },
    { unitId: 'u-reactions', position: 1, termIndex: 1, weekInTerm: 1, lessonsAllocated: 7 }
  ]);
  const { findings } = reviewScheme(scheme(), placements);
  const outOfSequence = findings.find((f) => f.code === 'out-of-sequence');
  assert.ok(outOfSequence);
  assert.equal(outOfSequence.unitId, 'u-acids');
  assert.match(outOfSequence.detail, /Chemical Reactions/);
});

test('review flags a prerequisite that is absent altogether', () => {
  const placements = withIds([
    { unitId: 'u-acids', position: 0, termIndex: 0, weekInTerm: 1, lessonsAllocated: 7 }
  ]);
  const { findings } = reviewScheme(scheme(), placements);
  assert.ok(findings.some((f) => f.code === 'missing-prerequisite'));
});

test('review flags a long stretch with no practical work', () => {
  // A unit stretched far beyond its own lessons leaves practical-free weeks.
  const placements = withIds([
    { unitId: 'u-particles', position: 0, termIndex: 0, weekInTerm: 1, lessonsAllocated: 20 }
  ]);
  const { findings } = reviewScheme(scheme(), placements);
  assert.ok(findings.some((f) => f.code === 'practical-gap'));
});

test('review is quiet about a sound default plan', () => {
  const placements = withIds(autoPlan({}).placements);
  const { findings } = reviewScheme(scheme(), placements);
  assert.deepEqual(findings.filter((f) => f.severity === 'error'), []);
  assert.deepEqual(findings.filter((f) => f.code === 'coverage-gaps'), []);
});

test('an empty scheme is reported as empty, not as broken', () => {
  const { findings } = reviewScheme(scheme(), []);
  assert.ok(findings.some((f) => f.code === 'empty-scheme'));
  assert.equal(findings.filter((f) => f.severity === 'error').length, 0);
});

test('stats summarise the plan for the dashboard', () => {
  const placements = withIds(autoPlan({}).placements);
  const stats = schemeStats(scheme(), placements);
  assert.equal(stats.unitCount, curriculum.units.length);
  assert.equal(stats.lessonsAvailable, 78);
  assert.ok(stats.practicalCount > 20);
  assert.equal(stats.coveragePercent, 100);
});
