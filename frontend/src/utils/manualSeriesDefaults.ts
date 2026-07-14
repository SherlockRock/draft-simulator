export const getManualSeriesGameDefaults = (
    seriesIndex: number
): { blueSideTeam: 1 | 2; firstPick: "blue" } => ({
    blueSideTeam: seriesIndex % 2 === 0 ? 1 : 2,
    firstPick: "blue"
});
