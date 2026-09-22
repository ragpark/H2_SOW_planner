import { Router } from 'express';
import { config } from '../config.js';
import { registry, spineSummary, unitSummary } from '../curriculum/index.js';
import { DEFAULT_TERMS } from '../services/planner.js';
import {
  createLocalUser,
  createSession,
  destroySession,
  redeemHandoff
} from '../services/identity.js';
import * as schemes from '../services/schemes.js';
import { lessonPlanToMarkdown, schemeToMarkdown } from '../services/exporter.js';
import { SESSION_COOKIE, requireEditor, requireSession, sessionCookieOptions } from '../middleware/auth.js';

export function apiRouter() {
  const router = Router();

  // Express 4 does not catch a rejected promise from a handler, so every async
  // route is wrapped and its rejection forwarded to the error middleware.
  const wrap = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  /** Load a scheme and check access in one step. */
  const loadScheme = async (req, { write = false } = {}) => {
    const scheme = await schemes.getSchemeById(req.params.id);
    const access = schemes.assertAccess(scheme, req.session, { write });
    return { scheme, access };
  };

  // ---------- session ----------

  router.get('/session', (req, res) => {
    res.json({
      authenticated: Boolean(req.session),
      session: req.session,
      capabilities: {
        standalone: config.standaloneEnabled,
        lti: config.lti.enabled
      }
    });
  });

  router.post('/session/local', wrap(async (req, res) => {
    if (!config.standaloneEnabled) {
      return res.status(403).json({ error: 'standalone sign-in is disabled on this deployment' });
    }
    const user = await createLocalUser({ displayName: req.body?.displayName, email: req.body?.email });
    const session = await createSession({ userId: user.id, source: 'local' });
    res.cookie(SESSION_COOKIE, session.id, sessionCookieOptions());
    res.json({ token: session.id, expiresAt: session.expiresAt });
  }));

  // Exchanges the one-time token from an LTI launch redirect for a session.
  router.post('/session/exchange', wrap(async (req, res) => {
    const result = await redeemHandoff(req.body?.handoff);
    if (!result) return res.status(401).json({ error: 'handoff token is invalid or has expired' });
    res.cookie(SESSION_COOKIE, result.session.id, sessionCookieOptions());
    res.json({ token: result.session.id, session: result.session, target: result.target });
  }));

  router.delete('/session', wrap(async (req, res) => {
    if (req.session) await destroySession(req.session.id);
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    res.status(204).end();
  }));

  // ---------- curriculum library (readable without a scheme) ----------

  /**
   * Which curricula this deployment has installed. The client uses this to
   * offer subject and key stage, and to decide whether a picker is needed at
   * all — with one installed spine there is nothing to choose.
   */
  router.get('/subjects', requireSession, (_req, res) => {
    res.json({
      spines: registry.summaries(),
      subjects: registry.subjects(),
      keyStages: registry.keyStages(),
      default: registry.default()?.id ?? null,
      defaultTerms: DEFAULT_TERMS
    });
  });

  /** Resolve the spine a request is asking about, by id or subject/key stage. */
  const spineFromQuery = (req) => {
    if (req.query.spine) return registry.get(String(req.query.spine));
    if (req.query.subject || req.query.keyStage) {
      const fallback = registry.default();
      return registry.resolve({
        subject: String(req.query.subject || fallback?.subject || ''),
        keyStage: String(req.query.keyStage || fallback?.keyStage || '')
      });
    }
    return registry.default();
  };

  router.get('/curriculum', requireSession, (req, res) => {
    const spine = spineFromQuery(req);
    if (!spine) {
      return res.status(400).json({
        error: 'specify which curriculum with ?spine=, or ?subject= and ?keyStage=',
        spines: registry.summaries().map((s) => s.id)
      });
    }
    res.json({
      ...spineSummary(spine),
      strands: spine.strands,
      units: spine.units.map((u) => unitSummary(spine, u)),
      defaultTerms: DEFAULT_TERMS,
      totalLessons: spine.totalLessons()
    });
  });

  router.get('/curriculum/units/:unitId', requireSession, (req, res) => {
    // Unit ids are unique across spines, so the owning curriculum is implied.
    const spine = registry.findByUnitId(req.params.unitId);
    if (!spine) return res.status(404).json({ error: 'unit not found' });
    const unit = spine.getUnit(req.params.unitId);
    res.json({
      ...unit,
      spineId: spine.id,
      spineTitle: spine.title,
      prerequisites: (spine.prerequisites[unit.id] || []).map((id) => ({
        id,
        title: spine.getUnit(id)?.title
      })),
      statements: [...(unit.ncRefs || []), ...(unit.wsRefs || [])]
        .map((id) => spine.getStatement(id))
        .filter(Boolean)
    });
  });

  router.get('/curriculum/lessons/:lessonId', requireSession, (req, res) => {
    const spine = registry.list().find((s) => s.getLesson(req.params.lessonId));
    if (!spine) return res.status(404).json({ error: 'lesson not found' });
    const lesson = spine.getLesson(req.params.lessonId);
    const unit = spine.getUnit(lesson.unitId);
    res.json({
      ...lesson,
      spineId: spine.id,
      spineTitle: spine.title,
      practicalDetail: lesson.practical ? spine.getPractical(lesson.practical) : null,
      statements: [...(lesson.ncRefs || []), ...(lesson.wsRefs || [])]
        .map((id) => spine.getStatement(id))
        .filter(Boolean),
      misconceptions: unit?.misconceptions || [],
      keyVocabulary: unit?.keyVocabulary || []
    });
  });

  // ---------- schemes ----------

  router.get('/schemes', requireSession, wrap(async (req, res) => {
    res.json({ schemes: await schemes.listSchemes(req.session) });
  }));

  router.post('/schemes', requireEditor, wrap(async (req, res) => {
    const scheme = await schemes.createScheme(req.session, req.body || {});
    res.status(201).json(await schemes.getSchemeDetail(scheme.id));
  }));

  router.get('/schemes/:id', requireSession, wrap(async (req, res) => {
    const { access } = await loadScheme(req);
    res.json({ ...(await schemes.getSchemeDetail(req.params.id)), access });
  }));

  router.patch('/schemes/:id', requireEditor, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req, { write: true });
    await schemes.updateScheme(scheme, req.body || {});
    res.json(await schemes.getSchemeDetail(scheme.id));
  }));

  router.delete('/schemes/:id', requireEditor, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req, { write: true });
    if (scheme.ownerId !== req.session.user.id) {
      return res.status(403).json({ error: 'only the owner can delete a scheme' });
    }
    await schemes.deleteScheme(scheme.id);
    res.status(204).end();
  }));

  router.post('/schemes/:id/duplicate', requireEditor, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req);
    const copy = await schemes.duplicateScheme(scheme, req.session, req.body?.title);
    res.status(201).json(await schemes.getSchemeDetail(copy.id));
  }));

  // ---------- units within a scheme ----------

  router.post('/schemes/:id/units', requireEditor, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req, { write: true });
    await schemes.addUnit(scheme, req.body || {});
    res.json(await schemes.getSchemeDetail(scheme.id));
  }));

  router.patch('/schemes/:id/units/:placementId', requireEditor, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req, { write: true });
    await schemes.updatePlacement(scheme, req.params.placementId, req.body || {});
    res.json(await schemes.getSchemeDetail(scheme.id));
  }));

  router.delete('/schemes/:id/units/:placementId', requireEditor, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req, { write: true });
    await schemes.removeUnit(scheme, req.params.placementId);
    res.json(await schemes.getSchemeDetail(scheme.id));
  }));

  router.post('/schemes/:id/reorder', requireEditor, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req, { write: true });
    await schemes.reorderUnits(scheme, req.body?.order || []);
    res.json(await schemes.getSchemeDetail(scheme.id));
  }));

  router.post('/schemes/:id/autoplan', requireEditor, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req, { write: true });
    const result = await schemes.applyAutoPlan(scheme, req.body?.unitIds || null);
    res.json({ ...(await schemes.getSchemeDetail(scheme.id)), unplaced: result.unplaced });
  }));

  router.put('/schemes/:id/lessons/:lessonId', requireEditor, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req, { write: true });
    const note = await schemes.setLessonNote(scheme, req.params.lessonId, req.body || {});
    res.json({ lessonId: req.params.lessonId, note });
  }));

  // ---------- export ----------

  router.get('/schemes/:id/export', requireSession, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req);
    const detail = await schemes.getSchemeDetail(scheme.id);
    const spine = schemes.spineForScheme(scheme);
    const slug = scheme.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scheme-of-work';
    if (req.query.format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${slug}.json"`);
      return res.json(detail);
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.md"`);
    res.send(schemeToMarkdown(detail, spine));
  }));

  router.get('/schemes/:id/lessons/:lessonId/plan', requireSession, wrap(async (req, res) => {
    const { scheme } = await loadScheme(req);
    const notes = await schemes.getLessonNotes(scheme.id);
    const markdown = lessonPlanToMarkdown(req.params.lessonId, {
      spine: schemes.spineForScheme(scheme),
      scheme,
      note: notes[req.params.lessonId] || null
    });
    if (!markdown) return res.status(404).json({ error: 'lesson not found' });
    if (req.query.format === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(markdown);
    }
    res.json({ lessonId: req.params.lessonId, markdown });
  }));

  return router;
}
