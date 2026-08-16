import {
    For,
    Index,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    untrack
} from "solid-js";
import type {
    AnchorType,
    CanvasAnnotation as CanvasAnnotationRow
} from "../utils/schemas";
import {
    championsMatchingQuery,
    insertChampionToken,
    mentionQueryAt,
    parseAnnotationText,
    uniqueChampions,
    type AnnotationSegment
} from "../utils/annotationTokens";
import { annotationSurfaceClass, ANNOTATION_FONT_PX } from "../utils/annotationStyle";
import { MIN_ANNOTATION_HEIGHT, MIN_ANNOTATION_WIDTH } from "../utils/annotationSize";
import { scaledStrokePx, screenConstantPx } from "../utils/viewport";
import {
    LOCK_BADGE_DOT_SCREEN_PX,
    LOCK_BADGE_TEXT_SCREEN_PX,
    lockBadgeMode
} from "../utils/annotationLockBadge";
import { resizeFromLeft, resizeHandleWorldPx } from "../utils/resizeHandle";
import { CUSTOM_GROUP_HEADER_HEIGHT } from "./CustomGroupContainer";
import { ChampionPortrait } from "./ChampionPortrait";
import { ResizeGrip } from "./ResizeGrip";
import { AnchorPoints } from "./AnchorPoints";

export const annotationRenderTop = (positionY: number, isGrouped: boolean): number =>
    isGrouped ? positionY - CUSTOM_GROUP_HEADER_HEIGHT : positionY;

type CanvasAnnotationProps = {
    annotation: CanvasAnnotationRow;
    isGrouped: boolean;
    zoom: () => number;
    canEdit: () => boolean;
    isConnectionMode: boolean;
    onAnchorClick: (annotationId: string, anchorType: AnchorType) => void;
    connectionSource: () => string | null;
    sourceAnchor: () => { type: AnchorType } | null;
    snappedSize: () => { width: number; height: number } | null;
    isSelected: () => boolean;
    editingAnnotationId: () => string | null;
    lockedByName: () => string | null;
    /** Feedback for a double-click declined because someone else holds the note. */
    onBlockedByLock: (holderName: string) => void;
    onEditingComplete: () => void;
    /**
     * Enter inline edit. The component cannot do this itself: the textarea is
     * only mounted while editing, so at rest `textareaRef` is undefined and
     * focusing it is a no-op.
     */
    onStartEditing: (annotationId: string) => void;
    onMouseDown: (e: MouseEvent, annotation: CanvasAnnotationRow) => void;
    /**
     * True once this note's text is too small on screen to read (design §4).
     *
     * Supplied by the parent rather than computed here, and that is the whole
     * optimisation: the state machine depends only on the FONT PRESET and the
     * zoom, so Canvas keeps four of them and every note shares one. Computing
     * it per note would put a reactive node on every annotation for a value
     * that has four distinct answers.
     */
    isTextCollapsed: () => boolean;
    /**
     * Right-click insert (§3). The caret is captured HERE, not passed up and
     * re-derived: it is a fact only this component's textarea knows
     * (technique: don't re-derive caller facts). While an insert session is
     * open, blur defers the commit — the picker steals focus by design.
     */
    onOpenInsertPicker: (annotationId: string) => void;
    onCloseInsertPicker: () => void;
    insertPickerOpenFor: () => string | null;
    insertedChampion: () => {
        annotationId: string;
        championName: string;
        session: number;
    } | null;
    onCommitText: (annotationId: string, text: string, measuredHeight: number) => void;
    /**
     * `isLeftEdge` says which corner is being dragged, and it is passed rather
     * than inferred on purpose. The receiver cannot recover it from the
     * numbers: comparing the incoming `positionX` against the stored one calls
     * a RIGHT-edge drag a left-edge one whenever the note's x has moved since
     * mousedown, and calls a left-edge drag a right-edge one at the exact
     * moment the user drags back to where they started.
     */
    onResize: (
        annotationId: string,
        positionX: number,
        width: number,
        height: number,
        isLeftEdge: boolean
    ) => void;
    onResizeEnd: (
        annotationId: string,
        positionX: number,
        width: number,
        height: number,
        isLeftEdge: boolean
    ) => void;
};

/**
 * One renderer for both the display div and the auto-fit measure div (§5) —
 * shared so the measured layout cannot drift from the painted one.
 *
 * `<Index>`, not `<For>`: `parseAnnotationText` returns fresh object
 * identities every call, so `<For>` would reconcile nothing and rebuild
 * every row per keystroke (the measure div re-parses on each input).
 * `<Index>` keys by position and updates rows in place.
 *
 * Icon is `1em` of the note's own font: it scales with the text under zoom
 * like any glyph, so world/screen-space is not in play. Icons opt back into
 * pointer events (the display div is pointer-events-none) so `title` hover
 * works; mousedown still bubbles to the root drag handler.
 */
