import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpeculationScheduler, type Command, type Speaker } from './speculation.ts'

/**
 * The scheduler behaviour matrix, ported from the Kotlin suite it mirrors.
 *
 * A fake clock, no audio, no worker, no model. Every fixture below is a
 * recorded-shape interim sequence replayed through the scheduler with assertions
 * on the commands it emits — which is the whole reason this module imports
 * nothing.
 */

/** A fake clock. Every test advances it explicitly; nothing here reads wall time. */
class Clock {
  now = 0
  advance(ms: number): number {
    this.now += ms
    return this.now
  }
}

interface Harness {
  clock: Clock
  scheduler: SpeculationScheduler
  interim: (text: string, speaker?: Speaker) => Command[]
  final: (text: string, speaker?: Speaker) => Command[]
  /** Lets the stability window elapse and reports whatever that triggers. */
  settle: (ms?: number) => Command[]
}

function harness(): Harness {
  const clock = new Clock()
  const scheduler = new SpeculationScheduler()
  return {
    clock,
    scheduler,
    interim: (text, speaker = 'interviewer') => scheduler.onInterim(text, speaker, clock.now),
    final: (text, speaker = 'interviewer') => scheduler.onFinal(text, speaker, clock.now),
    settle: (ms = 400) => scheduler.onTick(clock.advance(ms))
  }
}

/** Asserts exactly one command of the expected kind came back, and returns it. */
function only<K extends Command['kind']>(
  commands: Command[],
  kind: K
): Extract<Command, { kind: K }> {
  assert.equal(commands.length, 1, `expected exactly one command, got ${JSON.stringify(commands)}`)
  assert.equal(commands[0].kind, kind, `expected ${kind}, got ${JSON.stringify(commands[0])}`)
  return commands[0] as Extract<Command, { kind: K }>
}

// ── Trigger ────────────────────────────────────────────────────────────────

test('a clean question fires once and commits once, which is the whole latency win', () => {
  const { scheduler, interim, final, settle } = harness()
  assert.deepEqual(interim('so tell me about a time'), []) // 6 words: below the floor
  assert.deepEqual(interim('so tell me about a time you disagreed'), []) // 8 words, not yet stable

  const fire = only(settle(), 'fire')
  assert.equal(fire.text, 'so tell me about a time you disagreed')

  const commit = only(final('so tell me about a time you disagreed with your manager'), 'commit')
  assert.equal(commit.specId, fire.specId)

  assert.equal(scheduler.metrics.fired, 1)
  assert.equal(scheduler.metrics.committed, 1)
  assert.equal(scheduler.metrics.hitRate, 1)
})

test('a short interim never fires, however long it sits still, because tokens are not free', () => {
  const { scheduler, interim, settle } = harness()
  interim('so, uh, yeah —')
  assert.deepEqual(settle(5000), [])
  assert.equal(scheduler.metrics.fired, 0)
})

test('an interim that has not settled does not fire, since the text is still changing', () => {
  const { scheduler, clock, interim } = harness()
  interim('tell me about a time you disagreed with someone')
  // 399ms is not 400ms. Firing early throws away the overlap being paid for.
  assert.deepEqual(scheduler.onTick(clock.advance(399)), [])
  assert.equal(scheduler.onTick(clock.advance(1)).length, 1)
})

test('a long statement that is not a question does not fire, or every remark costs a draft', () => {
  const { scheduler, interim, settle } = harness()
  interim('we have been building this platform for about three years now')
  assert.deepEqual(settle(), [])
  assert.equal(scheduler.metrics.fired, 0)
})

test('a statement that becomes a question fires when it does, because the trigger never latches', () => {
  const { interim, settle } = harness()
  interim('we have been building this platform for about three years now')
  assert.deepEqual(settle(), [])
  // The next words made it a question, and the scheduler has to notice that
  // rather than having written the utterance off.
  interim('we have been building this platform for about three years now, why do you ask')
  assert.equal(settle().length, 1)
})

test('the behavioural opener is recognised as a question without a question mark', () => {
  // "Tell me about a time…" is the single most common behavioural prompt and is
  // not grammatically interrogative at all.
  const { interim, settle } = harness()
  interim('tell me about a time you had to influence without authority')
  only(settle(), 'fire')
})

test("the provider's own interrogative signal outranks guessing from the text", () => {
  // A trailing rise the ASR heard and this code cannot.
  const { scheduler, clock } = harness()
  scheduler.onInterim('you worked at acme for three years then', 'interviewer', clock.now, true)
  only(scheduler.onTick(clock.advance(400), true), 'fire')
})

