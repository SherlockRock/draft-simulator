"use strict";

// Public esclub pages we link out to. Kept apart from services/esclub so the
// canvas payload can build a link without loading the esclub client.
const ESCLUB_SERIE_PAGE = "https://esclub.gg/multimedia/serie/";

/**
 * The public esclub page of one serie.
 * @param {string} externalId  LeagueSeries.external_id (esclub's id_serie)
 * @returns {string}
 */
const esclubSerieUrl = (externalId) => `${ESCLUB_SERIE_PAGE}${externalId}`;

module.exports = { ESCLUB_SERIE_PAGE, esclubSerieUrl };
