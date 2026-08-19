/**
 * Split an answer into the beats the model separated with blank lines.
 *
 * The glance surface is read aloud, live, with the reader glancing down between
 * spoken sentences and needing to find their place again in a fraction of a
 * second. Blank lines are how the answer gives the eye somewhere to land, and
 * HTML collapses them, so the split has to happen here or the structure the
 * prompt asks for never reaches the screen.
 *
 * A lone newline is deliberately not a boundary. The model wraps lines inside a
 * single spoken beat, and splitting on every newline would shatter one sentence
 * into fragments that read as separate thoughts.
 *
 * Recomputed on every render rather than memoised: the answer streams, so a
 * cache would be invalidated on every token anyway, and this is one regex over
 * a few hundred characters.
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
}
