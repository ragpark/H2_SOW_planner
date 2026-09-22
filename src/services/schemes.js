import { randomUUID } from 'node:crypto';
import { many, one, query, withTx } from '../db/index.js';
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
    terms: row.terms,
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

export async function createScheme(session, input = {}) {
  const id = randomUUID();
  const terms = validateTerms(input.terms || DEFAULT_TERMS);
  const lessonsPerWeek = validateLessonsPerWeek(input.lessonsPerWeek ?? 2);
  const yearGroup = Number(input.yearGroup ?? 9);
  if (!Number.isInteger(yearGroup) || yearGroup < 7 || yearGroup > 13) {
    throw new HttpError('yearGroup must be between 7 and 13');
  }

  await query(
    `INSERT INTO schemes (id, owner_id, context_id, title, subject, key_stage, year_group,
                          academic_year, lessons_per_week, terms, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [
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
    ]
  );

  if (input.autoPlan) {
    const plan = autoPlan({ terms, lessonsPerWeek, unitIds: input.unitIds || null });
    await writePlacements(id, plan.placements);
  }
  return getSchemeById(id);
}

export async function getSchemeById(id) {
  return rowToScheme(await one('SELECT * FROM schemes WHERE id = $1', [id]));
}

export async function getPlacements(schemeId) {
  const rows = await many('SELECT * FROM placements WHERE scheme_id = $1 ORDER BY position', [schemeId]);
  return rows.map(rowToPlacement);
}

/**
 * Replace a scheme's placements wholesale. Done in a transaction so a failure
 * part-way cannot leave a scheme with half its units.
 */
async function writePlacements(schemeId, placements) {
  await withTx(async (client) => {
    await client.query('DELETE FROM placements WHERE scheme_id = $1', [schemeId]);
    for (const [i, p] of placements.entries()) {
      await client.query(
        `INSERT INTO placements (id, scheme_id, unit_id, position, term_index, week_in_term,
                                 lessons_allocated, custom_title, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          p.id || randomUUID(),
          schemeId,
          p.unitId,
          i,
          p.termIndex,
          p.weekInTerm,
          p.lessonsAllocated,
          p.customTitle || null,
          p.notes || null
        ]
      );
    }
    await client.query('UPDATE schemes SET updated_at = now() WHERE id = $1', [schemeId]);
  });
}

