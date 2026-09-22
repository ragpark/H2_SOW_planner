import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * A curriculum spine is one (subject, key stage) pair: its programme of study
 * statements, its units, and the order they assume. Spines are data packages
 * loaded from disk, so adding physics — or key stage 4 chemistry — means
 * adding a directory, not changing code.
 *
 * Extra roots can be supplied via CURRICULUM_DIR (colon-separated) so a school
 * can carry its own spine without forking the project.
 */
function spineRoots() {
  const roots = [join(here, 'spines')];
  const extra = process.env.CURRICULUM_DIR;
  if (extra) {
    for (const dir of extra.split(':').map((d) => d.trim()).filter(Boolean)) {
      roots.push(resolve(dir));
    }
  }
  return roots.filter((dir) => existsSync(dir));
}

/** Strands shared between subjects, such as Working scientifically. */
function loadSharedStrands() {
  const dir = join(here, 'common');
  const shared = new Map();
  if (!existsSync(dir)) return shared;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const doc = readJson(join(dir, file));
    shared.set(doc.id, doc);
  }
  return shared;
}

const sharedStrands = loadSharedStrands();

/** Canonical identifier for a (subject, key stage) pair. */
export const spineIdFor = (subject, keyStage) =>
  `${String(subject || '').toLowerCase()}-${String(keyStage || '').toLowerCase()}`;

function loadSpine(dir) {
  const manifest = readJson(join(dir, 'manifest.json'));
  const spineDoc = existsSync(join(dir, 'spine.json')) ? readJson(join(dir, 'spine.json')) : { strands: [] };

  const unitsDir = join(dir, 'units');
  const units = existsSync(unitsDir)
    ? readdirSync(unitsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => readJson(join(unitsDir, f)))
    : [];

  // Shared strands are appended so a subject's own strands read first.
  const strands = [...(spineDoc.strands || [])];
  for (const name of manifest.sharedStrands || []) {
    const doc = sharedStrands.get(name);
    if (doc) strands.push(doc.strand);
  }

  const statementIndex = new Map();
  for (const strand of strands) {
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

  const id = manifest.id || spineIdFor(manifest.subject, manifest.keyStage);

  return {
    id,
    dir,
    subject: manifest.subject,
    subjectTitle: manifest.subjectTitle || manifest.subject,
    keyStage: manifest.keyStage,
    keyStageTitle: manifest.keyStageTitle || manifest.keyStage,
    title: manifest.title || `${manifest.keyStage} ${manifest.subject}`,
    yearGroups: manifest.yearGroups || [],
    defaultYearGroup: manifest.defaultYearGroup ?? manifest.yearGroups?.at(-1) ?? 9,
    source: manifest.source || '',
    // 'statements-only' is a spine with a programme of study but no units yet:
    // useful for coverage and for making a subject visible before its content
    // is written. Declaring it explicitly means an empty units/ directory is
    // still caught as a mistake.
    contentStatus: manifest.contentStatus || 'complete',
    strands,
    units,
    prerequisites: manifest.prerequisites || {},
    getStatement: (sid) => statementIndex.get(sid) || null,
    getUnit: (uid) => unitIndex.get(uid) || null,
    getLesson: (lid) => lessonIndex.get(lid) || null,
    getPractical: (pid) => practicalIndex.get(pid) || null,
    allStatements: () => [...statementIndex.values()],
    totalLessons: () => units.reduce((n, u) => n + u.lessons.length, 0)
  };
}

function loadAllSpines() {
  const spines = new Map();
  for (const root of spineRoots()) {
    for (const entry of readdirSync(root).sort()) {
      const dir = join(root, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, 'manifest.json'))) continue;
      const spine = loadSpine(dir);
      spines.set(spine.id, spine);
    }
  }
  return spines;
}

let spines = loadAllSpines();

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
 * Referential integrity across every installed spine. Run at boot so a bad
 * content edit fails loudly rather than silently producing wrong coverage.
 */
