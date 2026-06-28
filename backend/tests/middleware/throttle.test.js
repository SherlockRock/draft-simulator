// backend/tests/middleware/throttle.test.js
import { describe, expect, test, vi } from "vitest";
import { perUserThrottle } from "../../middleware/throttle.js";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe("perUserThrottle", () => {
  test("allows up to max then 429s within the window", () => {
    const mw = perUserThrottle({ windowMs: 10_000, max: 2 });
    const req = { user: { id: "u1" } };
    const next = vi.fn();

    mw(req, mockRes(), next);
    mw(req, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);

    const res = mockRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(429);
  });

  test("separate users have separate budgets", () => {
    const mw = perUserThrottle({ windowMs: 10_000, max: 1 });
    const next = vi.fn();
    mw({ user: { id: "a" } }, mockRes(), next);
    mw({ user: { id: "b" } }, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("401s when unauthenticated", () => {
    const mw = perUserThrottle({ windowMs: 10_000, max: 1 });
    const res = mockRes();
    const next = vi.fn();
    mw({}, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("budget recovers after the window elapses", () => {
    vi.useFakeTimers();
    const mw = perUserThrottle({ windowMs: 1_000, max: 1 });
    const req = { user: { id: "u1" } };
    const next = vi.fn();
    mw(req, mockRes(), next);
    const blocked = mockRes();
    mw(req, blocked, next);
    expect(blocked.statusCode).toBe(429);
    vi.advanceTimersByTime(1_100);
    mw(req, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
