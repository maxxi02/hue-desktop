import { useEffect, useRef, useState } from 'react'
import type { ProviderUsage, RateLimitSnapshot, UsageSummary, UsageTotals } from '@shared/usage'

/**
 * What Hue has spent, and what the vendor says is left.
 *
 * ## The one rule this panel exists to keep
 *
 * Every numeric field on a `RateLimitSnapshot` is optional, and an absent one
 * means "the vendor did not report it" — never zero. So absence renders as an
 * em-dash and nothing else. Rounding a missing number down to 0 would print
 * "0 requests left", which reads as a stop sign; inventing that over silence
 * would be a lie in the only direction that costs the user something, because
 * they would stop a session that could have carried on.
 *
 * The same rule is why `limit: null` gets a sentence rather than an empty box.
 * Ollama is local and Deepgram and AssemblyAI send no rate-limit headers at all;
 * a blank quota section for those would read as "we looked and found nothing
 * left", when the truth is that there is nothing to look at.
 *
 * ## Two kinds of number, kept apart
 *
 * The tally ("Used by Hue") is counted from what this app sent. The headroom
 * ("Left in your quota") is the account's, and it also moves when the same key
 * is used elsewhere. They are stacked, never summed or reconciled: they answer
 * different questions and the pair is what is actually useful.
 */

type TallyWindow = 'lastHour' | 'lastDay' | 'lastWeek'

const WINDOWS: { key: TallyWindow; label: string }[] = [
  { key: 'lastHour', label: 'Last hour' },
  { key: 'lastDay', label: 'Last 24 hours' },
  { key: 'lastWeek', label: 'Last 7 days' }
]

/**
 * Why a provider publishes no quota.
 *
 * A table rather than a chain of name checks, matching how `usage.ts` itself
 * treats provider quirks — and the fallback matters as much as the entries: a
 * provider absent from this list is one we simply have not heard headroom from
 * yet, which is a different claim from "this vendor has none".
 */
const NO_QUOTA_REASON: Record<string, string> = {
  ollama: 'Ollama runs on your machine, so there is no account quota to run out of.',
  deepgram: 'Deepgram sends no rate-limit headers, so there is no headroom to report.',
  assemblyai: 'AssemblyAI sends no rate-limit headers, so there is no headroom to report.'
}

const EM_DASH = '—'

/** One decimal at most, and never a trailing ".0" — "12k", not "12.0k". */
function short(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, '')
}

/** Token and request counts, which run to six figures and are read at a glance. */
function formatCount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${short(n / 1000)}k`
  return `${short(n / 1_000_000)}M`
}

/** "3m 20s". Raw seconds past a minute or two stop being a duration to a reader. */
function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const restSeconds = total % 60
  if (minutes < 60) return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`
}

function formatValue(n: number, unit: 'count' | 'seconds'): string {
  return unit === 'seconds' ? formatSeconds(n) : formatCount(n)
}

/** One remaining-vs-limit line. Either half may be missing; both missing is dropped. */
interface Meter {
  label: string
  remaining?: number
  limit?: number
  unit: 'count' | 'seconds'
}

function metersFor(limit: RateLimitSnapshot): Meter[] {
  const all: Meter[] = [
    {
      label: 'requests',
      remaining: limit.remainingRequests,
      limit: limit.limitRequests,
      unit: 'count'
    },
    { label: 'tokens', remaining: limit.remainingTokens, limit: limit.limitTokens, unit: 'count' },
    {
      label: 'audio',
      remaining: limit.remainingAudioSeconds,
      limit: limit.limitAudioSeconds,
      unit: 'seconds'
    }
  ]
  // A meter with neither number is not a dash, it is a row the vendor never
  // mentioned — printing "— of — tokens" for every provider that only reports
  // requests would bury the numbers that are real.
  return all.filter((m) => m.remaining !== undefined || m.limit !== undefined)
}

