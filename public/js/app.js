import { api, tokenStore } from './api.js';
import { el, field, mount, toast } from './dom.js';
import { dashboardView } from './views/dashboard.js';
import { deepLinkView } from './views/deeplink.js';
import { libraryView } from './views/library.js';
import { schemeView } from './views/scheme.js';
import { closeDrawer } from './views/detail.js';

const state = {
  session: null,
  capabilities: { standalone: true, lti: true },
  ltiContext: null,
  // Set when a link asked for a curriculum that is not installed.
  curriculumNotice: null,
  // Every installed curriculum, and the one the library view is showing.
  catalogue: { spines: [], subjects: [], keyStages: [], default: null },
  activeSpineId: null,
  library: null,
  schemes: [],
  route: { name: 'dashboard', params: {} }
};

/**
 * Curriculum asked for in the address bar, as `?subject=physics&keyStage=KS3`
 * or `?spine=physics-ks3`. Read from the hash query first (`#/library?...`)
 * and then the ordinary query string, because either is a reasonable thing to
 * type or to paste into a learning platform as a plain link.
 */
function readUrlCurriculum() {
  const fromHash = new URLSearchParams(location.hash.split('?')[1] || '');
  const fromSearch = new URLSearchParams(location.search);
  const pick = (...keys) => {
    for (const key of keys) {
      const value = fromHash.get(key) ?? fromSearch.get(key);
      if (value !== null && value.trim() !== '') return value.trim();
    }
    return null;
  };
  const requested = {
    spine: pick('spine', 'curriculum'),
    subject: pick('subject'),
    keyStage: pick('keyStage', 'key_stage', 'keystage')
  };
  return requested.spine || requested.subject || requested.keyStage ? requested : null;
}

/**
 * Match an address-bar request against what is installed. Mirrors how an LTI
 * launch is resolved: an unrecognised value is reported, never silently
 * swapped for something else.
 */
function resolveFromCatalogue(catalogue, requested) {
  if (!requested) return null;
  const spines = catalogue?.spines || [];
  const installed = spines.map((s) => s.id).join(', ') || 'none';
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  if (requested.spine) {
    const hit = spines.find((s) => eq(s.id, requested.spine));
    return hit
      ? { spine: hit }
      : { error: `No curriculum "${requested.spine}" is installed. Installed: ${installed}.` };
  }

  if (requested.subject) {
    const forSubject = spines.filter((s) => eq(s.subject, requested.subject));
    if (!forSubject.length) {
      return { error: `No ${requested.subject} curriculum is installed. Installed: ${installed}.` };
    }
    if (requested.keyStage) {
      const hit = forSubject.find((s) => eq(s.keyStage, requested.keyStage));
      return hit
        ? { spine: hit }
        : {
            error:
              `No ${requested.subject} curriculum at ${requested.keyStage} is installed. ` +
              `Installed for ${requested.subject}: ${forSubject.map((s) => s.keyStage).join(', ')}.`
          };
    }
    // A subject alone is enough when only one key stage is installed for it.
    return forSubject.length === 1
      ? { spine: forSubject[0] }
      : {
          error:
            `More than one key stage is installed for ${requested.subject}. ` +
            `Add keyStage=: ${forSubject.map((s) => s.keyStage).join(', ')}.`
        };
  }

  const forKeyStage = spines.filter((s) => eq(s.keyStage, requested.keyStage));
  return forKeyStage.length === 1
    ? { spine: forKeyStage[0] }
    : { error: `Give a subject as well as ${requested.keyStage}. Installed: ${installed}.` };
}

/**
 * Keep the address bar in step with the curriculum on screen, so the page can
 * be bookmarked, shared with a colleague, or pasted into a learning platform
 * as a plain link.
 */
