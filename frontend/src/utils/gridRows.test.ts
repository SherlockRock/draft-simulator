import { describe, expect, it } from "vitest";
import {
    gridContentHeight,
    gridContentHeightForRows,
    hintRowOffsets,
    memberY,
    rowAtY,
    rowMetricsAt,
    rowsOf,
    type RowMember
} from "./gridRows";
import {
    GRID_CELL_GAP,
    GRID_HEADER_HEIGHT,
    GRID_PADDING,
    GROUP_BORDER_WIDTH
} from "./gridLayout";
import {
    SERIES_GAME_CONTROLS_HEIGHT,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING_Y,
    cardHeight,
    getSeriesGroupDimensions
} from "./helpers";
import type { CardLayout } from "./canvasCardLayout";

const layout: CardLayout = "vertical";
const ch = cardHeight(layout);
const top = GRID_HEADER_HEIGHT + GRID_PADDING;
const step = ch + GRID_CELL_GAP;

/**
 * The REAL chrome, not the design's stale table. `canvasTree.insetOf` produces
 * exactly these, so a fixture here cannot encode geometry the app never sees.
 * The module itself is ignorant of all of it — it only ever sees an inset and a
 * height — but a synthetic 78/96 would have quietly reproduced the very bug
 * Task 0 fixed.
 */
const CARD_INSET = GROUP_BORDER_WIDTH;
const SERIES_INSET =
    GROUP_BORDER_WIDTH +
    SERIES_HEADER_HEIGHT +
    SERIES_PADDING_Y +
    SERIES_GAME_CONTROLS_HEIGHT;
const SERIES_H = getSeriesGroupDimensions(3, layout).height;
/** How much taller a series row is than a Card row — the whole point of §6.0a. */
const SERIES_GROWTH = SERIES_H - ch;

const cardAt = (id: string, y: number): RowMember => ({
    id,
    y,
    inset: CARD_INSET,
    height: ch
});
const seriesAt = (id: string, y: number): RowMember => ({
    id,
    y,
    inset: SERIES_INSET,
    height: SERIES_H
});

describe("rowsOf", () => {
    it("returns no rows for an empty container", () => {
        expect(rowsOf([], layout)).toEqual([]);
    });

    // Entry condition 5: a legacy all-Card grid must read back as the rows it
    // already has, with no migration and no visible change.
    it("reproduces the uniform lattice for an all-Card grid", () => {
        const rows = rowsOf(
            [cardAt("a", top), cardAt("b", top), cardAt("c", top + step)],
            layout
        );
        expect(rows).toHaveLength(2);
        expect(rows[0].offset).toBe(top);
        expect(rows[0].height).toBe(ch);
        expect(rows[0].ids).toEqual(["a", "b"]);
        expect(rows[1].offset).toBe(top + step);
        expect(rows[1].ids).toEqual(["c"]);
    });

    it("groups row-mates that rule 3 gave DIFFERENT y — this is what killed rev 1", () => {
        // A series and a Card sharing a row: the Card sits lower by the
        // difference of their insets.
        const rows = rowsOf(
            [seriesAt("s", top), cardAt("c", top + (SERIES_INSET - CARD_INSET))],
            layout
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].ids).toEqual(["s", "c"]);
    });

    it("takes the largest inset in the row as the baseline", () => {
        const rows = rowsOf(
            [seriesAt("s", top), cardAt("c", top + (SERIES_INSET - CARD_INSET))],
            layout
        );
        expect(rows[0].baseline).toBe(SERIES_INSET);
    });

    it("sizes a row as baseline + max(height - inset), so the series fits exactly", () => {
        const rows = rowsOf([seriesAt("s", top)], layout);
        expect(rows[0].height).toBe(SERIES_H);
    });

    it("floors a row at cardHeight", () => {
        const rows = rowsOf([{ id: "tiny", y: top, inset: 2, height: 10 }], layout);
        expect(rows[0].height).toBe(ch);
    });

    it("offsets each row by the previous row's height plus the gap", () => {
        const rows = rowsOf(
            [seriesAt("s", top), cardAt("c", top + SERIES_H + GRID_CELL_GAP)],
            layout
        );
        expect(rows).toHaveLength(2);
        expect(rows[1].offset).toBe(top + SERIES_H + GRID_CELL_GAP);
    });

    // ADR-0006's subtraction drift, measured at ~9.1e-13 in 8.5% of cases.
    it("tolerates float drift on a child Group's derived y", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("b", top + 9.1e-13)], layout);
        expect(rows).toHaveLength(1);
    });

    // Reachable on production all-Card grids: drop a card two rows below the
    // last one, or empty a middle row. An earlier draft collapsed these.
    it("PRESERVES an empty row — rows 0 and 2 stay 0 and 2", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("c", top + 2 * step)], layout);
        expect(rows.map((r) => r.index)).toEqual([0, 2]);
        expect(rows[1].offset).toBe(top + 2 * step);
    });

    it("preserves a LEADING empty row — a grid whose first occupied row is 1", () => {
        const rows = rowsOf([cardAt("a", top + step)], layout);
        expect(rows[0].index).toBe(1);
    });

    it("measures a gap after a TALL row correctly", () => {
        const rows = rowsOf(
            [seriesAt("s", top), cardAt("c", top + SERIES_H + GRID_CELL_GAP + step)],
            layout
        );
        expect(rows.map((r) => r.index)).toEqual([0, 2]);
    });

    /**
     * Gap inference runs on row TOPS, never on row KEYS. A key carries the
     * row's baseline, so `key_r - key_p` has a `baseline_r - baseline_p` term
     * of pure error — and with the corrected series inset that term (~171) is
     * within ~33px of half a lattice step in the `horizontal` layout, close
     * enough to round to a PHANTOM empty row between a Card row and a series
     * row. On tops the residual is identically zero.
     */
    it("does not invent a phantom empty row between a Card row and a series row", () => {
        for (const l of ["vertical", "horizontal", "compact"] as CardLayout[]) {
            const h = cardHeight(l);
            const seriesH = getSeriesGroupDimensions(3, l).height;
            const t = GRID_HEADER_HEIGHT + GRID_PADDING;
            const rows = rowsOf(
                [
                    { id: "card", y: t, inset: CARD_INSET, height: h },
                    {
                        id: "series",
                        y: t + h + GRID_CELL_GAP,
                        inset: SERIES_INSET,
                        height: seriesH
                    }
                ],
                l
            );
            expect(rows.map((r) => r.index)).toEqual([0, 1]);
        }
    });

    it("orders rows by their shared identity, not by store order", () => {
        const rows = rowsOf([cardAt("late", top + step), cardAt("early", top)], layout);
        expect(rows[0].ids).toEqual(["early"]);
        expect(rows[1].ids).toEqual(["late"]);
    });
});