const SegmentedText = (props: { segments: AnnotationSegment[] }) => (
    <Index each={props.segments}>
        {(segment) => <SegmentView segment={segment()} />}
    </Index>
);

const SegmentView = (props: { segment: AnnotationSegment }) => (
    <Show
        when={props.segment.kind === "champion" ? props.segment : null}
        fallback={props.segment.kind === "text" ? props.segment.value : null}
    >
        {(champion) => (
            <Show
                when={champion().resolved}
                fallback={
                    /* §2: same 1em box as the resolved icon — a taller
                       chip would change line-box height and desync the
                       auto-fit measurement from the icon case. */
                    <span
                        class="pointer-events-auto inline-flex h-[1em] max-w-[8em] items-center overflow-hidden rounded border border-dashed border-darius-crimson px-[0.2em] align-[-0.125em] text-[0.6em] leading-none text-darius-crimson"
                        title={`Unknown champion: ${champion().raw}`}
                    >
                        <span class="truncate">{champion().raw}</span>
                    </span>
                }
            >
                {(resolved) => (
                    <ChampionPortrait
                        src={resolved().img}
                        alt={resolved().name}
                        title={resolved().name}
                        class="pointer-events-auto inline-block h-[1em] w-[1em] rounded-sm align-[-0.125em]"
                    />
                )}
            </Show>
        )}
    </Show>
);

