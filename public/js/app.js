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
  // Every installed curriculum, and the one the library view is showing.
  catalogue: { spines: [], subjects: [], keyStages: [], default: null },
  activeSpineId: null,
  library: null,
  schemes: [],
  route: { name: 'dashboard', params: {} }
};

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
  window.addEventListener('hashchange', () => {
    closeDrawer();
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

  // Choose which curriculum to show. A learning platform that named one
  // outranks what this browser happened to look at last — except where the
  // choice was only inferred from a course name, which is a suggestion.
  const ids = catalogue.spines.map((s) => s.id);
  const fromLti = state.ltiContext?.curriculum?.spineId;
  const ltiIsAuthoritative = fromLti && state.ltiContext.curriculum.source !== 'default';
  const remembered = recallSpine();
  state.activeSpineId =
    (state.activeSpineId && ids.includes(state.activeSpineId) && state.activeSpineId) ||
    (ltiIsAuthoritative && ids.includes(fromLti) && fromLti) ||
    (remembered && ids.includes(remembered) && remembered) ||
    catalogue.default ||
    ids[0] ||
    null;

  state.library = state.activeSpineId ? await api.curriculum(state.activeSpineId) : null;
}

export async function setActiveSpine(spineId) {
  if (!spineId || spineId === state.activeSpineId) return;
  state.activeSpineId = spineId;
  rememberSpine(spineId);
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

  try {
    if (state.route.name === 'scheme') {
      const detail = await api.scheme(state.route.params.id);
      mount(inner, schemeView({
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
      mount(inner, libraryView({
        library: state.library,
        catalogue: state.catalogue,
        onSpineChange: setActiveSpine
      }));
    } else if (state.route.name === 'deepLink') {
      mount(inner, deepLinkView({
        schemes: state.schemes,
        library: state.library,
        catalogue: state.catalogue,
        ltiContext: state.ltiContext
      }));
    } else {
      mount(inner, dashboardView({
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
