const TOKEN_KEY = 'sow.session';

export const tokenStore = {
  get: () => {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (token) => {
    try {
      // sessionStorage keeps an LTI launch scoped to the tab it opened in.
      sessionStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(TOKEN_KEY, token);
    } catch { /* storage may be blocked in an iframe; the cookie still works */ }
  },
  clear: () => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
    } catch { /* ignore */ }
  }
};

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    throw new ApiError(
      (payload && payload.error) || `request failed with status ${res.status}`,
      res.status
    );
  }
  return payload;
}

export const api = {
  getSession: () => request('GET', '/session'),
  signInLocal: (displayName) => request('POST', '/session/local', { displayName }),
  exchangeHandoff: (handoff) => request('POST', '/session/exchange', { handoff }),
  signOut: () => request('DELETE', '/session'),

  subjects: () => request('GET', '/subjects'),
  curriculum: (spineId) =>
    request('GET', spineId ? `/curriculum?spine=${encodeURIComponent(spineId)}` : '/curriculum'),
  unit: (id) => request('GET', `/curriculum/units/${encodeURIComponent(id)}`),
  lesson: (id) => request('GET', `/curriculum/lessons/${encodeURIComponent(id)}`),

  listSchemes: () => request('GET', '/schemes'),
  createScheme: (input) => request('POST', '/schemes', input),
  scheme: (id) => request('GET', `/schemes/${encodeURIComponent(id)}`),
  updateScheme: (id, input) => request('PATCH', `/schemes/${encodeURIComponent(id)}`, input),
  deleteScheme: (id) => request('DELETE', `/schemes/${encodeURIComponent(id)}`),
  duplicateScheme: (id, title) => request('POST', `/schemes/${encodeURIComponent(id)}/duplicate`, { title }),

  addUnit: (id, input) => request('POST', `/schemes/${encodeURIComponent(id)}/units`, input),
  updatePlacement: (id, placementId, input) =>
    request('PATCH', `/schemes/${encodeURIComponent(id)}/units/${encodeURIComponent(placementId)}`, input),
  removeUnit: (id, placementId) =>
    request('DELETE', `/schemes/${encodeURIComponent(id)}/units/${encodeURIComponent(placementId)}`),
  reorder: (id, order) => request('POST', `/schemes/${encodeURIComponent(id)}/reorder`, { order }),
  autoPlan: (id, unitIds) => request('POST', `/schemes/${encodeURIComponent(id)}/autoplan`, { unitIds }),
  setLessonNote: (id, lessonId, input) =>
    request('PUT', `/schemes/${encodeURIComponent(id)}/lessons/${encodeURIComponent(lessonId)}`, input),
  lessonPlan: (id, lessonId) =>
    request('GET', `/schemes/${encodeURIComponent(id)}/lessons/${encodeURIComponent(lessonId)}/plan`),

  ltiContext: () => request('GET', '/lti/context'),
  ltiBind: (schemeId, spineId) => request('POST', '/lti/bind', { schemeId, spineId }),
  deepLink: (items) => request('POST', '/lti/deep-link', { items })
};

export const exportUrl = (schemeId, format) =>
  `/api/schemes/${encodeURIComponent(schemeId)}/export?format=${format}`;

/**
 * Downloads go through fetch rather than a plain link so the bearer token is
 * sent — inside an LMS iframe the session cookie is often unavailable.
 */
export async function downloadFile(path, filename) {
  const headers = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { headers, credentials: 'same-origin' });
  if (!res.ok) throw new ApiError('download failed', res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
