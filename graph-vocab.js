// graph-vocab.js — the single source of truth for what belongs in the knowledge
// graph, shared by every surface where the Familiar decides to create a node or
// an edge: the autonomous memorization extraction prompt (memorization.js) and
// the live chat-path graph tools (cerebellum.js). Holding the rubric in one place
// is what stops the entity-type vocabulary and the "no abstractions" rule from
// drifting across surfaces — a node made mid-chat is now held to the same
// standard as one made during memorization.
//
// First person throughout (Psycheros convention): these strings are the
// Familiar's own voice, read by the model as a statement of its own nature.
//
// NOTE: the Python side carries the SAME vocabulary by hand —
// phylactery/src/phylactery/server.py `graph_relate` / `graph_node_create`
// docstrings. Keep them in sync with this list.

export const GRAPH_ENTITY_TYPES = ['person', 'place', 'organisation', 'pet', 'condition', 'project', 'thing'];

export const GRAPH_ENTITY_TYPES_STR = GRAPH_ENTITY_TYPES.join(', ');

// What earns a node: a concrete, nameable entity — never an abstraction. This is
// the single biggest driver of graph quality (it's what keeps "stress" and
// "work-life balance" from becoming nodes).
export const GRAPH_NODE_RUBRIC =
  'I only make a node for a concrete, nameable entity — never an abstraction, ' +
  'feeling, idea, theme or topic ("stress", "the future", "work-life balance" are not entities).';

// What earns an edge: a stated or clearly-implied link between two such entities,
// never invented, typed as a short snake_case label read from→to.
export const GRAPH_EDGE_RUBRIC =
  'I record an edge only when both endpoints are concrete named entities and the ' +
  'link is stated or clearly implied — I never invent edges. The type is a short ' +
  'snake_case label read from→to (works_at, lives_in, parent_of, has_condition, owns, located_in, …).';