export const CanvasAnnotation = (props: CanvasAnnotationProps) => {
    const [textSignal, setTextSignal] = createSignal(props.annotation.text);
    const [isTextFocused, setIsTextFocused] = createSignal(false);
    let textareaRef: HTMLTextAreaElement | undefined;
    let measureRef: HTMLDivElement | undefined;
    // Non-reactive on purpose: nothing renders from these.
    let insertSelection: { start: number; end: number } | null = null;
    // Seeded from the CURRENT signal value, not 0: annotations remount when
    // dragged between the grouped and loose <For> blocks, and a fresh instance
    // starting at 0 would treat the last completed insert as unconsumed and
    // replay it into a note nobody is editing.
    // `untrack` because this is a one-time seed, not a subscription — the
    // insert effect below is the tracked consumer.
    let consumedInsertSession = untrack(() => props.insertedChampion()?.session ?? 0);

    const [caretPos, setCaretPos] = createSignal(0);
    // Escape dismisses THIS mention until the user starts a different one; the
    // literal text stays (§3). Keyed by (start, query-prefix), not position
    // alone: delete-the-mention-then-type-a-new-@ can land at the same offset
    // and must not inherit the dismissal, while typing MORE characters into
    // the dismissed mention keeps it dismissed.
    const [dismissedMention, setDismissedMention] = createSignal<{
        start: number;
        query: string;
    } | null>(null);
    const [mentionHighlight, setMentionHighlight] = createSignal(0);
    // True once the user has engaged the list with the arrow keys — gates
    // Enter-accept for the empty query (a bare "@" opens the popover per §3,
    // but "@⏎" must still mean newline, not "insert the roster's first name").
    const [mentionArmed, setMentionArmed] = createSignal(false);

    const mention = createMemo(() => {
        if (!isTextFocused()) return null;
        return mentionQueryAt(textSignal(), caretPos());
    });
    const mentionMatches = createMemo(() => {
        const m = mention();
        if (!m) return [];
        const dismissed = dismissedMention();
        // An empty dismissed query suppresses ONLY the empty query — every
        // string starts with "", so startsWith alone would let a dismissed
        // bare "@" suppress all future typing at that offset.
        if (
            dismissed &&
            dismissed.start === m.start &&
            (dismissed.query === ""
                ? m.query === ""
                : m.query.startsWith(dismissed.query))
        ) {
            return [];
        }
        return championsMatchingQuery(m.query).slice(0, 8);
    });
    const isMentionOpen = () => mentionMatches().length > 0;

    // New mention context: reset the highlight, disarm Enter, and clear a
    // stale dismissal.
    createEffect(() => {
        const m = mention();
        setMentionHighlight(0);
        setMentionArmed(false);
        if (m === null) setDismissedMention(null);
    });

    const acceptMention = (name: string) => {
        const m = mention();
        if (!m) return;
        const next = insertChampionToken(textSignal(), m.start, caretPos(), name);
        setTextSignal(next.text);
        textareaRef?.focus();
        textareaRef?.setSelectionRange(next.caret, next.caret);
        setCaretPos(next.caret);
    };

    // Both branches handled: when the store value changes under an unfocused
    // note we resync, and while focused we deliberately do not — that is the
    // whole reason the blur handler has to snapshot.
    createEffect(() => {
        const stored = props.annotation.text;
        if (!isTextFocused() && textSignal() !== stored) setTextSignal(stored);
    });

    createEffect(() => {
        if (props.editingAnnotationId() === props.annotation.id) {
            textareaRef?.focus();
            textareaRef?.select();
        }
    });

    const isEditing = () => props.editingAnnotationId() === props.annotation.id;

    createEffect(() => {
        if (props.lockedByName() && isEditing()) {
            // A lock landing while the insert picker is up: end the session
            // first so the blur below commits instead of deferring.
            if (insertSelection) {
                insertSelection = null;
                props.onCloseInsertPicker();
            }
            textareaRef?.blur();
        }
    });

    // Applies a picked champion at the captured caret, then hands focus back.
    createEffect(() => {
        const inserted = props.insertedChampion();
        if (!inserted || inserted.annotationId !== props.annotation.id) return;
        if (inserted.session === consumedInsertSession) return;
        consumedInsertSession = inserted.session;
        const fallback = { start: textSignal().length, end: textSignal().length };
        const selection = insertSelection ?? fallback;
        insertSelection = null;
        const next = insertChampionToken(
            textSignal(),
            selection.start,
            selection.end,
            inserted.championName
        );
        setTextSignal(next.text);
        textareaRef?.focus();
        textareaRef?.setSelectionRange(next.caret, next.caret);
        // Without this, the mention memo evaluates against the pre-insert
        // caret and can pop the autocomplete open on top of the fresh token.
        setCaretPos(next.caret);
    });

    // Close-without-pick. Ordered guards: if a pick for this note is still
    // unconsumed, the insert effect owns the session — do not clear its
    // captured caret. Otherwise the session is over, and there are two exits:
    // an ordinary cancel (Escape) RESUMES the edit; an invalidating close
    // (permission lost, lock arrived) COMMITS what was typed — resuming an
    // editor the user is no longer allowed to be in contradicts why the
    // picker closed, and dropping the text is the silent-loss bug this
    // component's commit path exists to prevent.
    createEffect(() => {
        if (props.insertPickerOpenFor() === props.annotation.id) return;
        if (!insertSelection) return;
        const pending = props.insertedChampion();
        if (
            pending &&
            pending.annotationId === props.annotation.id &&
            pending.session !== consumedInsertSession
        ) {
            return;
        }
        insertSelection = null;
        if (!props.canEdit() || props.lockedByName() || props.isConnectionMode) {
            commitText();
        } else {
            textareaRef?.focus();
        }
    });

    // While this note's insert session is open, a mousedown outside both the
    // picker and this textarea ends the session and COMMITS — the user has
    // moved on, and stranding the edit uncommitted is the silent-loss bug.
    // Capture-phase, so it runs before whatever the click starts.
    createEffect(() => {
        if (props.insertPickerOpenFor() !== props.annotation.id) return;
        const onWindowMouseDown = (e: MouseEvent) => {
            if (!(e.target instanceof Element)) return;
            if (e.target.closest(".canvas-picker-popover")) return;
            if (e.target === textareaRef) {
                // Clicking back into the textarea means "keep editing, drop
                // the insert": cancel without committing — focus lands in the
                // textarea naturally, and the stale captured caret dies here.
                insertSelection = null;
                props.onCloseInsertPicker();
                return;
            }
            insertSelection = null;
            props.onCloseInsertPicker();
            commitText();
        };
        window.addEventListener("mousedown", onWindowMouseDown, true);
        onCleanup(() => window.removeEventListener("mousedown", onWindowMouseDown, true));
    });

    // Snapped inside a grid, stored outside it (design D5a). Snapping happens
    // at RENDER and never at commit, so drag-into-grid then drag-back-out is a
    // lossless round trip rather than a silent resize.
    //
    // ⚠️ One exception, and it is deliberate: the resize handle SEEDS from
    // these, so a hand-resize inside a grid commits a snapped-derived size and
    // that note's round trip is no longer lossless. Only an explicit resize
    // does this — a note the user never resized still round-trips exactly.
    // See the resize handle below for why the alternative was worse.
    const renderWidth = () => props.snappedSize()?.width ?? props.annotation.width;
    const renderHeight = () => props.snappedSize()?.height ?? props.annotation.height;

    const fontPx = createMemo(() => ANNOTATION_FONT_PX[props.annotation.fontSize]);

    const segments = createMemo(() => parseAnnotationText(props.annotation.text));

    // Rough viewport fit: the actual match-row count at ~1.6em per row, in
    // screen px. Deliberately an estimate that reads layout imperatively —
    // acceptable for a transient editor affordance, and recorded as such: the
    // design asks for below-or-above-whichever-fits, not pixel-perfect
    // clamping. Horizontal overflow is accepted (the note is on-screen while
    // editing; the popover left-aligns to it).
    const mentionOpensUpward = () => {
        const el = textareaRef;
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const popoverScreenPx = fontPx() * 1.6 * mentionMatches().length * props.zoom();
        const fitsBelow = rect.bottom + popoverScreenPx <= window.innerHeight;
        const fitsAbove = rect.top - popoverScreenPx >= 0;
        // "Whichever fits": flip up only when below fails AND above works —
        // flipping into a space that also doesn't fit just clips off the top.
        return !fitsBelow && fitsAbove;
    };

    /*
     * Edit-lock badge geometry. Declared HERE, below `renderWidth`, and not up
     * beside the blur effect: `createMemo` evaluates its body eagerly at
     * creation, so a memo reading `renderWidth` before that `const` initialises
     * dies in the temporal dead zone rather than merely reading a stale value.
     *
     * Each is bound to its own const — `solid/reactivity` cannot analyse a
     * `createMemo` written inline in an object literal, and the lint gate holds
     * at exactly 64 warnings.
     */
    const badgeMode = createMemo(() => lockBadgeMode(props.zoom(), renderWidth()));
    const badgeTextPx = createMemo(() =>
        screenConstantPx(LOCK_BADGE_TEXT_SCREEN_PX, props.zoom())
    );
    const badgeInsetPx = createMemo(() => screenConstantPx(4, props.zoom()));
    // Screen-constant, then capped at half the note's shortest side — the same
    // two rules the resize grip resolves, for the same reason.
    const dotSizePx = createMemo(() =>
        resizeHandleWorldPx(
            props.zoom(),
            Math.min(renderWidth(), renderHeight()),
            LOCK_BADGE_DOT_SCREEN_PX
        )
    );

    /**
     * Both bottom corners, which differ in exactly one thing: which horizontal
     * edge stays put. `se` pins the left edge and grows right; `sw` pins the
     * RIGHT edge and moves `positionX` as the width changes. Height is
     * identical for both — they are both BOTTOM corners.
     */
    const handleResizeMouseDown = (e: MouseEvent, corner: "sw" | "se") => {
        e.stopPropagation();
        const isLeftEdge = corner === "sw";
        const startX = e.clientX;
        const startY = e.clientY;
        // Seeded from the PAINTED box, not the stored size — and via the same
        // accessors that paint it, so the gesture's origin cannot drift from
        // the corner the handle is sitting on.
        //
        // Inside a grid those differ, and seeding from the stored size left the
        // handle detached from the number it controls: a 56px-stored note
        // painting 700px needed ~700px of travel before the first cell
        // appeared, and a 120px-stored note painting 384px beside a Card did
        // nothing for ~264px. The vertical dead zone's SIZE depended on what
        // else shared the row, which is what made the two axes feel unrelated.
        //
        // Captured once, deliberately. Re-reading them per mousemove would feed
        // each frame's snapped result back in as the next frame's origin.
        //
        // `positionX` is the exception that needs no render accessor: the note
        // paints at `left: positionX` verbatim, so stored and painted x are the
        // same number. Only the SIZE is ever snapped away from storage.
        const startPositionX = props.annotation.positionX;
        const startWidth = renderWidth();
        const startHeight = renderHeight();

        const onMove = (move: MouseEvent) => {
            const deltaX = (move.clientX - startX) / props.zoom();
            const deltaY = (move.clientY - startY) / props.zoom();
            // Clamped to the RESIZE MINIMUM, not to the manual floor — this
            // gesture is what SETS the floor, so reading it here would ratchet
            // the note's size up and make it un-shrinkable by hand.
            const horizontal = isLeftEdge
                ? resizeFromLeft({
                      startPositionX,
                      startWidth,
                      deltaX,
                      minWidth: MIN_ANNOTATION_WIDTH
                  })
                : {
                      // The LIVE x, not the captured one. This corner does not
                      // move the note, so it must not write a stale origin over
                      // an x that something else has since changed.
                      positionX: props.annotation.positionX,
                      width: Math.max(MIN_ANNOTATION_WIDTH, startWidth + deltaX)
                  };
            const height = Math.max(MIN_ANNOTATION_HEIGHT, startHeight + deltaY);
            props.onResize(
                props.annotation.id,
                horizontal.positionX,
                horizontal.width,
                height,
                isLeftEdge
            );
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            props.onResizeEnd(
                props.annotation.id,
                props.annotation.positionX,
                props.annotation.width,
                props.annotation.height,
                isLeftEdge
            );
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    const commitText = () => {
        // ⚠️ Snapshot BEFORE clearing the focus flag. Solid flushes the resync
        // effect above SYNCHRONOUSLY on that write, which restores the OLD
        // store text into textSignal — so reading the signal afterwards hands
        // the commit the value it already had, and the equality check upstream
        // then bails silently. That was the whole draft-rename regression: no
        // request, no toast, the text reverts. Snapshotting makes the commit
        // independent of effect scheduling rather than dependent on statement
        // order (CanvasCard.tsx:721 carries the twin of this comment).
        const typed = textSignal();
        // §5: the display rendering post-commit, not textarea scrollHeight. The
        // snapshot-before-clearing-the-focus-flag discipline is unchanged and
        // still load-bearing (see the comment above).
        const measured = measureRef ? measureRef.scrollHeight : 0;
        setIsTextFocused(false);
        props.onCommitText(props.annotation.id, typed, measured);
        props.onEditingComplete();
    };

    return (
        <div
            data-annotation-id={props.annotation.id}
            // `canvas-annotation` is REQUIRED: `dispatchContextMenu` in
            // Canvas.tsx matches on it to route the right-click to the
            // annotation menu.
            //
            // ⚠️ `class` here is a STATIC string and must stay static. A
            // reactive `class` alongside a reactive `classList` on the same
            // element is a real bug: Solid's `className()` does
            // `node.className = value` — a wholesale write that wipes every
            // class `classList` added — and `classList()` then skips re-adding
            // them because it diffs against its own `prev` map. The first
            // colour change would silently drop `cursor-grab` and the selection
            // ring, permanently.
            //
            // Multi-class classList keys are fine and are the house idiom
            // (CanvasCard.tsx:636, :746): Solid's `toggleClassKey` does
            // `key.trim().split(/\s+/)` and toggles each name.
            class="canvas-annotation absolute select-none rounded-md border-2 transition-colors"
            classList={{
                [annotationSurfaceClass(props.annotation.color)]: true,
                "cursor-grab": props.canEdit() && !props.isConnectionMode,
                "ring-2 ring-darius-purple-bright": props.isSelected()
            }}
            style={{
                left: `${props.annotation.positionX}px`,
                top: `${annotationRenderTop(
                    props.annotation.positionY,
                    props.isGrouped
                )}px`,
                width: `${renderWidth()}px`,
                height: `${renderHeight()}px`,
                // `scaledStrokePx`, NOT `screenConstantPx`. viewport.ts:55-84
                // is explicit: constant on-screen size is for chrome that is
                // genuinely zoom-independent, and "reads as absurdly heavy when
                // the card it surrounds is 34px wide". A note's minimum width is
                // 56px, so screenConstantPx(2) at MIN_ZOOM would be ~20 world px
                // of border swallowing the whole box. This scales with the
                // content and holds at a floor instead of rasterising away.
                "border-width": `${scaledStrokePx(2, props.zoom())}px`
            }}
            onMouseDown={(e) => props.onMouseDown(e, props.annotation)}
            onDblClick={(e) => {
                if (!props.canEdit() || props.isConnectionMode) return;
                // A held note declines to open the editor, and SAYS SO. Left
                // silent this is indistinguishable from a double-click that
                // missed — and the `annotationLockDenied` toast cannot cover
                // it, because returning here means we never emit the
                // `annotationEditStart` the server would have refused. That
                // toast still covers the race where the lock lands after we
                // have opened the editor.
                const holder = props.lockedByName();
                if (holder) {
                    e.stopPropagation();
                    props.onBlockedByLock(holder);
                    return;
                }
                e.stopPropagation();
                // NOT `textareaRef?.focus()` — at rest the textarea is not
                // mounted, so the ref is undefined and that would silently do
                // nothing. Ask Canvas to set editingAnnotationId; the <Show>
                // below then mounts the textarea and the effect above focuses
                // it. §4 requires double-click to enter edit.
                props.onStartEditing(props.annotation.id);
            }}
        >
            {/* Advisory only (design D12): this badge and the textarea's
                `readOnly` are the WHOLE enforcement. The note can still be
                dragged, resized, duplicated and deleted while it is held, and
                a PATCH from this client still succeeds — last-write-wins
                remains the truth.

                Sized in SCREEN px, not world px, because it is the only
                user-facing signal the lock has: `readOnly` is invisible and a
                declined double-click looks like a missed one. A 10px world-space
                badge is ~1px at MIN_ZOOM, i.e. no signal at all. */}
            <Show when={props.lockedByName()}>
                {(name) => (
                    <Show
                        when={badgeMode() === "label"}
                        fallback={
                            <div
                                // Collapsed. The words no longer fit beside the
                                // note, but "held by someone" still has to read,
                                // so it degrades to a dot rather than vanishing.
                                // Capped against the note's shortest side by the
                                // same rule the resize grip uses — screen-constant
                                // alone would grow the dot until it covered a note
                                // that is 6 screen px wide.
                                class="pointer-events-none absolute z-10 rounded-full bg-darius-purple-bright shadow"
                                title={`${name()} is editing`}
                                style={{
                                    top: `${badgeInsetPx()}px`,
                                    right: `${badgeInsetPx()}px`,
                                    width: `${dotSizePx()}px`,
                                    height: `${dotSizePx()}px`
                                }}
                            />
                        }
                    >
                        <div
                            class="pointer-events-none absolute z-10 whitespace-nowrap rounded bg-darius-purple text-darius-text-primary shadow"
                            style={{
                                top: `${badgeInsetPx()}px`,
                                right: `${badgeInsetPx()}px`,
                                "font-size": `${badgeTextPx()}px`,
                                "line-height": "1.4",
                                padding: `${badgeTextPx() * 0.2}px ${badgeTextPx() * 0.5}px`
                            }}
                        >
                            {name()} is editing
                        </div>
                    </Show>
                )}
            </Show>
            {/* The clipping box the ROOT used to be, and the flex column the
                content below is written against.

                It exists because the anchor dots straddle the border: an
                `overflow-hidden` root cuts each of them in half. `inset-0`
                resolves to the padding box — the same box the content occupied
                when it was the root's flex children — so this is a pure
                re-parenting and the layout is unchanged. */}
            <div class="absolute inset-0 flex flex-col overflow-hidden rounded-md">
                {/* Zoom-collapse face (design §4): when the text collapses, the note
                    renders its champions — unique, first-appearance order, DERIVED from
                    the tokens rather than stored. The strip's old geometry: flex-wrap,
                    gap, clip with the box, no scrolling (D7's wheel argument holds).
                    Editing exemption mirrors the text block's below: while the textarea
                    is up, the text (and its tokens) are the face. */}
                <Show when={props.isTextCollapsed() && !isEditing() && !isTextFocused()}>
                    <div class="pointer-events-none flex shrink-0 flex-wrap gap-1 overflow-hidden px-2 pt-2">
                        <For each={uniqueChampions(segments())}>
                            {(champion) => (
                                <ChampionPortrait
                                    src={champion.img}
                                    alt={champion.name}
                                    title={champion.name}
                                    // pointer-events-auto: the parent opts out so the cluster
                                    // never blocks the note surface, but title-on-hover needs
                                    // the icons themselves to receive events (same treatment
                                    // as the inline icons in SegmentedText).
                                    class="pointer-events-auto h-8 w-8 rounded"
                                />
                            )}
                        </For>
                    </div>
                </Show>

                {/* Collapsed to a bare colour block below the legibility floor
                (design §4). The surface keeps painting its colour and the
                champion strip below still renders — those read the note's
                presence and category at a glance, which is the whole
                affordance; the text at that size is a smear.

                ⚠️ Editing is EXEMPT, and deliberately so. Unmounting a focused
                textarea does not reliably fire `blur`, and `commitText` runs on
                blur — so collapsing mid-edit would drop whatever the user had
                typed. That is the same class of silent-loss bug as the
                draft-rename regression this component's commit path already
                carries a comment about. Zooming out far enough to collapse
                while editing is rare; losing the edit when it happens is not
                acceptable, and the exemption costs one condition.

                Because the size is STORED, this is paint-only and can never
                reflow anything. */}
                <Show when={!props.isTextCollapsed() || isEditing() || isTextFocused()}>
                    <Show
                        when={isEditing() || isTextFocused()}
                        fallback={
                            <div
                                // `min-h-0 flex-1`, NOT `h-full`: the clipping box
                                // above is a flex column and the strip is its FIRST
                                // row (it was the ROOT until the anchor dots needed
                                // to escape the root's clip). `h-full` makes
                                // this child consume the whole content box, so the strip
                                // gets squeezed out past the note's border and never
                                // renders inside the frame. Still true with the strip
                                // above — `h-full` overflows the column either way.
                                class="pointer-events-none min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words p-2 text-darius-text-primary"
                                style={{
                                    "font-size": `${fontPx()}px`,
                                    "line-height": "1.25",
                                    // Ellipsis/fade at rest (D7). An inner scroll
                                    // container was rejected: a scrollable element
                                    // inside a scale()d world layer fights canvas zoom
                                    // for wheel events, and hides content from a view
                                    // whose whole purpose is seeing everything at once.
                                    "mask-image":
                                        "linear-gradient(to bottom, black calc(100% - 1.5em), transparent 100%)"
                                }}
                            >
                                <SegmentedText segments={segments()} />
                            </div>
                        }
                    >
                        <textarea
                            ref={textareaRef}
                            value={textSignal()}
                            disabled={!props.canEdit()}
                            // `readOnly`, NOT `disabled`, and only for the LOCK
                            // — the two say different things. No edit permission
                            // is a hard fact about this user; a lock is a HINT
                            // that someone else is typing, and the design (D12)
                            // is explicit that it may never block a write. A
                            // disabled textarea also cannot fire `blur`, and
                            // `commitText` runs on blur, so disabling on a lock
                            // arriving mid-edit would drop what was typed.
                            readOnly={Boolean(props.lockedByName())}
                            class="annotation-editor-surface h-full w-full resize-none bg-transparent p-2 text-darius-text-primary outline-none"
                            style={{
                                "font-size": `${fontPx()}px`,
                                "line-height": "1.25"
                            }}
                            onFocus={() => setIsTextFocused(true)}
                            onInput={(e) => {
                                if (insertSelection) {
                                    insertSelection = null;
                                    props.onCloseInsertPicker();
                                }
                                setTextSignal(e.currentTarget.value);
                                setCaretPos(e.currentTarget.selectionStart);
                            }}
                            onClick={(e) => setCaretPos(e.currentTarget.selectionStart)}
                            onKeyUp={(e) => setCaretPos(e.currentTarget.selectionStart)}
                            onContextMenu={(e) => {
                                // §3: right-click is pan everywhere on the canvas EXCEPT
                                // inside a focused annotation editor. preventDefault/
                                // stopPropagation run UNCONDITIONALLY: a locked (readOnly)
                                // editor gets no picker, but it must not get the native
                                // menu either — the smoke contract is "nothing opens".
                                e.preventDefault();
                                e.stopPropagation();
                                if (!props.canEdit() || props.lockedByName()) return;
                                const el = e.currentTarget;
                                // queueMicrotask: on Linux/X11 `contextmenu` fires at
                                // MOUSEDOWN time (Canvas.tsx's aux-pan comment), i.e.
                                // before the browser has moved the caret to the click
                                // point — a synchronous read captures the caret's
                                // PREVIOUS position. One microtask later both orders
                                // agree.
                                // `untrack`: the microtask is a detached
                                // continuation of this event handler, not a
                                // tracked scope — the reads are deliberate
                                // one-shots.
                                queueMicrotask(() =>
                                    untrack(() => {
                                        insertSelection = {
                                            start: el.selectionStart,
                                            end: el.selectionEnd
                                        };
                                        props.onOpenInsertPicker(props.annotation.id);
                                    })
                                );
                            }}
                            onKeyDown={(e) => {
                                if (isMentionOpen()) {
                                    if (e.key === "ArrowDown") {
                                        e.preventDefault();
                                        setMentionArmed(true);
                                        setMentionHighlight((i) =>
                                            Math.min(i + 1, mentionMatches().length - 1)
                                        );
                                        return;
                                    }
                                    if (e.key === "ArrowUp") {
                                        e.preventDefault();
                                        setMentionArmed(true);
                                        setMentionHighlight((i) => Math.max(i - 1, 0));
                                        return;
                                    }
                                    if (e.key === "Enter") {
                                        const m = mention();
                                        // Empty query + no arrow engagement: Enter
                                        // keeps meaning newline — fall through past
                                        // the mention branch.
                                        if (m && (m.query !== "" || mentionArmed())) {
                                            e.preventDefault();
                                            const pick =
                                                mentionMatches()[mentionHighlight()];
                                            if (pick) acceptMention(pick.name);
                                            return;
                                        }
                                    }
                                    if (e.key === "Escape") {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        const m = mention();
                                        if (m) {
                                            setDismissedMention({
                                                start: m.start,
                                                query: m.query
                                            });
                                        }
                                        return;
                                    }
                                }
                                // Enter inserts a newline: the text is multi-line by
                                // design (D6, `\n` preserved). Escape commits, matching
                                // the draft-name field rather than the team-name field.
                                if (e.key === "Escape") {
                                    e.stopPropagation();
                                    e.currentTarget.blur();
                                }
                            }}
                            onBlur={() => {
                                // An open insert session means the picker took focus;
                                // the commit runs when the session resolves (insert
                                // effect or close effect below).
                                if (insertSelection) return;
                                commitText();
                            }}
                        />
                        {/* §5: auto-fit measures the DISPLAY rendering. Same
                            width (inset-x-0 inside the same clipping box), same
                            padding/font/wrap classes as the display div, same
                            SegmentedText renderer — so the measured wrap is
                            the wrap the note shows at rest. Invisible, never
                            interactive. */}
                        <div
                            ref={measureRef}
                            aria-hidden="true"
                            class="invisible absolute inset-x-0 top-0 whitespace-pre-wrap break-words p-2"
                            style={{
                                "font-size": `${fontPx()}px`,
                                "line-height": "1.25"
                            }}
                        >
                            <SegmentedText segments={parseAnnotationText(textSignal())} />
                        </div>
                    </Show>
                </Show>
            </div>

            {/* §3: anchored to the editor box, not the caret — caret mirroring inside
                a scale()d world layer was explicitly rejected. Below the note, unless
                the note's bottom is too close to the viewport's; world-space, so it
                zooms with the note like the text does. mousedown preventDefault keeps
                the textarea focused — this popover must never trigger the blur commit. */}
            <Show when={isMentionOpen()}>
                <div
                    // `annotation-editor-surface`: the same class the textarea carries —
                    // onAuxMouseDown's exemption (Task 5) keeps right-drag on the
                    // popover from panning the canvas (that listener is capture-phase,
                    // so stopPropagation here could not). z-20 is scoped to this note's
                    // stacking context; a later-rendered overlapping note can paint
                    // over the popover — accepted for a transient editor affordance.
                    class="annotation-editor-surface absolute left-0 z-20 overflow-hidden rounded-md border border-darius-purple-bright bg-slate-900 shadow-lg"
                    style={{
                        ...(mentionOpensUpward()
                            ? { bottom: "100%", "margin-bottom": "4px" }
                            : { top: "100%", "margin-top": "4px" }),
                        "min-width": `${Math.max(renderWidth(), 180)}px`,
                        "font-size": `${fontPx()}px`,
                        "line-height": "1.25"
                    }}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                    onContextMenu={(e) => {
                        // Without this, a right-click on the popover resolves through
                        // dispatchContextMenu's `.canvas-annotation` branch and opens
                        // the annotation menu on top of the list.
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                >
                    <For each={mentionMatches()}>
                        {(champion, index) => (
                            <button
                                type="button"
                                class="flex w-full items-center gap-2 px-2 py-1 text-left text-darius-text-primary"
                                classList={{
                                    "bg-darius-purple": index() === mentionHighlight()
                                }}
                                onClick={() => acceptMention(champion.name)}
                                onMouseEnter={() => setMentionHighlight(index())}
                            >
                                <ChampionPortrait
                                    src={champion.img}
                                    alt={champion.name}
                                    class="h-[1.2em] w-[1.2em] rounded-sm"
                                />
                                <span class="truncate">{champion.name}</span>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
            <Show when={props.canEdit() && !props.isConnectionMode && props.isSelected()}>
                <ResizeGrip
                    corner="sw"
                    size={resizeHandleWorldPx(
                        props.zoom(),
                        Math.min(renderWidth(), renderHeight())
                    )}
                    onMouseDown={(e) => handleResizeMouseDown(e, "sw")}
                />
                <ResizeGrip
                    corner="se"
                    // Screen-constant and capped, via the shared rule the
                    // Group's grip uses. The old `screenConstantPx(12, …)` was
                    // constant on screen but only 12px of it, and — uncapped —
                    // resolved to 120 WORLD px at MIN_ZOOM, which is more than
                    // a minimum 56x40 note is, so the handle covered the note
                    // and swallowed its drag.
                    size={resizeHandleWorldPx(
                        props.zoom(),
                        Math.min(renderWidth(), renderHeight())
                    )}
                    onMouseDown={(e) => handleResizeMouseDown(e, "se")}
                />
            </Show>
            <Show when={props.isConnectionMode}>
                <AnchorPoints
                    onSelectAnchor={(anchorType) =>
                        props.onAnchorClick(props.annotation.id, anchorType)
                    }
                    width={renderWidth}
                    height={renderHeight}
                    zoom={props.zoom()}
                    selected={() => props.connectionSource() === props.annotation.id}
                    sourceAnchor={props.sourceAnchor}
                />
            </Show>
        </div>
    );
};

export default CanvasAnnotation;
