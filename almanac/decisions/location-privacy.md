---
title: Location Privacy
topics: [decisions, weather]
sources:
  - id: weather-build-spec
    type: file
    path: docs/weather-build-spec.md
  - id: unruh-location
    type: file
    path: unruh/src/unruh/location.py
---

# Location Privacy

**Status: decided and shipped (W-A, 0.8.76-alpha).** The Familiar never learns the geographic location of the ward or the ward's places. Locations stay local and are never told to the model. A city or ZIP is geocoded exactly once in Node code (`weather-source.js`), and only coordinates go to the weather API thereafter [@weather-build-spec]. The model reads qualitative weather ("6°C, light rain") and ward-facing labels ("home", "work") — never coordinates or place names [@weather-build-spec].

## Context

Weather sense required the Familiar to know where the ward is so it could fetch relevant conditions. The naive approach would pass the place name ("Seattle") or coordinates to the model so it could reason about them. That would cross a privacy boundary: the model would retain geographic information across sessions, across the [multi-embodiment](../concepts/multi-embodiment) boundary, and potentially in any future checkpoint or audit. Even location labels like "home" and "work" could be combined with conversation history to infer a place.

The decision was motivated by the principle that unnecessary data should not be centralized: the Familiar's identity lives in [Phylactery](../architecture/phylactery), its schedule and interests in [Unruh](../architecture/unruh), but its geography should stay local — known only to the Node runtime that serves the ward directly.

## Decision

Locations are never bound as model tools. The model sees only `location_public`, which returns `{id, label, is_current}` — the id to refer back to a place, the label the ward chose, and whether it is the current location [@weather-build-spec]. The coordinate-bearing shapes — `location_private` and `weather_locations_private` — are called by Node code only, in [Unruh's location.py](../architecture/unruh) [@weather-build-spec] [@unruh-location].

This boundary is structural, not procedural. Unruh's MCP surface cannot be extended to include coordinates without explicit work to wire them as model tools. A future maintainer cannot accidentally leak a coordinate to the model by passing it in a prompt block.

## Consequences

Any weather-adjacent feature in the future must work through the same boundary:

- The model cannot compute a local time for a place without already knowing the place's timezone.
- The model cannot compare two places by distance or relative position.
- Weather and schedule features cannot reason about travel between places without the travel being logged as an explicit event node in [Unruh](../architecture/unruh)'s schedule.

This is a stability gain. The Familiar's geographic context is as minimal as the model's need for weather allows. If the model's capabilities expand or weather sense grows to shared surfaces (Session W-B), the location data stays where it is — no refactoring of Phylactery, no audit trail of location spillover.

## Related

- [Weather](../architecture/weather) — the autonomous loop that consumes weather sense via the location-privacy boundary.
- [Unruh](../architecture/unruh) — the temporal-context specialist that holds schedule and location references.
- [Multi-embodiment](../concepts/multi-embodiment) — the canonical-store model whose boundary this decision keeps geographic data out of.
