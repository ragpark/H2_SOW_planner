import { api, tokenStore } from '/js/api.js';

/**
 * Completes an LTI launch: exchanges the one-time handoff token for a session
 * the SPA holds itself, then continues to the view the launch resolved to.
 *
 * This lives in its own file rather than inline in launch.html because the
 * tool's Content-Security-Policy forbids inline scripts — an inline version
 * is silently blocked, leaving the launch stuck on this page forever.
 */
const status = document.getElementById('status');
const handoff = new URLSearchParams(location.search).get('handoff');

try {
  if (!handoff) throw new Error('This launch link is missing its handoff token.');
  const result = await api.exchangeHandoff(handoff);
  tokenStore.set(result.token);
  const target = result.target && result.target.startsWith('/') ? result.target.slice(1) : '';
  location.replace(`/${target}`);
} catch (err) {
  status.textContent = `${err.message} Open the tool again from your course.`;
}
