export type CardLayout =
    | "vertical"
    | "horizontal"
    | "wide"
    | "wide-draft-order"
    | "compact"
    | "draft-order";

const horizontalPickOrder = [
    0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 5, 6, 7, 8, 9
];

const verticalPickOrder = [
    0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 5, 6, 7, 8, 9, 15, 16, 17, 18, 19
];

const draftOrderPickOrder = [
    0, 1, 2, 10, 11, 12, 3, 4, 13, 14, 5, 6, 7, 15, 16, 17, 8, 9, 18, 19
];

export const getPickOrderForLayout = (cardLayout: CardLayout) => {
    switch (cardLayout) {
        case "horizontal":
            return horizontalPickOrder;
        case "wide-draft-order":
        case "draft-order":
            return draftOrderPickOrder;
        default:
            return verticalPickOrder;
    }
};

const directPickIndexShorthand = [
    "B1",
    "B2",
    "B3",
    "B4",
    "B5",
    "B1",
    "B2",
    "B3",
    "B4",
    "B5",
    "P1",
    "P2",
    "P3",
    "P4",
    "P5",
    "P1",
    "P2",
    "P3",
    "P4",
    "P5"
];

export const getIndexToShorthandForLayout = (_cardLayout: CardLayout) =>
    directPickIndexShorthand;

export const draftOrderTeam1Sections = [
    { key: "team1-bans-1", label: "Bans", indices: [0, 1, 2] },
    { key: "team1-picks-1", label: "Picks", indices: [10, 11, 12] },
    { key: "team1-bans-2", label: "Bans", indices: [3, 4] },
    { key: "team1-picks-2", label: "Picks", indices: [13, 14] }
] as const;

export const draftOrderTeam2Sections = [
    { key: "team2-bans-1", label: "Bans", indices: [5, 6, 7] },
    { key: "team2-picks-1", label: "Picks", indices: [15, 16, 17] },
    { key: "team2-bans-2", label: "Bans", indices: [8, 9] },
    { key: "team2-picks-2", label: "Picks", indices: [18, 19] }
] as const;

type NavigationAxis = "horizontal" | "vertical";
type NavigationDirection = "forward" | "backward";
type SlotCoordinate = { x: number; y: number };

const verticalRowOrder = [
    0, 5, 1, 6, 2, 7, 3, 8, 4, 9, 10, 15, 11, 16, 12, 17, 13, 18, 14, 19
];

const verticalColumnOrder = [
    0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 5, 6, 7, 8, 9, 15, 16, 17, 18, 19
];

const horizontalRowOrder = [
    0, 10, 15, 5, 1, 11, 16, 6, 2, 12, 17, 7, 3, 13, 18, 8, 4, 14, 19, 9
];

const horizontalColumnOrder = [
    0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 5, 6, 7, 8, 9
];

const draftOrderRowOrder = [
    0, 5, 1, 6, 2, 7, 10, 15, 11, 16, 12, 17, 3, 8, 4, 9, 13, 18, 14, 19
];

const draftOrderColumnOrder = [
    0, 1, 2, 10, 11, 12, 3, 4, 13, 14, 5, 6, 7, 15, 16, 17, 8, 9, 18, 19
];

const compactBanTeam1Order = [0, 1, 2, 3, 4, 10];
const compactBanTeam2Order = [5, 6, 7, 8, 9, 15];

const verticalSlotCoordinates: Record<number, SlotCoordinate> = {
    0: { x: 0, y: 0 },
    1: { x: 0, y: 1 },
    2: { x: 0, y: 2 },
    3: { x: 0, y: 3 },
    4: { x: 0, y: 4 },
    10: { x: 0, y: 5 },
    11: { x: 0, y: 6 },
    12: { x: 0, y: 7 },
    13: { x: 0, y: 8 },
    14: { x: 0, y: 9 },
    5: { x: 1, y: 0 },
    6: { x: 1, y: 1 },
    7: { x: 1, y: 2 },
    8: { x: 1, y: 3 },
    9: { x: 1, y: 4 },
    15: { x: 1, y: 5 },
    16: { x: 1, y: 6 },
    17: { x: 1, y: 7 },
    18: { x: 1, y: 8 },
    19: { x: 1, y: 9 }
};

