import { api, downloadFile } from '../api.js';
import { badge, bulletList, el, field, mount, section, toast } from '../dom.js';

let activeDrawer = null;

function closeDrawer() {
  if (!activeDrawer) return;
  activeDrawer.scrim.remove();
  activeDrawer.panel.remove();
  activeDrawer.lastFocus?.focus?.();
  document.removeEventListener('keydown', activeDrawer.onKey);
  activeDrawer = null;
}

/** Open a right-hand detail panel. Focus is trapped and Escape closes it. */
function openDrawer({ eyebrow, title, body, footer }) {
  closeDrawer();
  const lastFocus = document.activeElement;
  const scrim = el('div', { class: 'drawer-scrim', onClick: closeDrawer });
  const closeBtn = el('button', {
    class: 'btn btn--ghost',
    type: 'button',
    'aria-label': 'Close',
    onClick: closeDrawer
  }, '✕');

  const panel = el('aside', {
    class: 'drawer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title
  },
    el('header', { class: 'drawer__head' },
      el('div', { style: { flex: '1', minWidth: '0' } },
        eyebrow && el('div', { class: 'drawer__eyebrow', text: eyebrow }),
        el('h2', { text: title })
      ),
      closeBtn
    ),
    el('div', { class: 'drawer__body' }, body),
    footer && el('footer', { class: 'drawer__foot' }, footer)
  );

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDrawer();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = panel.querySelectorAll(
      'a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', onKey);
  document.body.append(scrim, panel);
  activeDrawer = { scrim, panel, onKey, lastFocus };
  closeBtn.focus();
  return panel;
}

function statementList(statements) {
  if (!statements?.length) return el('p', { class: 'muted small', text: 'No statements linked.' });
  return el('div', {}, statements.map((s) =>
    el('div', { class: 'statement statement--covered' },
      el('span', { class: 'statement__mark', text: '✓', 'aria-hidden': 'true' }),
      el('div', {},
        el('div', { text: s.text }),
        el('div', { class: 'statement__where', text: s.strandTitle })
      )
    )
  ));
}

function safetyCallout() {
  return el('div', { class: 'callout' },
    el('strong', { text: 'Not a risk assessment. ' }),
    'Hazards and controls here are a planning prompt. Check every activity against your ',
    'employer’s model risk assessments (for example CLEAPSS) before teaching it.'
  );
}

export async function showUnit(unitId, { scheme = null, onAdd = null } = {}) {
  let unit;
  try {
    unit = await api.unit(unitId);
  } catch (err) {
    toast(err.message, { error: true });
    return;
  }

  const body = el('div', {},
    el('p', { class: 'muted', text: unit.strapline }),
    el('div', { class: 'callout callout--info', style: { marginBottom: '1.25rem' } },
      el('strong', { text: 'Big idea. ' }), unit.bigIdea
    ),

    section('Suggested shape',
      el('div', { class: 'row small' },
        badge(`${unit.suggestedLessons} lessons`),
        badge(`${unit.practicals.length} practicals`, 'practical'),
        badge(`${unit.misconceptions.length} misconceptions`),
        unit.prerequisites.length
          ? badge(`After: ${unit.prerequisites.map((p) => p.title).join(', ')}`)
          : badge('No prerequisites')
      )
    ),

    section('Assumed prior knowledge', bulletList(unit.priorKnowledge)),
    section('Where this leads', bulletList(unit.futureLearning)),

    section('Common misconceptions',
      el('div', {}, unit.misconceptions.map((m) =>
        el('div', { class: 'misconception' },
          el('div', { class: 'misconception__claim', text: m.misconception }),
          el('div', { class: 'misconception__line' }, el('b', { text: 'Why it sticks: ' }), m.whyItSticks),
          el('div', { class: 'misconception__line' }, el('b', { text: 'How to address it: ' }), m.addressIt)
        )
      ))
    ),

    section('Key vocabulary',
      el('table', { class: 'datatable' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Term' }), el('th', { text: 'Meaning' }))),
        el('tbody', {}, unit.keyVocabulary.map((v) =>
          el('tr', {}, el('td', { text: v.term }), el('td', { text: v.definition }))
        ))
      )
    ),

    unit.practicals.length && section('Practical work',
      el('div', {}, unit.practicals.map((p) =>
        el('div', { class: 'misconception' },
          el('div', { class: 'misconception__claim', text: p.title }),
          el('div', { class: 'misconception__line', text: `${p.type} · ${p.timing}` }),
          el('div', { class: 'misconception__line' }, el('b', { text: 'Apparatus: ' }), p.apparatus.join(', ')),
          el('div', { class: 'misconception__line' }, el('b', { text: 'Hazards: ' }), p.hazards.join('; ')),
          el('div', { class: 'misconception__line' }, el('b', { text: 'Controls: ' }), p.control.join('; '))
        )
      )),
      safetyCallout()
    ),

    section('Lesson sequence',
      el('ol', { class: 'bulletlist' }, unit.lessons.map((l) =>
        el('li', {},
          el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onClick: () => showLesson(l.id, { scheme })
          }, l.title)
        )
      ))
    ),

    section('Assessment',
      unit.assessment?.summative
        ? el('div', {},
            el('p', {}, el('b', { text: unit.assessment.summative.title })),
            el('p', { class: 'small', text: unit.assessment.summative.style }),
            el('p', { class: 'small muted', text: unit.assessment.summative.markSchemeNotes })
          )
        : el('p', { class: 'muted small', text: 'No summative assessment defined.' }),
      el('h4', { class: 'section__title', style: { marginTop: '.75rem' }, text: 'Formative checks' }),
      bulletList(unit.assessment?.formative)
    ),

    section('Curriculum statements covered', statementList(unit.statements))
  );

  const footer = [];
  if (onAdd) {
    footer.push(el('button', {
      class: 'btn btn--primary',
      type: 'button',
      onClick: async () => {
        await onAdd(unit.id);
        closeDrawer();
      }
    }, 'Add to this scheme'));
  }
  footer.push(el('button', { class: 'btn', type: 'button', onClick: () => window.print() }, 'Print'));

  openDrawer({ eyebrow: 'Unit', title: unit.title, body, footer });
}

