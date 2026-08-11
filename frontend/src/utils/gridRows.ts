import { GRID_CELL_GAP, GRID_HEADER_HEIGHT, GRID_PADDING } from "./gridLayout";
import { cardHeight } from "./helpers";
import type { CardLayout } from "./canvasCardLayout";

/**
 * The row model for grid containers (design §6.0a rules 2, 3 and 4).
 *
 * A row is no longer a fixed `cardHeight` slot. It is a band whose height comes
 * from its tallest member measured BELOW the row's baseline, and whose members
 * are aligned on their first draft Card rather than on their own top edge — so
 * a Bo3 occupies one row and its games sit level with a loose Card beside it.
 *
 * **Rows are derived from stored pixels, and that is deliberate.** Rev 1 ranked
 * rows on raw `y`, which rule 3 makes differ within a row, so every row split
 * into one row per member. The fix is not to stop using pixels but to rank on
 * the right function of them: rule 3 places member `i` at
 * `offset + baseline - inset_i`, so
 *
 *     y_i + inset_i === offset + baseline
 *
 * is ONE value shared by the whole row and by nothing else. Consecutive rows
 * differ in it by at least `cardHeight + gap - maxInset`, which is ~235px in
 * the tightest card layout (`horizontal`), so rounding to integer px absorbs
 * the ADR-0006 subtraction drift (~9.1e-13) without any risk of merging two
 * real rows.
 *
 * This module is deliberately ignorant of the tree, of columns and of cells. It
 * sees a vertical stack of things that have an inset and a height.
 */

/** One member of a grid, as the row model sees it. `y` is container-relative. */
export type RowMember = {
    id: string;
    y: number;
    inset: number;
    height: number;
};

/** A member whose lattice row is already known, rather than inferred from `y`. */
export type IndexedRowMember = {
    id: string;
    index: number;
    inset: number;
    height: number;
};

/**
 * A row band. `offset` is container-relative; `ids` is in the order the members
 * were supplied, which is `gridItemsOf`'s order (Groups then Cards).
 *
 * `index` is the ABSOLUTE lattice row, not this row's position in the array —
 * `rowsOf` returns only OCCUPIED rows, so a grid with Cards in rows 0 and 2
 * returns two entries with `index` 0 and 2. Getting this wrong collapses empty
 * rows out of existence, which silently renumbers `metadata.rowLabels` and
 * makes a card in an emptied middle row jump up on the next drop. Reachable on
 * production all-Card grids with no series involved.
 */
export type RowMetrics = {
    index: number;
    offset: number;
    baseline: number;
    height: number;
    ids: string[];
};

/** Container-relative y of the first row's top edge. */
const firstRowOffset = () => GRID_HEADER_HEIGHT + GRID_PADDING;

/** The only two properties of a member the row geometry depends on. */
type Chrome = { inset: number; height: number };

/** Rule 3: the row aligns on its deepest-inset member. */
const baselineOf = (bucket: Chrome[]): number => {
    let baseline = 0;
    for (const member of bucket) baseline = Math.max(baseline, member.inset);
    return baseline;
};

/**
 * Rule 2: baseline plus the furthest any member reaches below its own inset,
 * floored at one card so an all-Card row is exactly the lattice it always was.
 *
 * Shared by `rowsOf`'s gap inference and `rowsOfIndexed`'s materialization on
 * purpose: if the two ever computed height differently, reading back a layout
 * this module wrote would not reproduce it.
 */
const heightOf = (bucket: Chrome[], minHeight: number): number => {
    let below = 0;
    for (const member of bucket) below = Math.max(below, member.height - member.inset);
    return Math.max(minHeight, baselineOf(bucket) + below);
};

/**
 * The value every member of a row shares, rounded so that ADR-0006's float
 * drift cannot split a row. Integer px is the right grain: nothing in the
 * layout is ever placed on a sub-pixel boundary on purpose.
 */
const rowKeyOf = (member: RowMember): number => Math.round(member.y + member.inset);

