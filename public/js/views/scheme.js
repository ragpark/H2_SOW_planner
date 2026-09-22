import { api, downloadFile, exportUrl } from '../api.js';
import { badge, el, field, meter, mount, section, stat, toast } from '../dom.js';
import { showLesson, showUnit } from './detail.js';

const SEVERITY_ICON = { error: '!', warning: '!', info: 'i' };
const SEVERITY_WORD = { error: 'Must fix', warning: 'Check this', info: 'For information' };

/** Findings pair colour with an icon and a written severity, never colour alone. */
function findingCard(f) {
  return el('div', { class: `finding finding--${f.severity}` },
    el('div', { class: 'finding__icon', 'aria-hidden': 'true', text: SEVERITY_ICON[f.severity] }),
    el('div', {},
      el('div', { class: 'finding__severity', text: SEVERITY_WORD[f.severity] }),
      el('div', { class: 'finding__title', text: f.title }),
      el('div', { class: 'finding__detail', text: f.detail }),
      f.action && el('div', { class: 'finding__action', text: f.action })
    )
  );
}

function statsRow(s) {
  return el('div', { class: 'stats' },
    stat(s.unitCount, 'Units'),
    stat(`${s.lessonsAllocated}`, 'Lessons planned', `of ${s.lessonsAvailable} available`),
    stat(s.practicalCount, 'Practical activities'),
    stat(`${s.coveragePercent}%`, 'Curriculum covered'),
    stat(s.misconceptionCount, 'Misconceptions addressed')
  );
}

export function schemeView(ctx) {
  const { detail, reload, canEdit } = ctx;
  const { scheme, timeline, findings, stats } = detail;

  const tabs = ['Plan', 'Units', 'Coverage', 'Review', 'Settings'];
  const state = { tab: ctx.tab && tabs.includes(ctx.tab) ? ctx.tab : 'Plan' };

  const panel = el('div', {});
  const tabBar = el('div', { class: 'tabs', role: 'tablist' },
    tabs.map((name) =>
      el('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: `tab-${name}`,
        'aria-selected': String(name === state.tab),
        onClick: () => {
          state.tab = name;
          for (const b of tabBar.children) b.setAttribute('aria-selected', String(b.textContent === name));
          renderPanel();
        }
      }, name)
    )
  );

  function renderPanel() {
    const views = {
      Plan: planTab,
      Units: unitsTab,
      Coverage: coverageTab,
      Review: reviewTab,
      Settings: settingsTab
    };
    mount(panel, views[state.tab](ctx));
    panel.setAttribute('aria-labelledby', `tab-${state.tab}`);
  }

  renderPanel();

  const blockingCount = findings.filter((f) => f.severity !== 'info').length;

  return el('div', { class: 'stack' },
    el('div', { class: 'page-head' },
      el('div', { class: 'page-head__text' },
        el('h1', { text: scheme.title }),
        el('p', {
          text:
            `Year ${scheme.yearGroup} ${scheme.subjectTitle || scheme.subject} · ${scheme.keyStage}` +
            (scheme.academicYear ? ` · ${scheme.academicYear}` : '') +
            ` · ${scheme.lessonsPerWeek} lessons a week across ${stats.weeks} weeks`
        }),
        !canEdit && el('p', { class: 'small muted', text: 'This launch is read-only.' })
      ),
      el('div', { class: 'page-head__actions' },
        blockingCount > 0 && el('button', {
          class: 'btn',
          type: 'button',
          onClick: () => {
            state.tab = 'Review';
            for (const b of tabBar.children) b.setAttribute('aria-selected', String(b.textContent === 'Review'));
            renderPanel();
          }
        }, `${blockingCount} to review`),
        el('button', {
          class: 'btn',
          type: 'button',
          onClick: () =>
            downloadFile(exportUrl(scheme.id, 'markdown'), `${scheme.title}.md`)
              .catch((err) => toast(err.message, { error: true }))
        }, 'Export'),
        el('button', { class: 'btn', type: 'button', onClick: () => window.print() }, 'Print')
      )
    ),
    statsRow(stats),
    tabBar,
    el('div', { role: 'tabpanel' }, panel)
  );
}

/* ---------- Plan: the year, week by week ---------- */

