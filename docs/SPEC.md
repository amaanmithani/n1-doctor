# n1-doctor — spec

Finds N+1 query patterns in OpenTelemetry traces, points at the code that
issued them, suggests the batched form, and fails CI when a change introduces
a new one.

## Goals (v1)

| #   | Capability                                                                                                                                                                                                           | Done when                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| G1  | Read traces as OTLP/JSON (collector file exporter, Jaeger/Tempo exports)                                                                                                                                             | fixtures from real instrumented runs               |
| G2  | Normalise SQL to a fingerprint (literals, IN-lists, whitespace, casing), so `WHERE id = 1` and `WHERE id = 2` match                                                                                                  | unit tests on Postgres/Prisma-style SQL            |
| G3  | Detect: the same fingerprint executed at least N times under one parent span (default N = 5), reporting count, total and wasted time, example statements, and the code location when spans carry `code.*` attributes | precision/recall on a seeded demo app              |
| G4  | Suggest the fix per pattern: batched `IN (...)` / `= ANY($1)` query, ORM eager loading (Prisma `include`, `where: { id: { in } }`), DataLoader                                                                       | suggestions in text and JSON output                |
| G5  | CI gate: `n1doctor check traces.json --baseline n1-baseline.json` exits non-zero only for N+1s not in the baseline; GitHub Action wrapper with annotations                                                           | a PR in the demo app shows it failing then passing |
| G6  | Demo: an Express + Prisma + Postgres app with OpenTelemetry, a few endpoints with seeded N+1s and their fixed twins                                                                                                  | measured latency before/after the fix              |

## Non-goals

Runtime interception (it analyses traces, doesn't patch drivers), non-SQL N+1s
(HTTP fan-out) in v1, auto-fixing code.

## Measured (committed)

- Detection precision/recall on the demo app's labelled endpoints, including
  look-alikes that must NOT be flagged (a legitimate loop of distinct queries,
  paginated batches under the threshold).
- Latency and query count before/after fixing each seeded N+1.