/**
 * A row's TOP from its key and its baseline: `key = offset + baseline`.
 *
 * Gap inference must run on tops, never on keys. `key_r - key_p` carries a
 * `baseline_r - baseline_p` term that is pure error, and with the corrected
 * series inset that term (~171) is within ~33px of half a lattice step in the
 * `horizontal` layout — close enough to round to a PHANTOM empty row between a
 * Card row and a series row. On tops the residual is identically zero for any
 * inset, so this is exact rather than merely within tolerance.
 */
const rowTopOf = (key: number, baseline: number): number => key - baseline;

/**
 * The OCCUPIED rows a set of members forms, top to bottom, each carrying its
 * absolute lattice index.
 *
 * Empty rows are recovered from the pixel gap, which is the whole reason a row
 * index can stay a lattice coordinate under pixel authority. Row `r`'s
 * successor sits at `offset + height + gap`; anything beyond that is a whole
 * number of empty card rows, because this module materialized those offsets
 * itself. Without this, rows 0 and 2 collapse to 0 and 1.
 *
 * `offset` is RECOMPUTED by stacking rather than read back from the members'
 * stored y. The two agree for any state this module wrote, and where they
 * disagree — legacy pixels, an interleaved concurrent commit — stacking is the
 * coherent answer and the stored one is not. That is what makes reading torn
 * state safe rather than merely defined.
 */
export const rowsOf = (members: RowMember[], layout: CardLayout): RowMetrics[] => {
    if (members.length === 0) return [];

    const byKey = new Map<number, RowMember[]>();
    for (const member of members) {
        const key = rowKeyOf(member);
        const bucket = byKey.get(key);
        if (bucket) bucket.push(member);
        else byKey.set(key, [member]);
    }

    const minHeight = cardHeight(layout);
    const step = minHeight + GRID_CELL_GAP;
    const keys = [...byKey.keys()].sort((a, b) => a - b);

    // Everything above the FIRST occupied row is empty and therefore uniformly
    // step-spaced, so its own top alone says how many rows precede it.
    const firstBucket = byKey.get(keys[0]) ?? [];
    let index = Math.max(
        0,
        Math.round((rowTopOf(keys[0], baselineOf(firstBucket)) - firstRowOffset()) / step)
    );

    const indexed: IndexedRowMember[] = [];
    let previousTop: number | null = null;
    let previousHeight = 0;
    for (const key of keys) {
        const bucket = byKey.get(key) ?? [];
        const currentTop = rowTopOf(key, baselineOf(bucket));
        if (previousTop !== null) {
            const adjacent = previousHeight + GRID_CELL_GAP;
            // Rounded, because stored pixels may carry ADR-0006's drift. On
            // tops the only residual IS that drift.
            const empty = Math.max(
                0,
                Math.round((currentTop - previousTop - adjacent) / step)
            );
            index += 1 + empty;
        }
        for (const member of bucket) {
            indexed.push({
                id: member.id,
                index,
                inset: member.inset,
                height: member.height
            });
        }
        previousTop = currentTop;
        previousHeight = heightOf(bucket, minHeight);
    }
    return rowsOfIndexed(indexed, layout);
};

/**
 * Rows from members whose lattice index is already decided — the form the
 * layout engine works in, where a cell assignment IS the row.
 *
 * `rowsOf` is this function with an inference step in front of it. Keeping them
 * separate is what lets `materializeGrid` project a post-drop layout without
 * having to fabricate pixel positions to infer indices back out of, which is
 * what an earlier draft did (a synthetic `index * STRIDE - inset`) and which
 * silently collapsed sparse indices.
 */
