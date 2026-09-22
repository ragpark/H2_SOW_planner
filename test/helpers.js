process.env.DATABASE_FILE = ':memory:';
process.env.SESSION_SECRET = 'test-secret';
process.env.LTI_ADMIN_TOKEN = 'test-admin-token';

const { createApp } = await import('../src/server.js');

export async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, token, headers = {}, redirect = 'manual' } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined && typeof body === 'object') h['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers: h,
      redirect,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    const contentType = res.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await res.json()
      : await res.text();
    return { status: res.status, body: payload, headers: res.headers };
  };

  return {
    base,
    call,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export async function signIn(call, displayName = 'Miss Hart') {
  const res = await call('POST', '/api/session/local', { body: { displayName } });
  return res.body.token;
}
