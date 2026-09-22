# SOW Planner

A lightweight web app that helps a secondary teacher build and interrogate a
**scheme of work** for a UK national curriculum subject. It ships with a
complete **key stage 3 chemistry** content library aimed at Year 9.

It runs two ways from the same codebase:

- **Standalone** — a teacher signs in and plans.
- **LTI 1.3 tool** — launched from Canvas, Moodle, Blackboard, Schoology or any
  IMS-certified platform, with Deep Linking so a scheme can be placed into a course.

## What it actually does for a teacher

Most planning tools are document stores. This one models the year, so it can
answer the questions a teacher and a head of department actually ask:

| Question | How the tool answers it |
|---|---|
| Does my year cover the programme of study? | Coverage is computed per strand from the units placed, with every uncovered statement named. |
| Does my order make sense? | Units declare prerequisites. Teaching acids before chemical reactions is flagged, with the reason. |
| Does it fit? | Terms × weeks × lessons-per-week gives real capacity. Over-allocation is an error, not a surprise in February. |
| Is there enough practical work? | A run of three or more taught weeks with no practical is flagged. |
| When is assessment? | Terms that contain teaching but no summative point are flagged against the reporting calendar. |
| What do I teach on Tuesday? | Every lesson has objectives, a timed phase-by-phase sequence, retrieval starter, key questions, support and challenge, homework and an exit ticket. |

Auto-plan lays the suggested sequence across the year; everything after that is
the teacher's to reshape. The tool advises, it does not enforce.

### The content library

Nine units, 55 planned lessons, 26 practicals, covering **100% of the key stage 3
chemistry programme of study** including *Working scientifically*.

| Unit | Lessons | Focus |
|---|---|---|
| Particles, Purity and Separating Mixtures | 7 | Particle model, changes of state, separation techniques |
| Atoms, Elements and Compounds | 6 | Dalton, formulae, conservation of mass |
| The Periodic Table | 7 | Mendeleev, groups and periods, trends |
| Chemical Reactions and Equations | 7 | Reaction types, word and symbol equations |
| Acids, Alkalis and Salts | 7 | pH, neutralisation, salt preparation |
| Metals, Reactivity and Extraction | 6 | Reactivity series, corrosion, extraction |
| Energy Changes and Catalysts | 5 | Exothermic and endothermic, rates |
| Earth, Atmosphere and Climate | 6 | Earth structure, rock cycle, carbon cycle |
| Materials | 4 | Ceramics, polymers, composites |

Each unit carries its big idea, assumed prior knowledge, GCSE links, **common
misconceptions with why they stick and how to address them**, tiered vocabulary,
practicals with hazards and controls, and formative and summative assessment.

> **Safety.** Hazard and control notes are a *planning prompt, not a risk
> assessment*. Check every activity against your employer's model risk
> assessments (for example CLEAPSS) before teaching it. The app states this
> wherever practicals appear, including in exports.

## Running it

```bash
npm install
npm start           # http://localhost:3000
npm test            # 50 tests
```

Zero configuration in development: SQLite creates itself, the LTI keypair
generates on first use, and standalone sign-in is enabled.

### Production

```bash
NODE_ENV=production \
TOOL_URL=https://sow-planner.example.school \
SESSION_SECRET="$(openssl rand -hex 32)" \
npm start
```

The server refuses to boot in production without `TOOL_URL` and
`SESSION_SECRET`, and requires HTTPS. See `.env.example` for all settings.

## Architecture

```
src/
  server.js              Express app, security headers, static shell
  config.js              Environment configuration and production preflight
  curriculum/            The content library (JSON) + index, with integrity checks
    nc-ks3-chemistry.json    49 programme of study statements across 9 strands
    units/*.json             9 units with full lesson sequences
  services/
    planner.js           Calendar, auto-plan, timeline, coverage, review checks
    schemes.js           Scheme persistence and access rules
    identity.js          Users, contexts, sessions, role mapping
    exporter.js          Markdown for a scheme and for a single lesson plan
  lti/                   LTI 1.3: keys, platform registry, launch validation
  routes/                REST API and LTI endpoints
  db/                    SQLite schema and connection
public/                  Zero-build SPA: ES modules, no framework, no bundler
test/                    50 tests over the planner, API and LTI protocol
```

**No build step.** The client is plain ES modules served as-is. The whole
runtime is Express, better-sqlite3, cookie-parser and jose.

