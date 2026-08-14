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

/**
 * Whether a member's own geometry SHAPES the row it starts in, or merely sits
 * in it.
 *
 * A member that may span rows cannot also size them: its height would set the
 * row height, which would then decide its span, which decides its height. The
 * fixpoint is broken by taking such members out of the measurement entirely —
 * rows are sized by "the other things within the row", and a row with no sizing
 * member falls back to `cardHeight(layout)`.
 *
 * Kind-agnostic on purpose. This module knows nothing about the tree, and a
 * boolean keeps it that way where a `kind` would not.
 */
type RowSizing = {
    sizesRow: boolean;
    /**
     * How many rows this member COVERS from the one it starts in. 1 for
     * everything that cannot span, which is every kind but an annotation.
     *
     * A covered row exists in the model even when no member starts there.
     * Its existence, not a distinct height, is load-bearing: content height
     * must include the entire painted span after a resize that does not update
     * `metadata.gridRows`.
     */
    rowSpan: number;
};

/** One member of a grid, as the row model sees it. `y` is container-relative. */
export type RowMember = RowSizing & {
    id: string;
    y: number;
    inset: number;
    height: number;
};

/** A member whose lattice row is already known, rather than inferred from `y`. */
export type IndexedRowMember = RowSizing & {
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

/** The only properties of a member the row geometry depends on. */
type Chrome = RowSizing & { inset: number; height: number };

/**
 * Rule 3: the row aligns on its deepest-inset member.
 *
 * Measured over the SIZING members only, for the same reason `heightOf` is —
 * a member excluded from the height must be excluded from the baseline too, or
 * it still shapes the row through `heightOf`'s `baselineOf(bucket) + below`.
 */
const baselineOf = (bucket: Chrome[]): number => {
    let baseline = 0;
    for (const member of bucket) {
        if (member.sizesRow) baseline = Math.max(baseline, member.inset);
    }
    return baseline;
};

/**
 * Rule 2: an occupied row is exactly its baseline plus the furthest any SIZING
 * member reaches below its own inset. An all-Card row is still exactly
 * `cardHeight`: its baseline is the Card inset and its below-baseline extent is
 * `cardHeight - inset`, so no explicit floor is needed.
 *
 * A row with no sizing member — whether nothing starts there or only spanning
 * notes do — measures `cardHeight(layout)`. This is the explicit 2026-08-14
 * REVERSAL of the earlier 120px ruling. It remains non-circular because a row's
 * height never consults a member that can span.
 *
 * Shared by `rowsOf`'s gap inference and `rowsOfIndexed`'s materialization on
 * purpose: if the two ever computed height differently, reading back a layout
 * this module wrote would not reproduce it.
 */
const heightOf = (bucket: Chrome[], layout: CardLayout): number => {
    let below = 0;
    let sized = false;
    for (const member of bucket) {
        if (!member.sizesRow) continue;
        sized = true;
        below = Math.max(below, member.height - member.inset);
    }
    if (!sized) return cardHeight(layout);
    return baselineOf(bucket) + below;
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

    const rowPitch = cardHeight(layout);
    const step = rowPitch + GRID_CELL_GAP;
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
            // A spanned row and a truly empty row now have the same pitch
            // (`cardHeight + gap`), so the division absorbs spanned rows for
            // free. Advancing by the span as well would double-count them.
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
                height: member.height,
                sizesRow: member.sizesRow,
                rowSpan: member.rowSpan
            });
        }
        previousTop = currentTop;
        previousHeight = heightOf(bucket, layout);
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
    // `byIndex` is members that START in a row — it decides the row's baseline,
    // its height and its `ids`, all of which are about where members SIT.
    // `covered` additionally holds every row a footprint reaches into, which
    // decides only whether the row EXISTS. Keeping them separate is what stops
    // a spanning member being positioned against its last row instead of its
    // first, and leaves every `ids` consumer untouched.
    const byIndex = new Map<number, IndexedRowMember[]>();
    const covered = new Set<number>();
    for (const member of members) {
        const index = Math.max(0, Math.round(member.index));
        const bucket = byIndex.get(index);
        if (bucket) bucket.push(member);
        else byIndex.set(index, [member]);
        for (let i = 0; i < Math.max(1, Math.round(member.rowSpan)); i++) {
            covered.add(index + i);
        }
    }

    const rowPitch = cardHeight(layout);
    const step = rowPitch + GRID_CELL_GAP;
    const rows: RowMetrics[] = [];
    let previous: RowMetrics | null = null;

    const occupiedIndices = [...new Set([...byIndex.keys(), ...covered])].sort(
        (a, b) => a - b
    );
    for (const index of occupiedIndices) {
        // A row that is only COVERED has an empty bucket. Its height now equals
        // the empty-row lattice; materializing it remains necessary so content
        // height reaches a spanning note's painted bottom.
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
            height: heightOf(bucket, layout),
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
    // ⚠️ Clamped at the row's TOP. For a SIZING member the clamp is a no-op —
    // the baseline is the max of their insets, so `baseline - inset` is never
    // negative. It bites only for a member excluded from the baseline: a note
    // that spans has inset 2 in a row whose baseline is 0, and without the
    // clamp it is laid out two pixels ABOVE the band it belongs to.
    row.offset + Math.max(0, row.baseline - inset);

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
 * The height a row contributes to a footprint COVERING it.
 *
 * An occupied row answers with its own height — a Card sharing the row still
 * sizes it. A row not in the model answers `cardHeight(layout)`, the same as
 * `rowMetricsAt`. Span arithmetic and targeting therefore agree on every
 * unmodelled row.
 */
const spanRowHeight = (rows: RowMetrics[], index: number, layout: CardLayout): number =>
    rowByIndex(rows, index)?.height ?? cardHeight(layout);

/**
 * How many rows a member of `height` starting at `startIndex` needs.
 *
 * The row axis's answer to `canvasTree.spanFor`, and CEIL-flavoured for the
 * same reason: this is the OCCUPANCY question, "how many rows does this cover",
 * where covering nine tenths of a row still means occupying it. The gesture
 * question — "which row count did the user mean" — is `snapHeightToRows`.
 *
 * It cannot be a division the way `spanFor` is. Rows are bands of differing
 * heights (rule 2), so the span depends on WHICH rows are being covered, which
 * is why `startIndex` is a parameter and why this walks rather than divides.
 *
 * Rows past the model measure `cardHeight(layout)`. That fallback is
 * span-independent, so this remains a single pass rather than a fixpoint: a
 * row's height never consults any span.
 *
 * Bounded by `MAX_GROWTH_ROWS`, and terminating without it for any positive row
 * height, since the accumulator strictly increases.
 */
export const rowSpanFor = (
    height: number,
    startIndex: number,
    rows: RowMetrics[],
    layout: CardLayout
): number => {
    if (!Number.isFinite(height)) return 1;
    let covered = spanRowHeight(rows, startIndex, layout);
    let span = 1;
    while (covered < height && span < MAX_GROWTH_ROWS) {
        covered += GRID_CELL_GAP + spanRowHeight(rows, startIndex + span, layout);
        span++;
    }
    return span;
};

/**
 * The pixel height of a `span`-row footprint starting at `startIndex`.
 *
 * ⚠️ This is the function `§6.0a` rule 1 said could not be written, and the
 * reason its objection does not bind: the rejected shape was `rows × cardHeight`,
 * which is wrong because "a row's height is a property of its MEMBERSHIP". This
 * asks the row model for each covered row's ACTUAL height instead, so the drop
 * highlight draws the true rectangle. Unmodelled rows use `cardHeight(layout)`.
 *
 * The width sibling is `gridLayout.footprintPixelWidth`, which CAN multiply,
 * because columns really are a uniform lattice.
 */
export const footprintPixelHeight = (
    rows: RowMetrics[],
    startIndex: number,
    span: number,
    layout: CardLayout
): number => {
    const count = Math.max(1, Math.round(span));
    let total = 0;
    for (let i = 0; i < count; i++) {
        total += spanRowHeight(rows, startIndex + i, layout);
    }
    return total + (count - 1) * GRID_CELL_GAP;
};

/**
 * The painted height of a footprint whose FIRST row is already resolved.
 *
 * Distinct from `footprintPixelHeight` in exactly one way, and it matters: the
 * caller supplies the starting band. `landingBandOf` resolves a growth row via
 * `rowMetricsAt`. A projected band can be taller than the lattice (for example
 * a Bo3 landing in a growth row), so the supplied first band must be honoured.
 *
 * Rows BELOW the first are measured the way a spanning member measures them,
 * because it is that member reaching them that makes them occupied.
 */
export const spannedBandHeight = (
    rows: RowMetrics[],
    band: RowMetrics,
    span: number,
    layout: CardLayout
): number => {
    const count = Math.max(1, Math.round(span));
    let total = band.height;
    for (let i = 1; i < count; i++) {
        total += GRID_CELL_GAP + spanRowHeight(rows, band.index + i, layout);
    }
    return total;
};

/**
 * The nearest whole-row height to a hand-dragged one — the row axis's twin of
 * `annotationSize.snapWidthToCells`, and NEAREST for the same reason that one
 * is. The resize handle is seeded from the painted box, which already sits on a
 * row boundary, so a ceil rule would buy a whole extra row for one pixel of
 * downward jitter.
 *
 * Floored at one row: a member always occupies the row it starts in.
 */
export const snapHeightToRows = (
    draggedHeight: number,
    startIndex: number,
    rows: RowMetrics[],
    layout: CardLayout
): number => {
    let span = 1;
    let candidate = footprintPixelHeight(rows, startIndex, 1, layout);
    if (!Number.isFinite(draggedHeight)) return candidate;
    while (candidate < draggedHeight && span < MAX_GROWTH_ROWS) {
        const next = footprintPixelHeight(rows, startIndex, span + 1, layout);
        if (next >= draggedHeight) {
            return draggedHeight - candidate <= next - draggedHeight ? candidate : next;
        }
        span++;
        candidate = next;
    }
    return candidate;
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
