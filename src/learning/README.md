# Embedded learning implementation ledger

Approved scope: LearningService and behavioral learning tests, no shared contract/store/engine modifications.

1. RED: behavior suite proves missing public API before implementing learning.
2. Implement separate version-1 WAL SQLite database, immutable history, canonical project keys, explicit development/production isolation and formal exclusion.
3. Add structured, bounded evidence-linked reflection and deterministic incremental curation; never ingest transcript reasoning.
4. Journal before original-goal usage reservation; atomically persist a reservation marker within goal usage. Mark dispatch before the only completion call, retain uncertain charges, and recover without replay.
5. Validate cancellation before every dispatch, inspect the supplied transport quota without creating or reserving an alternate allowance, and publish learning.* events.
6. GREEN: 32 learning behavior tests and isolated strict compilation passed. Shared typecheck/build currently blocked by web/src/MaturationViews.tsx:59 (unknown ReactNode); full repository run at 17:17 had 492 passing, 8 failing, 9 skipped tests in other worker areas. No live model calls.

Ruling: partition defaults to production and accepts goal.partition (plus older learningPartition); formal wins conflicts and any formal budget ancestor forces formal exclusion. Cancelled budget ancestors also prohibit reflection. Integrator must label formal roots explicitly.
Ruling: the supplied transport owns atomic provider quota reservation. Learning consults its optional quotaSnapshot() inspector or the actual owned SerialQuota instance, never a local/default alternative. Transports without an inspector retain quota enforcement at complete(). Injected offline transports do not read ambient quota state.
Ruling: native reserveAttempt/settleAttempt atomically account against the original goal and budgetRootId ancestry. usage.learningReservations adds safe reservation metadata and active-time reservations to every owner. A base SessionStore without native reservations uses an atomic usage marker only for a single owner and fails closed for a shared budget. It survives engine spread-based usage updates. It is intentionally not a model message or reusable memory.
Ruling: source fingerprints use the engine's existing framing and exclusions. Keep stateDir outside source, or under ignored .ernie, as with other runtime state.
Ruling: all manual text edits become candidates without evidence; human status changes cannot promote an unsupported assertion. Model additions cannot silently re-enable a disabled entry.

Public API: LearningService(store: SessionStore, model: ModelTransport, bus: EventBus, stateDir: string); prepare(goal), reflect(goalId, signal?), list(workspace), update(id, {text?, status?}), close(). Entry text is a bounded model proposal tied to matching observed checks, not a semantic proof of the proposed strategy. Native reservation and settlement each explicitly use calls=1.