export const rowsOfIndexed = (
    members: IndexedRowMember[],
    layout: CardLayout
): RowMetrics[] => {
    if (members.length === 0) return [];
    const byIndex = new Map<number, IndexedRowMember[]>();
    for (const member of members) {
        const index = Math.max(0, Math.round(member.index));
        const bucket = byIndex.get(index);
        if (bucket) bucket.push(member);
        else byIndex.set(index, [member]);
    }

    const minHeight = cardHeight(layout);
    const step = minHeight + GRID_CELL_GAP;
    const rows: RowMetrics[] = [];
    let previous: RowMetrics | null = null;

    for (const index of [...byIndex.keys()].sort((a, b) => a - b)) {
        const bucket = byIndex.get(index) ?? [];
        const row: RowMetrics = {
            index,
            offset: previous
                ? previous.offset +
                  previous.height +
                  GRID_CELL_GAP +
                  (index - previous.index - 1) * step
                : firstRowOffset() + index * step,
            baseline: baselineOf(bucket),
            height: heightOf(bucket, minHeight),
            ids: bucket.map((m) => m.id)
        };
        rows.push(row);
        previous = row;
    }
    return rows;
};

/** The occupied row carrying lattice `index`, or undefined if that row is empty. */
export const rowByIndex = (rows: RowMetrics[], index: number): RowMetrics | undefined =>
    rows.find((row) => row.index === index);

/**
 * Where a member with `inset` sits inside `row` — rule 3.
 *
 * The member that owns the baseline sits flush at the row's top; everything
 * shallower is pushed down by the difference, so all their first Cards line up.
 */
export const memberY = (row: RowMetrics, inset: number): number =>
    row.offset + (row.baseline - inset);

/**
 * Metrics for ANY row index, including ones past the last occupied row.
 *
 * `firstFreeRectFrom` and `nearestFreeRectIn` both routinely return a row past
 * the end and `hintCells` draws growth rows, so this has to be total — rev 1
 * left it undefined, which was a lookup miss on the most common drop there is.
 *
 * A growth row is one empty card tall with baseline 0, and the FIRST one starts
 * one GAP below the last row's bottom. §6.0a's rule 4 said
 * `lastRowBottom + (i - n + 1) * (cardHeight + gap)`, which puts it a whole
 * cardHeight too low (entry condition 7), and said nothing at all about an
 * empty container.
 *
 * Rule 4 is TARGETING-ONLY. A node landing in a growth row changes that row's
 * baseline, so a caller drawing a preview must re-run the model over projected
 * membership rather than trusting these metrics — see `Canvas.tsx`'s drop
 * previews.
 */
export const rowMetricsAt = (
    rows: RowMetrics[],
    index: number,
    layout: CardLayout
): RowMetrics => {
    const bounded = Math.max(0, index);
    const existing = rowByIndex(rows, bounded);
    if (existing) return existing;

    const step = cardHeight(layout) + GRID_CELL_GAP;
    // The nearest occupied row ABOVE the target — which may be none (the target
    // is above every occupied row) and may be an interior gap rather than the
    // end. Both were undefined in rev 1's rule 4.
    let above: RowMetrics | undefined;
    for (const row of rows) {
        if (row.index < bounded) above = row;
    }
    return {
        index: bounded,
        offset: above
            ? above.offset +
              above.height +
              GRID_CELL_GAP +
              (bounded - above.index - 1) * step
            : firstRowOffset() + bounded * step,
        baseline: 0,
        height: cardHeight(layout),
        ids: []
    };
};

/**
 * The row index a container-relative `y` targets.
 *
 * **Nearest row TOP, not band containment.** The boundary between rows `r` and
 * `r+1` is the midpoint of their two tops. For a uniform all-Card grid the
 * tops are `step` apart, so that boundary is `top_r + step/2` — which is
 * exactly `Math.round((y - firstRowOffset) / cellH)`, the rule `positionToCell`
 * used. Drop targeting in an all-Card grid is therefore **unchanged**, which
 * band containment would not have been: it would have required dragging a full
 * card height instead of half a cell to reach the next row, while `colAt` kept
 * round-to-nearest on x, making the gesture asymmetric.
 *
 * One rule for occupied rows, interior gaps and growth rows alike — an earlier
 * draft had two branches that disagreed about which row owns the gap between
 * them, and contradicted its own test.
 */