export function validateCurriculum() {
  const errors = [];
  if (spines.size === 0) errors.push('no curriculum spines were found');

  // Unit and lesson ids must be unique across all spines, because a scheme
  // stores them as bare strings. Enforcing it here means no stored id ever
  // needs rewriting when a subject is added.
  const seenUnitIds = new Map();
  const seenLessonIds = new Map();

  for (const spine of spines.values()) {
    if (!spine.subject || !spine.keyStage) {
      errors.push(`${spine.id}: manifest must declare subject and keyStage`);
    }
    if (spine.id !== spineIdFor(spine.subject, spine.keyStage)) {
      errors.push(
        `${spine.id}: id must be "${spineIdFor(spine.subject, spine.keyStage)}" for subject/keyStage`
      );
    }
    if (spine.units.length === 0 && spine.contentStatus !== 'statements-only') {
      errors.push(
        `${spine.id}: has no units — declare "contentStatus": "statements-only" in the manifest if that is deliberate`
      );
    }
    if (spine.units.length > 0 && spine.contentStatus === 'statements-only') {
      errors.push(`${spine.id}: is declared statements-only but defines ${spine.units.length} units`);
    }

    for (const unit of spine.units) {
      if (seenUnitIds.has(unit.id)) {
        errors.push(`unit id "${unit.id}" is used by both ${seenUnitIds.get(unit.id)} and ${spine.id}`);
      }
      seenUnitIds.set(unit.id, spine.id);

      const practicalIds = new Set((unit.practicals || []).map((p) => p.id));
      for (const id of unitStatementIds(unit)) {
        if (!spine.getStatement(id)) errors.push(`${spine.id}/${unit.id} references unknown statement ${id}`);
      }
      for (const lesson of unit.lessons || []) {
        if (seenLessonIds.has(lesson.id)) {
          errors.push(`lesson id "${lesson.id}" is used by both ${seenLessonIds.get(lesson.id)} and ${spine.id}`);
        }
        seenLessonIds.set(lesson.id, spine.id);
        if (lesson.practical && !practicalIds.has(lesson.practical)) {
          errors.push(`${spine.id}/${lesson.id} references unknown practical ${lesson.practical}`);
        }
      }
      if (unit.lessons.length !== unit.suggestedLessons) {
        errors.push(
          `${spine.id}/${unit.id} declares ${unit.suggestedLessons} lessons but defines ${unit.lessons.length}`
        );
      }
    }

    for (const [unitId, reqs] of Object.entries(spine.prerequisites)) {
      if (!spine.getUnit(unitId)) errors.push(`${spine.id}: prerequisite map references unknown unit ${unitId}`);
      for (const r of reqs) {
        if (!spine.getUnit(r)) errors.push(`${spine.id}: ${unitId} requires unknown unit ${r}`);
      }
    }
  }
  return errors;
}

/** Compact unit shape for list views — omits the heavy lesson bodies. */
export function unitSummary(spine, unit) {
  return {
    id: unit.id,
    spineId: spine.id,
    subject: spine.subject,
    keyStage: spine.keyStage,
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
    prerequisites: spine.prerequisites[unit.id] || [],
    misconceptionCount: (unit.misconceptions || []).length
  };
}

/** Headline description of a spine, for pickers and listings. */
export const spineSummary = (spine) => ({
  id: spine.id,
  subject: spine.subject,
  subjectTitle: spine.subjectTitle,
  keyStage: spine.keyStage,
  keyStageTitle: spine.keyStageTitle,
  title: spine.title,
  yearGroups: spine.yearGroups,
  defaultYearGroup: spine.defaultYearGroup,
  source: spine.source,
  contentStatus: spine.contentStatus,
  unitCount: spine.units.length,
  lessonCount: spine.totalLessons(),
  statementCount: spine.allStatements().length
});

export const registry = {
  list: () => [...spines.values()].sort((a, b) => a.title.localeCompare(b.title)),
  summaries: () => registry.list().map(spineSummary),
  get: (id) => spines.get(id) || null,

  /** Resolve a (subject, key stage) pair to an installed spine. */
  resolve: ({ subject, keyStage } = {}) => {
    if (!subject || !keyStage) return null;
    return spines.get(spineIdFor(subject, keyStage)) || null;
  },

  /** Spines that actually have units, and so can be planned with. */
  plannable: () => registry.list().filter((s) => s.units.length > 0),

  /**
   * The spine to use when nothing has said which. An explicit DEFAULT_SPINE
   * wins; otherwise a single plannable spine is unambiguous, and beyond that
   * the caller must choose. A statements-only spine never becomes the default
   * by accident: it is visible and selectable, but planning against it is a
   * deliberate choice.
   */
  default: () => {
    const preferred = process.env.DEFAULT_SPINE;
    if (preferred && spines.has(preferred)) return spines.get(preferred);
    const plannable = registry.plannable();
    if (plannable.length === 1) return plannable[0];
    const all = registry.list();
    return all.length === 1 ? all[0] : null;
  },

  /** Find whichever spine owns a unit id — ids are unique across spines. */
  findByUnitId: (unitId) => registry.list().find((s) => s.getUnit(unitId)) || null,

  subjects: () => [...new Set(registry.list().map((s) => s.subject))].sort(),
  keyStages: () => [...new Set(registry.list().map((s) => s.keyStage))].sort(),

  /** Test helper: reload from disk after changing CURRICULUM_DIR. */
  reload: () => {
    spines = loadAllSpines();
    return registry;
  }
};
