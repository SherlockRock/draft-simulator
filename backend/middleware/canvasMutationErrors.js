const { CanvasMutationError } = require("../services/canvasMutations");

const STATUS_BY_CODE = {
  NOT_AUTHENTICATED: 401,
  NOT_AUTHORIZED: 403,
  DRAFT_LOCKED: 423,
  CHAMPION_RESTRICTED: 409,
  INVALID_MUTATION: 400,
};

function respondCanvasMutationError(res, error, messages = {}) {
  if (!(error instanceof CanvasMutationError)) {
    return false;
  }

  const status = STATUS_BY_CODE[error.code] || 400;
  res.status(status).json({ error: messages[error.code] ?? error.message });
  return true;
}

module.exports = {
  respondCanvasMutationError,
};
