import { api } from '../api.js';
import { badge, el, field, meter, stat, toast } from '../dom.js';

export function dashboardView({ schemes, library, catalogue, canEdit, reload, ltiContext }) {
  const spines = catalogue?.spines || [];
  const multi = spines.length > 1;
  // With one curriculum installed there is nothing to choose, so no picker is
  // shown; the create form simply uses it.
  const initialSpine = spines.find((s) => s.id === library?.id) || spines[0] || null;

  const title = el('input', {
    type: 'text',
    placeholder: initialSpine ? `Year ${initialSpine.defaultYearGroup} ${initialSpine.subjectTitle} — Set 2` : 'Scheme title',
    value: ''
  });

  const curriculum = el('select', {},
    spines.map((s) => el('option', { value: s.id, text: s.title, selected: s.id === initialSpine?.id }))
  );

  const yearGroupOptions = () => {
    const spine = spines.find((s) => s.id === curriculum.value) || initialSpine;
    const years = spine?.yearGroups?.length ? spine.yearGroups : [7, 8, 9, 10, 11];
    return years.map((y) =>
      el('option', { value: String(y), text: `Year ${y}`, selected: y === spine?.defaultYearGroup })
    );
  };
  const yearGroup = el('select', {}, yearGroupOptions());

  // Changing curriculum changes which year groups make sense.
  curriculum.addEventListener('change', () => {
    const spine = spines.find((s) => s.id === curriculum.value);
    yearGroup.replaceChildren(...yearGroupOptions());
    if (spine) {
      title.placeholder = `Year ${spine.defaultYearGroup} ${spine.subjectTitle} — Set 2`;
    }
  });
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
        multi ? field('Curriculum', curriculum, 'Subject and key stage — fixed once the scheme exists') : null,
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
              const spine = spines.find((s) => s.id === curriculum.value) || initialSpine;
              const created = await api.createScheme({
                title:
                  title.value.trim() ||
                  `Year ${yearGroup.value} ${spine?.subjectTitle || ''}`.trim(),
                spineId: spine?.id,
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
                  text: s.stats
                    ? `${s.spineTitle} · Year ${s.yearGroup} · ${s.stats.unitCount} units · ` +
                      `${s.stats.lessonsAllocated} of ${s.stats.lessonsAvailable} lessons planned` +
                      (s.isOwner ? '' : ' · shared with you')
                    : `${s.spineTitle} · this curriculum is not installed on this deployment`
                })
              ),
              s.stats
                ? el('div', { style: { minWidth: '9rem' } },
                    meter(s.stats.coveragePercent, {
                      label: `${s.stats.coveragePercent} per cent curriculum coverage`
                    }),
                    el('div', { class: 'small muted', style: { marginTop: '.25rem', textAlign: 'right' },
                      text: `${s.stats.coveragePercent}% covered` })
                  )
                : null
            )
          )
        )
      )
    : el('div', { class: 'empty' },
        el('h3', { text: 'No schemes of work yet' }),
        el('p', {
          text: multi
            ? 'Create one below. Choose a curriculum, and the planner lays out a sequence from its programme of study that you can reshape.'
            : `Create one below. The planner starts from the ${(library?.title || 'curriculum').toLowerCase()} programme of study and lays out a sequence you can reshape.`
        })
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
      multi
        ? stat(spines.length, 'Curricula installed', catalogue.subjects.join(', '))
        : stat(library?.units.length ?? 0, 'Units in the library'),
      stat(library?.totalLessons ?? 0, 'Planned lessons available', multi ? library?.title : undefined),
      stat(library?.strands.reduce((n, s) => n + s.statements.length, 0) ?? 0, 'Curriculum statements'),
      stat(schemes.length, 'Your schemes')
    ),
    list,
    canEdit ? createCard : null
  );
}
