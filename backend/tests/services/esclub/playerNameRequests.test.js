import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const R = require("../../../services/esclub/requests");
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/esclub/${name}.json`, import.meta.url), "utf8")).reply;
const client = (reply) => ({ request: async () => reply });
const user = { id_user: "synthetic-context-private" };

describe("private name request projections", () => {
  it("returns only Riot account keys and parsed names, counts malformed names", async () => {
    const reply = fixture("riot-oauths");
    const result = await R.fetchRiotAccounts(client(reply), user);
    expect(result).toEqual({ accounts: [{ accountKey: "synthetic-account-a", gameName: "Player # One", tagLine: "TAG" }], dropped: 0 });
    for (const name of ["no separator", "#TAG", "Player# ", "x".repeat(65) + "#T", "P#" + "x".repeat(17)]) {
      reply.oauths.push({ type_oauth: "Riot", id_oauth_external: "synthetic-account-b", name });
    }
    expect((await R.fetchRiotAccounts(client(reply), user)).dropped).toBe(5);
    expect(await R.fetchRiotAccounts(client({ oauths: [] }), user)).toEqual({ accounts: [], dropped: 0 });
    expect(await R.fetchRiotAccounts(client({ oauths: [{ type_oauth: "Other" }] }), user)).toEqual({ accounts: [], dropped: 0 });
  });
  it("accepts exact length limits after trimming", async () => {
    const result = await R.fetchRiotAccounts(client({ oauths: [{ type_oauth: "Riot", id_oauth_external: "synthetic-account", name: " " + "x".repeat(64) + "#" + "y".repeat(16) + " " }] }), user);
    expect(result.accounts).toHaveLength(1);
    expect(result.dropped).toBe(0);
  });
  it.each([
    [{}, "reply.oauths"],
    [{ oauths: [{ type_oauth: null }] }, "oauths[0].type_oauth"],
    [{ oauths: [{ type_oauth: "Riot", id_oauth_external: null, name: "secret" }] }, "oauths[0].id_oauth_external"],
    [{ oauths: [{ type_oauth: "Riot", id_oauth_external: "private", name: null }] }, "oauths[0].name"],
  ])("shape errors include paths and omit context and values", async (reply, path) => {
    let error;
    try { await R.fetchRiotAccounts(client(reply), user); } catch (e) { error = e; }
    expect(error?.name).toBe("EsclubProtocolChanged");
    expect(error?.message).toContain(path);
    expect(error?.message).not.toMatch(/synthetic-context-private|secret|private/);
  });
  it("sorts and deduplicates player members per roster, including ended rows", async () => {
    const reply = fixture("name-members");
    const result = await R.fetchSerieRosterPlayers(client(reply), { id_serie: "synthetic-series" });
    expect(result.members.map((m) => m.type_member)).toEqual(["Starter", "Substitute", "Starter", "Starter"]);
    expect(result.members.map((m) => m.time_start)).toEqual([3, 2, 9, null]);
    expect(Object.keys(result.members[0]).sort()).toEqual(["id_parent", "id_user", "time_end", "time_start", "type_member", "type_parent"]);
    expect(await R.fetchSerieTeamOrder(client(reply), { id_serie: "synthetic-series" })).toEqual({ rosterIds: ["synthetic-roster-a", "synthetic-roster-b"] });
  });
  it.each(["fetchSerieRosterPlayers", "fetchSerieTeamOrder"])("%s shares roster checks", async (method) => {
    const reply = fixture("name-members");
    reply.members[0].type_parent = "private-type";
    await expect(R[method](client(reply), { id_serie: "synthetic-series" })).rejects.toThrow('members[0].type_parent is not "TeamRoster"');
    reply.members[0].type_parent = "TeamRoster";
    reply.members.push({ ...reply.members[0], id_parent: "third-roster" });
    await expect(R[method](client(reply), { id_serie: "synthetic-series" })).rejects.toThrow("expected at most 2");
  });
});