export const rowAtY = (rows: RowMetrics[], y: number, layout: CardLayout): number => {
    const step = cardHeight(layout) + GRID_CELL_GAP;

    // Candidate rows: every occupied row, every EMPTY RUN — above the first
    // occupied row, between two of them, and past the last. A run is uniformly
    // step-spaced, which is the one thing this module guarantees about rows it
    // never had to measure, so the nearest row of a run is a division rather
    // than a scan.
    const last = rows[rows.length - 1];
    const afterLast = last
        ? last.index +
          1 +
          Math.max(
              0,
              Math.round((y - (last.offset + last.height + GRID_CELL_GAP)) / step)
          )
        : Math.max(0, Math.round((y - firstRowOffset()) / step));

    let best = afterLast;
    let bestDistance = Math.abs(y - rowMetricsAt(rows, afterLast, layout).offset);
    // Strict `<` keeps the LOWER index on a tie, matching Math.round's
    // behaviour at an exact midpoint in the uniform case.
    const consider = (index: number, offset: number) => {
        const distance = Math.abs(y - offset);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
        }
    };
    /**
     * The nearest row of a BOUNDED empty run — `count` rows from lattice
     * `startIndex`, whose top is `startOffset`.
     *
     * Rev 1 generated no candidate at all above the first occupied row, and
     * exactly ONE below each of them. So a grid whose only members sat in row 2
     * had `{2, 3, 4, …}` as its entire reachable answer set — rows 0 and 1 were
     * unreachable from any pointer position, including a y far above the
     * container — and rows at `{0, 4}` could reach 1 but never 2 or 3, which
     * `hintRowOffsets` paints as drop targets. `rowMetricsAt` resolved all of
     * them correctly the whole time; only the candidate generation was blind.
     */
    const considerRun = (startIndex: number, startOffset: number, count: number) => {
        if (count <= 0) return;
        const k = Math.min(count - 1, Math.max(0, Math.round((y - startOffset) / step)));
        consider(startIndex + k, startOffset + k * step);
    };

    const first = rows[0];
    if (first) considerRun(0, firstRowOffset(), first.index);
    rows.forEach((row, position) => {
        consider(row.index, row.offset);
        // The interior gap between this row and the next occupied one. The run
        // past the LAST row is `afterLast`, which is unbounded above.
        const next = rows[position + 1];
        if (next) {
            considerRun(
                row.index + 1,
                row.offset + row.height + GRID_CELL_GAP,
                next.index - row.index - 1
            );
        }
    });
    return Math.max(0, best);
};

/**
 * A grid container's content height — rule 2's second sentence.
 *
 * `header + 2*padding + sum(row heights) + (n-1)*gap`, NOT `rowCount * cellH`.
 * An empty grid is still header plus its padding, which is what
 * `resolveGridDims` then floors against `MIN_GROUP_HEIGHT` and the manual
 * floor.
 */
export const gridContentHeight = (rows: RowMetrics[]): number => {
    const last = rows[rows.length - 1];
    if (!last) return GRID_HEADER_HEIGHT + 2 * GRID_PADDING;
    // Measured to the LAST row's bottom rather than summed over row heights, so
    // that empty rows — whose height is in the offsets, not in the array —
    // still occupy the container they are part of.
    return last.offset + last.height + GRID_PADDING;
};

/**
 * A grid container's content height when it must present at least `minRows`
 * rows — `metadata.gridRows`, the count the settings dialog offers.
 *
 * The stored count is a FLOOR, never a ceiling: content that needs more rows
 * still gets them, so this is the taller of the two heights. Without it an
 * empty grid is header-plus-padding tall however it was configured, and a
 * container the user built as a 3x4 grid opens as a sliver.
 *
 * The trailing rows are measured with `rowMetricsAt`, the same extrapolation
 * the drop targeting and the hint painter use, so a configured-but-empty row
 * is exactly where a drop into it would put a card — rather than a second,
 * subtly different notion of how tall an empty row is.
 */
