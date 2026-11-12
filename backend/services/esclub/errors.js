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

module.exports = {
  EsclubError,
  EsclubDisabled,
  EsclubUnavailable,
  EsclubProtocolChanged,
  EsclubNotFound,
  EsclubUnsupported,
  EsclubUnknownChampion,
};
