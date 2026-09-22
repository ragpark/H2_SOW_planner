import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { curriculum } from '../curriculum/index.js';
import {
  DEFAULT_TERMS,
  autoPlan,
  buildTimeline,
  computeCoverage,
  reviewScheme,
  schemeStats
} from './planner.js';

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const rowToScheme = (row) =>
  row && {
    id: row.id,
    ownerId: row.owner_id,
    contextId: row.context_id,
    title: row.title,
    subject: row.subject,
    keyStage: row.key_stage,
    yearGroup: row.year_group,
    academicYear: row.academic_year,
    lessonsPerWeek: row.lessons_per_week,
    terms: JSON.parse(row.terms),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

const rowToPlacement = (row) => ({
  id: row.id,
  unitId: row.unit_id,
  position: row.position,
  termIndex: row.term_index,
  weekInTerm: row.week_in_term,
  lessonsAllocated: row.lessons_allocated,
  customTitle: row.custom_title,
  notes: row.notes
});

function validateTerms(terms) {
  if (!Array.isArray(terms) || terms.length === 0) throw new HttpError('terms must be a non-empty array');
  return terms.map((t, i) => {
    const weeks = Number(t.weeks);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 20) {
      throw new HttpError(`term ${i + 1} must have between 1 and 20 weeks`);
    }
    return { name: String(t.name || `Term ${i + 1}`).slice(0, 60), weeks };
  });
}

function validateLessonsPerWeek(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 10) throw new HttpError('lessonsPerWeek must be between 1 and 10');
  return v;
}

export function createScheme(session, input = {}) {
  const db = getDb();
  const id = randomUUID();
  const terms = validateTerms(input.terms || DEFAULT_TERMS);
  const lessonsPerWeek = validateLessonsPerWeek(input.lessonsPerWeek ?? 2);
  const yearGroup = Number(input.yearGroup ?? 9);
  if (!Number.isInteger(yearGroup) || yearGroup < 7 || yearGroup > 13) {
    throw new HttpError('yearGroup must be between 7 and 13');
  }

  db.prepare(
    `INSERT INTO schemes (id, owner_id, context_id, title, subject, key_stage, year_group, academic_year, lessons_per_week, terms, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    session.user.id,
    input.contextId ?? session.context?.id ?? null,
    String(input.title || `Year ${yearGroup} Chemistry`).slice(0, 160),
    input.subject || curriculum.subject,
    input.keyStage || curriculum.keyStage,
    yearGroup,
    input.academicYear ? String(input.academicYear).slice(0, 20) : null,
    lessonsPerWeek,
    JSON.stringify(terms),
    input.notes ? String(input.notes).slice(0, 4000) : null
  );

  if (input.autoPlan) {
    const plan = autoPlan({ terms, lessonsPerWeek, unitIds: input.unitIds || null });
    writePlacements(id, plan.placements);
  }
  return getSchemeById(id);
}

export const getSchemeById = (id) => rowToScheme(getDb().prepare('SELECT * FROM schemes WHERE id = ?').get(id));

export function getPlacements(schemeId) {
  return getDb()
    .prepare('SELECT * FROM placements WHERE scheme_id = ? ORDER BY position')
    .all(schemeId)
    .map(rowToPlacement);
}

function writePlacements(schemeId, placements) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM placements WHERE scheme_id = ?').run(schemeId);
    const insert = db.prepare(
      `INSERT INTO placements (id, scheme_id, unit_id, position, term_index, week_in_term, lessons_allocated, custom_title, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    placements.forEach((p, i) => {
      insert.run(
        p.id || randomUUID(),
        schemeId,
        p.unitId,
        i,
        p.termIndex,
        p.weekInTerm,
        p.lessonsAllocated,
        p.customTitle || null,
        p.notes || null
      );
    });
    db.prepare("UPDATE schemes SET updated_at = datetime('now') WHERE id = ?").run(schemeId);
  });
  tx();
}

export function listSchemes(session) {
  const db = getDb();
  const rows = session.context?.id
    ? db
        .prepare('SELECT * FROM schemes WHERE owner_id = ? OR context_id = ? ORDER BY updated_at DESC')
        .all(session.user.id, session.context.id)
    : db.prepare('SELECT * FROM schemes WHERE owner_id = ? ORDER BY updated_at DESC').all(session.user.id);

  return rows.map((row) => {
    const scheme = rowToScheme(row);
    const placements = getPlacements(scheme.id);
    return { ...scheme, stats: schemeStats(scheme, placements), isOwner: scheme.ownerId === session.user.id };
  });
}

