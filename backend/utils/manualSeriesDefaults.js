function getManualSeriesGameDefaults(seriesIndex) {
  return {
    blueSideTeam: seriesIndex % 2 === 0 ? 1 : 2,
    firstPick: "blue",
  };
}

module.exports = { getManualSeriesGameDefaults };
