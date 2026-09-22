import { randomUUID } from 'node:crypto';
import { Router, urlencoded } from 'express';
import { config } from '../config.js';
import { many, one, query } from '../db/index.js';
import { getJwks } from '../lti/keys.js';
import { listPlatforms, registerPlatform } from '../lti/platforms.js';
import {
  LtiError,
  MESSAGE_TYPE,
  buildDeepLinkingResponse,
  buildLoginRedirect,
  redirectUri,
  summariseLaunch,
  validateLaunch
} from '../lti/service.js';
import { createHandoff, createSession, upsertLtiContext, upsertLtiUser } from '../services/identity.js';
import { SESSION_COOKIE, requireSession, sessionCookieOptions } from '../middleware/auth.js';
import { escapeHtml } from '../util/html.js';

const form = urlencoded({ extended: false });

/** Remember which scheme an LMS link points at, so relaunching reopens it. */
async function findResourceLinkBinding(launch) {
  if (!launch.resourceLink.id) return null;
  return one(
    `SELECT * FROM resource_links
      WHERE issuer = $1 AND client_id = $2 AND deployment_id = $3 AND resource_link_id = $4`,
    [launch.platform.issuer, launch.platform.clientId, launch.deploymentId, launch.resourceLink.id]
  );
}

export async function upsertResourceLinkBinding(launch, { schemeId, view = 'scheme' }) {
  const row = await one(
    `INSERT INTO resource_links (id, issuer, client_id, deployment_id, resource_link_id, scheme_id, view)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (issuer, client_id, deployment_id, resource_link_id)
     DO UPDATE SET scheme_id = EXCLUDED.scheme_id, view = EXCLUDED.view
     RETURNING id`,
    [
      randomUUID(),
      launch.platform.issuer,
      launch.platform.clientId,
      launch.deploymentId,
      launch.resourceLink.id,
      schemeId,
      view
    ]
  );
  return row.id;
}

export async function getLaunchForSession(sessionId) {
  const row = await one(
    'SELECT summary FROM lti_launches WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',
    [sessionId]
  );
  return row ? row.summary : null;
}

