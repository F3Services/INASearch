/* Synthetic profile containing recoverable legacy values that require normalization. */
window.AUTHORITY_SEARCH_PROFILE = {
  "schemaVersion": 1,
  "profileId": "synthetic-legacy-normalization",
  "createdAt": "2026-07-30T12:00:00.000Z",
  "updatedAt": null,
  "corpusVersionSeen": "2026.07.30-1",
  "visaSummaryUnlocks": [],
  "visaChallengeLockouts": [],
  "visaFactUnlocks": [],
  "visaFactChallengeLockouts": [],
  "notes": [
    {
      "id": "string-number-day",
      "title": "String-number day",
      "body": "Week and day were saved as strings.",
      "tags": [],
      "links": [],
      "coursePlacement": { "kind": "day", "week": "6", "day": "5" }
    },
    {
      "id": "classification-note:visa-f-1",
      "title": "Legacy classification note",
      "body": "The legacy classificationNoteVisaId takes precedence.",
      "tags": [],
      "links": [],
      "classificationNoteVisaId": "visa-f-1",
      "coursePlacement": { "kind": "day", "week": 1, "day": 1 }
    },
    {
      "id": "invalid-placement",
      "title": "Invalid placement",
      "body": "An invalid week/day becomes uncategorized rather than disappearing.",
      "tags": [],
      "links": [],
      "coursePlacement": { "kind": "day", "week": 9, "day": 8 }
    }
  ],
  "courseStructure": {
    "blocks": [
      {
        "id": " duplicate-id ",
        "number": "2",
        "title": "  Trimmed Block  ",
        "modules": [
          { "id": " duplicate-module ", "number": "3", "title": "  Trimmed Module  " },
          { "id": " duplicate-module ", "number": 0, "title": null }
        ]
      },
      {
        "id": " duplicate-id ",
        "number": 0,
        "title": null,
        "modules": []
      }
    ]
  },
  "preferences": {
    "theme": "system",
    "resultFilter": "all",
    "compactResults": false
  }
};
