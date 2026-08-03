/*
 * AuthoritySearch local profile
 *
 * Keep this file beside AuthoritySearch.html. AuthoritySearch can update it
 * after you connect the file once, or download a replacement when direct
 * file writing is unavailable. Do not place sensitive or student-identifying
 * information here unless your environment permits it.
 *
 * CONFIGURING BLOCKS AND MODULES ON THE WORK NETWORK
 * Edit only the "courseStructure" object below while AuthoritySearch is closed,
 * then save this file and reopen AuthoritySearch.html. Use this shape:
 *
 * "courseStructure": {
 *   "blocks": [
 *     {
 *       "id": "block-1",
 *       "number": 1,
 *       "title": "Your block title",
 *       "modules": [
 *         { "id": "module-1", "number": 1, "title": "Your module title" }
 *       ]
 *     }
 *   ]
 * }
 *
 * Copy a whole block or module object to add another. Keep every block id unique;
 * keep module ids unique within their block. IDs are permanent links used by notes,
 * so do not rename or reuse an id after a note has been assigned to it. "number" is
 * a positive whole number used for ordering and display. "title" may be blank. Keep
 * the quotation marks and commas valid JavaScript/JSON. The public profile contains
 * no block or module titles; add controlled labels only in the authorized environment.
 */
window.AUTHORITY_SEARCH_PROFILE = {
  "schemaVersion": 1,
  "profileId": "b28a83da-7f4a-4b1d-91cf-7bd72b7b3372",
  "createdAt": "2026-07-30T00:00:00.000Z",
  "updatedAt": null,
  "corpusVersionSeen": "2026.08.02-7",
  "visaSummaryUnlocks": [],
  "visaChallengeLockouts": [],
  "visaFactUnlocks": [],
  "visaFactChallengeLockouts": [],
  "resourceUnlocks": [],
  "notes": [],
  "courseStructure": {
    "blocks": []
  },
  "preferences": {
    "theme": "system",
    "resultFilter": "all",
    "compactResults": false,
    "quizCursorKey": null,
    "quizClassification": "all"
  }
};
