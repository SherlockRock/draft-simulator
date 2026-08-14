import { describe, expect, it } from "vitest";
import {
    gridContentHeight,
    gridContentHeightForRows,
    hintRowOffsets,
    memberY,
    rowAtY,
    rowMetricsAt,
    rowsFromHeight,
    rowsOf,
    rowsOfIndexed,
    rowSpanFor,
    footprintPixelHeight,
    spannedBandHeight,
    snapHeightToRows,
    SPANNED_ROW_HEIGHT,
    type RowMember,
    type RowMetrics
} from "./gridRows";
import { defaultAnnotationSize } from "./annotationSize";
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
    height: ch,
    sizesRow: true,
    rowSpan: 1
});
const seriesAt = (id: string, y: number): RowMember => ({
    id,
    y,
    inset: SERIES_INSET,
    height: SERIES_H,
    sizesRow: true,
    rowSpan: 1
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

    it("sizes an occupied row from its members", () => {
        const rows = rowsOf(
            [{ id: "tiny", y: top, inset: 2, height: 10, sizesRow: true, rowSpan: 1 }],
            layout
        );
        expect(rows[0].height).toBe(10);
    });

    it("keeps an all-Card row exactly cardHeight", () => {
        expect(rowsOf([cardAt("card", top)], layout)[0].height).toBe(cardHeight(layout));
    });

    it("lets a Card dominate a mixed Card and annotation row", () => {
        const annotation = {
            id: "note",
            y: top,
            inset: CARD_INSET,
            height: 120,
            sizesRow: true,
            rowSpan: 1
        };
        expect(rowsOf([cardAt("card", top), annotation], layout)[0].height).toBe(ch);
    });

    it("sizes an annotation-only row to the annotation's height", () => {
        const annotation = {
            id: "note",
            y: top,
            inset: CARD_INSET,
            height: 120,
            sizesRow: true,
            rowSpan: 1
        };
        expect(rowsOf([annotation], layout)[0].height).toBe(120);
    });

    it("sizes a row containing only a short nested Group to that Group", () => {
        const group = {
            id: "group",
            y: top,
            inset: 66,
            height: 100,
            sizesRow: true,
            rowSpan: 1
        };
        expect(rowsOf([group], layout)[0].height).toBe(100);
    });

    it("makes three 120px annotation row bands 408px in every Card layout", () => {
        const layouts: CardLayout[] = ["wide", "compact"];
        for (const cardLayout of layouts) {
            const rows = rowsOfIndexed(
                [0, 1, 2].map((index) => ({
                    id: `note-${index}`,
                    index,
                    inset: CARD_INSET,
                    height: 120,
                    sizesRow: true,
                    rowSpan: 1
                })),
                cardLayout
            );
            const rowBands =
                rows.reduce((total, row) => total + row.height, 0) +
                (rows.length - 1) * GRID_CELL_GAP;
            expect(rowBands).toBe(408);
        }
    });

    it("round-trips member-derived rows from indexed materialization through pixels", () => {
        const indexed = [
            {
                id: "note-a",
                index: 0,
                inset: CARD_INSET,
                height: 120,
                sizesRow: true,
                rowSpan: 1
            },
            { id: "note-b", index: 1, inset: 66, height: 100, sizesRow: true, rowSpan: 1 }
        ];
        const materialized = rowsOfIndexed(indexed, layout);
        const members = indexed.map((member) => {
            const row = materialized.find((candidate) =>
                candidate.ids.includes(member.id)
            );
            if (!row) throw new Error(`missing materialized row for ${member.id}`);
            return {
                id: member.id,
                y: memberY(row, member.inset),
                inset: member.inset,
                height: member.height,
                sizesRow: true,
                rowSpan: 1
            };
        });

        expect(rowsOf(members, layout)).toEqual(materialized);
    });

    it("keeps legacy note membership but infers and preserves a phantom empty row", () => {
        const cardLayout: CardLayout = "wide";
        const legacyStep = cardHeight(cardLayout) + GRID_CELL_GAP;
        const legacy = rowsOf(
            [
                {
                    id: "note-a",
                    y: top,
                    inset: CARD_INSET,
                    height: 120,
                    sizesRow: true,
                    rowSpan: 1
                },
                {
                    id: "note-b",
                    y: top + legacyStep,
                    inset: CARD_INSET,
                    height: 120,
                    sizesRow: true,
                    rowSpan: 1
                }
            ],
            cardLayout
        );

        expect(legacy.map((row) => row.ids)).toEqual([["note-a"], ["note-b"]]);
        expect(legacy.map((row) => row.index)).toEqual([0, 2]);

        const rewritten = rowsOfIndexed(
            legacy.map((row) => ({
                id: row.ids[0] ?? "missing",
                index: row.index,
                inset: CARD_INSET,
                height: 120,
                sizesRow: true,
                rowSpan: 1
            })),
            cardLayout
        );
        expect(rewritten.map((row) => row.index)).toEqual([0, 2]);
        expect(rewritten[1].offset).toBe(top + 120 + GRID_CELL_GAP + legacyStep);
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
                    {
                        id: "card",
                        y: t,
                        inset: CARD_INSET,
                        height: h,
                        sizesRow: true,
                        rowSpan: 1
                    },
                    {
                        id: "series",
                        y: t + h + GRID_CELL_GAP,
                        inset: SERIES_INSET,
                        height: seriesH,
                        sizesRow: true,
                        rowSpan: 1
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

/**
 * The inverse of `gridContentHeightForRows`, and the row half of the resize →
 * counts rule: a manual resize decides the grid's configuration rather than
 * leaving a floor that silently disagrees with it.
 *
 * Rows are variable-height bands, so this cannot be a division the way
 * `colsFromWidth` is. It walks `rowMetricsAt` — the same extrapolation the drop
 * targeting and `hintRowOffsets` use — so the rows a resize yields are exactly
 * the rows the hints were painting at that height.
 */
describe("rowsFromHeight", () => {
    it("is the inverse of gridContentHeightForRows on an empty grid", () => {
        for (const count of [1, 2, 3, 7]) {
            const height = gridContentHeightForRows([], count, layout);
            expect(rowsFromHeight([], height, layout)).toBe(count);
        }
    });

    it("never reports zero rows — a grid always presents one", () => {
        expect(rowsFromHeight([], 0, layout)).toBe(1);
        expect(rowsFromHeight([], -500, layout)).toBe(1);
    });

    it("does not count a row the container is one pixel too short for", () => {
        const height = gridContentHeightForRows([], 3, layout);
        expect(rowsFromHeight([], height - 1, layout)).toBe(2);
    });

    it("counts a TALL row as the one row it is, not as the cards it spans", () => {
        // A Bo3 occupies one row whose band is SERIES_GROWTH taller than a card
        // row. Measuring in card-height steps would call that band two rows and
        // hand the container a row count its own model contradicts.
        const rows = rowsOf([seriesAt("s", top - SERIES_INSET + CARD_INSET)], layout);
        const height = gridContentHeightForRows(rows, 1, layout);
        expect(rowsFromHeight(rows, height, layout)).toBe(1);
        expect(height).toBeGreaterThan(gridContentHeightForRows([], 1, layout));
    });

    it("counts the growth row past a tall row once the height allows it", () => {
        const rows = rowsOf([seriesAt("s", top - SERIES_INSET + CARD_INSET)], layout);
        const two = gridContentHeightForRows(rows, 2, layout);
        expect(rowsFromHeight(rows, two, layout)).toBe(2);
        expect(rowsFromHeight(rows, two - 1, layout)).toBe(1);
    });

    it("agrees with the rows hintRowOffsets paints at the same height", () => {
        // The two must not disagree: the hints are the promise a drop makes,
        // and the count is what the container stores as its floor.
        const rows = rowsOf([cardAt("a", top)], layout);
        const height = gridContentHeightForRows(rows, 4, layout);
        expect(rowsFromHeight(rows, height, layout)).toBe(
            hintRowOffsets(rows, height, layout).length
        );
    });

    it("is bounded, so a huge manual resize cannot return thousands", () => {
        expect(rowsFromHeight([], 10_000_000, layout)).toBeLessThan(80);
    });
});

/**
 * A two-row model with DELIBERATELY UNEQUAL row heights (200 then 50).
 *
 * Every span assertion below depends on the two differing: with equal rows a
 * `rows × cardHeight` implementation and a member-derived one agree, which is
 * exactly the coincidence that would let §6.0a's rejected shape pass as
 * correct. Row 2 onwards is empty, so it extrapolates at `cardHeight`.
 */
const UNEVEN_ROWS = rowsOfIndexed(
    [
        { id: "tall", index: 0, inset: 0, height: 200, sizesRow: true, rowSpan: 1 },
        { id: "short", index: 1, inset: 0, height: 50, sizesRow: true, rowSpan: 1 }
    ],
    layout
);
const ONE_ROW = 200;
const TWO_ROWS = 200 + GRID_CELL_GAP + 50;

describe("row sizing excludes members that span", () => {
    it("falls back when every member of a row spans past it", () => {
        const rows = rowsOf(
            [{ id: "note", y: top, inset: 0, height: 900, sizesRow: false, rowSpan: 1 }],
            layout
        );
        expect(rows[0].height).toBe(SPANNED_ROW_HEIGHT);
    });

    // THE LOAD-BEARING ONE. The fallback alone would pass even if the member
    // were still measured, because a lone member's height IS the row height.
    // Here the non-sizing member is far TALLER than the Card, so only genuine
    // exclusion keeps the row at cardHeight.
    it("lets a Card size a row a much taller spanning note shares", () => {
        const rows = rowsOf(
            [
                cardAt("card", top),
                {
                    id: "note",
                    y: top,
                    inset: CARD_INSET,
                    height: 5000,
                    sizesRow: false,
                    rowSpan: 1
                }
            ],
            layout
        );
        expect(rows[0].height).toBe(ch);
    });

    it("keeps a spanning member out of the baseline as well as the height", () => {
        // A deep inset would raise `baselineOf`, and `heightOf` is
        // `baselineOf + below` — so measuring the baseline over all members
        // would let an excluded one inflate the row through the back door.
        //
        // ⚠️ `rowsOfIndexed`, NOT `rowsOf`. `rowsOf` buckets on
        // `round(y + inset)`, so a fixture that varies the inset to test the
        // baseline puts the two members in DIFFERENT ROWS and the assertion
        // passes without ever exercising the composition. That is exactly how
        // the first draft of this test failed to catch its own mutation.
        const rows = rowsOfIndexed(
            [
                {
                    id: "card",
                    index: 0,
                    inset: CARD_INSET,
                    height: ch,
                    sizesRow: true,
                    rowSpan: 1
                },
                {
                    id: "note",
                    index: 0,
                    inset: 900,
                    height: 20,
                    sizesRow: false,
                    rowSpan: 1
                }
            ],
            layout
        );
        expect(rows[0].ids).toEqual(["card", "note"]);
        expect(rows[0].baseline).toBe(CARD_INSET);
        expect(rows[0].height).toBe(ch);
    });

    it("is the default note height, which it cannot import without a cycle", () => {
        const layouts: CardLayout[] = ["vertical", "horizontal", "wide", "compact"];
        for (const cardLayout of layouts) {
            expect(SPANNED_ROW_HEIGHT).toBe(defaultAnnotationSize(cardLayout).height);
        }
    });

    it("is not the Card floor Task 24 removed", () => {
        expect(SPANNED_ROW_HEIGHT).toBeLessThan(cardHeight("horizontal"));
    });
});

describe("rowSpanFor", () => {
    it("is one row for a height the starting row already covers", () => {
        expect(rowSpanFor(ONE_ROW, 0, UNEVEN_ROWS)).toBe(1);
        expect(rowSpanFor(1, 0, UNEVEN_ROWS)).toBe(1);
    });

    it("takes the next row the moment the height exceeds the first", () => {
        expect(rowSpanFor(ONE_ROW + 1, 0, UNEVEN_ROWS)).toBe(2);
        expect(rowSpanFor(TWO_ROWS, 0, UNEVEN_ROWS)).toBe(2);
        expect(rowSpanFor(TWO_ROWS + 1, 0, UNEVEN_ROWS)).toBe(3);
    });

    // The reason this walks instead of dividing. Starting in the SHORT row, the
    // same height needs a different span than it does from the tall one — a
    // division by any single row height cannot produce both answers.
    it("depends on which rows are being covered, not just how many", () => {
        expect(rowSpanFor(220, 0, UNEVEN_ROWS)).toBe(2);
        expect(rowSpanFor(51, 1, UNEVEN_ROWS)).toBe(2);
        expect(rowSpanFor(51, 0, UNEVEN_ROWS)).toBe(1);
        // Same height, different starting row, different answer: 220 fits in
        // rows 0-1 (200 + gap + 50) but needs three from row 1 (50 + gap + 120
        // + gap + 120). No division by any single row height produces both.
        expect(rowSpanFor(220, 1, UNEVEN_ROWS)).toBe(3);
    });

    it("terminates on an absurd height rather than hanging", () => {
        expect(rowSpanFor(1e9, 0, UNEVEN_ROWS)).toBeLessThanOrEqual(64);
    });
});

describe("footprintPixelHeight", () => {
    it("is the row's own height at span one", () => {
        expect(footprintPixelHeight(UNEVEN_ROWS, 0, 1)).toBe(ONE_ROW);
        expect(footprintPixelHeight(UNEVEN_ROWS, 1, 1)).toBe(50);
    });

    // §6.0a rejected `rows × cardHeight`. This is the assertion that says the
    // replacement is member-derived: two rows here are 250 + gap, and no
    // multiple of cardHeight is.
    it("sums the ACTUAL heights of the rows it covers, plus their gaps", () => {
        expect(footprintPixelHeight(UNEVEN_ROWS, 0, 2)).toBe(TWO_ROWS);
        expect(footprintPixelHeight(UNEVEN_ROWS, 0, 2)).not.toBe(2 * ch + GRID_CELL_GAP);
    });

    /**
     * ⚠️ CONTRACT CHANGED 2026-08-14, from `cardHeight` to SPANNED_ROW_HEIGHT.
     * A row past the model that a footprint COVERS is not an empty lattice row
     * — covering it is what makes it an occupied, un-sized one. Measuring it at
     * `cardHeight` is what made a 300px note paint 1004 in `wide`.
     *
     * `rowMetricsAt` still answers `cardHeight` for the same index, and that is
     * correct: its job is targeting rows nothing reaches.
     */
    it("measures a covered row past the model at the SPANNED height", () => {
        expect(footprintPixelHeight(UNEVEN_ROWS, 0, 3)).toBe(
            TWO_ROWS + GRID_CELL_GAP + SPANNED_ROW_HEIGHT
        );
        expect(rowMetricsAt(UNEVEN_ROWS, 2, layout).height).toBe(ch);
    });

    it("never reports less than the row it starts in", () => {
        expect(footprintPixelHeight(UNEVEN_ROWS, 0, 0)).toBe(ONE_ROW);
    });
});

describe("snapHeightToRows", () => {
    // The row twin of snapWidthToCells' jitter case: the handle is seeded from
    // the painted box, which sits exactly on ONE_ROW, so a ceil rule would buy
    // a whole extra row for one pixel of downward drift.
    it("holds the row against a nudge past the boundary", () => {
        expect(snapHeightToRows(ONE_ROW + 1, 0, UNEVEN_ROWS)).toBe(ONE_ROW);
        expect(snapHeightToRows(ONE_ROW + 20, 0, UNEVEN_ROWS)).toBe(ONE_ROW);
    });

    it("takes the next row once the drag passes the midpoint", () => {
        const midpoint = (ONE_ROW + TWO_ROWS) / 2;
        expect(snapHeightToRows(midpoint - 1, 0, UNEVEN_ROWS)).toBe(ONE_ROW);
        expect(snapHeightToRows(midpoint + 1, 0, UNEVEN_ROWS)).toBe(TWO_ROWS);
    });

    it("never returns less than one row, however far the drag shrinks", () => {
        expect(snapHeightToRows(0, 0, UNEVEN_ROWS)).toBe(ONE_ROW);
        expect(snapHeightToRows(-500, 0, UNEVEN_ROWS)).toBe(ONE_ROW);
    });

    it("is a fixpoint, and agrees with the span rowSpanFor derives", () => {
        const snapped = snapHeightToRows(TWO_ROWS - 5, 0, UNEVEN_ROWS);
        expect(snapped).toBe(TWO_ROWS);
        expect(snapHeightToRows(snapped, 0, UNEVEN_ROWS)).toBe(snapped);
        expect(rowSpanFor(snapped, 0, UNEVEN_ROWS)).toBe(2);
    });
});

/**
 * Spanned-into rows are OCCUPIED (maintainer ruling 2026-08-14), measuring
 * SPANNED_ROW_HEIGHT rather than being read as empty and taking the cardHeight
 * lattice. Measured before the ruling: a 300px note painted 1004 in `wide`.
 */
describe("a row a footprint spans into", () => {
    const spanning = (id: string, index: number, rowSpan: number, height = 300) => ({
        id,
        index,
        inset: 0,
        height,
        sizesRow: false,
        rowSpan
    });

    it("exists in the model, even though no member starts in it", () => {
        const rows = rowsOfIndexed([spanning("note", 0, 2)], layout);
        expect(rows.map((r) => r.index)).toEqual([0, 1]);
    });

    it("measures SPANNED_ROW_HEIGHT, not the cardHeight lattice", () => {
        const rows = rowsOfIndexed([spanning("note", 0, 2)], layout);
        expect(rows[1].height).toBe(SPANNED_ROW_HEIGHT);
        expect(rows[1].height).not.toBe(ch);
    });

    // `ids` still means "starts here". A spanning member listed in every row it
    // covers would be positioned against its LAST row by materializeGrid's
    // rowOf map, which walks rows in order and would overwrite.
    it("lists no member of its own", () => {
        const rows = rowsOfIndexed([spanning("note", 0, 2)], layout);
        expect(rows[0].ids).toEqual(["note"]);
        expect(rows[1].ids).toEqual([]);
    });

    it("paints the height the ruling described", () => {
        const rows = rowsOfIndexed([spanning("note", 0, 2)], layout);
        expect(footprintPixelHeight(rows, 0, 2)).toBe(
            SPANNED_ROW_HEIGHT * 2 + GRID_CELL_GAP
        );
    });

    // Task 24's lattice pitch is untouched: only rows something REACHES are
    // occupied. A gap nothing covers is still a card-pitch empty row.
    it("leaves a truly empty row on the cardHeight lattice", () => {
        const rows = rowsOfIndexed(
            [spanning("note", 0, 2), { ...spanning("other", 4, 1), sizesRow: true }],
            layout
        );
        expect(rows.map((r) => r.index)).toEqual([0, 1, 4]);
        // Rows 2 and 3 are absent — genuinely empty — and row 4 sits a full two
        // card-pitch steps below row 1's bottom.
        expect(rows[2].offset).toBe(
            rows[1].offset + rows[1].height + GRID_CELL_GAP + 2 * step
        );
    });

    it("lets a sizing member that STARTS there win over the fallback", () => {
        const rows = rowsOfIndexed(
            [
                spanning("note", 0, 2),
                {
                    id: "card",
                    index: 1,
                    inset: CARD_INSET,
                    height: ch,
                    sizesRow: true,
                    rowSpan: 1
                }
            ],
            layout
        );
        expect(rows[1].height).toBe(ch);
    });

    /**
     * THE ROUND TRIP, and the reason `rowsOf`'s inference had to learn about
     * spans. The pixels between two START rows now hold spanned rows at one
     * pitch and empty rows at another; charging the spanned ones first is what
     * keeps the remainder a whole number of lattice steps. Without it the
     * indices compress and a layout this module wrote does not read back as
     * itself — silently renumbering rowLabels.
     */
    it("reads back at the same indices it was written at", () => {
        const indexed = [
            spanning("note-a", 0, 2),
            { ...spanning("note-b", 2, 1, 120), sizesRow: true }
        ];
        const materialized = rowsOfIndexed(indexed, layout);
        expect(materialized.map((r) => r.index)).toEqual([0, 1, 2]);

        const members = indexed.map((member) => {
            const row = materialized.find((r) => r.ids.includes(member.id));
            if (!row) throw new Error(`no row for ${member.id}`);
            return {
                id: member.id,
                y: memberY(row, member.inset),
                inset: member.inset,
                height: member.height,
                sizesRow: member.sizesRow,
                rowSpan: member.rowSpan
            };
        });
        expect(rowsOf(members, layout)).toEqual(materialized);
    });

    /**
     * ⚠️ THE DISCRIMINATING SPAN, and it has to be this deep.
     *
     * Dropping `spannedExtent` from the inference is invisible at a 2-row span:
     * the error is one spanned pitch (144px), and `empty` divides it by a full
     * lattice step (624 in `vertical`) and rounds to 0, so the index still comes
     * out right. The error only becomes a PHANTOM EMPTY ROW once it passes half
     * a step, which needs `(span - 1) * 144 >= 312` — a four-row span.
     *
     * Found by mutation testing: the two round-trip tests above BOTH survived
     * that mutation. Without this case the spanned-extent term would have been
     * deletable with a green suite.
     */
    it("round-trips a deep span, where a missing extent term becomes a phantom row", () => {
        const indexed = [
            spanning("note-a", 0, 4),
            { ...spanning("note-b", 4, 1, 120), sizesRow: true }
        ];
        const materialized = rowsOfIndexed(indexed, layout);
        expect(materialized.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);

        const members = indexed.map((member) => {
            const row = materialized.find((r) => r.ids.includes(member.id));
            if (!row) throw new Error(`no row for ${member.id}`);
            return {
                id: member.id,
                y: memberY(row, member.inset),
                inset: member.inset,
                height: member.height,
                sizesRow: member.sizesRow,
                rowSpan: member.rowSpan
            };
        });
        expect(rowsOf(members, layout).map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    });

    it("still round-trips when an empty row follows the spanned one", () => {
        const indexed = [
            spanning("note-a", 0, 2),
            { ...spanning("note-b", 4, 1, 120), sizesRow: true }
        ];
        const materialized = rowsOfIndexed(indexed, layout);
        const members = indexed.map((member) => {
            const row = materialized.find((r) => r.ids.includes(member.id));
            if (!row) throw new Error(`no row for ${member.id}`);
            return {
                id: member.id,
                y: memberY(row, member.inset),
                inset: member.inset,
                height: member.height,
                sizesRow: member.sizesRow,
                rowSpan: member.rowSpan
            };
        });
        expect(rowsOf(members, layout).map((r) => r.index)).toEqual([0, 1, 4]);
    });
});

describe("memberY under a row nothing sizes", () => {
    // Found by flipping ANNOTATIONS_SIZE_ROWS: a copy landed 2px above its row.
    // `baselineOf` excludes non-sizing members, so a note-only row has baseline
    // 0 while the note still has a real inset — and `baseline - inset` went
    // negative.
    it("lays a member out at the row top, never above it", () => {
        const row = { index: 1, offset: 520, baseline: 0, height: 120, ids: ["note"] };
        expect(memberY(row, GROUP_BORDER_WIDTH)).toBe(520);
    });

    it("still offsets a shallow member down to the row's baseline", () => {
        const row = { index: 0, offset: 64, baseline: 170, height: 400, ids: ["s", "c"] };
        expect(memberY(row, 2)).toBe(64 + 168);
        expect(memberY(row, 170)).toBe(64);
    });
});

describe("spannedBandHeight", () => {
    const band = (index: number, height: number): RowMetrics => ({
        index,
        offset: 0,
        baseline: 0,
        height,
        ids: []
    });

    it("is the band's own height at span one", () => {
        expect(spannedBandHeight(UNEVEN_ROWS, band(0, 200), 1)).toBe(200);
    });

    /**
     * THE REASON THIS IS NOT `footprintPixelHeight`. `landingBandOf` resolves a
     * growth row through `rowMetricsAt`, which answers `cardHeight` — so a Card
     * dropped there must get a cardHeight highlight. The span arithmetic would
     * answer SPANNED_ROW_HEIGHT for the same index and draw a 120px box under an
     * 860px Card.
     */
    it("trusts the caller's band for the first row, lattice height included", () => {
        expect(spannedBandHeight(UNEVEN_ROWS, band(9, ch), 1)).toBe(ch);
        expect(footprintPixelHeight(UNEVEN_ROWS, 9, 1)).toBe(SPANNED_ROW_HEIGHT);
    });

    it("adds each further row at the spanned pitch", () => {
        expect(spannedBandHeight(UNEVEN_ROWS, band(0, 200), 2)).toBe(
            200 + GRID_CELL_GAP + 50
        );
        expect(spannedBandHeight(UNEVEN_ROWS, band(0, 200), 3)).toBe(
            200 + GRID_CELL_GAP + 50 + GRID_CELL_GAP + SPANNED_ROW_HEIGHT
        );
    });

    it("floors a degenerate span at the band itself", () => {
        expect(spannedBandHeight(UNEVEN_ROWS, band(0, 200), 0)).toBe(200);
    });
});