function planTab({ detail, canEdit, reload }) {
  const { scheme, timeline, lessonNotes } = detail;
  if (!detail.placements.length) {
    return el('div', { class: 'empty' },
      el('h3', { text: 'No units placed yet' }),
      el('p', {
        text: `Auto-plan lays the whole ${scheme.spineTitle || 'curriculum'} sequence across your year, which you can then adjust.`
      }),
      canEdit && el('button', {
        class: 'btn btn--primary',
        type: 'button',
        onClick: async (e) => {
          e.target.disabled = true;
          try {
            await api.autoPlan(scheme.id, null);
            toast('Scheme generated');
            reload();
          } catch (err) {
            toast(err.message, { error: true });
            e.target.disabled = false;
          }
        }
      }, 'Auto-plan the year')
    );
  }

  const terms = [];
  for (const [termIndex, term] of scheme.terms.entries()) {
    const weeks = timeline.weeks.filter((w) => w.termIndex === termIndex);
    const taught = weeks.filter((w) => w.entries.length > 0).length;
    terms.push(
      el('section', { class: 'term' },
        el('div', { class: 'term__head' },
          el('h2', { class: 'term__name', text: term.name }),
          el('span', { class: 'term__meta', text: `${term.weeks} weeks · ${taught} with teaching planned` })
        ),
        weeks.map((week) =>
          el('div', { class: `week${week.entries.length ? '' : ' week--empty'}` },
            el('div', { class: 'week__no', text: `Wk ${week.weekInTerm}` }),
            el('div', { class: 'week__body' },
              week.entries.map((entry) =>
                el('div', { class: 'block' },
                  el('div', { class: 'block__title' },
                    el('button', {
                      class: 'btn btn--ghost btn--sm',
                      type: 'button',
                      style: { padding: '0', fontWeight: '640' },
                      onClick: () => showUnit(entry.unitId, { scheme })
                    }, entry.unitTitle)
                  ),
                  el('div', { class: 'block__lessons' },
                    entry.lessons.map((lesson) =>
                      el('button', {
                        class: 'lesson-chip',
                        type: 'button',
                        onClick: () =>
                          showLesson(lesson.id, {
                            scheme,
                            note: lessonNotes[lesson.id] || null,
                            onNoteSaved: reload
                          })
                      },
                        el('span', {
                          class: 'lesson-chip__status',
                          dataset: { status: lessonNotes[lesson.id]?.status || 'planned' },
                          'aria-hidden': 'true'
                        }),
                        el('span', { class: 'lesson-chip__title', text: lesson.title }),
                        lesson.practical && badge('Practical', 'practical'),
                        lessonNotes[lesson.id]?.status
                          ? badge(lessonNotes[lesson.id].status)
                          : null
                      )
                    ),
                    entry.spareLessons > 0 && el('div', {
                      class: 'spare',
                      text: `${entry.spareLessons} spare lesson${entry.spareLessons === 1 ? '' : 's'} — consolidation, assessment feedback or an extended investigation`
                    })
                  )
                )
              )
            )
          )
        )
      )
    );
  }
  return el('div', {}, terms);
}

/* ---------- Units: order, allocation, and adding from the library ---------- */

