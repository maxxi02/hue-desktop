import test from 'node:test'
import assert from 'node:assert/strict'
import {
  backgroundParts,
  buildSystemPrompt,
  candidateBackground,
  captureInstruction,
  jobContext,
  section,
  stripCaptureImage
} from './prompt.ts'
import { DEFAULT_SETTINGS, type HueSettings, type LlmMessage } from './types.ts'
import type { ProfileBundle } from './profile.ts'

/**
 * These tests exist because the prompt is the product.
 *
 * Everything asserted below was previously guarded by nothing: the builders sat
 * inside `pipeline.ts`, where reaching them meant constructing a microphone. The
 * rules they enforce are not stylistic preferences. Each one is a failure that
 * has actually happened, and the comment at each site in `prompt.ts` records
 * which. A test that only checked "a string comes back" would restate that the
 * function runs; these check the specific things that went wrong.
 */

function settings(overrides: Partial<HueSettings> = {}): HueSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

function bundle(): ProfileBundle {
  return {
    version: 2,
    hash: 'a'.repeat(64),
    createdAt: '2026-08-09T12:00:00.000Z',
    profile: {
      identity: {
        name: 'Jordan Reyes',
        headline: 'Backend Engineer',
        location: 'Cebu',
        email: 'jordan@example.com',
        links: []
      },
      roles: [
        {
          id: 'acme-robotics',
          company: 'Acme Robotics',
          title: 'Backend Engineer',
          start: '2023',
          end: null,
          current: true,
          stack: ['Go'],
          summary: 'Owned the checkout platform.'
        }
      ],
      education: [],
      skills: ['Go'],
      metrics: [{ roleId: 'acme-robotics', value: '40%', claim: 'p99 latency' }]
    },
    stories: [
      {
        id: 'conflict-manager-roadmap',
        roleId: 'acme-robotics',
        competencies: ['conflict'],
        situation: 'Sprint planning conflict.',
        task: 'Settle it.',
        action: 'Proposed a data-backed alternative.',
        result: 'My approach won.',
        metrics: ['40%'],
        source: 'resume'
      }
    ],
    gaps: []
  }
}

// --- The dash rule ----------------------------------------------------------

/*
 * The one rule that governs the prompt text itself rather than what it asks for.
 *
 * `HUMAN_VOICE_GUIDANCE` forbids em dashes, en dashes and spaced hyphens in
 * Hue's output, on the grounds that a dash has no sound: the user reading aloud
 * stumbles where the punctuation should have told them to pause. But a quoted
 * example outweighs an abstract rule, so one "good" example containing a dash
 * teaches the model to use one no matter what the rule says. That is exactly how
 * em dashes reached the answers before. The prohibition therefore has to hold
 * over every prompt string this module can emit, its examples included.
 *
 * Asserted over built output rather than by reading the source file, so a dash
 * arriving from `profile.ts`, `job-spec.ts` or `answer-shape.ts` fails here too.
 * This module is the last point at which all of them are one string.
 *
 * The spaced-hyphen arm is a literal " - " rather than `\s-\s`, because `\s`
 * matches the newline before a markdown bullet: written that way the rule fired
 * on every "\n- Use plain words" line of the guidance block it was policing.
 */
const DASHES = /[—–]| - /

/**
 * The built prompt, minus the one dash the project has already decided to allow.
 *
 * `profile.test.ts` records the exception and the reasoning: a parenthesised
 * "(2018 – present)" is data rather than prose, the en dash is correct
 * typography there, and the format is shared with hue-mobile's renderer. That
 * decision predates this file, so this test carries the exception instead of
 * overriding it. Everything else stays subject to the rule.
 */
function promptProse(built: string): string {
  return built
    .split('\n')
    .filter((line) => !/\([^)]*–[^)]*\)/.test(line))
    .join('\n')
}

test('no prompt Hue can build contains a dash it would then imitate', () => {
  const cases: Array<[string, HueSettings]> = [
    ['companion, bare', settings()],
    ['companion, star mode', settings({ interviewMode: 'star' })],
    ['companion, with a title', settings({ jobTitle: 'Backend Engineer' })],
    [
      'companion, with a summary',
      settings({ resumeSummary: 'Three years on payments infrastructure.' })
    ],
    ['companion, with a bundle', settings({ profileBundleJson: JSON.stringify(bundle()) })],
    ['interviewer', settings({ hueMode: 'interviewer' })],
    [
      'interviewer, with a bundle',
      settings({ hueMode: 'interviewer', profileBundleJson: JSON.stringify(bundle()) })
    ]
  ]
  for (const [label, s] of cases) {
    for (const assessment of [false, true]) {
      const built = promptProse(buildSystemPrompt(s, assessment))
      const hit = DASHES.exec(built)
      const at = hit?.index ?? 0
      assert.equal(
        hit,
        null,
        `${label} (assessment=${assessment}) put a dash in the prompt near ` +
          `"${built.slice(Math.max(0, at - 60), at + 60)}"`
      )
    }
  }
})