// ── Invalidation ───────────────────────────────────────────────────────────

test('a prefix extension lets the draft run, which is the case speculation is paid for', () => {
  const { scheduler, interim, settle } = harness()
  interim('so tell me about a time you disagreed')
  const fire = only(settle(), 'fire')

  assert.deepEqual(interim('so tell me about a time you disagreed with your manager'), [])
  assert.equal(scheduler.currentSpecId, fire.specId)
  assert.equal(scheduler.metrics.aborted, 0)
})

test('a mid-question reversal aborts, clears the card, and drops the stale draft', () => {
  const { scheduler, interim, settle } = harness()
  interim('so tell me about a time you disagreed')
  const first = only(settle(), 'fire')

  const commands = interim(
    'so tell me about a time you disagreed with your manager. actually let me ask instead'
  )
  // Abort first, then clear the card: the stale draft answers a question that
  // was withdrawn, and leaving it under a new one is the failure this whole
  // guard exists for.
  assert.deepEqual(commands[0], { kind: 'abort', specId: first.specId })
  assert.deepEqual(commands[1], { kind: 'reset' })

  assert.equal(scheduler.currentSpecId, null)
  assert.equal(scheduler.accepts(first.specId), false, 'stale deltas must be dropped')
})

test('a token before the fire point changing aborts the draft it invalidated', () => {
  const { scheduler, interim, settle } = harness()
  interim('tell me about a time you disagreed with a colleague')
  const fire = only(settle(), 'fire')

  // ASR revised an earlier word. What is in flight was fired on text that no
  // longer exists.
  const commands = interim('tell me about a time you agreed with a colleague')
  assert.deepEqual(
    commands.filter((c) => c.kind === 'abort'),
    [{ kind: 'abort', specId: fire.specId }]
  )
  assert.equal(scheduler.accepts(fire.specId), false)
})

test('a reset word inside the question itself is not a withdrawal', () => {
  const { scheduler, interim, settle } = harness()
  interim('tell me what actually happened when the migration failed')
  const fire = only(settle(), 'fire')
  // "actually" is part of the question, not a retraction of it. Aborting here
  // would burn a fire and the latency it bought.
  assert.deepEqual(
    interim('tell me what actually happened when the migration failed last year'),
    []
  )
  assert.equal(scheduler.currentSpecId, fire.specId)
})

test('a reset marker only matches as a whole word, so "factually" is not "actually"', () => {
  const { scheduler, interim, settle } = harness()
  interim('how do you factually verify a claim like that one')
  const fire = only(settle(), 'fire')
  assert.deepEqual(interim('how do you factually verify a claim like that one in practice'), [])
  assert.equal(scheduler.currentSpecId, fire.specId)
})

// ── Self speech ────────────────────────────────────────────────────────────

test("the user's own speech never fires a draft, or Hue answers itself mid-sentence", () => {
  const { scheduler, interim, final, settle } = harness()
  interim('so tell me about a time you disagreed with your manager')
  const fire = only(settle(), 'fire')

  // The user starts answering. On the acoustic path the machine hears them far
  // louder than the call; unhandled, Hue drafts a reply to itself.
  assert.deepEqual(interim('yeah so at acme we had this situation where', 'self'), [])
  assert.deepEqual(final('yeah so at acme we had this situation where', 'self'), [])

  assert.equal(scheduler.currentSpecId, fire.specId)
  assert.equal(scheduler.metrics.fired, 1)
})

test('self speech alone never even opens a question, so it cannot skew the cost metrics', () => {
  const { scheduler, interim, settle } = harness()
  assert.deepEqual(interim('so what I did there was refactor the whole pipeline', 'self'), [])
  assert.deepEqual(settle(), [])
  assert.equal(scheduler.metrics.questions, 0)
})

// ── One draft in flight ────────────────────────────────────────────────────

test('at most one draft is ever in flight: a second question waits for the first to commit', () => {
  const { scheduler, interim, final, settle } = harness()
  interim('so tell me about a time you disagreed with your manager')
  const first = only(settle(), 'fire')

  // The interviewer is still going; nothing new may fire while one is up.
  interim('so tell me about a time you disagreed with your manager and')
  assert.deepEqual(settle(), [])
  assert.equal(scheduler.currentSpecId, first.specId)

  only(final('so tell me about a time you disagreed with your manager'), 'commit')
  assert.equal(scheduler.currentSpecId, null)

  interim('and how did you handle the fallout from that decision')
  const second = only(settle(), 'fire')
  assert.ok(second.specId > first.specId, 'specIds must be monotonic')
})