function unitsTab({ detail, library, canEdit, reload }) {
  const { scheme, placements } = detail;
  const placedIds = new Set(placements.map((p) => p.unitId));

  const list = el('div', { class: 'orderlist' });
  let dragId = null;

  const commitOrder = async (order) => {
    try {
      await api.reorder(scheme.id, order);
      reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  placements.forEach((p, index) => {
    const item = el('div', {
      class: 'orderitem',
      draggable: canEdit ? 'true' : null,
      dataset: { id: p.id },
      onDragstart: (e) => {
        dragId = p.id;
        item.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', p.id);
      },
      onDragend: () => {
        dragId = null;
        item.classList.remove('is-dragging');
        for (const c of list.children) c.classList.remove('is-over');
      },
      onDragover: (e) => {
        if (!canEdit || !dragId || dragId === p.id) return;
        e.preventDefault();
        item.classList.add('is-over');
      },
      onDragleave: () => item.classList.remove('is-over'),
      onDrop: (e) => {
        e.preventDefault();
        item.classList.remove('is-over');
        const sourceId = dragId || e.dataTransfer.getData('text/plain');
        if (!sourceId || sourceId === p.id) return;
        const order = placements.map((x) => x.id).filter((id) => id !== sourceId);
        order.splice(order.indexOf(p.id), 0, sourceId);
        commitOrder(order);
      }
    },
      el('div', { class: 'orderitem__grip', 'aria-hidden': 'true', text: '⠿' }),
      el('div', {},
        el('div', { class: 'orderitem__title', text: p.customTitle || p.unit?.title || p.unitId }),
        el('div', {
          class: 'orderitem__meta',
          text:
            `${scheme.terms[p.termIndex]?.name || 'Term'} week ${p.weekInTerm} · ` +
            `${p.lessonsAllocated} lessons (unit provides ${p.unit?.lessonCount ?? 0})` +
            (p.unit?.practicalCount ? ` · ${p.unit.practicalCount} practicals` : '')
        })
      ),
      el('div', { class: 'orderitem__controls' },
        canEdit && el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          'aria-label': 'Move earlier',
          disabled: index === 0,
          onClick: () => {
            const order = placements.map((x) => x.id);
            [order[index - 1], order[index]] = [order[index], order[index - 1]];
            commitOrder(order);
          }
        }, '↑'),
        canEdit && el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          'aria-label': 'Move later',
          disabled: index === placements.length - 1,
          onClick: () => {
            const order = placements.map((x) => x.id);
            [order[index + 1], order[index]] = [order[index], order[index + 1]];
            commitOrder(order);
          }
        }, '↓'),
        canEdit && el('input', {
          class: 'orderitem__lessons',
          type: 'number',
          min: '1',
          max: '40',
          value: String(p.lessonsAllocated),
          'aria-label': `Lessons allocated to ${p.unit?.title || 'unit'}`,
          onChange: async (e) => {
            try {
              await api.updatePlacement(scheme.id, p.id, { lessonsAllocated: Number(e.target.value) });
              reload();
            } catch (err) {
              toast(err.message, { error: true });
            }
          }
        }),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onClick: () => showUnit(p.unitId, { scheme })
        }, 'View'),
        canEdit && el('button', {
          class: 'btn btn--ghost btn--sm btn--danger',
          type: 'button',
          onClick: async () => {
            if (!confirm(`Remove ${p.unit?.title || 'this unit'} from the scheme?`)) return;
            try {
              await api.removeUnit(scheme.id, p.id);
              toast('Unit removed');
              reload();
            } catch (err) {
              toast(err.message, { error: true });
            }
          }
        }, 'Remove')
      )
    );
    list.append(item);
  });

  const available = (library?.units || []).filter((u) => !placedIds.has(u.id));

  return el('div', { class: 'stack' },
    el('div', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', { text: 'Teaching order' }),
        canEdit && el('button', {
          class: 'btn btn--sm',
          type: 'button',
          onClick: async () => {
            if (!confirm('Auto-plan replaces the current sequence with the suggested one. Continue?')) return;
            try {
              await api.autoPlan(scheme.id, null);
              toast('Sequence regenerated');
              reload();
            } catch (err) {
              toast(err.message, { error: true });
            }
          }
        }, 'Auto-plan')
      ),
      placements.length
        ? el('div', { class: 'card__body card__body--flush' }, list)
        : el('div', { class: 'card__body' }, el('p', { class: 'muted', text: 'No units yet — add some below.' })),
      canEdit && placements.length
        ? el('div', { class: 'card__body', style: { borderTop: '1px solid var(--rule)', paddingTop: '.75rem' } },
            el('p', { class: 'small muted', text: 'Drag a unit, or use the arrows, to change the order. Weeks reflow automatically.' })
          )
        : null
    ),

    el('div', { class: 'card' },
      el('div', { class: 'card__head' }, el('h2', { text: 'Unit library' })),
      el('div', { class: 'card__body' },
        available.length
          ? el('div', { class: 'unitgrid' }, available.map((u) => unitCard(u, { scheme, canEdit, reload })))
          : el('p', { class: 'muted', text: 'Every unit in the library is already in this scheme.' })
      )
    )
  );
}