export async function showLesson(lessonId, { scheme = null, note = null, onNoteSaved = null } = {}) {
  let lesson;
  try {
    lesson = await api.lesson(lessonId);
  } catch (err) {
    toast(err.message, { error: true });
    return;
  }

  const p = lesson.practicalDetail;
  const totalMinutes = lesson.sequence.reduce((n, s) => n + s.minutes, 0);

  const statusSelect = el('select', {},
    ['planned', 'ready', 'taught', 'skipped'].map((s) =>
      el('option', { value: s, text: s[0].toUpperCase() + s.slice(1), selected: note?.status === s })
    )
  );
  const notesBox = el('textarea', {
    placeholder: 'Notes for this class — groupings, timings, what to reteach…',
    value: note?.notes || ''
  });

  const body = el('div', {},
    el('div', { class: 'row small muted', style: { marginBottom: '1rem' } },
      badge(`${totalMinutes} minutes planned`),
      p && badge('Practical', 'practical'),
      badge(`${lesson.objectives.length} objectives`)
    ),

    section('Learning objectives', bulletList(lesson.objectives)),
    section('Retrieval starter', bulletList(lesson.retrieval)),

    section('Lesson sequence',
      el('table', { class: 'datatable datatable--mins' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Phase' }), el('th', { text: 'Mins' }), el('th', { text: 'What happens' })
        )),
        el('tbody', {}, lesson.sequence.map((s) =>
          el('tr', {}, el('td', { text: s.phase }), el('td', { text: String(s.minutes) }), el('td', { text: s.detail }))
        ))
      )
    ),

    p && section(`Practical: ${p.title}`,
      el('p', { class: 'small muted', text: `${p.type} · ${p.timing}` }),
      el('h4', { class: 'section__title', text: 'Apparatus' }), bulletList(p.apparatus),
      el('h4', { class: 'section__title', text: 'Hazards' }), bulletList(p.hazards),
      el('h4', { class: 'section__title', text: 'Controls' }), bulletList(p.control),
      safetyCallout()
    ),

    section('Key questions', bulletList(lesson.keyQuestions)),
    section('Adaptive teaching',
      el('h4', { class: 'section__title', text: 'Support' }), bulletList(lesson.support),
      el('h4', { class: 'section__title', text: 'Challenge' }), bulletList(lesson.challenge)
    ),

    section('Watch for',
      el('div', {}, lesson.misconceptions.slice(0, 3).map((m) =>
        el('div', { class: 'misconception' },
          el('div', { class: 'misconception__claim', text: m.misconception }),
          el('div', { class: 'misconception__line', text: m.addressIt })
        )
      ))
    ),

    section('Homework', el('p', { class: 'small', text: lesson.homework || 'None set.' })),
    section('Exit ticket', el('p', { class: 'small', text: lesson.exitTicket || 'None.' })),
    section('Curriculum links', statementList(lesson.statements)),

    scheme && section('Your notes for this class',
      field('Status', statusSelect),
      el('div', { style: { marginTop: '.625rem' } }, field('Notes', notesBox))
    )
  );

  const footer = [];
  if (scheme) {
    footer.push(el('button', {
      class: 'btn btn--primary',
      type: 'button',
      onClick: async (e) => {
        e.target.disabled = true;
        try {
          await api.setLessonNote(scheme.id, lessonId, {
            status: statusSelect.value,
            notes: notesBox.value
          });
          toast('Lesson notes saved');
          onNoteSaved?.();
          closeDrawer();
        } catch (err) {
          toast(err.message, { error: true });
          e.target.disabled = false;
        }
      }
    }, 'Save notes'));
    footer.push(el('button', {
      class: 'btn',
      type: 'button',
      onClick: () =>
        downloadFile(
          `/api/schemes/${encodeURIComponent(scheme.id)}/lessons/${encodeURIComponent(lessonId)}/plan?format=markdown`,
          `${lessonId}.md`
        ).catch((err) => toast(err.message, { error: true }))
    }, 'Download plan'));
  }
  footer.push(el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => window.print() }, 'Print'));

  openDrawer({ eyebrow: lesson.unitTitle, title: lesson.title, body, footer });
}

export { closeDrawer };