test('a superseded interim aborts the previous generation before firing the replacement', () => {
  const { scheduler, interim, settle } = harness()
  interim('tell me about a time you disagreed with a colleague')
  const first = only(settle(), 'fire')

  // Revision to a token before the fire point: abort now, re-fire once stable.
  const aborted = only(interim('tell me about a time you argued with a colleague'), 'abort')
  assert.equal(aborted.specId, first.specId)
  assert.equal(scheduler.currentSpecId, null, 'nothing may be in flight between abort and re-fire')

  const second = only(settle(), 'fire')
  assert.ok(second.specId > first.specId)
  assert.equal(scheduler.metrics.aborted, 1)
})

// ── Commit ─────────────────────────────────────────────────────────────────

test('a final that matches the speculated text commits rather than regenerating', () => {
  const { scheduler, interim, final, settle } = harness()
  interim('so tell me about a time you disagreed with your manager')
  const fire = only(settle(), 'fire')
  // Punctuation, a filler, and one trailing word — the normal difference between
  // an interim and its final. Requiring equality here would throw away almost
  // every draft that was in fact correct.
  const commit = only(final('So, tell me about a time you disagreed with your manager?'), 'commit')
  assert.equal(commit.specId, fire.specId)
  assert.equal(scheduler.metrics.committed, 1)
})

test('a final that diverges discards the draft and refires, without blanking the screen', () => {
  const { scheduler, interim, final, settle } = harness()
  interim('so tell me about a time you disagreed with your manager')
  const fire = only(settle(), 'fire')

  // Entirely different question — F1 well under threshold.
  const regenerate = only(final('what does your ideal engineering culture look like'), 'regenerate')

  assert.ok(regenerate.specId > fire.specId)
  assert.equal(regenerate.text, 'what does your ideal engineering culture look like')
  // The screen is never blanked: no reset is emitted, so the stale draft stays
  // up (dimmed) until the fresh one lands.
  assert.equal(scheduler.currentSpecId, regenerate.specId)
})

test('a final with nothing in flight falls through to endpoint-then-generate', () => {
  const { scheduler, final } = harness()
  const fire = only(final('what is your favourite programming language'), 'fire')
  assert.equal(fire.text, 'what is your favourite programming language')
  assert.equal(scheduler.metrics.fired, 1)
  assert.equal(scheduler.metrics.committed, 0)
})

test('an empty final asks for nothing at all rather than generating on silence', () => {
  const { final } = harness()
  assert.deepEqual(final('   '), [])
})

// ── Fire cap ───────────────────────────────────────────────────────────────

test('the fire cap falls through to endpoint-then-generate, which is what bounds the cost', () => {
  const { scheduler, interim, final, settle } = harness()
  // Three fires, each invalidated by a revision to a token before the fire
  // point, which is what burns the budget in practice.
  interim('tell me about a time you disagreed with a colleague')
  only(settle(), 'fire')

  interim('tell me about a time you agreed with a colleague')
  only(settle(), 'fire')

  interim('tell me about a time you argued with a colleague')
  only(settle(), 'fire')

  assert.equal(scheduler.metrics.fired, 3)

  // Fourth revision: aborts what is in flight, but must not fire again.
  const commands = interim('tell me about a time you fought with a colleague')
  assert.equal(commands.length, 1)
  assert.equal(commands[0].kind, 'abort')
  assert.deepEqual(settle(), [])
  assert.equal(scheduler.metrics.fired, 3)

  // The final still produces an answer — just at unspeculated latency.
  only(final('tell me about a time you fought with a colleague'), 'fire')
})

test('the fire budget resets with the next question', () => {
  const { interim, final, settle } = harness()
  for (let i = 0; i < 3; i++) {
    interim(`tell me about a time you disagreed with colleague number ${i}`)
    only(settle(), 'fire')
  }
  assert.deepEqual(settle(), [])

  final('tell me about a time you disagreed with colleague number 2')

  interim('and how did you handle the fallout from that decision')
  only(settle(), 'fire')
})

