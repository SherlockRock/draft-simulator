// The Riot/esclub regions a team or tournament may belong to. One list, shared
// by routes/teams.js, models/Team.js and models/Tournament.js. The database has
// no CHECK on region: the set lives here so adding a region is a code change.
const TEAM_REGIONS = ["na1", "euw1", "eun1", "kr", "br1", "oc1"];

const REGION_SET = new Set(TEAM_REGIONS);

function isValidRegion(value) {
  return typeof value === "string" && REGION_SET.has(value);
}

module.exports = { TEAM_REGIONS, isValidRegion };
