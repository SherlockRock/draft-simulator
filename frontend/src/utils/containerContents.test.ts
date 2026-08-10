import { describe, expect, it } from "vitest";
import { containerContentsLabel, isContainerEmpty } from "./containerContents";

describe("isContainerEmpty", () => {
    it("is true only when the container holds neither kind of child", () => {
        expect(isContainerEmpty({ drafts: 0, groups: 0 })).toBe(true);
        expect(isContainerEmpty({ drafts: 1, groups: 0 })).toBe(false);
        expect(isContainerEmpty({ drafts: 0, groups: 1 })).toBe(false);
        expect(isContainerEmpty({ drafts: 3, groups: 2 })).toBe(false);
    });

    /**
     * The defect, stated as an assertion: a container holding two nested Groups
     * and no Cards was reported empty, so it drew a dashed border and a "Drag
     * drafts here" placeholder over the Groups it was holding.
     */
    it("is false for a container holding only Groups", () => {
        expect(isContainerEmpty({ drafts: 0, groups: 2 })).toBe(false);
    });
});

describe("containerContentsLabel", () => {
    it("reads exactly as before for a container of Cards", () => {
        expect(containerContentsLabel({ drafts: 0, groups: 0 })).toBe("0 drafts");
        expect(containerContentsLabel({ drafts: 1, groups: 0 })).toBe("1 draft");
        expect(containerContentsLabel({ drafts: 3, groups: 0 })).toBe("3 drafts");
    });

    it("names the child Groups when there are any", () => {
        expect(containerContentsLabel({ drafts: 0, groups: 2 })).toBe(
            "0 drafts · 2 groups"
        );
        expect(containerContentsLabel({ drafts: 3, groups: 1 })).toBe(
            "3 drafts · 1 group"
        );
    });
});
