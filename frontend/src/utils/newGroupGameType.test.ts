import { describe, expect, it } from "vitest";
import { defaultNewGroupGameType } from "./newGroupGameType";

describe("defaultNewGroupGameType", () => {
    it("starts a plain custom group as scratch", () => {
        expect(defaultNewGroupGameType(false)).toBe("scratch");
    });

    it("starts a new series as scrim so its team reaches the search dropdown", () => {
        expect(defaultNewGroupGameType(true)).toBe("scrim");
    });
});
