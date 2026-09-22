import { unitStatementIds } from '../curriculum/index.js';

/**
 * Every function here takes the curriculum spine it should plan against, and
 * reads nothing global. That is what makes the planner subject-agnostic: the
 * same sequencing, coverage and review logic serves key stage 3 chemistry and
 * key stage 4 physics alike.
 */

export const DEFAULT_TERMS = [
  { name: 'Autumn 1', weeks: 7 },
  { name: 'Autumn 2', weeks: 7 },
  { name: 'Spring 1', weeks: 6 },
  { name: 'Spring 2', weeks: 6 },
  { name: 'Summer 1', weeks: 6 },
  { name: 'Summer 2', weeks: 7 }
];

/**
 * Expand a term structure into an ordered list of teaching weeks, each of which
 * carries a fixed number of lesson slots. Every planning calculation in this
 * module works against this list, so a change to term lengths or the weekly
 * allocation flows through coverage, sequencing and capacity alike.
 */
export function buildCalendar(terms, lessonsPerWeek) {
  const weeks = [];
  let globalWeek = 0;
  let firstLessonIndex = 0;
  terms.forEach((term, termIndex) => {
    for (let w = 1; w <= term.weeks; w += 1) {
      weeks.push({
        termIndex,
        termName: term.name,
        weekInTerm: w,
        globalWeek: ++globalWeek,
        firstLessonIndex,
        lessonSlots: lessonsPerWeek
      });
      firstLessonIndex += lessonsPerWeek;
    }
  });
  return {
    weeks,
    totalWeeks: weeks.length,
    lessonsPerWeek,
    totalLessonSlots: weeks.length * lessonsPerWeek
  };
}

/** Which calendar week does the nth lesson slot of the year fall in? */
function weekForLessonIndex(calendar, lessonIndex) {
  if (calendar.lessonsPerWeek < 1 || calendar.weeks.length === 0) return null;
  const weekOffset = Math.floor(lessonIndex / calendar.lessonsPerWeek);
  return calendar.weeks[weekOffset] || null;
}

/**
 * Lay a sequence of units across the calendar, giving each the number of
 * lessons it asks for. Units that do not fit are returned as `unplaced` rather
 * than being silently truncated — the teacher decides what to cut.
 */
export function autoPlan({ spine, terms = DEFAULT_TERMS, lessonsPerWeek = 2, unitIds = null, allocations = {} } = {}) {
  const calendar = buildCalendar(terms, lessonsPerWeek);
  const ordered = (unitIds && unitIds.length
    ? unitIds.map((id) => spine.getUnit(id)).filter(Boolean)
    : [...spine.units].sort((a, b) => a.suggestedPosition - b.suggestedPosition));

  const placements = [];
  const unplaced = [];
  let cursor = 0;

  let full = false;
  ordered.forEach((unit, position) => {
    const lessons = Math.max(1, Number(allocations[unit.id] ?? unit.suggestedLessons));
    const week = full ? null : weekForLessonIndex(calendar, cursor);
    // Once the year is full, everything after it stays unplaced. A later unit
    // is never slipped into the gap, because that would silently reorder the
    // sequence the teacher chose.
    if (!week || cursor + lessons > calendar.totalLessonSlots) {
      full = true;
      unplaced.push({ unitId: unit.id, title: unit.title, lessons });
      return;
    }
    placements.push({
      unitId: unit.id,
      position,
      termIndex: week.termIndex,
      weekInTerm: week.weekInTerm,
      lessonsAllocated: lessons
    });
    cursor += lessons;
  });

  return {
    calendar,
    placements,
    unplaced,
    lessonsAllocated: cursor,
    lessonsAvailable: calendar.totalLessonSlots
  };
}

/**
 * Resolve stored placements into a week-by-week timeline, with each placed
 * unit's lessons distributed across the weeks it occupies.
 */
export function buildTimeline(spine, scheme, placements) {
  const calendar = buildCalendar(scheme.terms, scheme.lessonsPerWeek);
  const byWeek = new Map(calendar.weeks.map((w) => [w.globalWeek, { ...w, entries: [] }]));

  const sorted = [...placements].sort((a, b) => a.position - b.position);
  for (const p of sorted) {
    const unit = spine.getUnit(p.unitId);
    if (!unit) continue;
    const startWeek = calendar.weeks.find(
      (w) => w.termIndex === p.termIndex && w.weekInTerm === p.weekInTerm
    );
    if (!startWeek) continue;

    let remaining = p.lessonsAllocated;
    let lessonCursor = 0;
    let weekPointer = startWeek.globalWeek;
    while (remaining > 0 && byWeek.has(weekPointer)) {
      const take = Math.min(remaining, scheme.lessonsPerWeek);
      const lessons = unit.lessons.slice(lessonCursor, lessonCursor + take).map((l) => ({
        id: l.id,
        title: l.title,
        practical: l.practical || null
      }));
      byWeek.get(weekPointer).entries.push({
        placementId: p.id,
        unitId: unit.id,
        unitTitle: p.customTitle || unit.title,
        lessons,
        // Lessons beyond the unit's own content are shown as spare capacity the
        // teacher can use for consolidation or an extended investigation.
        spareLessons: Math.max(0, take - lessons.length)
      });
      lessonCursor += take;
      remaining -= take;
      weekPointer += 1;
    }
  }

  return {
    calendar,
    weeks: [...byWeek.values()],
    overrunWeeks: Math.max(0, totalWeeksNeeded(scheme, placements) - calendar.totalWeeks)
  };
}

