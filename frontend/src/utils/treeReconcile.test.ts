import { describe, expect, test } from "vitest";
import {
    collectNodeKeyPaths,
    nodeKey,
    nodeKeyPath,
    nodeKeyPathToIndices,
    pathIndicesToNodeKeyPath,
    pathStepsToIndexPath,
    pathStepsToNodeKeyPath
} from "./treeReconcile";

type Node = {
    side: "blue" | "red" | null;
    actionType: "ban" | "pick";
    championIds: string[];
    children: Node[];
};

function makeNode(
    side: "blue" | "red" | null,
    actionType: "ban" | "pick",
    championIds: string[],
    children: Node[] = []
): Node {
    return { side, actionType, championIds, children };
}

describe("nodeKey", () => {
    test("joins side, actionType, and championIds with separators", () => {
        const n = makeNode("blue", "pick", ["Ahri"]);
        expect(nodeKey(n)).toBe("blue:pick:Ahri");
    });

    test("sorts championIds so pair order is irrelevant", () => {
        const a = makeNode("red", "pick", ["Ahri", "Zed"]);
        const b = makeNode("red", "pick", ["Zed", "Ahri"]);
        expect(nodeKey(a)).toBe(nodeKey(b));
        expect(nodeKey(a)).toBe("red:pick:Ahri|Zed");
    });

    test("uses 'none' when side is null", () => {
        const n = makeNode(null, "ban", ["Ahri"]);
        expect(nodeKey(n)).toBe("none:ban:Ahri");
    });
});

describe("nodeKeyPath", () => {
    test("joins keys with '>' separator", () => {
        expect(nodeKeyPath(["a", "b", "c"])).toBe("a>b>c");
    });

    test("returns empty string for empty input", () => {
        expect(nodeKeyPath([])).toBe("");
    });
});

describe("collectNodeKeyPaths", () => {
    test("walks every reachable node and returns its full key-path", () => {
        const root = makeNode(
            null,
            "ban",
            [],
            [
                makeNode("blue", "pick", ["A"], [makeNode("red", "pick", ["B"])]),
                makeNode("blue", "pick", ["C"])
            ]
        );

        const paths = collectNodeKeyPaths(root);
        expect(paths).toEqual(
            new Set(["blue:pick:A", "blue:pick:A>red:pick:B", "blue:pick:C"])
        );
    });

    test("returns empty set when root has no children", () => {
        const root = makeNode(null, "ban", []);
        expect(collectNodeKeyPaths(root)).toEqual(new Set());
    });
});

describe("pathIndicesToNodeKeyPath", () => {
    const root = makeNode(
        null,
        "ban",
        [],
        [makeNode("blue", "pick", ["A"], [makeNode("red", "pick", ["B"])])]
    );

    test("translates a valid index path to a nodeKeyPath", () => {
        expect(pathIndicesToNodeKeyPath(root, [0])).toBe("blue:pick:A");
        expect(pathIndicesToNodeKeyPath(root, [0, 0])).toBe("blue:pick:A>red:pick:B");
    });

    test("empty index path returns empty string", () => {
        expect(pathIndicesToNodeKeyPath(root, [])).toBe("");
    });

    test("returns null when any index is out of bounds", () => {
        expect(pathIndicesToNodeKeyPath(root, [5])).toBeNull();
        expect(pathIndicesToNodeKeyPath(root, [0, 1])).toBeNull();
    });
});

describe("pathStepsToIndexPath", () => {
    const root = makeNode(
        null,
        "ban",
        [],
        [
            makeNode("blue", "pick", ["A"], [makeNode("red", "pick", ["B", "C"])]),
            makeNode("blue", "pick", ["D"])
        ]
    );

    test("matches steps by championIds sorted-set equality", () => {
        const path = pathStepsToIndexPath(root, [
            { slot: 6, championIds: ["A"] },
            { slot: 7, championIds: ["C", "B"] }
        ]);
        expect(path).toEqual([0, 0]);
    });

    test("returns null when any step does not match a child", () => {
        const path = pathStepsToIndexPath(root, [
            { slot: 6, championIds: ["A"] },
            { slot: 7, championIds: ["X"] }
        ]);
        expect(path).toBeNull();
    });

    test("empty step list returns empty array", () => {
        expect(pathStepsToIndexPath(root, [])).toEqual([]);
    });
});

describe("pathStepsToNodeKeyPath", () => {
    const root = makeNode(
        null,
        "ban",
        [],
        [makeNode("blue", "pick", ["A"], [makeNode("red", "pick", ["B", "C"])])]
    );

    test("returns the joined nodeKeyPath for matching steps", () => {
        const keyPath = pathStepsToNodeKeyPath(root, [
            { slot: 6, championIds: ["A"] },
            { slot: 7, championIds: ["C", "B"] }
        ]);
        expect(keyPath).toBe("blue:pick:A>red:pick:B|C");
    });

    test("returns null when any step does not match", () => {
        expect(
            pathStepsToNodeKeyPath(root, [{ slot: 6, championIds: ["Z"] }])
        ).toBeNull();
    });
});

describe("nodeKeyPathToIndices", () => {
    const root = makeNode(
        null,
        "ban",
        [],
        [makeNode("blue", "pick", ["A"], [makeNode("red", "pick", ["B", "C"])])]
    );

    test("translates a valid keyPath back to index path", () => {
        expect(nodeKeyPathToIndices(root, "blue:pick:A>red:pick:B|C")).toEqual([0, 0]);
    });

    test("empty keyPath returns empty array", () => {
        expect(nodeKeyPathToIndices(root, "")).toEqual([]);
    });

    test("returns null when a segment doesn't match any child", () => {
        expect(nodeKeyPathToIndices(root, "blue:pick:Z")).toBeNull();
    });
});
