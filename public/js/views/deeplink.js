import { api } from '../api.js';
import { badge, el, toast } from '../dom.js';

/**
 * Deep Linking picker. The teacher chooses what the LMS link should open, and
 * the tool posts a signed response back to the platform.
 */
export function deepLinkView({ schemes, library, catalogue, ltiContext }) {
  const selected = new Set();
  const submitBtn = el('button', { class: 'btn btn--primary', type: 'button', disabled: true }, 'Add to course');

  const refresh = () => {
    submitBtn.disabled = selected.size === 0;
    submitBtn.textContent = selected.size
      ? `Add ${selected.size} item${selected.size === 1 ? '' : 's'} to course`
      : 'Add to course';
  };

  const option = (key, title, subtitle, payload) => {
    const box = el('input', {
      type: 'checkbox',
      onChange: (e) => {
        if (e.target.checked) selected.add(JSON.stringify(payload));
        else selected.delete(JSON.stringify(payload));
        refresh();
      }
    });
    return el('label', { class: 'orderitem', style: { cursor: 'pointer' } },
      box,
      el('div', {},
        el('div', { class: 'orderitem__title', text: title }),
        el('div', { class: 'orderitem__meta', text: subtitle })
      ),
      el('div', {}, badge(key))
    );
  };

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    try {
      const items = [...selected].map((s) => JSON.parse(s));
      const { returnUrl, jwt } = await api.deepLink(items);
      // The platform expects a form POST from the browser, not a fetch.
      const form = el('form', { method: 'POST', action: returnUrl },
        el('input', { type: 'hidden', name: 'JWT', value: jwt })
      );
      document.body.append(form);
      form.submit();
    } catch (err) {
      toast(err.message, { error: true });
      submitBtn.disabled = false;
    }
  });

  return el('div', { class: 'stack' },
    el('div', { class: 'page-head' },
      el('div', { class: 'page-head__text' },
        el('h1', { text: 'Choose what to add to your course' }),
        el('p', {
          text: ltiContext?.contextTitle
            ? `Adding to ${ltiContext.contextTitle}. Pick a whole scheme of work, or a single unit for pupils or colleagues to read.`
            : 'Pick a whole scheme of work, or a single unit.'
        })
      ),
      el('div', { class: 'page-head__actions' }, submitBtn)
    ),

    schemes.length
      ? el('div', { class: 'card' },
          el('div', { class: 'card__head' }, el('h2', { text: 'Your schemes of work' })),
          el('div', { class: 'card__body card__body--flush' },
            schemes.map((s) =>
              option(
                'Scheme',
                s.title,
                s.stats
                  ? `${s.spineTitle} · Year ${s.yearGroup} · ${s.stats.unitCount} units · ${s.stats.coveragePercent}% coverage`
                  : `${s.spineTitle} · curriculum not installed`,
                {
                  schemeId: s.id,
                  title: s.title,
                  text: s.stats
                    ? `Scheme of work: ${s.stats.unitCount} units, ${s.stats.lessonsAllocated} lessons.`
                    : 'Scheme of work.'
                }
              )
            )
          )
        )
      : el('div', { class: 'empty' },
          el('h3', { text: 'No schemes yet' }),
          el('p', { text: 'Create a scheme of work first, then come back to add it to your course.' }),
          el('a', { class: 'btn btn--primary', href: '#/' }, 'Go to the planner')
        ),

    el('div', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', { text: 'Individual units' }),
        (catalogue?.spines || []).length > 1 ? badge(library.title) : null
      ),
      el('div', { class: 'card__body card__body--flush' },
        library.units.map((u) =>
          option('Unit', u.title, `${u.suggestedLessons} lessons · ${u.practicalCount} practicals`, {
            unitId: u.id,
            title: u.title,
            text: u.strapline
          })
        )
      )
    )
  );
}