function totalWeeksNeeded(scheme, placements) {
  const calendar = buildCalendar(scheme.terms, scheme.lessonsPerWeek);
  let furthest = 0;
  for (const p of placements) {
    const startWeek = calendar.weeks.find(
      (w) => w.termIndex === p.termIndex && w.weekInTerm === p.weekInTerm
    );
    if (!startWeek) continue;
    const weeksNeeded = Math.ceil(p.lessonsAllocated / scheme.lessonsPerWeek);
    furthest = Math.max(furthest, startWeek.globalWeek + weeksNeeded - 1);
  }
  return furthest;
}

/**
 * Coverage of the National Curriculum programme of study by the units placed
 * in this scheme, reported per strand so a teacher can see at a glance which
 * area of the subject is thin.
 */
export function computeCoverage(spine, placements) {
  const placedUnitIds = new Set(placements.map((p) => p.unitId));
  const coveredBy = new Map();
  for (const unitId of placedUnitIds) {
    const unit = spine.getUnit(unitId);
    if (!unit) continue;
    for (const sid of unitStatementIds(unit)) {
      if (!coveredBy.has(sid)) coveredBy.set(sid, []);
      coveredBy.get(sid).push({ unitId: unit.id, unitTitle: unit.title });
    }
  }

  const strands = spine.strands.map((strand) => {
    const statements = strand.statements.map((s) => ({
      id: s.id,
      text: s.text,
      coveredBy: coveredBy.get(s.id) || []
    }));
    const covered = statements.filter((s) => s.coveredBy.length > 0).length;
    return {
      id: strand.id,
      title: strand.title,
      total: statements.length,
      covered,
      percent: statements.length ? Math.round((covered / statements.length) * 100) : 0,
      statements
    };
  });

  const total = strands.reduce((n, s) => n + s.total, 0);
  const covered = strands.reduce((n, s) => n + s.covered, 0);
  return {
    strands,
    total,
    covered,
    percent: total ? Math.round((covered / total) * 100) : 0,
    gaps: strands.flatMap((s) =>
      s.statements.filter((st) => st.coveredBy.length === 0).map((st) => ({ ...st, strandTitle: s.title }))
    )
  };
}

/**
 * Advisory checks over a scheme. These are deliberately warnings rather than
 * errors: a head of department may have good reasons to depart from the
 * suggested order, and the tool's job is to make the consequence visible.
 */
