import { badge, el, meter } from '../dom.js';
import { unitCard } from './scheme.js';

export function libraryView({ library, catalogue, onSpineChange }) {
  const spines = catalogue?.spines || [];

  // A picker only earns its place once there is more than one curriculum.
  const picker = spines.length > 1
    ? el('select', {
        'aria-label': 'Curriculum',
        onChange: (e) => onSpineChange?.(e.target.value)
      }, spines.map((s) => el('option', { value: s.id, text: s.title, selected: s.id === library.id })))
    : null;

  return el('div', { class: 'stack' },
    el('div', { class: 'page-head' },
      el('div', { class: 'page-head__text' },
        el('h1', { text: `${library.title} library` }),
        el('p', { text: 'Every unit carries its curriculum links, the misconceptions it has to deal with, its practical work and a lesson-by-lesson sequence.' })
      ),
      picker ? el('div', { class: 'page-head__actions' }, picker) : null
    ),

    el('div', { class: 'card' },
      el('div', { class: 'card__head' }, el('h2', { text: 'Programme of study' })),
      el('div', { class: 'card__body card__body--flush' },
        library.strands.map((s) => {
          const unitsCovering = library.units.filter((u) => u.statementIds.some((id) => id.startsWith(`${s.id}.`)));
          return el('div', { class: 'coverage-row' },
            el('div', {},
              el('div', { class: 'coverage-row__title', text: s.title }),
              el('div', { class: 'small muted', text: `${s.statements.length} statements` })
            ),
            meter(unitsCovering.length ? 100 : 0, {
              label: `${s.title}: ${unitsCovering.length} units address this strand`
            }),
            el('div', { class: 'coverage-row__count', text: `${unitsCovering.length} units` })
          );
        })
      )
    ),

    el('div', {},
      el('h2', { style: { marginBottom: '.75rem' }, text: 'Units' }),
      el('div', { class: 'unitgrid' }, library.units.map((u) => unitCard(u)))
    ),

    el('p', { class: 'small muted', text: `Curriculum statements: ${library.source}` })
  );
}
