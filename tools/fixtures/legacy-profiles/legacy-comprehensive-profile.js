/*
 * Synthetic AuthoritySearch three-file profile.
 * Test data only: contains no student information or controlled course content.
 */
window.AUTHORITY_SEARCH_PROFILE = {
  "schemaVersion": 1,
  "profileId": "synthetic-legacy-comprehensive",
  "createdAt": "2026-07-30T12:00:00.000Z",
  "updatedAt": "2026-07-31T18:45:00.000Z",
  "corpusVersionSeen": "2026.07.31-10",
  "unlocks": [
    {
      "groupId": "obsolete-source-identification-group",
      "groupRevision": 1,
      "normalizedResponse": "obsolete test response",
      "unlockedAt": "2026-07-30T13:00:00.000Z"
    }
  ],
  "visaSummaryUnlocks": [
    {
      "visaId": "visa-h-1b",
      "challengeRevision": 4,
      "unlockedAt": "2026-07-31T12:00:00.000Z",
      "corpusVersion": "2026.07.31-10"
    },
    {
      "visaId": "visa-f-1",
      "challengeRevision": 4,
      "unlockedAt": "2026-07-31T12:05:00.000Z",
      "corpusVersion": "2026.07.31-10"
    }
  ],
  "visaChallengeLockouts": [
    {
      "visaId": "visa-a-1",
      "challengeRevision": 4,
      "lockedUntil": "2099-01-01T00:00:00.000Z"
    },
    {
      "visaId": "visa-f-1",
      "challengeRevision": 4,
      "lockedUntil": "2000-01-01T00:00:00.000Z"
    }
  ],
  "visaFactUnlocks": [
    {
      "factId": "visa-h-1b:visa-row-020:eos",
      "challengeRevision": 5,
      "unlockedAt": "2026-07-31T12:10:00.000Z",
      "corpusVersion": "2026.07.31-10"
    },
    {
      "factId": "visa-h-2a:visa-row-023:maximum_stay",
      "challengeRevision": 4,
      "unlockedAt": "2026-07-31T12:15:00.000Z",
      "corpusVersion": "2026.07.31-10"
    }
  ],
  "visaFactChallengeLockouts": [
    {
      "factId": "visa-a-1:visa-row-001:cos",
      "challengeRevision": 5,
      "lockedUntil": "2099-01-01T00:00:00.000Z"
    },
    {
      "factId": "visa-f-1:visa-row-016:eos",
      "challengeRevision": 5,
      "lockedUntil": "2000-01-01T00:00:00.000Z"
    }
  ],
  "notes": [
    {
      "id": "course-note:day:2:4",
      "title": "W2D4",
      "body": "A day note with two lines.\nSecond line: INA § 101(a)(15)(H).",
      "tags": ["statutes", "day-note"],
      "links": [
        {
          "kind": "usc",
          "id": "usc:8:1101-a-15-h",
          "label": "8 U.S.C. 1101(a)(15)(H)",
          "citation": "8 U.S.C. 1101(a)(15)(H)"
        },
        {
          "kind": "visa",
          "id": "visa:visa-h-1b",
          "label": "H-1B"
        }
      ],
      "createdAt": "2026-07-31T14:00:00.000Z",
      "updatedAt": "2026-07-31T14:10:00.000Z",
      "coursePlacement": { "kind": "day", "week": 2, "day": 4 }
    },
    {
      "id": "course-note:module:block-2:module-3",
      "title": "Block 2 Module 3",
      "body": "Synthetic module note containing quotes: \"alien\" and apostrophe: alien's.",
      "tags": ["module-note"],
      "links": [],
      "createdAt": "2026-07-31T15:00:00.000Z",
      "updatedAt": "2026-07-31T15:00:00.000Z",
      "coursePlacement": { "kind": "module", "blockId": "block-2", "moduleId": "module-3" }
    },
    {
      "id": "classification-note:visa-h-1b",
      "title": "Personal notes for H-1B",
      "body": "Classification note with parser-like text: }; and </script>, ampersand & Unicode — café 🚀.",
      "tags": ["classification"],
      "links": [
        {
          "kind": "cfr",
          "id": "cfr:8:214.2:h",
          "label": "8 CFR 214.2(h)",
          "url": "https://www.ecfr.gov/current/title-8/section-214.2"
        }
      ],
      "classificationNoteVisaId": "visa-h-1b",
      "createdAt": "2026-07-31T16:00:00.000Z",
      "updatedAt": "2026-07-31T16:05:00.000Z"
    },
    {
      "id": "old-manual-note",
      "title": "Older uncategorized note",
      "body": "This older note has no course placement.",
      "tags": [],
      "links": [],
      "createdAt": "2026-07-31T17:00:00.000Z",
      "updatedAt": "2026-07-31T17:00:00.000Z"
    }
  ],
  "courseStructure": {
    "blocks": [
      {
        "id": "block-1",
        "number": 1,
        "title": "Synthetic Block One",
        "modules": [
          { "id": "module-1", "number": 1, "title": "Synthetic Module One" },
          { "id": "module-2", "number": 2, "title": "Synthetic Module Two" }
        ]
      },
      {
        "id": "block-2",
        "number": 2,
        "title": "Synthetic Block Two",
        "modules": [
          { "id": "module-3", "number": 3, "title": "Synthetic Module Three" }
        ]
      }
    ]
  },
  "preferences": {
    "theme": "dark",
    "resultFilter": "notes",
    "compactResults": true,
    "quizCursorKey": "fact:visa-h-1b:visa-row-020:eos",
    "quizClassification": "H"
  }
};