function MeterRow({ meter }: { meter: Meter }): React.JSX.Element {
  const { remaining, limit, unit } = meter
  const figure = remaining === undefined ? EM_DASH : formatValue(remaining, unit)
  // The bar is a proportion, so it needs both ends. With only one number there
  // is nothing to draw it against and the sentence has to carry the fact alone.
  const drawable = remaining !== undefined && limit !== undefined && limit > 0
  const pct = drawable ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0

  return (
    <div className="usage-meter">
      <div className="review-split">
        <span className="review-split-figure">{figure}</span>
        <span className="review-split-rest">
          {limit === undefined
            ? `${meter.label} left · no ceiling reported`
            : `of ${formatValue(limit, unit)} ${meter.label} left`}
        </span>
      </div>
      {drawable && (
        <div className={remaining === 0 ? 'review-bar review-bar--none' : 'review-bar'}>
          <div className="review-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

/**
 * When the window refills, and how old the reading is.
 *
 * Both halves matter: headroom is a measurement taken at `observedAt`, and a
 * reset time quoted from a snapshot read twenty minutes ago is worth less than
 * one read a moment ago. Saying how stale it is costs a clause and stops the
 * panel overstating its own freshness.
 */
function ResetLine({ limit, now }: { limit: RateLimitSnapshot; now: number }): React.JSX.Element {
  const age = Math.max(0, (now - limit.observedAt) / 1000)
  const readAt = age < 5 ? 'read just now' : `read ${formatSeconds(age)} ago`
  if (limit.resetAt === undefined) return <div className="review-subnote">{readAt}</div>
  const left = (limit.resetAt - now) / 1000
  const reset = left <= 0 ? 'Window has since refilled' : `Refills in ${formatSeconds(left)}`
  return (
    <div className="review-subnote">
      {reset} · {readAt}
    </div>
  )
}

function TallyRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <li className="review-row">
      <span className="review-row-text">{label}</span>
      <span className="review-count-pill">{value}</span>
    </li>
  )
}

function TallyRows({ totals }: { totals: UsageTotals }): React.JSX.Element {
  return (
    <ul className="review-list">
      <TallyRow label="Requests" value={formatCount(totals.requests)} />
      <TallyRow label="Input tokens" value={formatCount(totals.inputTokens)} />
      <TallyRow label="Output tokens" value={formatCount(totals.outputTokens)} />
      {/* Audio and cache only when there is some. Whether a provider is ASR or
          whether it caches is a fact about the traffic, not a table to keep in
          sync — a zero row here would just be a provider list restated wrong. */}
      {totals.audioSeconds > 0 && (
        <TallyRow label="Audio transcribed" value={formatSeconds(totals.audioSeconds)} />
      )}
      {totals.cacheReadTokens > 0 && (
        <TallyRow label="Cache reads" value={formatCount(totals.cacheReadTokens)} />
      )}
      {totals.cacheWriteTokens > 0 && (
        <TallyRow label="Cache writes" value={formatCount(totals.cacheWriteTokens)} />
      )}
    </ul>
  )
}

function ProviderCard({
  usage,
  window: tallyWindow,
  now
}: {
  usage: ProviderUsage
  window: TallyWindow
  now: number
}): React.JSX.Element {
  const totals = usage[tallyWindow]
  const meters = usage.limit ? metersFor(usage.limit) : []

  return (
    <section className="review-section">
      <div className="usage-provider">{usage.provider}</div>

      <div className="usage-subhead">Left in your quota</div>
      {usage.limit === null ? (
        <div className="review-note">
          <span className="usage-dash">{EM_DASH}</span>{' '}
          {NO_QUOTA_REASON[usage.provider] ?? 'This provider has not reported any quota yet.'}
        </div>
      ) : meters.length === 0 ? (
        <div className="review-empty">
          <span className="usage-dash">{EM_DASH}</span> A reading came back, but it carried no
          numbers we recognise.
        </div>
      ) : (
        <>
          {meters.map((m) => (
            <MeterRow key={m.label} meter={m} />
          ))}
          <ResetLine limit={usage.limit} now={now} />
        </>
      )}

      <div className="usage-subhead">Used by Hue</div>
      {totals.requests === 0 ? (
        <div className="review-empty">Nothing in this window.</div>
      ) : (
        <TallyRows totals={totals} />
      )}
    </section>
  )
}

export function UsagePanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [tallyWindow, setTallyWindow] = useState<TallyWindow>('lastDay')
  const mountedRef = useRef(true)

  /*
   * "Refills in 2m" is computed against the clock, so without a tick it would be
   * frozen at whatever it said when the last summary arrived — and usage updates
   * only when a call completes, which during a quiet stretch is exactly when the
   * countdown is being watched. Ten seconds is finer than the smallest unit the
   * line ever prints past a minute, and coarse enough to be free.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    // Re-armed on every mount, not just the first: under StrictMode an effect
    // runs mount → cleanup → mount, so a ref only ever set false on cleanup
    // would swallow every update from the second run onward. Same guard, and
    // the same reason, as the cue-sheet subscription in Settings.tsx.
    mountedRef.current = true
    void window.hue.usage.get().then((s) => {
      if (mountedRef.current) setSummary(s)
    })
    // The initial `get` above is not redundant with this: `watch` only pushes on
    // the next change, and a panel opened between sessions would otherwise sit
    // blank indefinitely over data that already exists.
    const stop = window.hue.usage.watch((s) => {
      if (mountedRef.current) setSummary(s)
    })
    return () => {
      mountedRef.current = false
      stop()
    }
  }, [])

  const providers = summary?.providers ?? []

  return (
    <div className="review">
      <div className="review-head">
        <div className="review-head-text">
          <div className="review-title">Usage and quota</div>
          <div className="review-dateline">
            <span>What Hue spent, and what each provider says is left</span>
          </div>
        </div>
        <div className="review-nav">
          <button className="review-close" onClick={onClose} title="Close usage">
            Done
          </button>
        </div>
      </div>

      <div className="review-body">
        {providers.length === 0 ? (
          <div className="review-empty">
            Nothing recorded yet — usage appears here once you run a session.
          </div>
        ) : (
          <>
            {/* One toggle for every provider rather than one each: the question
                being asked is "how much did today cost", and answering it per
                provider with three separate switches would make the columns
                incomparable. */}
            <div className="review-chips usage-window">
              {WINDOWS.map((w) => (
                <button
                  key={w.key}
                  className={
                    w.key === tallyWindow ? 'review-chip' : 'review-chip review-chip--quiet'
                  }
                  aria-pressed={w.key === tallyWindow}
                  onClick={() => setTallyWindow(w.key)}
                >
                  {w.label}
                </button>
              ))}
            </div>
            {/* Already sorted by name upstream, and left that way — the order a
                list of providers is read in should not change under the reader
                as one of them gets busy. */}
            {providers.map((p) => (
              <ProviderCard key={p.provider} usage={p} window={tallyWindow} now={now} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
