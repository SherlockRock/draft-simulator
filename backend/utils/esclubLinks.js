"use strict";

// Public esclub pages we link out to. Kept apart from services/esclub so the
// canvas payload can build a link without loading the esclub client.
const ESCLUB_SERIE_PAGE = "https://esclub.gg/serie/";

/**
 * The public esclub page of one serie.
 * @param {string} externalId  LeagueSeries.external_id (esclub's id_serie)
 * @returns {string}
 */
const esclubSerieUrl = (externalId) => `${ESCLUB_SERIE_PAGE}${externalId}`;

const ACCEPTED_LINK_EXAMPLE = "https://esclub.gg/serie/<series id>";
const SERIE_LINK =
  /^https?:\/\/(?:www\.)?esclub\.gg\/(?:multimedia\/)?serie\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/[^?#\s]*)?(?:\?[^#\s]*)?(?:#\S*)?$/i;

/**
 * The esclub series link in `text`, or null. Both
 * `esclub.gg/serie/<id>` and `esclub.gg/multimedia/serie/<id>` (http or https, optional www, optional
 * further path, query and fragment) are accepted.
 * @param {unknown} text
 * @returns {{ kind: "serie", id: string } | null}
 */
function parseEsclubUrl(text) {
  if (typeof text !== "string") return null;
  const match = SERIE_LINK.exec(text.trim());
  return match ? { kind: "serie", id: match[1].toLowerCase() } : null;
}

module.exports = { ESCLUB_SERIE_PAGE, esclubSerieUrl, ACCEPTED_LINK_EXAMPLE, parseEsclubUrl };