describe("memberY", () => {
    it("drops a Card to the row's baseline when a series shares its row", () => {
        const rows = rowsOf([seriesAt("s", top)], layout);
        expect(memberY(rows[0], CARD_INSET)).toBe(top + SERIES_INSET - CARD_INSET);
    });

    it("is the row offset for the member that owns the baseline", () => {
        const rows = rowsOf([seriesAt("s", top)], layout);
        expect(memberY(rows[0], SERIES_INSET)).toBe(top);
    });

    it("round-trips: rowsOf(materialized members) recovers the same row", () => {
        const rows = rowsOf([seriesAt("s", top)], layout);
        const again = rowsOf(
            [
                seriesAt("s", memberY(rows[0], SERIES_INSET)),
                cardAt("c", memberY(rows[0], CARD_INSET))
            ],
            layout
        );
        expect(again).toHaveLength(1);
        expect(again[0].baseline).toBe(SERIES_INSET);
    });
});

// Entry condition 7. Rule 4 as written put the first growth row a whole
// cardHeight too low and was undefined for an empty container.
describe("rowMetricsAt — extrapolation past the last occupied row", () => {
    it("puts the first growth row one GAP below the last row's bottom", () => {
        const rows = rowsOf([seriesAt("s", top)], layout);
        const grown = rowMetricsAt(rows, 1, layout);
        expect(grown.offset).toBe(top + SERIES_H + GRID_CELL_GAP);
        expect(grown.baseline).toBe(0);
        expect(grown.height).toBe(ch);
    });

    it("steps each further growth row by cardHeight + gap", () => {
        const rows = rowsOf([cardAt("a", top)], layout);
        expect(rowMetricsAt(rows, 2, layout).offset).toBe(top + 2 * step);
    });

    it("is defined for an EMPTY container — row 0 starts under the header", () => {
        expect(rowMetricsAt([], 0, layout).offset).toBe(top);
        expect(rowMetricsAt([], 1, layout).offset).toBe(top + step);
    });

    it("is defined for a row inside an INTERIOR gap", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("c", top + 2 * step)], layout);
        expect(rowMetricsAt(rows, 1, layout).offset).toBe(top + step);
    });

    it("returns an occupied row by INDEX, not by array position", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("c", top + 2 * step)], layout);
        expect(rowMetricsAt(rows, 2, layout).ids).toEqual(["c"]);
    });

    it("returns an occupied row unchanged", () => {
        const rows = rowsOf([seriesAt("s", top)], layout);
        expect(rowMetricsAt(rows, 0, layout)).toEqual(rows[0]);
    });

    it("clamps a negative index to row 0", () => {
        const rows = rowsOf([cardAt("a", top)], layout);
        expect(rowMetricsAt(rows, -3, layout)).toEqual(rows[0]);
    });

    /**
     * `rowMetricsAt` and `rowsOfIndexed` must agree wherever both are defined,
     * or a preview and a commit disagree about where the same row is.
     */
    it("agrees with rowsOf on every occupied row", () => {
        const rows = rowsOf(
            [
                seriesAt("s", top),
                cardAt("c", top + SERIES_H + GRID_CELL_GAP),
                cardAt("d", top + SERIES_H + GRID_CELL_GAP + 2 * step)
            ],
            layout
        );
        for (const row of rows) {
            expect(rowMetricsAt(rows, row.index, layout)).toEqual(row);
        }
    });
});