function writeCurriculumToUrl(spine) {
  if (!spine || (state.catalogue.spines || []).length < 2) return;
  const url = new URL(location.href);
  url.searchParams.set('subject', spine.subject);
  url.searchParams.set('keyStage', spine.keyStage);
  url.searchParams.delete('spine');
  url.searchParams.delete('curriculum');

  // Strip the same keys from the hash so one answer is not stated twice.
  const [path, hashQuery] = location.hash.split('?');
  if (hashQuery) {
    const params = new URLSearchParams(hashQuery);
    for (const key of ['spine', 'curriculum', 'subject', 'keyStage', 'key_stage', 'keystage']) {
      params.delete(key);
    }
    const rest = params.toString();
    url.hash = rest ? `${path}?${rest}` : path;
  }
  history.replaceState(null, '', url);
}

/** Remember the last curriculum browsed, per viewer. */
const LAST_SPINE_KEY = 'sow.spine';
const rememberSpine = (id) => {
  try {
    localStorage.setItem(LAST_SPINE_KEY, id);
  } catch { /* storage may be blocked in an iframe */ }
};
const recallSpine = () => {
  try {
    return localStorage.getItem(LAST_SPINE_KEY);
  } catch {
    return null;
  }
};

const root = document.getElementById('app');

/* ---------- routing ---------- */

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  if (parts[0] === 'schemes' && parts[1]) {
    return { name: 'scheme', params: { id: parts[1], tab: params.tab } };
  }
  if (parts[0] === 'library') return { name: 'library', params: {} };
  if (parts[0] === 'deep-link') return { name: 'deepLink', params: {} };
  return { name: 'dashboard', params: {} };
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/* ---------- boot ---------- */

async function boot() {
  // An LTI launch lands on /launch.html, which stores the session token and
  // sends us here with the intended view already in the hash.
  try {
    const info = await api.getSession();
    state.capabilities = info.capabilities;
    state.session = info.session;
  } catch (err) {
    renderFatal(err.message);
    return;
  }

  if (!state.session) {
    renderSignIn();
    return;
  }

  await loadShellData();
  window.addEventListener('hashchange', async () => {
    closeDrawer();
    await applyUrlCurriculum();
    render();
  });
  render();
}

async function loadShellData() {
  const [catalogue, schemes, ltiContext] = await Promise.all([
    api.subjects(),
    api.listSchemes().then((r) => r.schemes),
    api.ltiContext().catch(() => ({ lti: false }))
  ]);
  state.catalogue = catalogue;
  state.schemes = schemes;
  state.ltiContext = ltiContext?.lti ? ltiContext : null;

  // Choose which curriculum to show. An address-bar parameter is the most
  // immediate statement of intent, so it outranks everything; then a learning
  // platform that named one; then what this browser last looked at.
  const ids = catalogue.spines.map((s) => s.id);
  const requested = readUrlCurriculum();
  const fromUrl = resolveFromCatalogue(catalogue, requested);
  state.curriculumNotice = fromUrl?.error || null;

  const fromLti = state.ltiContext?.curriculum?.spineId;
  const ltiIsAuthoritative = fromLti && state.ltiContext.curriculum.source !== 'default';
  const remembered = recallSpine();
  state.activeSpineId =
    fromUrl?.spine?.id ||
    (state.activeSpineId && ids.includes(state.activeSpineId) && state.activeSpineId) ||
    (ltiIsAuthoritative && ids.includes(fromLti) && fromLti) ||
    (remembered && ids.includes(remembered) && remembered) ||
    catalogue.default ||
    ids[0] ||
    null;

  // A link that named a curriculum has been honoured; remember it as this
  // viewer's choice so moving around the app stays on the same subject.
  if (fromUrl?.spine) rememberSpine(fromUrl.spine.id);

  state.library = state.activeSpineId ? await api.curriculum(state.activeSpineId) : null;
}

/**
 * Apply whatever curriculum the current address names. Called on every hash
 * change as well as on boot, because moving between views is a same-document
 * navigation — without this, a link carrying `#/library?subject=physics` would
 * be silently ignored.
 */
