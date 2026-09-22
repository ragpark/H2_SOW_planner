# SOW Planner

A lightweight web app that helps a secondary teacher build and interrogate a
**scheme of work** for a UK national curriculum subject.

The planning engine is **subject-agnostic**: a curriculum is a data package
identified by *(subject, key stage)*, and the app loads every one it finds. It
ships with a complete **key stage 3 chemistry** library aimed at Year 9; adding
physics, or key stage 4 chemistry, means adding a directory, not changing code.

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

# Any PostgreSQL will do; this starts a throwaway one.
docker run -d --name sow-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres

npm start           # http://localhost:3000
npm test            # 97 tests, against a real PostgreSQL
```

The schema applies itself on boot, the LTI keypair generates on first use, and
standalone sign-in is enabled. Tests run against real PostgreSQL rather than an
emulation, each test file in its own database, so dialect differences cannot
hide in the suite and appear only on deploy. Point them elsewhere with
`TEST_DATABASE_URL`.

### Deploying to Railway

The repository is Railway-ready: `railway.json` selects the Dockerfile build and
gates the deploy on `/healthz`.

1. **Create the service** from this repo. Railway builds the `Dockerfile`.
2. **Attach a volume.** This is the one step you must not skip — see below.
3. **Generate a domain** (Settings → Networking). Nothing else is required:
   `TOOL_URL` is derived from `RAILWAY_PUBLIC_DOMAIN`, and the database path is
   derived from the volume mount, so LTI redirect URIs are correct by
   construction rather than by remembering to set them.
4. **Set `LTI_ADMIN_TOKEN`** to a long random string if you will register LMS
   platforms over HTTP. Without it, the registration endpoint stays disabled.

```bash
railway up                       # from the repo root
railway variables --set "LTI_ADMIN_TOKEN=$(openssl rand -hex 32)"
```

#### Connect the database

Add a Postgres service to the project, then on the app service set:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

That reference resolves to the private-network address, so traffic never leaves
the project and needs no TLS. Confirm it worked:

```bash
curl https://<your-domain>/healthz
# {"ok":true,"subject":"chemistry","store":"postgres","lti":true}
```

The health check runs a real query, so a green check means the database is
genuinely reachable, not just that the process started. The app refuses to
start in production without `DATABASE_URL`, and waits and retries on boot
because a database container can accept connections slightly later than the app
starts.

#### Migrating from the SQLite version

An earlier version stored everything in SQLite on a mounted volume. On boot the
app imports that file into Postgres **once**, so no schemes of work are lost.
The import is deliberately conservative: it runs only when the file exists
*and* the Postgres database has no schemes, it records that it ran in
`data_migrations`, and it never overwrites. Short-lived rows (sessions,
handoffs, nonces) are not copied — they expire within hours, and a fresh
sign-in is better than importing state about to become invalid.

Once the boot log shows the import, the volume is no longer read and can be
detached. Set `SQLITE_IMPORT=off` to disable the behaviour entirely.

#### Replicas

`railway.json` pins `numReplicas` to 1. Postgres itself is no longer the reason
— the schema, the LTI key handling and session redemption are all
concurrency-safe — but nothing has been load-tested above one instance, so
raise it deliberately rather than by accident.

#### What Railway handles, and what it does not

Railway terminates TLS and sets `X-Forwarded-*`; the app sets `trust proxy` and
issues `SameSite=None; Secure` cookies accordingly, which LTI needs in an
iframe. On redeploy Railway sends `SIGTERM`; the app drains in-flight requests
and checkpoints the write-ahead log before exiting.

### Production on any other host

```bash
NODE_ENV=production \
TOOL_URL=https://sow-planner.example.school \
DATABASE_FILE=/var/lib/sow-planner/sow.db \
DATABASE_PERSISTENT=1 \
npm start
```

The server refuses to boot in production unless it can resolve a public HTTPS
URL, and warns if the database looks ephemeral. See `.env.example`.

> There is no `SESSION_SECRET`. Session tokens are 256-bit random opaque values
> stored in the database and looked up directly, so there is nothing to sign.
> If one is set, the app tells you it is unused rather than ignoring it.

## Architecture

```
src/
  server.js              Express app, security headers, static shell
  config.js              Environment configuration and production preflight
  curriculum/            Curriculum spines as data, with a registry and integrity checks
    common/*.json            Strands shared between subjects (working scientifically)
    spines/<subject>-<ks>/   One curriculum: manifest.json, spine.json, units/*.json
  services/
    planner.js           Calendar, auto-plan, timeline, coverage, review checks (pure, no I/O)
    schemes.js           Scheme persistence and access rules
    identity.js          Users, contexts, sessions, role mapping
    exporter.js          Markdown for a scheme and for a single lesson plan
  lti/                   LTI 1.3: keys, platform registry, launch validation
  routes/                REST API and LTI endpoints
  db/                    PostgreSQL schema, pool, and the one-time SQLite import
public/                  Zero-build SPA: ES modules, no framework, no bundler
test/                    97 tests over the planner, API, LTI protocol, config and migration
  fixtures/spines/       A synthetic curriculum, to prove subject-agnosticism
Dockerfile               Pinned Node 22, native module built from source
railway.json             Dockerfile build, /healthz deploy gate, single replica
```

**No build step.** The client is plain ES modules served as-is. The whole
runtime is Express, pg, cookie-parser and jose. (`better-sqlite3` remains only
to read a pre-Postgres file during the one-time import.)

**The planner is pure.** `services/planner.js` does no I/O — calendars,
sequencing, coverage and the review checks are functions over plain data. That
is why swapping the entire storage engine did not touch a line of it.

**Content is data.** A curriculum spine is a directory:

```
src/curriculum/spines/chemistry-ks3/
  manifest.json     subject, key stage, year groups, source, prerequisites
  spine.json        the programme of study strands and statements
  units/*.json      units with full lesson sequences
```

`validateCurriculum()` runs at boot across every installed spine and fails
loudly on a broken reference, so a bad content edit cannot silently produce
wrong coverage. It also enforces that **unit and lesson ids are unique across
all spines** — schemes store them as bare strings, so global uniqueness means
adding a subject never requires rewriting stored data.

Set `CURRICULUM_DIR` (colon-separated) to load spines from outside the
repository, so a school can carry its own without forking.

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

### Choosing the curriculum from the LMS

A platform administrator sets a custom parameter on the placement:

```
subject=physics
key_stage=KS3      # optional when only one key stage is installed for a subject
```

or `spine=physics-ks3` to name a curriculum outright. The launch resolves it
in this order, strongest first:

| | Source | Notes |
|---|---|---|
| 1 | The LMS link's own binding | What the link was created for |
| 2 | `custom.subject` / `custom.spine` | What the platform asked for |
| 3 | The course's remembered choice | Set when a scheme is bound |
| 4 | The course name | "Year 9 Physics" — a **suggestion**, never applied silently |
| 5 | `DEFAULT_SPINE`, or the only installed curriculum | |

Nothing is trusted. Every value is resolved against the installed curricula,
and an unrecognised one produces a visible notice naming what was asked for
and what is installed — while the launch still succeeds on a fallback. A
teacher is never locked out by a typo in an LMS configuration.

The interface always says where the choice came from, so a teacher who did not
pick the subject can see that their platform did, and correct it.

### What is implemented

- **OIDC third-party initiated login** with single-use `state` and `nonce`.
- **Launch validation**: signature against the platform JWKS, issuer, audience,
  expiry with configurable clock tolerance, nonce replay rejection, registered
  deployment check, and LTI version enforcement.
- **Deep Linking 2.0**: a picker returns a signed `LtiDeepLinkingResponse` with
  `ltiResourceLink` content items, echoing the platform's opaque `data` claim.
  Items carry their curriculum, so a created link reopens the right subject.
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
| `GET` | `/api/subjects` | Installed curricula, subjects and key stages |
| `GET` | `/api/curriculum` | Strands, statements and unit summaries (`?spine=` or `?subject=&keyStage=`) |
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

## Adding a subject or key stage

1. Create `src/curriculum/spines/<subject>-<keystage>/`.
2. Write `manifest.json` — subject, key stage, year groups, source attribution,
   any `sharedStrands` to include, and the unit prerequisite map.
3. Write `spine.json` with the subject's programme of study strands.
4. Write `units/*.json`, giving every unit and lesson a globally unique id.

Nothing else changes. The planner, coverage engine, review checks, exporter and
UI read whatever the spine declares — `services/planner.js` takes the spine as
an argument and reads nothing global, which is why the same sequencing and
coverage logic serves key stage 3 chemistry and key stage 4 physics alike.

With one spine installed the app hides the picker entirely and behaves exactly
as a single-subject tool. With more than one, the teacher chooses a curriculum
when creating a scheme; **that choice is then fixed**, because a scheme's units,
coverage and prerequisites all key off it.

The test suite includes a synthetic `fixtures-ks4` spine under
`test/fixtures/spines`. Running the planner assertions against both it and
chemistry is what proves the engine carries no subject assumptions — testing
chemistry twice would not.

## Licence and attribution

National curriculum statements are derived from *National curriculum in England:
science programmes of study — key stage 3* (Department for Education), available
under the Open Government Licence v3.0. The unit and lesson content is original
material written for this tool.