export function reviewScheme(spine, scheme, placements) {
  const findings = [];
  const calendar = buildCalendar(scheme.terms, scheme.lessonsPerWeek);
  const sorted = [...placements].sort((a, b) => a.position - b.position);
  const positionOf = new Map(sorted.map((p, i) => [p.unitId, i]));

  // Capacity
  const allocated = placements.reduce((n, p) => n + p.lessonsAllocated, 0);
  if (allocated > calendar.totalLessonSlots) {
    findings.push({
      severity: 'error',
      code: 'over-capacity',
      title: 'The scheme needs more lessons than the year provides',
      detail: `${allocated} lessons are allocated but only ${calendar.totalLessonSlots} are available across ${calendar.totalWeeks} weeks at ${scheme.lessonsPerWeek} lessons a week.`,
      action: 'Reduce a unit’s allocation, drop a unit, or increase lessons per week.'
    });
  } else if (allocated < calendar.totalLessonSlots * 0.6 && placements.length > 0) {
    findings.push({
      severity: 'info',
      code: 'under-capacity',
      title: 'There is substantial spare capacity',
      detail: `${calendar.totalLessonSlots - allocated} lesson slots are unallocated.`,
      action: 'Consider adding a unit, extending practical work, or building in more assessment and feedback time.'
    });
  }

  // Overrun past the end of the year
  const needed = totalWeeksNeeded(scheme, placements);
  if (needed > calendar.totalWeeks) {
    findings.push({
      severity: 'error',
      code: 'overruns-year',
      title: 'A unit runs past the end of the final term',
      detail: `Teaching extends to week ${needed} of ${calendar.totalWeeks}.`,
      action: 'Move units earlier or shorten an allocation.'
    });
  }

  // Sequencing against prerequisites
  for (const p of sorted) {
    const reqs = spine.prerequisites[p.unitId] || [];
    for (const req of reqs) {
      if (!positionOf.has(req)) {
        findings.push({
          severity: 'warning',
          code: 'missing-prerequisite',
          title: `${spine.getUnit(p.unitId)?.title} assumes knowledge that is not taught`,
          detail: `It builds on ${spine.getUnit(req)?.title}, which is not in this scheme.`,
          action: 'Add the prerequisite unit, or plan to teach the assumed knowledge within this unit.',
          unitId: p.unitId
        });
      } else if (positionOf.get(req) > positionOf.get(p.unitId)) {
        findings.push({
          severity: 'warning',
          code: 'out-of-sequence',
          title: `${spine.getUnit(p.unitId)?.title} is taught before its prerequisite`,
          detail: `${spine.getUnit(req)?.title} currently comes later in the year.`,
          action: 'Swap the two units, or check that pupils meet the prior knowledge elsewhere.',
          unitId: p.unitId
        });
      }
    }
  }

  // Practical science rhythm
  const timeline = buildTimeline(spine, scheme, placements);
  let dryRun = 0;
  let worstDryRun = 0;
  for (const week of timeline.weeks) {
    const hasPractical = week.entries.some((e) => e.lessons.some((l) => l.practical));
    const taught = week.entries.length > 0;
    if (!taught) continue;
    dryRun = hasPractical ? 0 : dryRun + 1;
    worstDryRun = Math.max(worstDryRun, dryRun);
  }
  if (worstDryRun >= 3) {
    findings.push({
      severity: 'warning',
      code: 'practical-gap',
      title: 'A long stretch of teaching without practical work',
      detail: `There is a run of ${worstDryRun} taught weeks with no practical activity.`,
      action: 'Move a practical, or plan a demonstration or investigation into that stretch.'
    });
  }

  // Assessment rhythm: each term with teaching should reach a summative point
  const termsWithTeaching = new Set(
    timeline.weeks.filter((w) => w.entries.length > 0).map((w) => w.termIndex)
  );
  const termsWithAssessment = new Set();
  for (const week of timeline.weeks) {
    for (const entry of week.entries) {
      const unit = spine.getUnit(entry.unitId);
      if (unit?.assessment?.summative) termsWithAssessment.add(week.termIndex);
    }
  }
  for (const termIndex of termsWithTeaching) {
    if (!termsWithAssessment.has(termIndex)) {
      findings.push({
        severity: 'info',
        code: 'no-summative-assessment',
        title: `No summative assessment falls in ${scheme.terms[termIndex]?.name || `term ${termIndex + 1}`}`,
        detail: 'Units are taught in this term but none reaches its end-of-unit assessment within it.',
        action: 'Check this against the school reporting calendar.'
      });
    }
  }

  // Coverage gaps
  const coverage = computeCoverage(spine, placements);
  if (coverage.gaps.length > 0) {
    findings.push({
      severity: coverage.percent < 80 ? 'warning' : 'info',
      code: 'coverage-gaps',
      title: `${coverage.gaps.length} programme of study statements are not covered`,
      detail: `This scheme covers ${coverage.percent}% of the ${spine.title} statements.`,
      action: 'Statements not covered here should be taught in another year of the key stage.'
    });
  }

  if (placements.length === 0) {
    findings.push({
      severity: 'info',
      code: 'empty-scheme',
      title: 'This scheme has no units yet',
      detail: 'Add units from the library, or use Auto-plan to generate a starting sequence.',
      action: 'Auto-plan gives a sequence you can then adjust.'
    });
  }

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { findings, coverage, calendar };
}

/** Headline numbers for the dashboard. */
export function schemeStats(spine, scheme, placements) {
  const calendar = buildCalendar(scheme.terms, scheme.lessonsPerWeek);
  const units = placements.map((p) => spine.getUnit(p.unitId)).filter(Boolean);
  const practicals = new Set();
  let misconceptions = 0;
  let assessments = 0;
  for (const u of units) {
    for (const p of u.practicals || []) practicals.add(p.id);
    misconceptions += (u.misconceptions || []).length;
    if (u.assessment?.summative) assessments += 1;
  }
  return {
    unitCount: units.length,
    lessonsAllocated: placements.reduce((n, p) => n + p.lessonsAllocated, 0),
    lessonsAvailable: calendar.totalLessonSlots,
    weeks: calendar.totalWeeks,
    practicalCount: practicals.size,
    misconceptionCount: misconceptions,
    assessmentCount: assessments,
    coveragePercent: computeCoverage(spine, placements).percent
  };
}