async function applyUrlCurriculum() {
  const requested = readUrlCurriculum();
  if (!requested) {
    state.curriculumNotice = null;
    return;
  }
  const resolved = resolveFromCatalogue(state.catalogue, requested);
  state.curriculumNotice = resolved?.error || null;
  if (!resolved?.spine || resolved.spine.id === state.activeSpineId) return;

  state.activeSpineId = resolved.spine.id;
  rememberSpine(resolved.spine.id);
  state.library = await api.curriculum(resolved.spine.id);
}

export async function setActiveSpine(spineId) {
  if (!spineId || spineId === state.activeSpineId) return;
  state.activeSpineId = spineId;
  rememberSpine(spineId);
  state.curriculumNotice = null;
  writeCurriculumToUrl((state.catalogue.spines || []).find((s) => s.id === spineId));
  state.library = await api.curriculum(spineId);
  render();
}

async function reload(keepRoute = true) {
  await loadShellData();
  if (keepRoute) render();
}

/* ---------- chrome ---------- */

function topbar() {
  const s = state.session;
  return el('header', { class: 'topbar' },
    el('div', { class: 'brand' },
      el('span', { class: 'brand__mark', 'aria-hidden': 'true', text: 'SW' }),
      el('span', {}, 'SOW Planner ',
        el('span', {
          class: 'brand__sub',
          text:
            state.catalogue.spines.length > 1
              ? `${state.catalogue.subjects.length} subjects`
              : state.library?.title || ''
        })
      )
    ),
    el('div', { class: 'topbar__spacer' }),
    state.ltiContext && el('div', { class: 'topbar__context topbar__context--lti' },
      el('span', { 'aria-hidden': 'true', text: '⛓' }),
      el('span', { text: state.ltiContext.contextTitle || state.ltiContext.platformName })
    ),
    el('div', { class: 'topbar__context' },
      el('span', { text: s.user.displayName }),
      el('span', { class: 'muted', text: s.permissions.role })
    ),
    el('button', {
      class: 'btn btn--ghost btn--sm',
      type: 'button',
      onClick: async () => {
        await api.signOut().catch(() => {});
        tokenStore.clear();
        location.hash = '';
        location.reload();
      }
    }, 'Sign out')
  );
}

function sidebar() {
  const route = state.route;
  const link = (hash, icon, label, count, active) =>
    el('a', {
      class: 'navlink',
      href: hash,
      'aria-current': active ? 'page' : null
    },
      el('span', { class: 'navlink__icon', 'aria-hidden': 'true', text: icon }),
      el('span', { text: label }),
      count !== undefined && el('span', { class: 'navlink__count', text: String(count) })
    );

  return el('nav', { class: 'sidebar', 'aria-label': 'Main' },
    el('div', { class: 'sidebar__group' },
      el('div', { class: 'sidebar__label', text: 'Planner' }),
      el('div', { class: 'navlist' },
        link('#/', '◧', 'Dashboard', undefined, route.name === 'dashboard'),
        link('#/library', '▤', 'Unit library', state.library?.units.length, route.name === 'library'),
        state.ltiContext?.canDeepLink
          ? link('#/deep-link', '⛓', 'Add to course', undefined, route.name === 'deepLink')
          : null
      )
    ),
    state.schemes.length
      ? el('div', { class: 'sidebar__group' },
          el('div', { class: 'sidebar__label', text: 'Schemes of work' }),
          el('div', { class: 'navlist' },
            state.schemes.map((s) =>
              link(`#/schemes/${s.id}`, '▦', s.title, `${s.stats.coveragePercent}%`,
                route.name === 'scheme' && route.params.id === s.id)
            )
          )
        )
      : null
  );
}

/* ---------- render ---------- */