test('the capture instruction is dash free in all three of its forms', () => {
  assert.equal(DASHES.test(captureInstruction(settings(), false)), false)
  assert.equal(DASHES.test(captureInstruction(settings(), true)), false)
  assert.equal(DASHES.test(captureInstruction(settings({ hueMode: 'interviewer' }), false)), false)
})

// --- Section order ----------------------------------------------------------

test('BACKGROUND precedes the posting, or the never-claim rule guards nothing', () => {
  // The posting block says a requirement may only be spoken as experience "if it
  // also appears in the candidate's background above". Placed after the posting,
  // "above" resolves to nothing and the guard becomes decoration on a list of
  // skills the user may not have.
  const s = settings({
    profileBundleJson: JSON.stringify(bundle()),
    jobTitle: 'Backend Engineer',
    jobDescription: 'We need someone strong in Rust and Kubernetes.'
  })
  const built = buildSystemPrompt(s, false)
  const background = built.indexOf('=== BACKGROUND ===')
  const role = built.indexOf('=== ROLE BEING INTERVIEWED FOR ===')
  assert.ok(background > -1, 'no background section was emitted')
  assert.ok(role > -1, 'no posting section was emitted')
  assert.ok(background < role, 'the posting was placed above the background it refers back to')
})

test('the output contract comes last and stands alone', () => {
  // It is the contract the response is judged against, and the evidence recorded
  // in `buildCompanionPrompt` is that it loses whenever it shares a paragraph
  // with another rule.
  const built = buildSystemPrompt(settings({ jobTitle: 'Backend Engineer' }), false)
  const contract = built.indexOf('=== OUTPUT CONTRACT ===')
  assert.ok(contract > -1)
  for (const other of ['=== ROLE ===', '=== VOICE ===', '=== HONESTY ===']) {
    assert.ok(built.indexOf(other) < contract, `${other} should precede the output contract`)
  }
  // Past the end of this section's own header, not `contract + 3`: that lands
  // inside "=== OUTPUT CONTRACT ===" and matches its own closing marker.
  const afterHeader = built.indexOf('\n', contract)
  assert.equal(built.indexOf('===', afterHeader), -1, 'a section was placed after the contract')
})

test('sections are marked with === and never with ##', () => {
  // `##` is the answer's own marker syntax (`answer-shape.ts`). A prompt must not
  // teach a second meaning for it in the same breath as defining the first.
  const built = buildSystemPrompt(settings({ profileBundleJson: JSON.stringify(bundle()) }), false)
  for (const name of ['ROLE', 'VOICE', 'HONESTY', 'BACKGROUND', 'OUTPUT CONTRACT']) {
    assert.ok(built.includes(`=== ${name} ===`), `${name} is not marked as a section`)
    assert.equal(built.includes(`## ${name}`), false, `${name} used the answer's marker syntax`)
  }
})

// --- Grounding --------------------------------------------------------------

test('a bundle puts every citable story id in the prompt and demands the citation line', () => {
  // The citation is what makes "never invent a story" checkable rather than
  // hopeful: `grounding.ts` reads the id back. If the id is not named here, or
  // the instruction to emit it goes missing, the receipt is unverifiable and the
  // "not anchored" chip fires on honest answers.
  const parts = backgroundParts(settings({ profileBundleJson: JSON.stringify(bundle()) }))
  const text = parts.filter((p): p is string => p !== null).join('\n')
  assert.match(text, /conflict-manager-roadmap/, 'the story id is not citable from the prompt')
  assert.match(text, /story_id: <id>/, 'nothing tells the model to emit a receipt')
  assert.match(text, /story_id: null/, 'no honest escape hatch when nothing fits')
  assert.match(text, /do not invent one/i)
})

test('without a bundle the older freeform summary still reaches the prompt', () => {
  // Losing someone's background on upgrade would be a worse failure than the
  // weaker grounding this fallback provides.
  const s = settings({ resumeSummary: 'Three years on payments.' })
  const parts = backgroundParts(s)
  assert.equal(parts.length, 1)
  assert.match(String(parts[0]), /Three years on payments/)
  assert.equal(candidateBackground(s), 'Three years on payments.')
})

test('with neither, the background section is omitted rather than left empty', () => {
  assert.deepEqual(backgroundParts(settings()), [])
  assert.equal(candidateBackground(settings()), null)
  assert.equal(buildSystemPrompt(settings(), false).includes('=== BACKGROUND ==='), false)
})

