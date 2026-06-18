import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mapNavigatorActivityRow } = require("../../utils/navigatorActivity");

describe("mapNavigatorActivityRow", () => {
  const session = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Scrim vs T1",
    user_id: "user-1",
    createdAt: new Date("2026-06-16T00:00:00.000Z"),
    updatedAt: new Date("2026-06-17T00:00:00.000Z"),
  };

  it("maps a session to a navigator activity row", () => {
    const row = mapNavigatorActivityRow(session, "user-1");
    expect(row).toMatchObject({
      resource_type: "navigator",
      resource_id: session.id,
      resource_name: "Scrim vs T1",
      description: null,
      icon: null,
      is_owner: true,
    });
    expect(row.timestamp).toEqual(session.updatedAt);
    expect(row.created_at).toEqual(session.createdAt);
  });

  it("falls back to 'Untitled Session' when name is null", () => {
    const row = mapNavigatorActivityRow({ ...session, name: null }, "user-1");
    expect(row.resource_name).toBe("Untitled Session");
  });

  it("sets is_owner false when the requesting user does not own the session", () => {
    const row = mapNavigatorActivityRow(session, "someone-else");
    expect(row.is_owner).toBe(false);
  });
});