/**
 * A teacher may open any scheme they own. Within an LMS course, staff on that
 * course share editing so a department can plan together; anyone else on the
 * course sees it read-only.
 */
export function assertAccess(scheme, session, { write = false } = {}) {
  if (!scheme) throw new HttpError('scheme not found', 404);
  const isOwner = scheme.ownerId === session.user.id;
  const sharesContext = Boolean(scheme.contextId) && scheme.contextId === session.context?.id;
  if (!isOwner && !sharesContext) throw new HttpError('scheme not found', 404);
  if (write && !isOwner && !(sharesContext && session.permissions.canEdit)) {
    throw new HttpError('you do not have permission to edit this scheme', 403);
  }
  return { isOwner, sharesContext, canEdit: isOwner || (sharesContext && session.permissions.canEdit) };
}

export function updateScheme(scheme, input) {
  const db = getDb();
  const next = {
    title: input.title !== undefined ? String(input.title).slice(0, 160) : scheme.title,
    academicYear:
      input.academicYear !== undefined ? String(input.academicYear || '').slice(0, 20) || null : scheme.academicYear,
    lessonsPerWeek:
      input.lessonsPerWeek !== undefined ? validateLessonsPerWeek(input.lessonsPerWeek) : scheme.lessonsPerWeek,
    terms: input.terms !== undefined ? validateTerms(input.terms) : scheme.terms,
    notes: input.notes !== undefined ? String(input.notes || '').slice(0, 4000) || null : scheme.notes
  };
  db.prepare(
    `UPDATE schemes SET title = ?, academic_year = ?, lessons_per_week = ?, terms = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(next.title, next.academicYear, next.lessonsPerWeek, JSON.stringify(next.terms), next.notes, scheme.id);
  return getSchemeById(scheme.id);
}

export function deleteScheme(schemeId) {
  getDb().prepare('DELETE FROM schemes WHERE id = ?').run(schemeId);
}

export function addUnit(scheme, { unitId, lessonsAllocated, position }) {
  const unit = curriculum.getUnit(unitId);
  if (!unit) throw new HttpError(`unknown unit ${unitId}`, 404);
  const placements = getPlacements(scheme.id);
  if (placements.some((p) => p.unitId === unitId)) {
    throw new HttpError('that unit is already in this scheme', 409);
  }
  const lessons = Math.max(1, Number(lessonsAllocated ?? unit.suggestedLessons));
  const next = {
    unitId,
    lessonsAllocated: lessons,
    termIndex: 0,
    weekInTerm: 1
  };
  const index = Number.isInteger(position) ? Math.max(0, Math.min(position, placements.length)) : placements.length;
  placements.splice(index, 0, next);
  writePlacements(scheme.id, resequence(scheme, placements));
  return getPlacements(scheme.id);
}

export function removeUnit(scheme, placementId) {
  const placements = getPlacements(scheme.id).filter((p) => p.id !== placementId);
  writePlacements(scheme.id, resequence(scheme, placements));
  return getPlacements(scheme.id);
}

export function reorderUnits(scheme, orderedPlacementIds) {
  const placements = getPlacements(scheme.id);
  const byId = new Map(placements.map((p) => [p.id, p]));
  const reordered = orderedPlacementIds.map((id) => byId.get(id)).filter(Boolean);
  if (reordered.length !== placements.length) throw new HttpError('the order must list every unit exactly once');
  writePlacements(scheme.id, resequence(scheme, reordered));
  return getPlacements(scheme.id);
}

export function updatePlacement(scheme, placementId, input) {
  const placements = getPlacements(scheme.id);
  const target = placements.find((p) => p.id === placementId);
  if (!target) throw new HttpError('unit not found in this scheme', 404);
  if (input.lessonsAllocated !== undefined) {
    const n = Number(input.lessonsAllocated);
    if (!Number.isInteger(n) || n < 1 || n > 40) throw new HttpError('lessonsAllocated must be between 1 and 40');
    target.lessonsAllocated = n;
  }
  if (input.customTitle !== undefined) target.customTitle = String(input.customTitle || '').slice(0, 160) || null;
  if (input.notes !== undefined) target.notes = String(input.notes || '').slice(0, 4000) || null;

  // An explicit start week pins the unit; everything after it reflows.
  if (input.termIndex !== undefined || input.weekInTerm !== undefined) {
    const termIndex = Number(input.termIndex ?? target.termIndex);
    const weekInTerm = Number(input.weekInTerm ?? target.weekInTerm);
    if (!scheme.terms[termIndex]) throw new HttpError('termIndex is outside this scheme');
    if (weekInTerm < 1 || weekInTerm > scheme.terms[termIndex].weeks) {
      throw new HttpError('weekInTerm is outside that term');
    }
    target.termIndex = termIndex;
    target.weekInTerm = weekInTerm;
    writePlacements(scheme.id, placements);
    return getPlacements(scheme.id);
  }
  writePlacements(scheme.id, resequence(scheme, placements));
  return getPlacements(scheme.id);
}

/** Lay units back-to-back from the start of the year, preserving their order. */
function resequence(scheme, placements) {
  const plan = autoPlan({
    terms: scheme.terms,
    lessonsPerWeek: scheme.lessonsPerWeek,
    unitIds: placements.map((p) => p.unitId),
    allocations: Object.fromEntries(placements.map((p) => [p.unitId, p.lessonsAllocated]))
  });
  const planByUnit = new Map(plan.placements.map((p) => [p.unitId, p]));
  return placements.map((p) => {
    const planned = planByUnit.get(p.unitId);
    return planned ? { ...p, termIndex: planned.termIndex, weekInTerm: planned.weekInTerm } : p;
  });
}

export function applyAutoPlan(scheme, unitIds) {
  const plan = autoPlan({ terms: scheme.terms, lessonsPerWeek: scheme.lessonsPerWeek, unitIds });
  writePlacements(scheme.id, plan.placements);
  return { placements: getPlacements(scheme.id), unplaced: plan.unplaced };
}

export function setLessonNote(schemeId, lessonId, { status, notes }) {
  if (!curriculum.getLesson(lessonId)) throw new HttpError(`unknown lesson ${lessonId}`, 404);
  const allowed = ['planned', 'ready', 'taught', 'skipped'];
  if (status && !allowed.includes(status)) throw new HttpError(`status must be one of ${allowed.join(', ')}`);
  const db = getDb();
  db.prepare(
    `INSERT INTO lesson_notes (scheme_id, lesson_id, status, notes, updated_at)
     VALUES (?, ?, COALESCE(?, 'planned'), ?, datetime('now'))
     ON CONFLICT (scheme_id, lesson_id) DO UPDATE SET
       status = COALESCE(excluded.status, lesson_notes.status),
       notes = COALESCE(excluded.notes, lesson_notes.notes),
       updated_at = datetime('now')`
  ).run(schemeId, lessonId, status || null, notes === undefined ? null : String(notes).slice(0, 4000));
  return getLessonNotes(schemeId)[lessonId] || null;
}

export function getLessonNotes(schemeId) {
  const rows = getDb().prepare('SELECT * FROM lesson_notes WHERE scheme_id = ?').all(schemeId);
  return Object.fromEntries(
    rows.map((r) => [r.lesson_id, { status: r.status, notes: r.notes, updatedAt: r.updated_at }])
  );
}

/** The full planning picture for one scheme, as the UI consumes it. */
export function getSchemeDetail(schemeId) {
  const scheme = getSchemeById(schemeId);
  if (!scheme) throw new HttpError('scheme not found', 404);
  const placements = getPlacements(schemeId);
  const review = reviewScheme(scheme, placements);
  return {
    scheme,
    placements: placements.map((p) => {
      const unit = curriculum.getUnit(p.unitId);
      return {
        ...p,
        unit: unit && {
          id: unit.id,
          title: unit.title,
          strapline: unit.strapline,
          suggestedLessons: unit.suggestedLessons,
          lessonCount: unit.lessons.length,
          practicalCount: (unit.practicals || []).length
        }
      };
    }),
    timeline: buildTimeline(scheme, placements),
    coverage: review.coverage,
    findings: review.findings,
    stats: schemeStats(scheme, placements),
    lessonNotes: getLessonNotes(schemeId)
  };
}

export function duplicateScheme(scheme, session, title) {
  const copy = createScheme(session, {
    title: title || `${scheme.title} (copy)`,
    subject: scheme.subject,
    keyStage: scheme.keyStage,
    yearGroup: scheme.yearGroup,
    academicYear: scheme.academicYear,
    lessonsPerWeek: scheme.lessonsPerWeek,
    terms: scheme.terms,
    notes: scheme.notes,
    contextId: scheme.contextId
  });
  writePlacements(copy.id, getPlacements(scheme.id).map(({ id, ...rest }) => rest));
  return getSchemeById(copy.id);
}

export { HttpError, computeCoverage };
