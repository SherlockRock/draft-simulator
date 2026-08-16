import { describe, expect, it } from "vitest";
import { championById } from "./constants";
import {
    insertChampionToken,
    parseAnnotationText,
    uniqueChampions
} from "./annotationTokens";

describe("parseAnnotationText", () => {
    it("returns a single text segment for token-free prose", () => {
        expect(parseAnnotationText("just words")).toEqual([
            { kind: "text", value: "just words" }
        ]);
    });

    it("returns no segments for empty text", () => {
        expect(parseAnnotationText("")).toEqual([]);
    });

    it("splits text around a resolved token", () => {
        const segments = parseAnnotationText("ban @[Ahri] early");
        expect(segments).toHaveLength(3);
        expect(segments[0]).toEqual({ kind: "text", value: "ban " });
        expect(segments[1]).toMatchObject({ kind: "champion", raw: "Ahri" });
        expect(segments[2]).toEqual({ kind: "text", value: " early" });
    });

    // §1: display names resolve through championByName, so a name whose id
    // diverges (Wukong → MonkeyKing) must still resolve.
    it("resolves a display name whose id differs", () => {
        const segments = parseAnnotationText("@[Wukong]");
        expect(segments).toHaveLength(1);
        const segment = segments[0];
        if (segment.kind !== "champion") throw new Error("expected champion");
        expect(segment.resolved).toBe(championById.get("MonkeyKing"));
    });

    it("handles tokens at start, end, and back-to-back", () => {
        const kinds = parseAnnotationText("@[Ahri]@[Akali]").map((s) => s.kind);
        expect(kinds).toEqual(["champion", "champion"]);
    });

    // D16 relocated: unresolved names are KEPT, marked, never dropped.
    it("keeps an unresolvable name with resolved null", () => {
        const segments = parseAnnotationText("@[Notachamp]");
        expect(segments).toEqual([
            { kind: "champion", raw: "Notachamp", resolved: null }
        ]);
    });

    // Grammar: `@[` + one-or-more chars that are not `]` or newline + `]`.
    it("treats a newline inside brackets as literal text", () => {
        expect(parseAnnotationText("@[Ah\nri]")).toEqual([
            { kind: "text", value: "@[Ah\nri]" }
        ]);
    });

    it("treats an unclosed @[ as literal text", () => {
        expect(parseAnnotationText("look @[Ahri")).toEqual([
            { kind: "text", value: "look @[Ahri" }
        ]);
    });

    it("treats empty brackets @[] as literal text", () => {
        expect(parseAnnotationText("@[]")).toEqual([{ kind: "text", value: "@[]" }]);
    });

    // D18 repealed: prose legitimately repeats champions.
    it("keeps duplicate champions as separate segments", () => {
        const segments = parseAnnotationText("@[Akali] then @[Akali]");
        expect(segments.filter((s) => s.kind === "champion")).toHaveLength(2);
    });

    it("resolves names containing spaces and apostrophes", () => {
        const segments = parseAnnotationText("@[Aurelion Sol] and @[Kai'Sa]");
        const champs = segments.filter((s) => s.kind === "champion");
        expect(champs).toHaveLength(2);
        expect(champs.every((s) => s.kind === "champion" && s.resolved !== null)).toBe(
            true
        );
    });

    // Grammar-faithful greediness, documented: the first `@[` opens a token
    // and the FIRST `]` closes it, so a literal `@[` swallows a following
    // token into one unresolved chip. Accepted — no escape grammar (§1).
    it("lets a literal @[ swallow up to the first closing bracket", () => {
        expect(parseAnnotationText("@[x @[Ahri]")).toEqual([
            { kind: "champion", raw: "x @[Ahri", resolved: null }
        ]);
    });
});

describe("uniqueChampions", () => {
    it("dedupes by champion id in first-appearance order", () => {
        const champs = uniqueChampions(parseAnnotationText("@[Akali] @[Ahri] @[Akali]"));
        expect(champs.map((c) => c.name)).toEqual(["Akali", "Ahri"]);
    });

    // §4: unresolved champions are excluded from the collapsed cluster — a
    // dashed chip at collapse distance is a smear; §2's inline rendering is
    // where unresolved data is surfaced.
    it("excludes unresolved segments", () => {
        expect(uniqueChampions(parseAnnotationText("@[Notachamp]"))).toEqual([]);
    });

    it("returns empty for token-free text", () => {
        expect(uniqueChampions(parseAnnotationText("plain"))).toEqual([]);
    });
});

describe("insertChampionToken", () => {
    it("inserts at a collapsed caret with a trailing space", () => {
        expect(insertChampionToken("ban  now", 4, 4, "Ahri")).toEqual({
            text: "ban @[Ahri]  now",
            caret: 12
        });
    });

    it("replaces a selection", () => {
        // Selection covers "THIS " including its trailing space (4..9) —
        // the token brings its own trailing space.
        expect(insertChampionToken("ban THIS now", 4, 9, "Ahri")).toEqual({
            text: "ban @[Ahri] now",
            caret: 12
        });
    });

    it("inserts into empty text", () => {
        expect(insertChampionToken("", 0, 0, "Aurelion Sol")).toEqual({
            text: "@[Aurelion Sol] ",
            caret: 16
        });
    });

    // The captured selection can be stale by the time a picker resolves;
    // out-of-range or reversed bounds must degrade to a sane splice, never
    // throw or corrupt.
    it("clamps out-of-range and reversed bounds", () => {
        expect(insertChampionToken("abc", 99, 120, "Ahri")).toEqual({
            text: "abc@[Ahri] ",
            caret: 11
        });
        expect(insertChampionToken("abc", 2, 1, "Ahri")).toEqual({
            text: "a@[Ahri] c",
            caret: 9
        });
    });
});