describe("rowAtY", () => {
    it("finds the row a point falls in", () => {
        const rows = rowsOf(
            [seriesAt("s", top), cardAt("c", top + SERIES_H + GRID_CELL_GAP)],
            layout
        );
        expect(rowAtY(rows, top + 10, layout)).toBe(0);
        expect(rowAtY(rows, top + SERIES_H + GRID_CELL_GAP + 10, layout)).toBe(1);
    });

    it("targets a growth row below the last one", () => {
        const rows = rowsOf([cardAt("a", top)], layout);
        expect(rowAtY(rows, top + step + 10, layout)).toBe(1);
        expect(rowAtY(rows, top + 2 * step + 10, layout)).toBe(2);
    });

    it("clamps above the first row to row 0", () => {
        const rows = rowsOf([cardAt("a", top)], layout);
        expect(rowAtY(rows, -500, layout)).toBe(0);
    });

    /**
     * Table-driven over the FIRST OCCUPIED row, because the fixture that only
     * ever put it at 0 is exactly what let the leading-rows blind spot ship:
     * the candidate set was `afterLast` + occupied + one gap row each, and
     * nothing in it could ever be below the first occupied index. A grid whose
     * only members are two Bo3s in row 2 then had `{2, 3, 4, …}` as its whole
     * reachable answer set, and a Card dragged to the top of the container was
     * targeted at the series, collided, and relocated to row 1 — the user's
     * "it only ever allows me to move it to the second row".
     */
    describe.each([0, 1, 2, 3])("with the first occupied row at %i", (first) => {
        const rows = rowsOf([cardAt("a", top + first * step)], layout);

        it("targets every leading empty row by its own top", () => {
            for (let index = 0; index <= first; index++) {
                expect(rowAtY(rows, top + index * step, layout)).toBe(index);
                // …and anywhere in that row's upper half, not just its top.
                expect(rowAtY(rows, top + index * step + 10, layout)).toBe(index);
            }
        });

        it("targets row 0 from far above the container", () => {
            expect(rowAtY(rows, -500, layout)).toBe(0);
            expect(rowAtY(rows, top - 5, layout)).toBe(0);
        });
    });

    /**
     * The same blind spot in its interior form. `hintRowOffsets` paints a hint
     * for EVERY row between two occupied ones — rows at {0, 4} owe hints for 1,
     * 2 and 3 — so all three have to be reachable, or the overlay offers a
     * target the resolver refuses.
     */
    it("targets every row of a multi-row interior gap", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("b", top + 4 * step)], layout);
        for (const index of [1, 2, 3]) {
            expect(rowAtY(rows, top + index * step, layout)).toBe(index);
        }
    });

    /**
     * A TALL leading row does not shift the rows above it: everything above the
     * first occupied row is uniformly step-spaced from the container's top,
     * whatever the first occupied row turns out to hold.
     */
    it("targets leading rows above a series row on the uniform lattice", () => {
        const rows = rowsOf([seriesAt("s", top + 2 * step)], layout);
        expect(rowAtY(rows, top, layout)).toBe(0);
        expect(rowAtY(rows, top + step, layout)).toBe(1);
        expect(rowAtY(rows, top + 2 * step, layout)).toBe(2);
    });

    it("is defined for an empty container", () => {
        expect(rowAtY([], top + 5, layout)).toBe(0);
        expect(rowAtY([], top + step + 5, layout)).toBe(1);
    });

    // Parity with the retired `positionToCell`: the boundary is HALF a step
    // below a row's top, not a full card height. This is the assertion that
    // stops drop targeting silently changing in every existing all-Card grid.
    it("switches rows at the midpoint between row tops, as positionToCell did", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("b", top + step)], layout);
        expect(rowAtY(rows, top + step / 2 - 1, layout)).toBe(0);
        expect(rowAtY(rows, top + step / 2 + 1, layout)).toBe(1);
    });

    it("gives the same answer whether or not a row exists below the point", () => {
        const one = rowsOf([cardAt("a", top)], layout);
        const two = rowsOf([cardAt("a", top), cardAt("b", top + step)], layout);
        const y = top + ch + 4;
        expect(rowAtY(one, y, layout)).toBe(rowAtY(two, y, layout));
    });

    /**
     * A TALL row claims proportionally more of the pointer's travel, because
     * the boundary is the midpoint between two row TOPS and the next top is
     * further away. This is the whole behavioural difference from the retired
     * uniform `cellH` inverse — and it is NOT band containment: a row claims
     * about half its own height either way, never all of it. Aiming at the
     * upper half of a row targets that row, whatever height it is.
     */
    it("moves the row boundary DOWN when the row above it is taller", () => {
        expect(SERIES_GROWTH).toBeGreaterThan(0);
        const uniformBoundary = step / 2;
        const tallBoundary = (SERIES_H + GRID_CELL_GAP) / 2;
        expect(tallBoundary).toBeGreaterThan(uniformBoundary);

        // One y, two containers: past a Card row's boundary, short of a series
        // row's. The uniform lattice could not tell these apart.
        const y = top + (uniformBoundary + tallBoundary) / 2;
        expect(rowAtY(rowsOf([cardAt("a", top)], layout), y, layout)).toBe(1);
        expect(rowAtY(rowsOf([seriesAt("s", top)], layout), y, layout)).toBe(0);
    });

    it("claims about half of its own band, tall or not — not the whole band", () => {
        const seriesRows = rowsOf([seriesAt("s", top)], layout);
        // Just inside the series row's own painted band, but past its
        // boundary: this targets the row BELOW, exactly as the lower half of a
        // Card row does.
        expect(rowAtY(seriesRows, top + SERIES_H - 1, layout)).toBe(1);
        expect(rowAtY(seriesRows, top + 1, layout)).toBe(0);
    });
});

