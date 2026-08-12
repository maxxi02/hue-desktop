import { useEffect, useRef } from 'react'
import type { CueCard, CueSheet } from '@shared/cuesheet'

/**
 * The armed cue sheet, as a document.
 *
 * ## Why the whole sheet, and not just the matched card
 *
 * `CueCardBody` in App.tsx renders the ONE card that latched onto the question
 * being asked, and that is the right thing for the transcript and for glance
 * mode: mid-answer, everything that is not the answer is noise. But it leaves
 * the user with no way to see what they prepared until the interviewer happens
 * to ask for it, and the minutes before and between questions are exactly when
 * someone wants to re-read their own material.
 *
 * So this panel is the other half of the same feature and deliberately not a
 * replacement for it: the whole sheet, always legible, with the matcher's
 * current pick moved under the eye rather than isolated on screen. Keeping the
 * surrounding questions visible is the point — the next question is usually
 * adjacent to the last one, and seeing it coming is worth more than a cleaner
 * frame.
 *
 * ## The layout
 *
 * A printed document, not a list of cards: title, subtitle, rule, then numbered
 * sections. Reading under pressure is reading, and the shape people read
 * fastest is the one they have read ten thousand times. The prepared script is
 * a block quote with a left border rather than a paragraph — it marks the text
 * as *quoted from what the user wrote*, which is the honest description of it
 * and also the visual cue that it is not a line to be recited verbatim.
 */

/**
 * Whether the reader has asked the OS to stop moving things.
 *
 * Read at pan time rather than subscribed to: this is consulted once per
 * question, the answer cannot go stale in a way that matters, and a listener
 * would be one more thing to tear down.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function CueSheetSection({
  card,
  ordinal,
  active,
  registerRef
}: {
  card: CueCard
  ordinal: number
  active: boolean
  registerRef: (id: string, el: HTMLElement | null) => void
}): React.JSX.Element {
  return (
    <section
      className={active ? 'cuedoc-section cuedoc-section--active' : 'cuedoc-section'}
      aria-current={active ? 'true' : undefined}
      ref={(el) => {
        registerRef(card.id, el)
      }}
    >
      <div className="cuedoc-ordinal">
        <span className="cuedoc-ordinal-num">{ordinal}</span>
        {/* The live marker rides the section heading rather than the panel
            header: the user's eye is already on the text that just moved, and a
            status word at the top of a scrolled document is a status word
            nobody reads. */}
        {active && <span className="cuedoc-live">Being asked now</span>}
      </div>

      <h3 className="cuedoc-q">
        <span className="cuedoc-q-mark" aria-hidden="true">
          Q:
        </span>
        {card.heading}
      </h3>

      {/* The bold lines are the answer as it should actually be delivered. They
          come first, and the full script sits under them, because a cue is
          something you glance at and a script is something you would read
          aloud — putting the script first invites exactly that. */}
      {card.cues.length > 0 && (
        <ul className="cuedoc-cues">
          {card.cues.map((cue, i) => (
            <li key={i} className="cuedoc-cue">
              <strong>{cue}</strong>
            </li>
          ))}
        </ul>
      )}

      {card.script && <blockquote className="cuedoc-script">{card.script}</blockquote>}
    </section>
  )
}

export function CueSheetPanel({
  sheet,
  activeCardId
}: {
  sheet: CueSheet
  /** The card the matcher has latched onto right now, or null between questions. */
  activeCardId: string | null
}): React.JSX.Element {
  const sections = useRef(new Map<string, HTMLElement>())
  const registerRef = (id: string, el: HTMLElement | null): void => {
    if (el) sections.current.set(id, el)
    else sections.current.delete(id)
  }

  /**
   * Pan to the answer.
   *
   * `block: 'center'` rather than `'start'` on purpose: a question that scrolls
   * to the top of the panel loses the section above it, and the thing directly
   * above a question is very often the one the interviewer just finished — the
   * context the user is still holding in their head. Centring keeps a line of
   * each neighbour on screen.
   *
   * Nothing happens when the latch clears (`activeCardId === null`). A question
   * ending is not a reason to move the document out from under someone who may
   * still be reading it; the next question moves it, and only then.
   */
  useEffect(() => {
    if (!activeCardId) return
    const el = sections.current.get(activeCardId)
    if (!el) return
    el.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center'
    })
  }, [activeCardId])

  const count = sheet.cards.length

  return (
    <article className="cuedoc" aria-label="Cue sheet">
      <div className="cuedoc-page">
        <header className="cuedoc-head">
          <h2 className="cuedoc-title">{sheet.label}</h2>
          <div className="cuedoc-subtitle">
            {count === 1 ? '1 prepared question' : `${count} prepared questions`}
            <span className="cuedoc-subtitle-sep" aria-hidden="true">
              ·
            </span>
            Hue moves to the answer as each one is asked
          </div>
        </header>
        <hr className="cuedoc-rule" />

        {count === 0 ? (
          <div className="cuedoc-empty">
            This sheet has no usable cue cards. Nothing here will match, and Hue will answer as it
            normally does.
          </div>
        ) : (
          sheet.cards.map((card, i) => (
            <CueSheetSection
              key={card.id}
              card={card}
              ordinal={i + 1}
              active={card.id === activeCardId}
              registerRef={registerRef}
            />
          ))
        )}
      </div>
    </article>
  )
}