test('a bundle wins over the legacy summary when both are present', () => {
  const s = settings({
    profileBundleJson: JSON.stringify(bundle()),
    resumeSummary: 'Stale freeform text.'
  })
  const built = buildSystemPrompt(s, false)
  assert.match(built, /conflict-manager-roadmap/)
  assert.equal(built.includes('Stale freeform text'), false, 'the superseded summary leaked in')
})

// --- The posting ------------------------------------------------------------

test('a raw posting is used when no analysed spec exists', () => {
  // The reason the raw text is stored at all: someone who pastes a posting sixty
  // seconds before the call and never presses Analyse still gets most of the
  // value, and a failed analysis leaves them no worse off than before.
  const block = jobContext(settings({ jobDescription: 'Rust, Kubernetes, on-call.' }))
  assert.ok(block)
  assert.match(String(block), /Rust, Kubernetes, on-call/)
})

test('no posting at all adds nothing', () => {
  assert.equal(jobContext(settings()), null)
  assert.equal(jobContext(settings({ jobDescription: '   ' })), null)
})

test('the posting is framed as being about the job, never about the user', () => {
  const built = buildSystemPrompt(
    settings({ jobDescription: 'Rust, Kubernetes, on-call.', jobTitle: 'Backend Engineer' }),
    false
  )
  assert.match(built, /never as a description of the user/i)
})

// --- Mode routing -----------------------------------------------------------

test('the two modes are different jobs, not variations on one', () => {
  const asker = buildSystemPrompt(settings({ hueMode: 'interviewer' }), false)
  const answerer = buildSystemPrompt(settings({ hueMode: 'companion' }), false)
  assert.match(asker, /acting as a professional interviewer/)
  assert.match(asker, /Ask ONE question at a time/)
  assert.match(answerer, /real-time interview companion/)
  assert.equal(answerer.includes('Ask ONE question at a time'), false)
})

test('interviewer mode ignores the assessment flag, having no answer to shape', () => {
  const s = settings({ hueMode: 'interviewer' })
  assert.equal(buildSystemPrompt(s, true), buildSystemPrompt(s, false))
})

test('assessment overrides the interview mode rather than combining with it', () => {
  // Someone in star mode who is asked to design a function still needs the code
  // answer; STAR structure imposed on it produces a Situation and a Task for a
  // binary search.
  const star = settings({ interviewMode: 'star' })
  const behavioural = buildSystemPrompt(star, false)
  const technical = buildSystemPrompt(star, true)
  assert.notEqual(behavioural, technical)
  assert.match(behavioural, /STAR|Situation/i)
})

test('star mode reaches the interviewer persona too', () => {
  const built = buildSystemPrompt(settings({ hueMode: 'interviewer', interviewMode: 'star' }), false)
  assert.match(built, /behavioral questions/i)
})

// --- section() --------------------------------------------------------------

test('an all-empty section is dropped, not emitted as a bare heading', () => {
  assert.equal(section('EMPTY', []), null)
  assert.equal(section('EMPTY', [null, null]), null)
  assert.equal(section('EMPTY', ['']), null)
  assert.equal(section('KEPT', [null, 'body', '']), '=== KEPT ===\nbody')
})

// --- Capture ----------------------------------------------------------------

test('the capture instruction says what the image is and, on assessment, stops there', () => {
  // Repeating "give a clear approach" in the user turn would compete with the
  // marker contract already stated in OUTPUT CONTRACT.
  const assess = captureInstruction(settings(), true)
  assert.match(assess, /screenshot of the interviewer/)
  assert.equal(assess.includes('include concise, correct code'), false)
  const normal = captureInstruction(settings(), false)
  assert.match(normal, /include concise, correct code/)
})

test('the interviewer reads a capture as context, not as a task', () => {
  const built = captureInstruction(settings({ hueMode: 'interviewer' }), false)
  assert.match(built, /Use it as context/)
  assert.equal(built.includes('help me solve'), false)
})

test('stripping a capture keeps the text and leaves a visible placeholder', () => {
  const msg: LlmMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }
    ]
  }
  const stripped = stripCaptureImage(msg)
  assert.equal(typeof stripped.content, 'string')
  assert.match(String(stripped.content), /Screen capture omitted/)
  assert.match(String(stripped.content), /What is this\?/)
  assert.equal(stripped.role, 'user')
})

test('stripping a text-only message leaves it exactly as it was', () => {
  const msg: LlmMessage = { role: 'user', content: 'Plain text.' }
  assert.equal(stripCaptureImage(msg), msg)
})
