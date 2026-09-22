import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const nc = readJson(join(here, 'nc-ks3-chemistry.json'));

const unitFiles = readdirSync(join(here, 'units'))
  .filter((f) => f.endsWith('.json'))
  .sort();

const units = unitFiles.map((f) => readJson(join(here, 'units', f)));

/**
 * Units that should normally be taught before a given unit. Used by the
 * sequencing checker to warn a teacher when the order they have chosen
 * asks pupils to use knowledge they have not met yet.
 */
const prerequisites = {
  'u-atoms': ['u-particles'],
  'u-periodic': ['u-atoms'],
  'u-reactions': ['u-atoms', 'u-periodic'],
  'u-acids': ['u-reactions'],
  'u-metals': ['u-reactions', 'u-acids'],
  'u-energetics': ['u-reactions'],
  'u-earth': ['u-reactions'],
  'u-materials': ['u-periodic', 'u-metals']
};

const statementIndex = new Map();
for (const strand of nc.strands) {
  for (const s of strand.statements) {
    statementIndex.set(s.id, { ...s, strandId: strand.id, strandTitle: strand.title });
  }
}

const unitIndex = new Map(units.map((u) => [u.id, u]));

const lessonIndex = new Map();
for (const unit of units) {
  for (const [i, lesson] of unit.lessons.entries()) {
    lessonIndex.set(lesson.id, { ...lesson, unitId: unit.id, unitTitle: unit.title, indexInUnit: i });
  }
}

const practicalIndex = new Map();
for (const unit of units) {
  for (const p of unit.practicals || []) {
    practicalIndex.set(p.id, { ...p, unitId: unit.id, unitTitle: unit.title });
  }
}

/** All NC statement ids a unit touches, from the unit header and its lessons. */
export function unitStatementIds(unit) {
  const ids = new Set([...(unit.ncRefs || []), ...(unit.wsRefs || [])]);
  for (const lesson of unit.lessons || []) {
    for (const id of lesson.ncRefs || []) ids.add(id);
    for (const id of lesson.wsRefs || []) ids.add(id);
  }
  return [...ids];
}

/**
 * Referential integrity check over the bundled content. Run at boot so a bad
 * content edit fails loudly rather than silently producing wrong coverage.
 */
export function validateCurriculum() {
  const errors = [];
  const seenUnitIds = new Set();
  for (const unit of units) {
    if (seenUnitIds.has(unit.id)) errors.push(`duplicate unit id: ${unit.id}`);
    seenUnitIds.add(unit.id);
    const practicalIds = new Set((unit.practicals || []).map((p) => p.id));
    for (const id of unitStatementIds(unit)) {
      if (!statementIndex.has(id)) errors.push(`${unit.id} references unknown statement ${id}`);
    }
    for (const lesson of unit.lessons || []) {
      if (lesson.practical && !practicalIds.has(lesson.practical)) {
        errors.push(`${lesson.id} references unknown practical ${lesson.practical}`);
      }
    }
    if (unit.lessons.length !== unit.suggestedLessons) {
      errors.push(`${unit.id} declares ${unit.suggestedLessons} lessons but defines ${unit.lessons.length}`);
    }
  }
  for (const [unitId, reqs] of Object.entries(prerequisites)) {
    if (!seenUnitIds.has(unitId)) errors.push(`prerequisite map references unknown unit ${unitId}`);
    for (const r of reqs) if (!seenUnitIds.has(r)) errors.push(`${unitId} requires unknown unit ${r}`);
  }
  return errors;
}

/** Compact unit shape for list views — omits the heavy lesson bodies. */
export function unitSummary(unit) {
  return {
    id: unit.id,
    title: unit.title,
    strapline: unit.strapline,
    bigIdea: unit.bigIdea,
    suggestedPosition: unit.suggestedPosition,
    suggestedLessons: unit.suggestedLessons,
    lessonCount: unit.lessons.length,
    practicalCount: (unit.practicals || []).length,
    statementIds: unitStatementIds(unit),
    ncRefs: unit.ncRefs || [],
    wsRefs: unit.wsRefs || [],
    prerequisites: prerequisites[unit.id] || [],
    misconceptionCount: (unit.misconceptions || []).length
  };
}

export const curriculum = {
  subject: nc.subject,
  keyStage: nc.keyStage,
  source: nc.source,
  strands: nc.strands,
  units,
  prerequisites,
  getStatement: (id) => statementIndex.get(id) || null,
  getUnit: (id) => unitIndex.get(id) || null,
  getLesson: (id) => lessonIndex.get(id) || null,
  getPractical: (id) => practicalIndex.get(id) || null,
  allStatements: () => [...statementIndex.values()],
  totalLessons: () => units.reduce((n, u) => n + u.lessons.length, 0)
};