export function unitCard(u, { scheme = null, canEdit = false, reload = null } = {}) {
  return el('article', { class: 'unitcard' },
    el('h3', { class: 'unitcard__title', text: u.title }),
    el('p', { class: 'unitcard__strapline', text: u.strapline }),
    el('div', { class: 'unitcard__meta' },
      badge(`${u.suggestedLessons} lessons`),
      u.practicalCount ? badge(`${u.practicalCount} practicals`, 'practical') : null,
      u.misconceptionCount ? badge(`${u.misconceptionCount} misconceptions`) : null
    ),
    el('div', { class: 'unitcard__actions' },
      el('button', {
        class: 'btn btn--sm',
        type: 'button',
        onClick: () =>
          showUnit(u.id, {
            scheme,
            onAdd: scheme && canEdit ? (unitId) => addUnit(scheme, unitId, reload) : null
          })
      }, 'Preview'),
      scheme && canEdit && el('button', {
        class: 'btn btn--sm btn--primary',
        type: 'button',
        onClick: () => addUnit(scheme, u.id, reload)
      }, 'Add to scheme')
    )
  );
}

async function addUnit(scheme, unitId, reload) {
  try {
    await api.addUnit(scheme.id, { unitId });
    toast('Unit added');
    reload?.();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* ---------- Coverage: magnitude against the programme of study ---------- */

function coverageTab({ detail, library }) {
  const { coverage } = detail;

  const rows = coverage.strands.map((s) =>
    el('div', { class: 'coverage-row' },
      el('div', { class: 'coverage-row__title', text: s.title }),
      meter(s.percent, { label: `${s.title}: ${s.covered} of ${s.total} statements covered` }),
      el('div', { class: 'coverage-row__count', text: `${s.covered}/${s.total}` })
    )
  );

  const detailTables = coverage.strands.map((s) =>
    el('details', { class: 'card', style: { marginBottom: '.625rem' } },
      el('summary', { class: 'card__head', style: { cursor: 'pointer' } },
        el('h3', { text: `${s.title} — ${s.covered} of ${s.total}` })
      ),
      el('div', { class: 'card__body' },
        s.statements.map((st) =>
          el('div', { class: `statement statement--${st.coveredBy.length ? 'covered' : 'gap'}` },
            el('span', { class: 'statement__mark', 'aria-hidden': 'true', text: st.coveredBy.length ? '✓' : '○' }),
            el('div', {},
              el('div', { text: st.text }),
              el('div', {
                class: 'statement__where',
                text: st.coveredBy.length
                  ? `Covered in ${st.coveredBy.map((c) => c.unitTitle).join(', ')}`
                  : 'Not covered by this scheme'
              })
            )
          )
        )
      )
    )
  );

  return el('div', { class: 'stack' },
    el('div', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', { text: 'Programme of study coverage' }),
        badge(`${coverage.covered} of ${coverage.total} statements`)
      ),
      el('div', { class: 'card__body card__body--flush' }, rows)
    ),
    el('div', {},
      el('p', { class: 'small muted', style: { marginBottom: '.625rem' } },
        'Statements not covered here are not necessarily a problem — they may be taught in another year of the key stage. ',
        library?.source ? `Source: ${library.source}.` : ''
      ),
      detailTables
    )
  );
}

/* ---------- Review: the advisory checks ---------- */

function reviewTab({ detail }) {
  const { findings } = detail;
  if (!findings.length) {
    return el('div', { class: 'empty' },
      el('h3', { text: 'Nothing to flag' }),
      el('p', { text: 'Sequencing, capacity, practical rhythm, assessment points and coverage all look sound.' })
    );
  }
  return el('div', { class: 'card' },
    el('div', { class: 'card__head' },
      el('h2', { text: 'Planning review' }),
      badge(`${findings.length} note${findings.length === 1 ? '' : 's'}`)
    ),
    el('div', { class: 'card__body card__body--flush' }, findings.map(findingCard))
  );
}

/* ---------- Settings ---------- */

function settingsTab({ detail, canEdit, reload, onDeleted }) {
  const { scheme } = detail;
  const title = el('input', { type: 'text', value: scheme.title, disabled: !canEdit });
  const academicYear = el('input', {
    type: 'text', value: scheme.academicYear || '', placeholder: 'e.g. 2026/27', disabled: !canEdit
  });
  const lessonsPerWeek = el('input', {
    type: 'number', min: '1', max: '10', value: String(scheme.lessonsPerWeek), disabled: !canEdit
  });
  const notes = el('textarea', { value: scheme.notes || '', disabled: !canEdit });

  const termInputs = scheme.terms.map((t) =>
    el('div', { class: 'row' },
      el('input', { type: 'text', value: t.name, style: { flex: '2' }, disabled: !canEdit, 'aria-label': 'Term name' }),
      el('input', { type: 'number', min: '1', max: '20', value: String(t.weeks), style: { flex: '0 0 5rem' }, disabled: !canEdit, 'aria-label': 'Weeks' })
    )
  );

  return el('div', { class: 'stack' },
    el('div', { class: 'card' },
      el('div', { class: 'card__head' }, el('h2', { text: 'Scheme details' })),
      el('div', { class: 'card__body stack' },
        el('div', { class: 'form-grid' },
          field('Title', title),
          field('Academic year', academicYear),
          field(
            'Lessons a week',
            lessonsPerWeek,
            `How many ${(scheme.subjectTitle || scheme.subject || 'subject').toLowerCase()} lessons this class gets each week`
          )
        ),
        field('Notes', notes, 'Context for colleagues: setting, prior attainment, department decisions'),
        el('div', {},
          el('h3', { class: 'section__title', text: 'Terms' }),
          el('div', { class: 'stack', style: { gap: '.375rem' } }, termInputs),
          el('p', { class: 'field__hint', style: { marginTop: '.5rem' }, text: 'Term name and number of teaching weeks. Changing these reflows the plan.' })
        ),
        canEdit && el('div', { class: 'row' },
          el('button', {
            class: 'btn btn--primary',
            type: 'button',
            onClick: async (e) => {
              e.target.disabled = true;
              try {
                await api.updateScheme(scheme.id, {
                  title: title.value,
                  academicYear: academicYear.value,
                  lessonsPerWeek: Number(lessonsPerWeek.value),
                  notes: notes.value,
                  terms: termInputs.map((row) => ({
                    name: row.children[0].value,
                    weeks: Number(row.children[1].value)
                  }))
                });
                toast('Scheme updated');
                reload();
              } catch (err) {
                toast(err.message, { error: true });
                e.target.disabled = false;
              }
            }
          }, 'Save changes')
        )
      )
    ),

    el('div', { class: 'card' },
      el('div', { class: 'card__head' }, el('h2', { text: 'Export and share' })),
      el('div', { class: 'card__body row' },
        el('button', {
          class: 'btn', type: 'button',
          onClick: () => downloadFile(exportUrl(scheme.id, 'markdown'), `${scheme.title}.md`)
            .catch((err) => toast(err.message, { error: true }))
        }, 'Download as Markdown'),
        el('button', {
          class: 'btn', type: 'button',
          onClick: () => downloadFile(exportUrl(scheme.id, 'json'), `${scheme.title}.json`)
            .catch((err) => toast(err.message, { error: true }))
        }, 'Download as JSON'),
        canEdit && el('button', {
          class: 'btn', type: 'button',
          onClick: async () => {
            try {
              const copy = await api.duplicateScheme(scheme.id);
              toast('Scheme duplicated');
              location.hash = `#/schemes/${copy.scheme.id}`;
              reload();
            } catch (err) {
              toast(err.message, { error: true });
            }
          }
        }, 'Duplicate')
      )
    ),

    canEdit && el('div', { class: 'card' },
      el('div', { class: 'card__head' }, el('h2', { text: 'Delete' })),
      el('div', { class: 'card__body' },
        el('p', { class: 'small muted', text: 'Deleting a scheme removes its plan and lesson notes. This cannot be undone.' }),
        el('button', {
          class: 'btn btn--danger',
          type: 'button',
          onClick: async () => {
            if (!confirm(`Delete "${scheme.title}"? This cannot be undone.`)) return;
            try {
              await api.deleteScheme(scheme.id);
              toast('Scheme deleted');
              onDeleted?.();
            } catch (err) {
              toast(err.message, { error: true });
            }
          }
        }, 'Delete this scheme')
      )
    )
  );
}
