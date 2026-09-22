import { registry, spineIdFor } from '../curriculum/index.js';

/**
 * Which curriculum an LTI launch should open.
 *
 * The platform can say so explicitly with a custom parameter, a course can
 * remember its own choice, and a course name can hint at one. These are
 * ranked, and the answer carries *why* — so the interface can tell a teacher
 * that their LMS chose physics, or that a requested subject is not installed,
 * rather than silently showing them something unexpected.
 *
 * Nothing here trusts the platform's value: every candidate is resolved
 * against the installed curricula, and an unrecognised one becomes a visible
 * warning rather than an error or a silent default.
 */

/** Custom parameter names a platform administrator can set on a placement. */
const CUSTOM_SPINE = 'spine';
const CUSTOM_SUBJECT = 'subject';
const CUSTOM_KEY_STAGE = ['key_stage', 'keystage'];

const readCustom = (custom, names) => {
  for (const name of [names].flat()) {
    const value = custom?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
};

/** Year groups imply a key stage when a course name mentions one. */
function keyStageFromYear(year) {
  const n = Number(year);
  if (n >= 7 && n <= 9) return 'KS3';
  if (n >= 10 && n <= 11) return 'KS4';
  if (n >= 12 && n <= 13) return 'KS5';
  return null;
}

/**
 * Guess a curriculum from a course title such as "Year 9 Physics" or
 * "KS3 Chemistry — Set 2". Only ever a suggestion: course names are written by
 * humans for humans, and a wrong guess applied silently would be worse than
 * no guess at all.
 */
export function inferFromContext({ title, label } = {}) {
  const text = [title, label].filter(Boolean).join(' ').toLowerCase();
  if (!text) return null;

  const subject = registry.subjects().find((s) => text.includes(s.toLowerCase()));
  if (!subject) return null;

  const explicitKeyStage = text.match(/\bk\s?s\s?([345])\b|\bkey stage ([345])\b/);
  const yearMatch = text.match(/\byear\s?(\d{1,2})\b|\by(\d{1,2})\b/);
  const keyStage =
    (explicitKeyStage && `KS${explicitKeyStage[1] || explicitKeyStage[2]}`) ||
    (yearMatch && keyStageFromYear(yearMatch[1] || yearMatch[2])) ||
    null;

  // With a subject but no key stage, a single installed key stage for that
  // subject is unambiguous enough to offer.
  const candidates = registry.list().filter((s) => s.subject === subject);
  if (keyStage) return registry.resolve({ subject, keyStage });
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * @param {object} input
 * @param {object} input.launch      the validated launch summary
 * @param {object|null} input.binding the stored resource_links row, if any
 * @param {string|null} input.contextDefaultSpineId remembered course preference
 */
export function selectCurriculum({ launch, binding = null, contextDefaultSpineId = null } = {}) {
  const custom = launch?.custom || {};
  const installed = registry.summaries().map((s) => s.id);
  const warnings = [];

  // 1. What this LMS link was created for.
  if (binding?.spine_id) {
    const fromLink = registry.get(binding.spine_id);
    if (fromLink) return { spine: fromLink, source: 'link', warnings, installed };
    warnings.push(
      `This link was created for "${binding.spine_id}", which is no longer installed.`
    );
  }

  // 2. What the platform asked for.
  const requestedSpine = readCustom(custom, CUSTOM_SPINE);
  const requestedSubject = readCustom(custom, CUSTOM_SUBJECT);
  const requestedKeyStage = readCustom(custom, CUSTOM_KEY_STAGE);

  if (requestedSpine) {
    const bySpine = registry.get(requestedSpine.toLowerCase());
    if (bySpine) {
      return { spine: bySpine, source: 'custom', requested: requestedSpine, warnings, installed };
    }
    warnings.push(`Your learning platform asked for the curriculum "${requestedSpine}", which is not installed.`);
  }

  if (requestedSubject) {
    // A subject without a key stage is fine when only one is installed for it.
    const forSubject = registry.list().filter((s) => s.subject === requestedSubject.toLowerCase());
    const bySubject = requestedKeyStage
      ? registry.resolve({ subject: requestedSubject, keyStage: requestedKeyStage })
      : forSubject.length === 1
        ? forSubject[0]
        : null;

    if (bySubject) {
      return {
        spine: bySubject,
        source: 'custom',
        requested: requestedKeyStage ? `${requestedSubject} ${requestedKeyStage}` : requestedSubject,
        warnings,
        installed
      };
    }
    warnings.push(
      requestedKeyStage
        ? `Your learning platform asked for ${requestedSubject} at ${requestedKeyStage}, which is not installed.`
        : forSubject.length > 1
          ? `Your learning platform asked for ${requestedSubject} without a key stage, and more than one is installed.`
          : `Your learning platform asked for the subject "${requestedSubject}", which is not installed.`
    );
  }

  // 3. What this course settled on last time.
  if (contextDefaultSpineId) {
    const fromContext = registry.get(contextDefaultSpineId);
    if (fromContext) return { spine: fromContext, source: 'context', warnings, installed };
  }

  // 4. What the course is called — a suggestion only.
  const inferred = inferFromContext(launch?.context || {});
  if (inferred) {
    return {
      spine: inferred,
      source: 'inferred',
      suggestion: true,
      from: launch?.context?.title || launch?.context?.label || null,
      warnings,
      installed
    };
  }

  // 5. The deployment's own default.
  const fallback = registry.default();
  if (fallback) return { spine: fallback, source: 'default', warnings, installed };

  return { spine: null, source: 'none', warnings, installed };
}

export { spineIdFor };
