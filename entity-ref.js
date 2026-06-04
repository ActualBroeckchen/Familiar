/**
 * Standing-value → entity-core reference resolution (Milestone 7).
 *
 * A standing value in Unruh's interest layer can carry a `value_ref`
 * that anchors it to a fact in entity-core's identity layer, so the
 * design's "redundancy is intentional" claim is structural rather than
 * a coincidence of wording. Thalamus is the mediator: it already
 * fetches both entity-core's identity and Unruh's interests in
 * enrich(), so it cross-checks the refs there and asks Unruh to demote
 * any whose anchor has disappeared.
 *
 * Reference format (string, stable-identifier anchored):
 *
 *   entity-core:<category>/<filename>[#<section>]
 *
 *   e.g.  entity-core:self/my_wants.md
 *         entity-core:self/my_wants.md#Caring for the user's wellbeing
 *
 * <category> is one of entity-core's identity categories (self / user /
 * relationship / custom); <filename> is the markdown file; the optional
 * <section> anchors to a heading within it. Only `entity-core:` refs are
 * resolvable here — anything else is "not applicable" so the caller
 * leaves it alone (never demotes a ref it doesn't understand).
 *
 * Pure functions, no I/O — unit-tested in tests/entity-ref.test.mjs.
 */

const VALID_CATEGORIES = new Set(['self', 'user', 'relationship', 'custom']);

/**
 * True only if `identity` (an identity_get_all result) actually carries
 * content — at least one category with at least one file. The
 * standing-value bridge MUST gate on this before trusting any "missing"
 * verdict: a down or erroring entity-core parses to `{}` (or all-empty),
 * against which every ref would read "missing" and trigger a wrongful
 * mass-demotion. Erring toward "looks empty → don't reconcile" keeps a
 * transient outage from stripping every standing value.
 */
export function identityHasContent(identity) {
  return !!identity && typeof identity === 'object'
    && [...VALID_CATEGORIES].some(k => Array.isArray(identity[k]) && identity[k].length > 0);
}

/**
 * Parse a value_ref string into its parts, or null if it isn't a
 * well-formed entity-core ref.
 * @returns {{ source:'entity-core', category:string, filename:string, section:string|null } | null}
 */
export function parseEntityCoreRef(ref) {
  if (typeof ref !== 'string') return null;
  const m = ref.match(/^entity-core:([^/]+)\/([^#]+?)(?:#(.*))?$/);
  if (!m) return null;
  const category = m[1].trim();
  const filename = m[2].trim();
  const section = (m[3] ?? '').trim() || null;
  if (!VALID_CATEGORIES.has(category) || !filename) return null;
  return { source: 'entity-core', category, filename, section };
}

/** True if the markdown `content` still contains `section` — either as a
 *  heading (`# Section`) or anywhere as text. Lenient on purpose: we
 *  only want to demote when the anchor has genuinely disappeared, not
 *  when a heading was lightly reworded. */
function contentHasAnchor(content, section) {
  if (typeof content !== 'string') return false;
  const target = section.toLowerCase();
  for (const line of content.split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h && h[1].trim().toLowerCase() === target) return true;
  }
  return content.toLowerCase().includes(target);
}

/**
 * Resolve a value_ref against entity-core's identity data.
 *
 * @param {string} ref           the standing value's value_ref
 * @param {object} identity      entity-core identity_get_all result,
 *                               shaped { self:[{filename,content}], user:[…], … }
 * @returns {'not-applicable'|'valid'|'missing'}
 *   - 'not-applicable': not an entity-core ref → caller leaves it alone
 *   - 'valid':          the anchored fact is present
 *   - 'missing':        the ref parses but its target is gone → demote
 */
export function resolveEntityCoreRef(ref, identity) {
  const parsed = parseEntityCoreRef(ref);
  if (!parsed) return 'not-applicable';
  const files = identity?.[parsed.category];
  if (!Array.isArray(files)) return 'missing';
  const file = files.find(f => f && f.filename === parsed.filename);
  if (!file) return 'missing';
  if (!parsed.section) return 'valid';
  return contentHasAnchor(file.content, parsed.section) ? 'valid' : 'missing';
}