async function render() {
  state.route = parseRoute();
  const main = el('main', { class: 'main', id: 'main' }, el('div', { class: 'main__inner' }, el('p', { class: 'muted', text: 'Loading…' })));
  const shell = el('div', { class: 'app' },
    el('a', { class: 'skip-link', href: '#main' }, 'Skip to content'),
    topbar(),
    el('div', { class: 'shell' }, sidebar(), main)
  );
  mount(root, shell);

  const inner = main.firstElementChild;
  const canEdit = state.session.permissions.canEdit;

  const notice = state.curriculumNotice
    ? el('div', { class: 'callout', style: { marginBottom: '1.25rem' } },
        el('strong', { text: 'Curriculum not found. ' }),
        `${state.curriculumNotice} Showing ${state.library?.title || 'the default curriculum'} instead.`
      )
    : null;
  const show = (content) => mount(inner, notice, content);

  try {
    if (state.route.name === 'scheme') {
      const detail = await api.scheme(state.route.params.id);
      show(schemeView({
        detail,
        library: state.library,
        tab: state.route.params.tab,
        canEdit: canEdit && (detail.access?.canEdit ?? true),
        reload: () => reload(),
        onDeleted: () => {
          navigate('#/');
          reload();
        }
      }));
      // Keep the LMS link pointed at whatever the teacher is working on, and
      // at the curriculum that scheme is for.
      if (state.ltiContext && !state.ltiContext.boundSchemeId && canEdit) {
        api.ltiBind(state.route.params.id, detail.scheme.spineId).catch(() => {});
        state.ltiContext.boundSchemeId = state.route.params.id;
      }
    } else if (state.route.name === 'library') {
      show(libraryView({
        library: state.library,
        catalogue: state.catalogue,
        onSpineChange: setActiveSpine
      }));
    } else if (state.route.name === 'deepLink') {
      show(deepLinkView({
        schemes: state.schemes,
        library: state.library,
        catalogue: state.catalogue,
        ltiContext: state.ltiContext
      }));
    } else {
      show(dashboardView({
        schemes: state.schemes,
        library: state.library,
        catalogue: state.catalogue,
        canEdit,
        ltiContext: state.ltiContext,
        reload: () => reload()
      }));
    }
  } catch (err) {
    mount(inner, el('div', { class: 'empty' },
      el('h3', { text: 'That could not be loaded' }),
      el('p', { text: err.message }),
      el('a', { class: 'btn', href: '#/' }, 'Back to the dashboard')
    ));
  }
}

function renderFatal(message) {
  mount(root, el('div', { class: 'signin' },
    el('div', { class: 'card signin__card' },
      el('div', { class: 'card__body' },
        el('h1', { text: 'The planner is unavailable' }),
        el('p', { class: 'muted', text: message })
      )
    )
  ));
}

function renderSignIn() {
  if (!state.capabilities.standalone) {
    renderFatal('This deployment only accepts launches from a learning platform. Open the tool from your course.');
    return;
  }
  const name = el('input', { type: 'text', placeholder: 'Your name', autocomplete: 'name' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      const { token } = await api.signInLocal(name.value.trim() || 'Teacher');
      tokenStore.set(token);
      location.hash = '#/';
      boot();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  mount(root, el('div', { class: 'signin' },
    el('form', { class: 'card signin__card', onSubmit: submit },
      el('div', { class: 'card__body stack' },
        el('div', { class: 'brand' },
          el('span', { class: 'brand__mark', 'aria-hidden': 'true', text: 'SW' }),
          el('span', { text: 'SOW Planner' })
        ),
        el('div', {},
          el('h1', { text: 'Plan a scheme of work' }),
          el('p', { class: 'muted', style: { marginTop: '.375rem' },
            text: 'National curriculum schemes of work. Sign in to start planning, or launch the tool from your learning platform.' })
        ),
        field('Your name', name, 'Used to label the schemes you create'),
        el('button', { class: 'btn btn--primary', type: 'submit' }, 'Start planning')
      )
    )
  ));
  name.focus();
}

boot();