describe("gridContentHeight", () => {
    it("is header + 2*padding for an empty grid", () => {
        expect(gridContentHeight([])).toBe(GRID_HEADER_HEIGHT + 2 * GRID_PADDING);
    });

    it("sums row heights and the gaps between them, not rowCount * cellH", () => {
        const rows = rowsOf(
            [seriesAt("s", top), cardAt("c", top + SERIES_H + GRID_CELL_GAP)],
            layout
        );
        expect(gridContentHeight(rows)).toBe(
            GRID_HEADER_HEIGHT + 2 * GRID_PADDING + SERIES_H + GRID_CELL_GAP + ch
        );
    });

    it("counts an empty row's height, which lives in the offsets", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("c", top + 2 * step)], layout);
        expect(gridContentHeight(rows)).toBe(top + 2 * step + ch + GRID_PADDING);
    });

    it("makes a lone Bo3 exactly ONE row tall — the whole point of 6.0a", () => {
        const rows = rowsOf([seriesAt("s", top)], layout);
        expect(rows).toHaveLength(1);
        expect(gridContentHeight(rows)).toBe(
            GRID_HEADER_HEIGHT + 2 * GRID_PADDING + SERIES_H
        );
    });
});

/**
 * `metadata.gridRows` is a FLOOR, not a count. A container configured as 3 rows
 * opens 3 rows tall while empty, and still grows past 3 when its content needs
 * to.
 */
