/**
 * Minimal element builder. Everything the app renders goes through here, so
 * user-supplied text is always set as text content and never parsed as HTML.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && typeof value !== 'object') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
};

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/** A labelled form control. */
export function field(label, control, hint) {
  return el('label', { class: 'field' },
    el('span', { class: 'field__label', text: label }),
    control,
    hint && el('span', { class: 'field__hint', text: hint })
  );
}

export function stat(value, label, note) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat__value', text: String(value) }),
    el('div', { class: 'stat__label', text: label }),
    note && el('div', { class: 'stat__note', text: note })
  );
}

/** Magnitude meter: one hue, proportion of a whole. */
export function meter(percent, { large = false, label } = {}) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return el('div', {
    class: `meter${large ? ' meter--lg' : ''}`,
    role: 'img',
    'aria-label': label || `${pct} per cent`
  }, el('div', { class: 'meter__fill', style: { width: `${pct}%` } }));
}

export function badge(text, variant) {
  return el('span', { class: `badge${variant ? ` badge--${variant}` : ''}`, text });
}

export function section(title, ...children) {
  return el('section', { class: 'section' },
    el('h3', { class: 'section__title', text: title }),
    ...children
  );
}

export function bulletList(items) {
  if (!items || !items.length) return el('p', { class: 'muted small', text: 'None recorded.' });
  return el('ul', { class: 'bulletlist' }, items.map((i) => el('li', { text: i })));
}

let toastTimer = null;
export function toast(message, { error = false } = {}) {
  document.querySelector('.toast')?.remove();
  const node = el('div', {
    class: `toast${error ? ' toast--error' : ''}`,
    role: 'status',
    'aria-live': 'polite',
    text: message
  });
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), error ? 6000 : 3000);
}