export async function listSchemes(session) {
  const rows = session.context?.id
    ? await many(
        'SELECT * FROM schemes WHERE owner_id = $1 OR context_id = $2 ORDER BY updated_at DESC',
        [session.user.id, session.context.id]
      )
    : await many('SELECT * FROM schemes WHERE owner_id = $1 ORDER BY updated_at DESC', [session.user.id]);

  return Promise.all(
    rows.map(async (row) => {
      const scheme = rowToScheme(row);
      const placements = await getPlacements(scheme.id);
      return { ...scheme, stats: schemeStats(scheme, placements), isOwner: scheme.ownerId === session.user.id };
    })
  );
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

export async function updateScheme(scheme, input) {
  const next = {
    title: input.title !== undefined ? String(input.title).slice(0, 160) : scheme.title,
    academicYear:
      input.academicYear !== undefined ? String(input.academicYear || '').slice(0, 20) || null : scheme.academicYear,
    lessonsPerWeek:
      input.lessonsPerWeek !== undefined ? validateLessonsPerWeek(input.lessonsPerWeek) : scheme.lessonsPerWeek,
    terms: input.terms !== undefined ? validateTerms(input.terms) : scheme.terms,
    notes: input.notes !== undefined ? String(input.notes || '').slice(0, 4000) || null : scheme.notes
  };
  await query(
    `UPDATE schemes SET title = $1, academic_year = $2, lessons_per_week = $3,
                        terms = $4::jsonb, notes = $5, updated_at = now()
     WHERE id = $6`,
    [next.title, next.academicYear, next.lessonsPerWeek, JSON.stringify(next.terms), next.notes, scheme.id]
  );
  return getSchemeById(scheme.id);
}

export async function deleteScheme(schemeId) {
  await query('DELETE FROM schemes WHERE id = $1', [schemeId]);
}

export async function addUnit(scheme, { unitId, lessonsAllocated, position }) {
  const unit = curriculum.getUnit(unitId);
  if (!unit) throw new HttpError(`unknown unit ${unitId}`, 404);
  const placements = await getPlacements(scheme.id);
  if (placements.some((p) => p.unitId === unitId)) {
    throw new HttpError('that unit is already in this scheme', 409);
  }
  const lessons = Math.max(1, Number(lessonsAllocated ?? unit.suggestedLessons));
  const next = { unitId, lessonsAllocated: lessons, termIndex: 0, weekInTerm: 1 };
  const index = Number.isInteger(position) ? Math.max(0, Math.min(position, placements.length)) : placements.length;
  placements.splice(index, 0, next);
  await writePlacements(scheme.id, resequence(scheme, placements));
  return getPlacements(scheme.id);
}

export async function removeUnit(scheme, placementId) {
  const placements = (await getPlacements(scheme.id)).filter((p) => p.id !== placementId);
  await writePlacements(scheme.id, resequence(scheme, placements));
  return getPlacements(scheme.id);
}

export async function reorderUnits(scheme, orderedPlacementIds) {
  const placements = await getPlacements(scheme.id);
  const byId = new Map(placements.map((p) => [p.id, p]));
  const reordered = orderedPlacementIds.map((id) => byId.get(id)).filter(Boolean);
  if (reordered.length !== placements.length) throw new HttpError('the order must list every unit exactly once');
  await writePlacements(scheme.id, resequence(scheme, reordered));
  return getPlacements(scheme.id);
}

export async function updatePlacement(scheme, placementId, input) {
  const placements = await getPlacements(scheme.id);
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
    await writePlacements(scheme.id, placements);
    return getPlacements(scheme.id);
  }
  await writePlacements(scheme.id, resequence(scheme, placements));
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

export async function applyAutoPlan(scheme, unitIds) {
  const plan = autoPlan({ terms: scheme.terms, lessonsPerWeek: scheme.lessonsPerWeek, unitIds });
  await writePlacements(scheme.id, plan.placements);
  return { placements: await getPlacements(scheme.id), unplaced: plan.unplaced };
}

export async function setLessonNote(schemeId, lessonId, { status, notes }) {
  if (!curriculum.getLesson(lessonId)) throw new HttpError(`unknown lesson ${lessonId}`, 404);
  const allowed = ['planned', 'ready', 'taught', 'skipped'];
  if (status && !allowed.includes(status)) throw new HttpError(`status must be one of ${allowed.join(', ')}`);
  await query(
    `INSERT INTO lesson_notes (scheme_id, lesson_id, status, notes, updated_at)
     VALUES ($1, $2, COALESCE($3, 'planned'), $4, now())
     ON CONFLICT (scheme_id, lesson_id) DO UPDATE SET
       status = COALESCE(EXCLUDED.status, lesson_notes.status),
       notes = COALESCE(EXCLUDED.notes, lesson_notes.notes),
       updated_at = now()`,
    [schemeId, lessonId, status || null, notes === undefined ? null : String(notes).slice(0, 4000)]
  );
  const all = await getLessonNotes(schemeId);
  return all[lessonId] || null;
}

export async function getLessonNotes(schemeId) {
  const rows = await many('SELECT * FROM lesson_notes WHERE scheme_id = $1', [schemeId]);
  return Object.fromEntries(
    rows.map((r) => [r.lesson_id, { status: r.status, notes: r.notes, updatedAt: r.updated_at }])
  );
}

/** The full planning picture for one scheme, as the UI consumes it. */
export async function getSchemeDetail(schemeId) {
  const scheme = await getSchemeById(schemeId);
  if (!scheme) throw new HttpError('scheme not found', 404);
  const [placements, lessonNotes] = await Promise.all([
    getPlacements(schemeId),
    getLessonNotes(schemeId)
  ]);
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
    lessonNotes
  };
}

export async function duplicateScheme(scheme, session, title) {
  const copy = await createScheme(session, {
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
  const source = await getPlacements(scheme.id);
  await writePlacements(copy.id, source.map(({ id, ...rest }) => rest));
  return getSchemeById(copy.id);
}

export { HttpError, computeCoverage };