const horizontalSlotCoordinates: Record<number, SlotCoordinate> = {
    0: { x: 0, y: 0 },
    1: { x: 0, y: 1 },
    2: { x: 0, y: 2 },
    3: { x: 0, y: 3 },
    4: { x: 0, y: 4 },
    10: { x: 1, y: 0 },
    11: { x: 1, y: 1 },
    12: { x: 1, y: 2 },
    13: { x: 1, y: 3 },
    14: { x: 1, y: 4 },
    15: { x: 2, y: 0 },
    16: { x: 2, y: 1 },
    17: { x: 2, y: 2 },
    18: { x: 2, y: 3 },
    19: { x: 2, y: 4 },
    5: { x: 3, y: 0 },
    6: { x: 3, y: 1 },
    7: { x: 3, y: 2 },
    8: { x: 3, y: 3 },
    9: { x: 3, y: 4 }
};

const draftOrderSlotCoordinates: Record<number, SlotCoordinate> = {
    0: { x: 0, y: 0 },
    1: { x: 0, y: 1 },
    2: { x: 0, y: 2 },
    10: { x: 0, y: 3 },
    11: { x: 0, y: 4 },
    12: { x: 0, y: 5 },
    3: { x: 0, y: 6 },
    4: { x: 0, y: 7 },
    13: { x: 0, y: 8 },
    14: { x: 0, y: 9 },
    5: { x: 1, y: 0 },
    6: { x: 1, y: 1 },
    7: { x: 1, y: 2 },
    15: { x: 1, y: 3 },
    16: { x: 1, y: 4 },
    17: { x: 1, y: 5 },
    8: { x: 1, y: 6 },
    9: { x: 1, y: 7 },
    18: { x: 1, y: 8 },
    19: { x: 1, y: 9 }
};

const compactSlotCoordinates: Record<number, SlotCoordinate> = {
    0: { x: 0, y: 0 },
    1: { x: 1, y: 0 },
    2: { x: 2, y: 0 },
    3: { x: 3, y: 0 },
    4: { x: 4, y: 0 },
    5: { x: 6, y: 0 },
    6: { x: 7, y: 0 },
    7: { x: 8, y: 0 },
    8: { x: 9, y: 0 },
    9: { x: 10, y: 0 },
    10: { x: 2, y: 1 },
    11: { x: 2, y: 2 },
    12: { x: 2, y: 3 },
    13: { x: 2, y: 4 },
    14: { x: 2, y: 5 },
    15: { x: 8, y: 1 },
    16: { x: 8, y: 2 },
    17: { x: 8, y: 3 },
    18: { x: 8, y: 4 },
    19: { x: 8, y: 5 }
};

const getCircularIndex = (
    currentIndex: number,
    sequence: readonly number[],
    direction: NavigationDirection
) => {
    const position = sequence.indexOf(currentIndex);
    if (position === -1) return currentIndex;

    const delta = direction === "forward" ? 1 : -1;
    const nextPosition = (position + delta + sequence.length) % sequence.length;
    return sequence[nextPosition];
};

export const getNextCanvasSlotIndex = (
    cardLayout: CardLayout,
    currentIndex: number,
    axis: NavigationAxis,
    direction: NavigationDirection
) => {
    if (cardLayout === "compact" && currentIndex >= 0 && currentIndex <= 9) {
        const banOrder =
            currentIndex <= 4 ? compactBanTeam1Order : compactBanTeam2Order;
        return getCircularIndex(currentIndex, banOrder, direction);
    }

    switch (cardLayout) {
        case "horizontal":
            return axis === "horizontal"
                ? getCircularIndex(currentIndex, horizontalRowOrder, direction)
                : getCircularIndex(currentIndex, horizontalColumnOrder, direction);
        case "draft-order":
        case "wide-draft-order":
            return axis === "horizontal"
                ? getCircularIndex(currentIndex, draftOrderRowOrder, direction)
                : getCircularIndex(currentIndex, draftOrderColumnOrder, direction);
        case "vertical":
        case "wide":
        case "compact":
        default:
            return axis === "horizontal"
                ? getCircularIndex(currentIndex, verticalRowOrder, direction)
                : getCircularIndex(currentIndex, verticalColumnOrder, direction);
    }
};

const getSlotCoordinatesForLayout = (cardLayout: CardLayout) => {
    switch (cardLayout) {
        case "horizontal":
            return horizontalSlotCoordinates;
        case "draft-order":
        case "wide-draft-order":
            return draftOrderSlotCoordinates;
        case "compact":
            return compactSlotCoordinates;
        case "vertical":
        case "wide":
        default:
            return verticalSlotCoordinates;
    }
};

