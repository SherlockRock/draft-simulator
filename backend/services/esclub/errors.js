/**
 * Typed errors of the esclub adapter. Callers branch on the class, never on a
 * message: the import route maps each to its own user-facing outcome.
 */

/** Base class of every error the adapter throws. */
class EsclubError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** The kill switch is off (`ESCLUB_SYNC_ENABLED` is not exactly "true"). */
class EsclubDisabled extends EsclubError {}
/** Connect failure, close, timeout or an error reply. */
class EsclubUnavailable extends EsclubError {}
/** A reply not of the expected shape. */
class EsclubProtocolChanged extends EsclubError {}
/** A by-id fetch that returned nothing. */
class EsclubNotFound extends EsclubError {}
/** A valid value we deliberately do not import. */
class EsclubUnsupported extends EsclubError {}
/** A champion resource we cannot map to a key. */
class EsclubUnknownChampion extends EsclubError {}
/** The game played differs from its draft in a way we will not guess at. */
class EsclubDraftMismatch extends EsclubError {}
/** The day's request budget is spent; the request was not sent. */
class EsclubBudgetExhausted extends EsclubError {}
/** One sync reached its per-sync request cap; the request was not sent. */
class EsclubRequestCapReached extends EsclubError {}
/** The sync is no longer running (taken over as stale); it must send nothing more. */
class EsclubSyncAbandoned extends EsclubError {}

module.exports = {
  EsclubError,
  EsclubDisabled,
  EsclubUnavailable,
  EsclubProtocolChanged,
  EsclubNotFound,
  EsclubUnsupported,
  EsclubUnknownChampion,
  EsclubDraftMismatch,
  EsclubBudgetExhausted,
  EsclubRequestCapReached,
  EsclubSyncAbandoned,
};
