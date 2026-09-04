# Versioning

Hue numbers releases the way Dota 2 numbers patches. This note says what the
scheme means, why the file on disk does not look like it, and what the next few
releases are called.

## The scheme

Three kinds of release, and the number tells you which one you are looking at:

| Looks like | Called a | What is in it |
|---|---|---|
| `1.6` | a **content patch** | New capability. A feature you could not do before. |
| `1.6b`, `1.6c` | a **lettered follow-up** | Fixes and tuning for the patch it follows. No new capability. |
| `2.0` | a **rework** | The product works differently. Rare, and deliberate. |

Two rules carried over from Dota, and they are the whole discipline:

- **There is no `1.6a`.** The base release *is* `a`. Letters begin at `b`, which
  is what makes a lettered release read as "the one after", not as "the first
  one". A user who sees `1.6b` knows there was a `1.6` and that something in it
  needed fixing.
- **A letter never adds a feature.** The moment a release does something the
  previous one could not, it takes the next number, not the next letter. This is
  the rule that makes the letter informative: `1.6c` promises that whatever you
  learned about `1.6` still holds.

## Why `package.json` says something else

npm and electron-builder both require semver — `major.minor.patch`, three
integers. `1.6b` is not a valid version string, and neither `npm version` nor
`electron-updater` can compare it. Writing it into `package.json` breaks
packaging outright.

So the letter lives in the **patch** field, and the display name is derived:

| Display | `package.json` | Installer |
|---|---|---|
| `1.5` | `1.5.0` | `Hue-1.5.0-setup.exe` |
| `1.5b` | `1.5.1` | `Hue-1.5.1-setup.exe` |
| `1.5c` | `1.5.2` | `Hue-1.5.2-setup.exe` |
| `1.6` | `1.6.0` | `Hue-1.6.0-setup.exe` |
| `2.0` | `2.0.0` | `Hue-2.0.0-setup.exe` |

The mapping is `patch 0 → no letter`, `patch n → the (n+1)th letter`. Past `z`
(patch 25) fall back to showing the raw number; Dota has never needed more than
about `h`, and a patch that needs a 26th fix has a different problem.

This mapping is not a workaround, it is the point: ordering is preserved
exactly. `1.5.0 < 1.5.1 < 1.6.0` in semver is `1.5 < 1.5b < 1.6` in Hue, so the
update feed sorts releases correctly without knowing the scheme exists.

**Filenames and `latest.yml` stay semver.** Only what a person reads — the
Settings header, release notes — uses the letter form. An artifact named
`Hue-1.5b-setup.exe` would be an artifact `electron-updater` cannot parse.

## The rule that outranks the others

**A version number identifies a binary.** Two different builds must never answer
to one number.

This is why 1.4.0 was not rebuilt after the gap-coverage merge and 1.5.0 was cut
instead. `latest.yml` carries a sha512 per version; publishing different bits
under a version that already has one gives the update feed two answers to the
same question, and it has no way to tell which it holds. Cheap to avoid, and
essentially undiagnosable once shipped.

Practically: **bump before you build, never after.**

## Where 1.8.0 came from, and what comes next

`1.5` shipped the gap-coverage merge — source-aware coverage, technical probes,
saved applications, and the categorised Settings pane. `1.6` shipped assessment
mode: a second provider role, screen captures routed to it, and the armed
toggle.

`1.7` is the résumé-grounding release. Every mined story now carries a verbatim
quote from the source document and is dropped if the document does not contain
it, and the mining count is derived from what the résumé can anchor rather than
fixed at 15–25. It also adds two things to the gap flow: an AI first draft built
only from verified material, and questions the user can reword.

It took a number rather than a letter even though it began as a bug report,
because the capability rule is about what the release *does*, not about what
prompted it — drafting and editing are both things the app could not do before.

`1.8` is the polish patch, and it takes a number rather than a letter for the
usual reason: two of the things in it are capabilities the app did not have.

- **OpenAI GPT as a seventh provider.** Its `/models` listing is the whole
  account catalogue rather than a chat lineup, so `ProviderConfig.modelFilter`
  exists to stop auto-pick landing on `babbage-002` and failing the first
  question of an interview on a perfectly good key.
- **A macOS route to system audio.** `audio: 'loopback'` is Windows only;
  macOS 15+ reaches it through ScreenCaptureKit's native picker. The per-platform
  decision is a tested pure function in `display-capture.ts`. Unverified on Apple
  hardware, which is in [[Tasks]] as a verification item rather than as done.

The rest is not new capability but is not a fix either, so it rides along with
the number: the prompt builders moved out of `pipeline.ts` into
`shared/prompt.ts` with 21 tests, which caught ten em dashes inside the prompt
strings themselves including in the rule forbidding them; the Settings tables,
controls and pure logic moved into `components/settings/` with 25 more tests;
and `package.json` and the README stopped describing the app as "An Electron
application with React and TypeScript".

Tests: 564 at 1.7, 619 here.

The next release is one of these:

- **`1.8b`** (`1.8.1`) — fixes and tuning against what 1.8 shipped. The known
  candidates are the `_omitted` lint error in `memory-policy.test.ts`, still
  outstanding, and whatever the macOS audio path turns out to do on a real Mac.
- **`1.9`** (`1.9.0`) — the next content patch. The nearest candidate is still
  teaching `rescanGaps` to emit technical probes: it regenerates behavioral
  questions only, so an existing bundle cannot pick up technical questions
  without a full re-ingest. A close second is keeping the résumé's source text
  in the bundle, which is what a v1 → v2 migration would need in order to
  re-check an existing story bank instead of only warning about it.
- **`2.0`** — reserved for a rework. Splitting the 2,500-line `Settings`
  component is the largest thing outstanding, but it changes no behaviour, so it
  does not qualify.

So: **1.8b if the next release fixes 1.8, 1.9 if it adds to it.** There is no
1.8a — 1.8 already is it.

## Checklist for cutting a release

1. Decide letter or number by the capability rule above.
2. Set `package.json` to the semver form.
3. Commit as `chore: <display name>` — e.g. `chore: 1.5b`, `chore: 1.6`.
4. Run the tests. `npm test` must be green before a build, not after.
5. `npm run build:win`.
6. Confirm the packaged `app.asar` reports the version you intended. A build
   picks up `package.json` at build time, so a bump made afterwards produces an
   installer that disagrees with its own filename.