const moveWithinLane = (
    currentIndex: number,
    lane: number[],
    direction: NavigationDirection
) => {
    const orderedLane = [...lane];
    return getCircularIndex(currentIndex, orderedLane, direction);
};

export const getDirectionalCanvasSlotIndex = (
    cardLayout: CardLayout,
    currentIndex: number,
    axis: NavigationAxis,
    direction: NavigationDirection
) => {
    const coordinates = getSlotCoordinatesForLayout(cardLayout);
    const currentCoordinate = coordinates[currentIndex];

    if (!currentCoordinate) return currentIndex;

    const slotEntries = Object.entries(coordinates).map(([index, coordinate]) => ({
        index: Number(index),
        coordinate
    }));

    const sameLane = slotEntries
        .filter(({ coordinate }) =>
            axis === "horizontal"
                ? coordinate.y === currentCoordinate.y
                : coordinate.x === currentCoordinate.x
        )
        .sort((a, b) =>
            axis === "horizontal"
                ? a.coordinate.x - b.coordinate.x
                : a.coordinate.y - b.coordinate.y
        )
        .map(({ index }) => index);

    if (sameLane.length > 1) {
        return moveWithinLane(currentIndex, sameLane, direction);
    }

    const isForward = direction === "forward";
    const directionalCandidates = slotEntries
        .filter(({ index }) => index !== currentIndex)
        .map(({ index, coordinate }) => {
            const primaryDelta =
                axis === "horizontal"
                    ? coordinate.x - currentCoordinate.x
                    : coordinate.y - currentCoordinate.y;
            const secondaryDelta =
                axis === "horizontal"
                    ? Math.abs(coordinate.y - currentCoordinate.y)
                    : Math.abs(coordinate.x - currentCoordinate.x);

            return { index, coordinate, primaryDelta, secondaryDelta };
        });

    const inDirection = directionalCandidates.filter(({ primaryDelta }) =>
        isForward ? primaryDelta > 0 : primaryDelta < 0
    );

    const targetCandidates =
        inDirection.length > 0
            ? inDirection.sort((a, b) => {
                  const primaryDistanceDiff =
                      Math.abs(a.primaryDelta) - Math.abs(b.primaryDelta);
                  if (primaryDistanceDiff !== 0) return primaryDistanceDiff;

                  const secondaryDistanceDiff =
                      a.secondaryDelta - b.secondaryDelta;
                  if (secondaryDistanceDiff !== 0) return secondaryDistanceDiff;

                  return a.index - b.index;
              })
            : directionalCandidates.sort((a, b) => {
                  const primaryCoordinateDiff =
                      axis === "horizontal"
                          ? isForward
                              ? a.coordinate.x - b.coordinate.x
                              : b.coordinate.x - a.coordinate.x
                          : isForward
                            ? a.coordinate.y - b.coordinate.y
                            : b.coordinate.y - a.coordinate.y;
                  if (primaryCoordinateDiff !== 0) return primaryCoordinateDiff;

                  const secondaryDistanceDiff =
                      a.secondaryDelta - b.secondaryDelta;
                  if (secondaryDistanceDiff !== 0) return secondaryDistanceDiff;

                  return a.index - b.index;
              });

    return targetCandidates[0]?.index ?? currentIndex;
};

export const DEFAULT_CARD_LAYOUT: CardLayout = "wide";

export const layoutOptions: Array<{
    value: CardLayout;
    label: string;
    description: string;
}> = [
    {
        value: "wide",
        label: "Wide",
        description:
            "Tall full-art slots with separate bans and picks sections for each team"
    },
    {
        value: "wide-draft-order",
        label: "Wide Draft Order",
        description:
            "Wide full-art slots ordered by the actual ban and pick sequence"
    },
    {
        value: "draft-order",
        label: "Draft Order",
        description: "Two team columns ordered by the actual ban and pick sequence"
    },
    {
        value: "vertical",
        label: "Vertical",
        description: "Bans stacked above picks in two side-by-side team columns"
    },
    {
        value: "horizontal",
        label: "Horizontal",
        description: "Four columns with team 1 bans and picks, then team 2 picks and bans"
    },
    {
        value: "compact",
        label: "Compact",
        description: "Small ban icons above full-width pick rows for both teams"
    }
];
