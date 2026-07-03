import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const canvasMutations = require("../../services/canvasMutations");
const {
  CanvasMutationError,
  NotAuthenticatedError,
  NotAuthorizedError,
  DraftLockedError,
  ChampionRestrictedError,
  InvalidMutationError,
} = canvasMutations;
const {
  respondCanvasMutationError,
} = require("../../middleware/canvasMutationErrors");

function buildRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status }, status, json };
}

describe("respondCanvasMutationError", () => {
  it.each([
    [new NotAuthenticatedError("auth needed"), 401, "auth needed"],
    [new NotAuthorizedError("forbidden"), 403, "forbidden"],
    [new DraftLockedError("locked"), 423, "locked"],
    [new ChampionRestrictedError("restricted"), 409, "restricted"],
    [new InvalidMutationError("bad payload"), 400, "bad payload"],
  ])("maps %s to its REST status", (error, expectedStatus, expectedMessage) => {
    const { res, status, json } = buildRes();

    const handled = respondCanvasMutationError(res, error);

    expect(handled).toBe(true);
    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith({ error: expectedMessage });
  });

  it("uses a message override when provided", () => {
    const { res, json } = buildRes();

    respondCanvasMutationError(res, new NotAuthorizedError("service text"), {
      NOT_AUTHORIZED: "route-specific text",
    });

    expect(json).toHaveBeenCalledWith({ error: "route-specific text" });
  });

  it("uses the default message when no override exists", () => {
    const { res, json } = buildRes();

    respondCanvasMutationError(res, new InvalidMutationError("default text"), {
      NOT_AUTHORIZED: "route-specific text",
    });

    expect(json).toHaveBeenCalledWith({ error: "default text" });
  });

  it("maps unknown future CanvasMutationError codes to 400", () => {
    const { res, status, json } = buildRes();

    respondCanvasMutationError(
      res,
      new CanvasMutationError("future text", "FUTURE_CODE"),
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "future text" });
  });

  it("has an explicit non-default REST status for every CanvasMutationError code", () => {
    const expectedStatusByCode = {
      NOT_AUTHENTICATED: 401,
      NOT_AUTHORIZED: 403,
      DRAFT_LOCKED: 423,
      CHAMPION_RESTRICTED: 409,
      INVALID_MUTATION: 400,
    };

    const errorClasses = Object.values(canvasMutations).filter(
      (value) =>
        typeof value === "function" &&
        (value === CanvasMutationError ||
          value.prototype instanceof CanvasMutationError),
    );

    for (const ErrorClass of errorClasses) {
      if (ErrorClass === CanvasMutationError) continue;

      const error = new ErrorClass("test message");
      const expectedStatus = expectedStatusByCode[error.code];
      expect(
        expectedStatus,
        `missing explicit REST status expectation for ${error.code}`,
      ).toBeDefined();

      const { res, status } = buildRes();
      const handled = respondCanvasMutationError(res, error);

      expect(handled).toBe(true);
      expect(status).toHaveBeenCalledWith(expectedStatus);
      if (error.code !== "INVALID_MUTATION") {
        expect(expectedStatus).not.toBe(400);
      }
    }
  });

  it("returns false for non-gate errors without touching res", () => {
    const { res, status, json } = buildRes();

    const handled = respondCanvasMutationError(res, new Error("boom"));

    expect(handled).toBe(false);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