test('a withdrawn question restores the fire budget, since it is a new question', () => {
  const { interim, settle } = harness()
  interim('tell me about a time you disagreed with a colleague')
  only(settle(), 'fire')
  interim('tell me about a time you agreed with a colleague')
  only(settle(), 'fire')

  // Charging a withdrawal the two fires already spent would leave the real
  // question with one attempt.
  interim('tell me about a time you agreed with a colleague, actually let me ask something else')
  interim('what does a good code review look like to you these days')
  only(settle(), 'fire')
  interim('what does a great code review look like to you these days')
  only(settle(), 'fire')
  interim('what does an ideal code review look like to you these days')
  only(settle(), 'fire')
})

// ── The specId guard ───────────────────────────────────────────────────────

test('deltas are accepted only for the draft currently in flight', () => {
  const { scheduler, interim, final, settle } = harness()
  interim('tell me about a time you disagreed with a colleague')
  const first = only(settle(), 'fire')
  assert.equal(scheduler.accepts(first.specId), true)

  interim('tell me about a time you agreed with a colleague')
  const second = only(settle(), 'fire')

  assert.equal(
    scheduler.accepts(first.specId),
    false,
    "a superseded draft's deltas must not render"
  )
  assert.equal(scheduler.accepts(second.specId), true)

  final('tell me about a time you agreed with a colleague')
  // Committed: nothing is in flight, so nothing more may render.
  assert.equal(scheduler.accepts(second.specId), false)
  assert.equal(scheduler.accepts(first.specId), false)
})

test('no reordering of deltas can ever render a stale specId', () => {
  // The property the docs ask for: under every reordering and interleaving of
  // deltas, no stale specId is accepted. Exhaustive over the ids a session
  // issued rather than sampled — the id space is small, and this is the guard
  // whose failure mode is reading the previous question's answer aloud.
  const { scheduler, interim, final, settle } = harness()
  const issued: number[] = []
  const record = (commands: Command[]): void => {
    for (const command of commands) {
      if (command.kind === 'fire' || command.kind === 'regenerate') issued.push(command.specId)
    }
  }

  record(interim('tell me about a time you disagreed with a colleague'))
  record(settle())
  record(interim('tell me about a time you agreed with a colleague'))
  record(settle())
  record(final('what does a good code review look like to you'))
  record(interim('and why do you think that matters so much here'))
  record(settle())

  assert.ok(issued.length >= 3, 'the session must have issued several drafts')

  const current = scheduler.currentSpecId
  for (const permutation of permutations(issued)) {
    for (const specId of permutation) {
      assert.equal(scheduler.accepts(specId), specId === current, `specId ${specId}`)
    }
  }

  // Ids that were never issued at all, including future ones.
  for (const specId of [0, -1, Number.MAX_SAFE_INTEGER, (current ?? 0) + 1]) {
    assert.equal(scheduler.accepts(specId), false)
  }
})

// ── Metrics ────────────────────────────────────────────────────────────────

test('hit rate and fires-per-question are reported, because the trigger is tuned against them', () => {
  const { scheduler, interim, final, settle } = harness()
  // One clean question: fire, commit.
  interim('so tell me about a time you disagreed with your manager')
  settle()
  final('so tell me about a time you disagreed with your manager')

  // One messy question: fire, revise, fire, commit.
  interim('what does a good code review look like to you')
  settle()
  interim('what does a great code review look like to you')
  settle()
  final('what does a great code review look like to you')

  const metrics = scheduler.metrics
  assert.equal(metrics.fired, 3)
  assert.equal(metrics.committed, 2)
  assert.equal(metrics.questions, 2)
  assert.ok(Math.abs(metrics.hitRate - 2 / 3) < 1e-9)
  assert.equal(metrics.firesPerQuestion, 1.5)
})

test('hit rate is zero rather than undefined before anything has fired', () => {
  const { scheduler } = harness()
  assert.equal(scheduler.metrics.hitRate, 0)
  assert.equal(scheduler.metrics.firesPerQuestion, 0)
})

// ── Reset ──────────────────────────────────────────────────────────────────

test('reset clears the in-flight draft so nothing survives a session boundary', () => {
  const { scheduler, interim, settle } = harness()
  interim('so tell me about a time you disagreed with your manager')
  const fire = only(settle(), 'fire')

  scheduler.reset()

  assert.equal(scheduler.currentSpecId, null)
  assert.equal(scheduler.accepts(fire.specId), false)
})

/** Every ordering of a small list. Small by construction — a session issues a handful of ids. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1))
    for (const tail of permutations(rest)) out.push([items[i], ...tail])
  }
  return out
}