export const gridContentHeightForRows = (
    rows: RowMetrics[],
    minRows: number,
    layout: CardLayout
): number => {
    const occupied = gridContentHeight(rows);
    if (minRows <= 0) return occupied;
    const last = rowMetricsAt(rows, minRows - 1, layout);
    return Math.max(occupied, last.offset + last.height + GRID_PADDING);
};

/** Bound on extrapolated hint rows, so a huge manual resize cannot paint thousands. */
const MAX_GROWTH_ROWS = 64;

/**
 * How many rows a container of `containerHeight` presents — the inverse of
 * `gridContentHeightForRows`, and the row half of the resize → counts rule.
 *
 * This cannot be the division `colsFromWidth` is. Columns are a uniform
 * lattice; rows are bands whose height comes from their tallest member (rule
 * 2), so a container holding a Bo3 has one row that measuring in card-heights
 * would call two. It walks `rowMetricsAt` instead — the same extrapolation the
 * drop targeting and `hintRowOffsets` use — against `hintRowOffsets`' own
 * `containerHeight - GRID_PADDING` limit, so the count a resize yields is
 * exactly the number of rows the hints were painting at that height.
 *
 * Floored at one: a grid always presents a row, and `DEFAULT_GRID_ROWS` is 1.
 * Bounded by `MAX_GROWTH_ROWS` for the same reason `hintRowOffsets` is.
 */
export const rowsFromHeight = (
    rows: RowMetrics[],
    containerHeight: number,
    layout: CardLayout
): number => {
    const limit = containerHeight - GRID_PADDING;
    let count = 0;
    while (count < MAX_GROWTH_ROWS) {
        const metrics = rowMetricsAt(rows, count, layout);
        if (metrics.offset + metrics.height > limit) break;
        count++;
    }
    return Math.max(1, count);
};

/**
 * Row bands to paint as drop hints: every occupied row, every INTERIOR gap row
 * between two occupied ones, one growth row past the end, and however many
 * further growth rows fit a container the user has resized taller.
 *
 * `containerHeight` is the container's RENDERED height, which tracks a live
 * resize — `handleResizeGroup` writes it on every mousemove and the resolver
 * reads the same store value, so the hints and the drop cannot disagree.
 *
 * A hint for a TALL row is the row's full band, not one card: the point is that
 * the user can see the row is tall before dropping into it.
 */
export const hintRowOffsets = (
    rows: RowMetrics[],
    containerHeight: number,
    layout: CardLayout
): { offset: number; height: number }[] => {
    const out: { offset: number; height: number }[] = [];
    rows.forEach((row, position) => {
        out.push({ offset: row.offset, height: row.height });
        // EVERY interior gap row between this row and the next occupied one is
        // a legal drop target — `rowAtY` can return any of them — so each is
        // offered a hint. Rows at {0, 2, 5} owe hints for 1, 3 AND 4.
        const next = rows[position + 1];
        if (!next) return;
        for (let index = row.index + 1; index < next.index; index++) {
            const gap = rowMetricsAt(rows, index, layout);
            out.push({ offset: gap.offset, height: gap.height });
        }
    });

    const limit = containerHeight - GRID_PADDING;
    const last = rows[rows.length - 1];
    // The next FREE lattice index. `rows.length` is the count of OCCUPIED rows,
    // which with rows at {0, 2} is 2 — an occupied index, so the hint list
    // would repeat row 2 and never offer row 3.
    const firstGrowth = last ? last.index + 1 : 0;
    let index = firstGrowth;
    do {
        const growth = rowMetricsAt(rows, index, layout);
        out.push({ offset: growth.offset, height: growth.height });
        index++;
    } while (
        rowMetricsAt(rows, index, layout).offset + cardHeight(layout) <= limit &&
        index < firstGrowth + MAX_GROWTH_ROWS
    );
    return out;
};
