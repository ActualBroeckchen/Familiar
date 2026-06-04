/**
 * Interest picker — chooses one live interest from a weighted list
 * using weight-proportional random sampling.
 *
 * Step 2 of the caring spine (see docs/caring-spine-build-plan.md).
 * Higher-weight interests win more often, but no pick is deterministic:
 * the Familiar shouldn't always ponder the loudest thread — sometimes
 * a quieter one is what's worth thinking about. Surprise is care.
 *
 * Pure function, no side effects, no Unruh dependency. Tests pass a
 * seeded rng to make picks deterministic. The CLI feeds it the live
 * interest array Unruh's interest_list MCP tool returns.
 */

/**
 * Pick one eligible interest from the list using weight-proportional
 * sampling. Returns null if no candidate is eligible.
 *
 * Input shape (matches Unruh interest_list "live" entries):
 *   [{ id, label, weight, tier, ... }, ...]
 *
 * Eligible = label is a non-empty string AND weight is a finite
 * positive number. Anything else (NaN, 0, negative, missing label,
 * non-object) is filtered out silently.
 */
export function pickInterest(interests, { rng = Math.random } = {}) {
  const eligible = (interests ?? []).filter(i =>
    i &&
    typeof i.label === 'string' &&
    i.label.trim() &&
    typeof i.weight === 'number' &&
    Number.isFinite(i.weight) &&
    i.weight > 0
  );
  if (eligible.length === 0) return null;

  const total = eligible.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const c of eligible) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  // Floating-point safety net: if rng() returned ~1.0 exactly, the
  // accumulator can leave a tiny positive r. Return the last entry.
  return eligible[eligible.length - 1];
}
