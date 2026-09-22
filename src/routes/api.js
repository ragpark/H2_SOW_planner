import { Router } from 'express';
import { config } from '../config.js';
import { curriculum, unitSummary } from '../curriculum/index.js';
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

  const wrap = (fn) => (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };

  /** Load a scheme and check access in one step. */
  const loadScheme = (req, { write = false } = {}) => {
    const scheme = schemes.getSchemeById(req.params.id);
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

  router.post('/session/local', (req, res) => {
    if (!config.standaloneEnabled) {
      return res.status(403).json({ error: 'standalone sign-in is disabled on this deployment' });
    }
    const user = createLocalUser({ displayName: req.body?.displayName, email: req.body?.email });
    const session = createSession({ userId: user.id, source: 'local' });
    res.cookie(SESSION_COOKIE, session.id, sessionCookieOptions());
    res.json({ token: session.id, expiresAt: session.expiresAt });
  });

  // Exchanges the one-time token from an LTI launch redirect for a session.
  router.post('/session/exchange', (req, res) => {
    const result = redeemHandoff(req.body?.handoff);
    if (!result) return res.status(401).json({ error: 'handoff token is invalid or has expired' });
    res.cookie(SESSION_COOKIE, result.session.id, sessionCookieOptions());
    res.json({ token: result.session.id, session: result.session, target: result.target });
  });

  router.delete('/session', (req, res) => {
    if (req.session) destroySession(req.session.id);
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    res.status(204).end();
  });

  // ---------- curriculum library (readable without a scheme) ----------

  router.get('/curriculum', requireSession, (_req, res) => {
    res.json({
      subject: curriculum.subject,
      keyStage: curriculum.keyStage,
      source: curriculum.source,
      strands: curriculum.strands,
      units: curriculum.units.map(unitSummary),
      defaultTerms: DEFAULT_TERMS,
      totalLessons: curriculum.totalLessons()
    });
  });

  router.get('/curriculum/units/:unitId', requireSession, (req, res) => {
    const unit = curriculum.getUnit(req.params.unitId);
    if (!unit) return res.status(404).json({ error: 'unit not found' });
    res.json({
      ...unit,
      prerequisites: (curriculum.prerequisites[unit.id] || []).map((id) => ({
        id,
        title: curriculum.getUnit(id)?.title
      })),
      statements: [...(unit.ncRefs || []), ...(unit.wsRefs || [])]
        .map((id) => curriculum.getStatement(id))
        .filter(Boolean)
    });
  });

  router.get('/curriculum/lessons/:lessonId', requireSession, (req, res) => {
    const lesson = curriculum.getLesson(req.params.lessonId);
    if (!lesson) return res.status(404).json({ error: 'lesson not found' });
    const unit = curriculum.getUnit(lesson.unitId);
    res.json({
      ...lesson,
      practicalDetail: lesson.practical ? curriculum.getPractical(lesson.practical) : null,
      statements: [...(lesson.ncRefs || []), ...(lesson.wsRefs || [])]
        .map((id) => curriculum.getStatement(id))
        .filter(Boolean),
      misconceptions: unit?.misconceptions || [],
      keyVocabulary: unit?.keyVocabulary || []
    });
  });

  // ---------- schemes ----------

  router.get('/schemes', requireSession, wrap((req, res) => {
    res.json({ schemes: schemes.listSchemes(req.session) });
  }));

  router.post('/schemes', requireEditor, wrap((req, res) => {
    const scheme = schemes.createScheme(req.session, req.body || {});
    res.status(201).json(schemes.getSchemeDetail(scheme.id));
  }));

  router.get('/schemes/:id', requireSession, wrap((req, res) => {
    const { access } = loadScheme(req);
    res.json({ ...schemes.getSchemeDetail(req.params.id), access });
  }));

  router.patch('/schemes/:id', requireEditor, wrap((req, res) => {
    const { scheme } = loadScheme(req, { write: true });
    schemes.updateScheme(scheme, req.body || {});
    res.json(schemes.getSchemeDetail(scheme.id));
  }));

  router.delete('/schemes/:id', requireEditor, wrap((req, res) => {
    const { scheme } = loadScheme(req, { write: true });
    if (scheme.ownerId !== req.session.user.id) {
      return res.status(403).json({ error: 'only the owner can delete a scheme' });
    }
    schemes.deleteScheme(scheme.id);
    res.status(204).end();
  }));

  router.post('/schemes/:id/duplicate', requireEditor, wrap((req, res) => {
    const { scheme } = loadScheme(req);
    const copy = schemes.duplicateScheme(scheme, req.session, req.body?.title);
    res.status(201).json(schemes.getSchemeDetail(copy.id));
  }));

  // ---------- units within a scheme ----------

  router.post('/schemes/:id/units', requireEditor, wrap((req, res) => {
    const { scheme } = loadScheme(req, { write: true });
    schemes.addUnit(scheme, req.body || {});
    res.json(schemes.getSchemeDetail(scheme.id));
  }));

  router.patch('/schemes/:id/units/:placementId', requireEditor, wrap((req, res) => {
    const { scheme } = loadScheme(req, { write: true });
    schemes.updatePlacement(scheme, req.params.placementId, req.body || {});
    res.json(schemes.getSchemeDetail(scheme.id));
  }));

  router.delete('/schemes/:id/units/:placementId', requireEditor, wrap((req, res) => {
    const { scheme } = loadScheme(req, { write: true });
    schemes.removeUnit(scheme, req.params.placementId);
    res.json(schemes.getSchemeDetail(scheme.id));
  }));

  router.post('/schemes/:id/reorder', requireEditor, wrap((req, res) => {
    const { scheme } = loadScheme(req, { write: true });
    schemes.reorderUnits(scheme, req.body?.order || []);
    res.json(schemes.getSchemeDetail(scheme.id));
  }));

  router.post('/schemes/:id/autoplan', requireEditor, wrap((req, res) => {
    const { scheme } = loadScheme(req, { write: true });
    const result = schemes.applyAutoPlan(scheme, req.body?.unitIds || null);
    res.json({ ...schemes.getSchemeDetail(scheme.id), unplaced: result.unplaced });
  }));

  router.put('/schemes/:id/lessons/:lessonId', requireEditor, wrap((req, res) => {
    const { scheme } = loadScheme(req, { write: true });
    const note = schemes.setLessonNote(scheme.id, req.params.lessonId, req.body || {});
    res.json({ lessonId: req.params.lessonId, note });
  }));

  // ---------- export ----------

  router.get('/schemes/:id/export', requireSession, wrap((req, res) => {
    const { scheme } = loadScheme(req);
    const detail = schemes.getSchemeDetail(scheme.id);
    const slug = scheme.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scheme-of-work';
    if (req.query.format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${slug}.json"`);
      return res.json(detail);
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.md"`);
    res.send(schemeToMarkdown(detail));
  }));

  router.get('/schemes/:id/lessons/:lessonId/plan', requireSession, wrap((req, res) => {
    const { scheme } = loadScheme(req);
    const notes = schemes.getLessonNotes(scheme.id);
    const markdown = lessonPlanToMarkdown(req.params.lessonId, {
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