export function ltiRouter() {
  const router = Router();

  const guard = (fn) => async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };

  if (!config.lti.enabled) {
    router.use((_req, res) => res.status(404).json({ error: 'LTI is disabled on this deployment' }));
    return router;
  }

  // The tool's public keys, so platforms can verify our Deep Linking responses.
  router.get(['/jwks.json', '/.well-known/jwks.json'], guard(async (_req, res) => {
    res.json(await getJwks());
  }));

  // Everything a platform administrator needs to register this tool by hand.
  router.get('/config.json', (_req, res) => {
    res.json({
      title: 'Scheme of Work Planner',
      description: 'Plan and review a key stage 3 science scheme of work against the national curriculum.',
      oidc_initiation_url: `${config.toolUrl}/lti/login`,
      target_link_uri: `${config.toolUrl}/lti/launch`,
      redirect_uris: [redirectUri()],
      public_jwk_url: `${config.toolUrl}/lti/jwks.json`,
      scopes: [],
      extensions: [
        {
          platform: 'generic',
          privacy_level: 'public',
          settings: {
            placements: [
              { placement: 'course_navigation', message_type: 'LtiResourceLinkRequest', text: 'Scheme of Work' },
              { placement: 'link_selection', message_type: 'LtiDeepLinkingRequest', text: 'Add a scheme of work' }
            ]
          }
        }
      ]
    });
  });

  // Step 1: third-party initiated login. Platforms use GET or POST.
  router.all('/login', form, guard(async (req, res) => {
    const params = { ...req.query, ...req.body };
    const { url } = await buildLoginRedirect(params);
    res.redirect(302, url);
  }));

  // Step 2: the platform posts the signed id_token back here.
  router.post('/launch', form, guard(async (req, res) => {
    const validated = await validateLaunch({ idToken: req.body.id_token, state: req.body.state });
    const launch = summariseLaunch(validated);

    const user = await upsertLtiUser({
      issuer: launch.platform.issuer,
      sub: launch.user.sub,
      name: launch.user.name,
      email: launch.user.email
    });
    const context = await upsertLtiContext({
      issuer: launch.platform.issuer,
      contextId: launch.context.id,
      title: launch.context.title,
      label: launch.context.label
    });

    const session = await createSession({
      userId: user.id,
      contextId: context?.id || null,
      roles: launch.roles,
      source: 'lti'
    });
    await query('INSERT INTO lti_launches (id, session_id, summary) VALUES ($1, $2, $3::jsonb)', [
      randomUUID(),
      session.id,
      JSON.stringify(launch)
    ]);

    let target = '/';
    if (launch.messageType === MESSAGE_TYPE.deepLinking) {
      target = '/#/deep-link';
    } else {
      const binding = await findResourceLinkBinding(launch);
      if (binding?.scheme_id) target = `/#/schemes/${binding.scheme_id}`;
    }

    // Set the cookie for browsers that allow it, and hand over a one-time
    // token for those that block third-party cookies in the LMS iframe.
    res.cookie(SESSION_COOKIE, session.id, sessionCookieOptions());
    const handoff = await createHandoff(session.id, target);
    res.redirect(302, `/launch.html?handoff=${encodeURIComponent(handoff)}`);
  }));

  // What kind of launch is the current session, and what can it do?
  router.get('/context', requireSession, guard(async (req, res) => {
    const launch = await getLaunchForSession(req.session.id);
    if (!launch) return res.json({ lti: false });
    const binding = await findResourceLinkBinding(launch);
    res.json({
      lti: true,
      messageType: launch.messageType,
      platformName: launch.platform.name,
      contextTitle: launch.context.title,
      resourceLinkTitle: launch.resourceLink.title,
      canDeepLink: Boolean(launch.deepLinking?.deep_link_return_url),
      acceptMultiple: launch.deepLinking?.accept_multiple !== false,
      returnUrl: launch.returnUrl,
      boundSchemeId: binding?.scheme_id || null
    });
  }));

  // Bind the LMS link the teacher launched from to a scheme.
  router.post('/bind', requireSession, guard(async (req, res) => {
    const launch = await getLaunchForSession(req.session.id);
    if (!launch) return res.status(400).json({ error: 'this is not an LTI session' });
    if (!req.session.permissions.canEdit) return res.status(403).json({ error: 'read-only launch' });
    await upsertResourceLinkBinding(launch, { schemeId: req.body?.schemeId || null });
    res.json({ ok: true });
  }));

  // Deep Linking: return the chosen resources to the platform as a signed JWT.
  router.post('/deep-link', requireSession, guard(async (req, res) => {
    const launch = await getLaunchForSession(req.session.id);
    if (!launch?.deepLinking?.deep_link_return_url) {
      return res.status(400).json({ error: 'this launch cannot return content to the platform' });
    }
    if (!req.session.permissions.canEdit) return res.status(403).json({ error: 'read-only launch' });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'choose at least one item' });

    const contentItems = items.slice(0, 20).map((item) => {
      const url = new URL(`${config.toolUrl}/lti/launch`);
      // Custom parameters come back on the next launch and tell us what to open.
      return {
        type: 'ltiResourceLink',
        title: String(item.title || 'Scheme of work').slice(0, 160),
        text: item.text ? String(item.text).slice(0, 400) : undefined,
        url: url.toString(),
        custom: {
          ...(item.schemeId ? { scheme_id: String(item.schemeId) } : {}),
          ...(item.unitId ? { unit_id: String(item.unitId) } : {}),
          ...(item.lessonId ? { lesson_id: String(item.lessonId) } : {})
        }
      };
    });

    const { returnUrl, jwt } = await buildDeepLinkingResponse({ launch, contentItems });
    res.json({ returnUrl, jwt });
  }));

  // Platform registration. Protected by a deployment-time shared secret rather
  // than a user session, since it is an administrator task done once per LMS.
  router.post('/platforms', guard(async (req, res) => {
    const token = process.env.LTI_ADMIN_TOKEN;
    if (!token) return res.status(403).json({ error: 'LTI_ADMIN_TOKEN is not configured' });
    if (req.get('x-admin-token') !== token) return res.status(401).json({ error: 'invalid admin token' });
    try {
      res.status(201).json(await registerPlatform(req.body || {}));
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  }));

  router.get('/platforms', guard(async (req, res) => {
    const token = process.env.LTI_ADMIN_TOKEN;
    if (!token || req.get('x-admin-token') !== token) return res.status(401).json({ error: 'invalid admin token' });
    res.json({ platforms: await listPlatforms() });
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    const status = err instanceof LtiError ? err.status : err.status || 500;
    if (status >= 500) console.error('[lti]', err);
    res
      .status(status)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Launch failed</title>` +
          `<style>body{font:16px/1.5 system-ui;margin:3rem auto;max-width:34rem;color:#1a2030}` +
          `code{background:#eef1f6;padding:.15em .4em;border-radius:4px}</style>` +
          `<h1>This launch could not be completed</h1><p>${escapeHtml(err.message)}</p>` +
          `<p>Ask your administrator to check the tool registration, then launch again from your course.</p>`
      );
  });

  return router;
}
