/* Reviewed semantic policy for contextual legal-reference parsing. */
window.INA_SEARCH_LEGAL_REFERENCE_POLICY = {
  "schemaVersion": 1,
  "reviewedAt": "2026-08-21",
  "interpretation": "scope-defined-act",
  "description": "A bare reference to 'the Act' is resolved only inside a CFR scope supported by the cited definition or express incorporation below. Scopes without an explicit authority continue to mean the Immigration and Nationality Act.",
  "scopes": [
    {
      "id": "title-8-chapter-i",
      "match": { "title": "8", "chapter": "I" },
      "basis": {
        "citation": "8 CFR 1.2",
        "sectionId": "8:1.2",
        "excerpt": "Act or INA means the Immigration and Nationality Act, as amended.",
        "sourceUrl": "https://www.ecfr.gov/current/title-8/part-1/section-1.2"
      }
    },
    {
      "id": "title-8-chapter-v",
      "match": { "title": "8", "chapter": "V" },
      "basis": {
        "citation": "8 CFR 1001.1(b)",
        "sectionId": "8:1001.1",
        "excerpt": "(b) The term Act means the Immigration and Nationality Act, as amended.",
        "sourceUrl": "https://www.ecfr.gov/current/title-8/part-1001/section-1001.1"
      }
    },
    {
      "id": "title-20-part-655",
      "match": { "title": "20", "parts": ["655"] },
      "basis": {
        "citation": "20 CFR 655.5",
        "sectionId": "20:655.5",
        "excerpt": "Act means the Immigration and Nationality Act or INA, as amended, 8 U.S.C. 1101 et seq.",
        "sourceUrl": "https://www.ecfr.gov/current/title-20/part-655/section-655.5"
      }
    },
    {
      "id": "title-20-part-656",
      "match": { "title": "20", "parts": ["656"] },
      "basis": {
        "citation": "20 CFR 656.2(a)",
        "sectionId": "20:656.2",
        "excerpt": "(a) Description of the Act. The Act (8 U.S.C. 1101 et seq.) regulates the admission of aliens into the United States.",
        "sourceUrl": "https://www.ecfr.gov/current/title-20/part-656/section-656.2"
      }
    },
    {
      "id": "title-20-part-416",
      "match": { "title": "20", "parts": ["416"] },
      "authority": {
        "family": "usc",
        "title": "42",
        "actName": "Social Security Act",
        "officialUrl": "https://www.ssa.gov/OP_Home/ssact/ssact-toc.htm",
        "sectionMap": {
          "202": "402",
          "204": "404",
          "205": "405",
          "206": "406",
          "208": "408",
          "215": "415",
          "223": "423",
          "228": "428",
          "1102": "1302",
          "1106": "1306",
          "1110": "1310",
          "1127": "1320a-6",
          "1128": "1320a-7",
          "1129": "1320a-8",
          "1611": "1382",
          "1613": "1382b",
          "1614": "1382c",
          "1615": "1382d",
          "1616": "1382e",
          "1618": "1382g",
          "1619": "1382h",
          "1631": "1383",
          "1632": "1383a",
          "1902": "1396a",
          "1915": "1396n",
          "1917": "1396p"
        }
      },
      "basis": {
        "citation": "20 CFR 416.120",
        "sectionId": "20:416.120",
        "excerpt": "The Act means the Social Security Act as amended (42 U.S.C. Chap. 7).",
        "sourceUrl": "https://www.ecfr.gov/current/title-20/part-416/section-416.120"
      }
    },
    {
      "id": "title-22-parts-40-42",
      "match": { "title": "22", "parts": ["40", "41", "42"] },
      "basis": {
        "citation": "22 CFR 40.1",
        "sectionId": "22:40.1",
        "excerpt": "The following definitions supplement definitions contained in the Immigration and Nationality Act (INA). As used in the regulations in parts 40, 41, 42, 43 and 45 of this subchapter, the term:",
        "sourceUrl": "https://www.ecfr.gov/current/title-22/part-40/section-40.1"
      }
    },
    {
      "id": "title-29-part-501",
      "match": { "title": "29", "parts": ["501"] },
      "basis": {
        "citation": "29 CFR 501.3",
        "sectionId": "29:501.3",
        "excerpt": "Act. The Immigration and Nationality Act, as amended (INA), 8 U.S.C. 1101 et seq.",
        "sourceUrl": "https://www.ecfr.gov/current/title-29/part-501/section-501.3"
      }
    },
    {
      "id": "title-29-part-502",
      "match": { "title": "29", "parts": ["502"] },
      "basis": {
        "citation": "29 CFR 502.10",
        "sectionId": "29:502.10",
        "excerpt": "INA/Act means the Immigration and Nationality Act, as amended, 8 U.S.C. 1101 et seq.",
        "sourceUrl": "https://www.ecfr.gov/current/title-29/part-502/section-502.10"
      }
    },
    {
      "id": "title-29-part-503",
      "match": { "title": "29", "parts": ["503"] },
      "basis": {
        "citation": "29 CFR 503.4",
        "sectionId": "29:503.4",
        "excerpt": "Act means the Immigration and Nationality Act or INA, as amended, 8 U.S.C. 1101 et seq.",
        "sourceUrl": "https://www.ecfr.gov/current/title-29/part-503/section-503.4"
      }
    },
    {
      "id": "title-45-part-400",
      "match": { "title": "45", "parts": ["400"] },
      "basis": {
        "citation": "45 CFR 400.2",
        "sectionId": "45:400.2",
        "excerpt": "Act means the Immigration and Nationality Act.",
        "sourceUrl": "https://www.ecfr.gov/current/title-45/part-400/section-400.2"
      }
    }
  ]
};
