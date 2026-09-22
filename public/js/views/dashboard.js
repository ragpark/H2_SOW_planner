import { api } from '../api.js';
import { badge, el, field, meter, stat, toast } from '../dom.js';

export function dashboardView({ schemes, library, canEdit, reload, ltiContext }) {
  const title = el('input', { type: 'text', placeholder: 'Year 9 Chemistry — Set 2', value: '' });
  const yearGroup = el('select', {}, [7, 8, 9, 10, 11].map((y) =>
    el('option', { value: String(y), text: `Year ${y}`, selected: y === 9 })
  ));
  const lessonsPerWeek = el('select', {}, [1, 2, 3, 4].map((n) =>
    el('option', { value: String(n), text: `${n} lesson${n === 1 ? '' : 's'} a week`, selected: n === 2 })
  ));
  const academicYear = el('input', { type: 'text', placeholder: '2026/27' });
  const autoPlan = el('input', { type: 'checkbox', checked: true });

  const createCard = el('div', { class: 'card' },
    el('div', { class: 'card__head' }, el('h2', { text: 'Start a new scheme of work' })),
    el('div', { class: 'card__body stack' },
      el('div', { class: 'form-grid' },
        field('Title', title),
        field('Year group', yearGroup),
        field('Teaching time', lessonsPerWeek),
        field('Academic year', academicYear)
      ),
      el('label', { class: 'row small', style: { gap: '.5rem' } },
        autoPlan,
        'Lay out the suggested sequence for me (you can change everything afterwards)'
      ),
      el('div', {},
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          onClick: async (e) => {
            e.target.disabled = true;
            try {
              const created = await api.createScheme({
                title: title.value.trim() || `Year ${yearGroup.value} Chemistry`,
                yearGroup: Number(yearGroup.value),
                lessonsPerWeek: Number(lessonsPerWeek.value),
                academicYear: academicYear.value.trim() || null,
                autoPlan: autoPlan.checked
              });
              toast('Scheme created');
              location.hash = `#/schemes/${created.scheme.id}`;
              reload();
            } catch (err) {
              toast(err.message, { error: true });
              e.target.disabled = false;
            }
          }
        }, 'Create scheme')
      )
    )
  );

  const list = schemes.length
    ? el('div', { class: 'card' },
        el('div', { class: 'card__head' },
          el('h2', { text: 'Your schemes of work' }),
          badge(`${schemes.length}`)
        ),
        el('div', { class: 'card__body card__body--flush' },
          schemes.map((s) =>
            el('a', {
              class: 'orderitem',
              href: `#/schemes/${s.id}`,
              style: { textDecoration: 'none', color: 'inherit' }
            },
              el('div', { class: 'orderitem__grip', 'aria-hidden': 'true', text: '▤' }),
              el('div', {},
                el('div', { class: 'orderitem__title', text: s.title }),
                el('div', {
                  class: 'orderitem__meta',
                  text:
                    `Year ${s.yearGroup} · ${s.stats.unitCount} units · ` +
                    `${s.stats.lessonsAllocated} of ${s.stats.lessonsAvailable} lessons planned` +
                    (s.isOwner ? '' : ' · shared with you')
                })
              ),
              el('div', { style: { minWidth: '9rem' } },
                meter(s.stats.coveragePercent, { label: `${s.stats.coveragePercent} per cent curriculum coverage` }),
                el('div', { class: 'small muted', style: { marginTop: '.25rem', textAlign: 'right' },
                  text: `${s.stats.coveragePercent}% covered` })
              )
            )
          )
        )
      )
    : el('div', { class: 'empty' },
        el('h3', { text: 'No schemes of work yet' }),
        el('p', { text: 'Create one below. The planner starts from the key stage 3 chemistry programme of study and lays out a sequence you can reshape.' })
      );

  return el('div', { class: 'stack' },
    el('div', { class: 'page-head' },
      el('div', { class: 'page-head__text' },
        el('h1', { text: 'Plan your teaching' }),
        el('p', {
          text: ltiContext?.contextTitle
            ? `${ltiContext.contextTitle} · launched from ${ltiContext.platformName}`
            : 'Build a scheme of work that covers the national curriculum, sequences sensibly, and gives you something to teach from.'
        })
      )
    ),
    el('div', { class: 'stats' },
      stat(library.units.length, 'Units in the library'),
      stat(library.totalLessons, 'Planned lessons available'),
      stat(library.strands.reduce((n, s) => n + s.statements.length, 0), 'Curriculum statements'),
      stat(schemes.length, 'Your schemes')
    ),
    list,
    canEdit ? createCard : null
  );
}