**Content is data.** Adding a subject means adding a statement file and unit
files. `validateCurriculum()` runs at boot and fails loudly on a broken
reference, so a bad content edit cannot silently produce wrong coverage.

### Design

Colour is used only where it carries meaning — status (findings, lesson state)
and magnitude (coverage meters) — following a validated palette. Unit identity
is carried by position and label rather than hue, so the timeline stays readable
for colourblind users and in print. Every finding pairs its colour with an icon
and a written severity. Light and dark modes are separately specified, layout
works to phone width, and a print stylesheet produces a scheme a department can
hand round.

## LTI 1.3

### Register the tool

Give your platform administrator:

| Field | Value |
|---|---|
| OIDC initiation URL | `{TOOL_URL}/lti/login` |
| Target link URI / Redirect URI | `{TOOL_URL}/lti/launch` |
| Public JWKS URL | `{TOOL_URL}/lti/jwks.json` |
| Tool configuration JSON | `{TOOL_URL}/lti/config.json` |

Then register the platform with the tool:

```bash
curl -X POST "$TOOL_URL/lti/platforms" \
  -H "x-admin-token: $LTI_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "School Canvas",
    "issuer": "https://canvas.instructure.com",
    "clientId": "10000000000001",
    "authLoginUrl": "https://canvas.instructure.com/api/lti/authorize_redirect",
    "authTokenUrl": "https://canvas.instructure.com/login/oauth2/token",
    "jwksUrl": "https://canvas.instructure.com/api/lti/security/jwks",
    "deploymentIds": ["1:abc123"]
  }'
```

### What is implemented

- **OIDC third-party initiated login** with single-use `state` and `nonce`.
- **Launch validation**: signature against the platform JWKS, issuer, audience,
  expiry with configurable clock tolerance, nonce replay rejection, registered
  deployment check, and LTI version enforcement.
- **Deep Linking 2.0**: a picker returns a signed `LtiDeepLinkingResponse` with
  `ltiResourceLink` content items, echoing the platform's opaque `data` claim.
- **Resource link binding**: relaunching the same LMS link reopens the scheme it
  was bound to.
- **Role mapping**: Instructor, ContentDeveloper, TeachingAssistant, Mentor,
  Administrator and Manager get editing rights; everyone else is read-only.
- **Course-level sharing**: staff on the same LMS course share editing of a
  scheme, so a department can plan together. Only the owner can delete.

### Third-party cookies

LTI tools run in an iframe, where browsers routinely block third-party cookies.
A launch therefore sets a `SameSite=None` cookie *and* redirects through
`/launch.html` with a single-use handoff token, which the SPA exchanges for a
session it holds itself and sends as a bearer token. The tool works whether or
not the cookie survives.

## API

All endpoints take a session as a `sow_session` cookie or an
`Authorization: Bearer` token.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/session` | Current session and deployment capabilities |
| `POST` | `/api/session/local` | Standalone sign-in |
| `POST` | `/api/session/exchange` | Redeem an LTI handoff token |
| `GET` | `/api/curriculum` | Strands, statements and unit summaries |
| `GET` | `/api/curriculum/units/:id` | A full unit |
| `GET` | `/api/curriculum/lessons/:id` | A full lesson |
| `GET`/`POST` | `/api/schemes` | List / create |
| `GET`/`PATCH`/`DELETE` | `/api/schemes/:id` | Read / update / delete |
| `POST` | `/api/schemes/:id/units` | Add a unit |
| `PATCH`/`DELETE` | `/api/schemes/:id/units/:placementId` | Resize or remove |
| `POST` | `/api/schemes/:id/reorder` | Reorder; weeks reflow |
| `POST` | `/api/schemes/:id/autoplan` | Generate a sequence |
| `PUT` | `/api/schemes/:id/lessons/:lessonId` | Lesson status and notes |
| `GET` | `/api/schemes/:id/export?format=markdown\|json` | Export |
| `GET` | `/api/schemes/:id/lessons/:lessonId/plan` | One-page lesson plan |

## Extending to another subject

1. Add `src/curriculum/nc-ks3-<subject>.json` with the programme of study.
2. Add unit files under `src/curriculum/units/`.
3. Declare prerequisites in `src/curriculum/index.js`.

The planner, coverage engine, review checks, exporter and UI are
subject-agnostic — they read whatever the content library declares.

## Licence and attribution

National curriculum statements are derived from *National curriculum in England:
science programmes of study — key stage 3* (Department for Education), available
under the Open Government Licence v3.0. The unit and lesson content is original
material written for this tool.