describe("gridContentHeightForRows", () => {
    it("gives an EMPTY grid the height its configured rows need", () => {
        const empty = gridContentHeight([]);
        expect(gridContentHeightForRows([], 1, layout)).toBe(top + ch + GRID_PADDING);
        expect(gridContentHeightForRows([], 3, layout)).toBe(
            top + 2 * step + ch + GRID_PADDING
        );
        // ...which is taller than the header-and-padding sliver it would be
        // without a configured count. That sliver is the bug.
        expect(gridContentHeightForRows([], 3, layout)).toBeGreaterThan(empty);
    });

    it("is a floor: content taller than the configured rows still wins", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("c", top + 3 * step)], layout);
        const content = gridContentHeight(rows);
        expect(gridContentHeightForRows(rows, 2, layout)).toBe(content);
        expect(gridContentHeightForRows(rows, 1, layout)).toBe(content);
    });

    it("extends past the content when the configured count is larger", () => {
        const rows = rowsOf([cardAt("a", top)], layout);
        expect(gridContentHeightForRows(rows, 3, layout)).toBe(
            top + 2 * step + ch + GRID_PADDING
        );
    });

    it("measures a trailing row exactly where rowMetricsAt puts it", () => {
        // Not a second notion of how tall an empty row is: the configured
        // height and the drop target for that row must agree, or a card
        // dropped into the last row lands outside the frame.
        const rows = rowsOf([seriesAt("s", top)], layout);
        const third = rowMetricsAt(rows, 2, layout);
        expect(gridContentHeightForRows(rows, 3, layout)).toBe(
            third.offset + third.height + GRID_PADDING
        );
    });

    it("falls back to the content height for a non-positive count", () => {
        const rows = rowsOf([cardAt("a", top)], layout);
        expect(gridContentHeightForRows(rows, 0, layout)).toBe(gridContentHeight(rows));
    });
});

describe("hintRowOffsets", () => {
    const emptyContainer = GRID_HEADER_HEIGHT + 2 * GRID_PADDING;

    it("gives one offset per occupied row plus a growth row", () => {
        const rows = rowsOf([seriesAt("s", top)], layout);
        const offsets = hintRowOffsets(rows, emptyContainer, layout);
        expect(offsets).toHaveLength(2);
        expect(offsets[0]).toEqual({ offset: top, height: SERIES_H });
        expect(offsets[1]).toEqual({
            offset: top + SERIES_H + GRID_CELL_GAP,
            height: ch
        });
    });

    it("fills a user-resized container with extra growth rows", () => {
        const rows = rowsOf([cardAt("a", top)], layout);
        const tall = top + 4 * step;
        expect(hintRowOffsets(rows, tall, layout).length).toBeGreaterThan(2);
    });

    // `rows.length` is the count of OCCUPIED rows, not the next free lattice
    // index — with rows at {0, 2} it starts at 2, which is occupied, so the
    // hint list would repeat row 2 and never offer row 3.
    it("extrapolates from the last LATTICE index, not the occupied-row count", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("c", top + 2 * step)], layout);
        const offsets = hintRowOffsets(rows, emptyContainer, layout);
        expect(new Set(offsets.map((o) => o.offset)).size).toBe(offsets.length);
        expect(offsets.some((o) => o.offset === top + 3 * step)).toBe(true);
    });

    it("includes the INTERIOR gap row, which is a legal drop target", () => {
        const rows = rowsOf([cardAt("a", top), cardAt("c", top + 2 * step)], layout);
        const offsets = hintRowOffsets(rows, emptyContainer, layout);
        expect(offsets.some((o) => o.offset === top + step)).toBe(true);
    });

    it("offers EVERY interior gap row, not just the first", () => {
        // Rows at {0, 2, 5} owe hints for gap rows 1, 3 and 4.
        const rows = rowsOf(
            [cardAt("a", top), cardAt("b", top + 2 * step), cardAt("c", top + 5 * step)],
            layout
        );
        expect(rows.map((r) => r.index)).toEqual([0, 2, 5]);
        const offsets = hintRowOffsets(rows, emptyContainer, layout);
        for (const gap of [1, 3, 4]) {
            expect(offsets.some((o) => o.offset === top + gap * step)).toBe(true);
        }
        expect(new Set(offsets.map((o) => o.offset)).size).toBe(offsets.length);
    });

    it("gives an empty container exactly one hint row", () => {
        expect(hintRowOffsets([], emptyContainer, layout)).toEqual([
            { offset: top, height: ch }
        ]);
    });

    it("paints a tall row at its FULL height, so the user can see it is tall", () => {
        const rows = rowsOf([seriesAt("s", top)], layout);
        expect(hintRowOffsets(rows, emptyContainer, layout)[0].height).toBe(SERIES_H);
        expect(SERIES_H).toBeGreaterThan(ch);
    });

    it("cannot paint thousands of rows for a huge manual resize", () => {
        const rows = rowsOf([cardAt("a", top)], layout);
        expect(hintRowOffsets(rows, 10_000_000, layout).length).toBeLessThan(80);
    });
});
