/* Curated initial-classification form questions supported by approved resources.
 * These mappings intentionally distinguish a direct filing from a derivative
 * classification that relies on a principal's underlying petition. */
window.INA_SEARCH_FORM_QUESTIONS = {
  "schemaVersion": 1,
  "nonimmigrant": [
    {
      "id": "resource-nonimmigrant-form-i-129-direct",
      "revision": "2026-08-02-1",
      "title": "Initial Form I-129 classifications",
      "source": {
        "label": "Form I-129 Instructions, Part 1 - Classifications That Always Require a Petition",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-129instr.pdf",
        "locator": "Part 1 - Petition Always Required",
        "supportingExcerpt": "The instructions identify the classifications that always require Form I-129."
      },
      "form": {
        "label": "Form I-129, Petition for a Nonimmigrant Worker",
        "shortLabel": "Form I-129",
        "url": "https://www.uscis.gov/i-129"
      },
      "prompt": "which of the following nonimmigrant statuses are initially petitioned for with {form}?",
      "answerLabel": "Employment-based and related principal classifications (H, L, O, P, Q, and R principals)",
      "correctSymbols": ["H1B", "H2A", "H2B", "H3", "L1", "O1", "O2", "P1", "P2", "P3", "Q1", "R1"],
      "card": { "fieldLabel": "Initial petition" }
    },
    {
      "id": "resource-nonimmigrant-form-i-129-derivative",
      "revision": "2026-08-02-1",
      "title": "Form I-129 dependent classifications",
      "source": {
        "label": "Form I-129 Instructions",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-129instr.pdf",
        "locator": "Dependent family members and the L, O, P, and R classification instructions",
        "supportingExcerpt": "Form I-129 is filed for the principal worker; dependent family members do not use it as their own petition."
      },
      "form": {
        "label": "Form I-129, Petition for a Nonimmigrant Worker",
        "shortLabel": "Form I-129",
        "url": "https://www.uscis.gov/i-129"
      },
      "prompt": "which of the following nonimmigrant dependent statuses do not file {form} themselves but instead rely on an individually petitioned principal's Form I-129?",
      "answerLabel": "Dependent classifications tied to I-129 principals: L-2, O-3, P-4, and R-2",
      "correctSymbols": ["L2", "O3", "P4", "R2"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "derivativeExplanation": "Dependent classification. Form I-129 is filed for the principal, not this dependent; the dependent's classification relies on the principal's petition."
      }
    },
    {
      "id": "resource-nonimmigrant-form-i-129s-direct",
      "revision": "2026-08-02-1",
      "title": "Blanket L principal filing",
      "source": {
        "label": "USCIS Form I-129S webpage",
        "url": "https://www.uscis.gov/i-129s",
        "locator": "Form I-129S purpose",
        "supportingExcerpt": "Form I-129S requests L-1 classification based on an approved blanket L petition."
      },
      "form": {
        "label": "Form I-129S, Nonimmigrant Petition Based on Blanket L Petition",
        "shortLabel": "Form I-129S",
        "url": "https://www.uscis.gov/i-129s"
      },
      "prompt": "which nonimmigrant principal status may be initially petitioned for with {form}?",
      "answerLabel": "L-1 principal under an approved blanket L petition",
      "correctSymbols": ["L1"],
      "card": { "fieldLabel": "Alternative initial petition" }
    },
    {
      "id": "resource-nonimmigrant-form-i-129s-derivative",
      "revision": "2026-08-02-1",
      "title": "Blanket L dependent classification",
      "source": {
        "label": "USCIS Form I-129S webpage",
        "url": "https://www.uscis.gov/i-129s",
        "locator": "Blanket L petition and dependent filing information",
        "supportingExcerpt": "The L-1 principal may use Form I-129S under a blanket petition; an L-2 dependent does not file that petition independently."
      },
      "form": {
        "label": "Form I-129S, Nonimmigrant Petition Based on Blanket L Petition",
        "shortLabel": "Form I-129S",
        "url": "https://www.uscis.gov/i-129s"
      },
      "prompt": "which nonimmigrant dependent status may rely on an L1 principal's {form} rather than having its own petition?",
      "answerLabel": "L-2 dependent of a blanket-petition L-1 principal",
      "correctSymbols": ["L2"],
      "card": {
        "fieldLabel": "Alternative principal petition",
        "derivativeExplanation": "Dependent classification. The L1 principal may use Form I-129 or Form I-129S; the L2 dependent does not file either petition independently."
      }
    },
    {
      "id": "resource-nonimmigrant-form-i-129cw-direct",
      "revision": "2026-08-02-1",
      "title": "Initial Form I-129CW classification",
      "source": {
        "label": "USCIS Form I-129CW webpage",
        "url": "https://www.uscis.gov/i-129cw",
        "locator": "Form I-129CW purpose",
        "supportingExcerpt": "An employer uses Form I-129CW to petition for a CNMI-only transitional worker."
      },
      "form": {
        "label": "Form I-129CW, Petition for a CNMI-Only Nonimmigrant Transitional Worker",
        "shortLabel": "Form I-129CW",
        "url": "https://www.uscis.gov/i-129cw"
      },
      "prompt": "which nonimmigrant status is initially petitioned for with {form}?",
      "answerLabel": "CW-1 CNMI-only transitional worker",
      "correctSymbols": ["CW1"],
      "card": { "fieldLabel": "Initial petition" }
    },
    {
      "id": "resource-nonimmigrant-form-i-129cw-derivative",
      "revision": "2026-08-02-1",
      "title": "CW dependent classification",
      "source": {
        "label": "Form I-539 Instructions, CW-2 Dependents of a CW-1 Transitional Worker",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-539instr.pdf",
        "locator": "CW-2 Dependents of a CW-1 Transitional Worker",
        "supportingExcerpt": "The employer files Form I-129CW for the CW-1 principal; the CW-2 applicant establishes the qualifying relationship to that principal."
      },
      "form": {
        "label": "Form I-129CW, Petition for a CNMI-Only Nonimmigrant Transitional Worker",
        "shortLabel": "Form I-129CW",
        "url": "https://www.uscis.gov/i-129cw"
      },
      "prompt": "which nonimmigrant dependent status does not use {form} itself but relies on the CW1 principal's Form I-129CW?",
      "answerLabel": "CW-2 dependent of a CW-1 worker",
      "correctSymbols": ["CW2"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "derivativeExplanation": "Dependent classification. Form I-129CW is filed for the CW1 principal, not the CW2 dependent."
      }
    },
    {
      "id": "resource-nonimmigrant-form-i-129f-direct",
      "revision": "2026-08-02-1",
      "title": "K principal petitions",
      "source": {
        "label": "USCIS Form I-129F webpage",
        "url": "https://www.uscis.gov/i-129f",
        "locator": "Form I-129F purpose",
        "supportingExcerpt": "Form I-129F is used for a K-1 fiance(e) or K-3 spouse."
      },
      "form": {
        "label": "Form I-129F, Petition for Alien Fiance(e)",
        "shortLabel": "Form I-129F",
        "url": "https://www.uscis.gov/i-129f"
      },
      "prompt": "which nonimmigrant principal statuses are initially petitioned for with {form}?",
      "answerLabel": "K-1 fiance(e) and K-3 spouse principals",
      "correctSymbols": ["K1", "K3"],
      "card": { "fieldLabel": "Initial petition" }
    },
    {
      "id": "resource-nonimmigrant-form-i-129f-derivative",
      "revision": "2026-08-02-1",
      "title": "K dependent classifications",
      "source": {
        "label": "USCIS Form I-129F webpage",
        "url": "https://www.uscis.gov/i-129f",
        "locator": "K-2 and K-4 children included through the K principal",
        "supportingExcerpt": "The form brings a K-1 or K-3 principal and that person's qualifying children to the United States."
      },
      "form": {
        "label": "Form I-129F, Petition for Alien Fiance(e)",
        "shortLabel": "Form I-129F",
        "url": "https://www.uscis.gov/i-129f"
      },
      "prompt": "which nonimmigrant dependent statuses are included through a K1 or K3 principal's {form}, rather than through a separate petition?",
      "answerLabel": "K-2 and K-4 dependent children",
      "correctSymbols": ["K2", "K4"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "derivativeExplanation": "Dependent classification. No separate Form I-129F is filed for the child; the classification is based on the K1 or K3 principal's petition."
      }
    },
    {
      "id": "resource-nonimmigrant-form-i-854a-direct",
      "revision": "2026-08-02-1",
      "title": "S principal classifications",
      "source": {
        "label": "Form I-854A/B Instructions",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-854instr.pdf",
        "locator": "Who Should Use These Forms? - S-5 and S-6 classifications",
        "supportingExcerpt": "A law-enforcement agency uses Form I-854A to request S-5 or S-6 classification for a witness or informant."
      },
      "form": {
        "label": "Form I-854A, Inter-Agency Alien Witness and Informant Record",
        "shortLabel": "Form I-854A",
        "url": "https://www.uscis.gov/i-854"
      },
      "prompt": "which nonimmigrant principal statuses are initially requested with {form}?",
      "answerLabel": "S-5 and S-6 witness or informant principals",
      "correctSymbols": ["S5", "S6"],
      "card": { "fieldLabel": "Initial classification request" }
    },
    {
      "id": "resource-nonimmigrant-form-i-854a-derivative",
      "revision": "2026-08-02-1",
      "title": "S derivative classification",
      "source": {
        "label": "Form I-854A/B Instructions, LEA May Also Make a Request for Derivative Beneficiaries",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-854instr.pdf",
        "locator": "LEA May Also Make a Request for Derivative Beneficiaries",
        "supportingExcerpt": "The sponsoring law-enforcement agency must complete a separate Form I-854A for each S-7 derivative."
      },
      "form": {
        "label": "Form I-854A, Inter-Agency Alien Witness and Informant Record",
        "shortLabel": "Form I-854A",
        "url": "https://www.uscis.gov/i-854"
      },
      "prompt": "which nonimmigrant derivative status is requested with {form}?",
      "answerLabel": "S-7 qualifying derivative family member",
      "correctSymbols": ["S7"],
      "card": {
        "fieldLabel": "Derivative classification request",
        "derivativeExplanation": "Derivative classification. The sponsoring law-enforcement agency must file a separate Form I-854A for each S7 derivative."
      }
    },
    {
      "id": "resource-nonimmigrant-form-i-914-direct",
      "revision": "2026-08-02-1",
      "title": "Principal T application",
      "source": {
        "label": "USCIS Form I-914 webpage",
        "url": "https://www.uscis.gov/i-914",
        "locator": "Application for T Nonimmigrant Status",
        "supportingExcerpt": "The principal applicant files Form I-914 to request T-1 nonimmigrant status."
      },
      "form": {
        "label": "Form I-914, Application for T Nonimmigrant Status",
        "shortLabel": "Form I-914",
        "url": "https://www.uscis.gov/i-914"
      },
      "prompt": "which nonimmigrant principal status is initially applied for with {form}?",
      "answerLabel": "T-1 principal trafficking-victim applicant",
      "correctSymbols": ["T1"],
      "card": { "fieldLabel": "Initial application" }
    },
    {
      "id": "resource-nonimmigrant-form-i-914a-derivative",
      "revision": "2026-08-02-1",
      "title": "Derivative T applications",
      "source": {
        "label": "USCIS Form I-914 webpage",
        "url": "https://www.uscis.gov/i-914",
        "locator": "Form I-914, Supplement A - Application for Family Member of T-1 Recipient",
        "supportingExcerpt": "The T-1 principal files Form I-914, Supplement A for a qualifying family member."
      },
      "form": {
        "label": "Form I-914, Supplement A",
        "shortLabel": "Form I-914, Supplement A",
        "url": "https://www.uscis.gov/i-914"
      },
      "prompt": "which nonimmigrant derivative statuses are initially applied for on their behalf with {form}?",
      "answerLabel": "T-2 through T-6 qualifying family members",
      "correctSymbols": ["T2", "T3", "T4", "T5", "T6"],
      "card": {
        "fieldLabel": "Derivative application",
        "value": "Form I-914",
        "derivativeExplanation": "Derivative classification. The T1 principal files Form I-914, Supplement A for the qualifying family member."
      }
    },
    {
      "id": "resource-nonimmigrant-form-i-918-direct",
      "revision": "2026-08-02-1",
      "title": "Principal U petition",
      "source": {
        "label": "USCIS Form I-918 webpage",
        "url": "https://www.uscis.gov/i-918",
        "locator": "Petition for U Nonimmigrant Status",
        "supportingExcerpt": "The principal petitioner files Form I-918 to request U-1 nonimmigrant status."
      },
      "form": {
        "label": "Form I-918, Petition for U Nonimmigrant Status",
        "shortLabel": "Form I-918",
        "url": "https://www.uscis.gov/i-918"
      },
      "prompt": "which nonimmigrant principal status is initially petitioned for with {form}?",
      "answerLabel": "U-1 principal crime-victim petitioner",
      "correctSymbols": ["U1"],
      "card": { "fieldLabel": "Initial petition" }
    },
    {
      "id": "resource-nonimmigrant-form-i-918a-derivative",
      "revision": "2026-08-02-1",
      "title": "Derivative U petitions",
      "source": {
        "label": "USCIS Form I-918 webpage",
        "url": "https://www.uscis.gov/i-918",
        "locator": "Form I-918, Supplement A - Petition for Qualifying Family Member of U-1 Recipient",
        "supportingExcerpt": "The U-1 principal files Form I-918, Supplement A for a qualifying family member."
      },
      "form": {
        "label": "Form I-918, Supplement A",
        "shortLabel": "Form I-918, Supplement A",
        "url": "https://www.uscis.gov/i-918"
      },
      "prompt": "which nonimmigrant derivative statuses are initially petitioned for on their behalf with {form}?",
      "answerLabel": "U-2 through U-5 qualifying family members",
      "correctSymbols": ["U2", "U3", "U4", "U5"],
      "card": {
        "fieldLabel": "Derivative petition",
        "value": "Form I-918",
        "derivativeExplanation": "Derivative classification. The U1 principal files Form I-918, Supplement A for the qualifying family member."
      }
    },
    {
      "id": "resource-nonimmigrant-form-i-539-v",
      "revision": "2026-08-02-1",
      "title": "Initial V applications",
      "source": {
        "label": "Form I-539 Instructions, V Nonimmigrant Status",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-539instr.pdf",
        "locator": "V Nonimmigrant Status",
        "supportingExcerpt": "A person physically present in the United States may use Form I-539 to request initial V nonimmigrant status."
      },
      "form": {
        "label": "Form I-539, Application to Extend/Change Nonimmigrant Status",
        "shortLabel": "Form I-539",
        "url": "https://www.uscis.gov/i-539"
      },
      "prompt": "which nonimmigrant statuses may be initially applied for with {form}?",
      "answerLabel": "V-1 through V-3 family-unity applicants inside the United States",
      "correctSymbols": ["V1", "V2", "V3"],
      "card": {
        "fieldLabel": "Initial application",
        "qualifier": "Inside the United States",
        "qualifierExplanation": "Form I-539 is the initial V-status application route for a person who is physically present in the United States."
      }
    }
  ],
  "immigrant": [
    {
      "id": "resource-immigrant-form-i-130-direct",
      "revision": "2026-08-02-1",
      "title": "Direct Form I-130 classifications",
      "source": {
        "label": "USCIS Policy Manual, Volume 7, Part A, Chapter 2, Section C.1",
        "url": "https://www.uscis.gov/node/73605",
        "locator": "Section C.1 - Eligibility to Receive an Immigrant Visa; immigrant petition table",
        "supportingExcerpt": "The table assigns Form I-130 to the listed family-based principal categories."
      },
      "form": {
        "label": "Form I-130, Petition for Alien Relative",
        "shortLabel": "Form I-130",
        "url": "https://www.uscis.gov/i-130"
      },
      "prompt": "which of the following immigrant statuses have their own underlying {form}?",
      "answerLabel": "Family-based principal beneficiaries with their own Form I-130 petition",
      "correctSymbols": ["IR1", "IR2", "IR5", "CR1", "CR2", "VI5", "F11", "F21", "F22", "F24", "C21", "C22", "C24", "FX1", "FX2", "CX1", "CX2", "F31", "C31", "F41"],
      "card": { "fieldLabel": "Underlying petition" }
    },
    {
      "id": "resource-immigrant-form-i-130-derivative",
      "revision": "2026-08-02-1",
      "title": "Derivative Form I-130 classifications",
      "source": {
        "label": "USCIS Policy Manual, Volume 7, Part A, Chapter 2, Section C.2",
        "url": "https://www.uscis.gov/node/73605",
        "locator": "Section C.2 - Dependents",
        "supportingExcerpt": "Dependents do not have their own underlying immigrant petition and may only adjust based on the principal's adjustment of status."
      },
      "form": {
        "label": "Form I-130, Petition for Alien Relative",
        "shortLabel": "Form I-130",
        "url": "https://www.uscis.gov/i-130"
      },
      "prompt": "which of the following immigrant statuses do not have their own underlying petition and instead derive from a principal beneficiary's {form}?",
      "answerLabel": "Family-based derivative beneficiaries relying on a principal's Form I-130",
      "correctSymbols": ["F12", "F23", "F25", "C23", "C25", "FX3", "CX3", "F32", "F33", "C32", "C33", "F42", "F43"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "derivativeExplanation": "Derivative classification. No separate Form I-130 is filed for this status; eligibility depends on the principal beneficiary's Form I-130 and, for adjustment, the principal's adjustment of status."
      }
    },
    {
      "id": "resource-immigrant-form-i-360-direct",
      "revision": "2026-08-02-1",
      "title": "Direct Form I-360 classifications",
      "source": {
        "label": "Form I-360 Instructions, What Is the Purpose of Form I-360? and Who May File Form I-360?",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-360instr.pdf",
        "locator": "What Is the Purpose of Form I-360?; Who May File Form I-360?",
        "supportingExcerpt": "The instructions list Amerasian, widow(er), VAWA, and special-immigrant classifications that use Form I-360."
      },
      "form": {
        "label": "Form I-360, Petition for Amerasian, Widow(er), or Special Immigrant",
        "shortLabel": "Form I-360",
        "url": "https://www.uscis.gov/i-360"
      },
      "prompt": "which of the following immigrant statuses have their own underlying {form}?",
      "answerLabel": "Special immigrant and self-petitioning principals with their own Form I-360",
      "correctSymbols": ["IW1", "IB1", "IB2", "IB5", "AM1", "B11", "B21", "B22", "B24", "BX1", "BX2", "B31", "BC1", "SD1", "SF1", "SG1", "SH1", "SI1", "SJ1", "SK1", "SK2", "SK3", "SK4", "SL1", "SM1", "SN1", "SN2", "SN3", "SN4", "SR1"],
      "card": { "fieldLabel": "Underlying petition" }
    },
    {
      "id": "resource-immigrant-form-i-360-derivative",
      "revision": "2026-08-02-1",
      "title": "Derivative Form I-360 classifications",
      "source": {
        "label": "USCIS Policy Manual derivative-beneficiary rule and Form I-360 Instructions",
        "url": "https://www.uscis.gov/node/73605",
        "locator": "Volume 7, Part A, Chapter 2, Section C.2; Form I-360 classification instructions",
        "supportingExcerpt": "These family-member classifications derive through the principal beneficiary's Form I-360 rather than a separate underlying petition."
      },
      "form": {
        "label": "Form I-360, Petition for Amerasian, Widow(er), or Special Immigrant",
        "shortLabel": "Form I-360",
        "url": "https://www.uscis.gov/i-360"
      },
      "prompt": "which of the following immigrant statuses do not have their own underlying petition and instead derive from a principal beneficiary's {form}?",
      "answerLabel": "Derivative special immigrants relying on a principal's Form I-360",
      "correctSymbols": ["IW2", "IB3", "AM2", "AM3", "B12", "B23", "B25", "BX3", "B32", "B33", "BC2", "BC3", "SD2", "SD3", "SF2", "SG2", "SH2", "SJ2", "SM2", "SM3", "SR2", "SR3"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "derivativeExplanation": "Derivative classification. No separate Form I-360 is filed for this status; it is based on the principal beneficiary's Form I-360."
      }
    },
    {
      "id": "resource-immigrant-form-i-360-si-derivative",
      "revision": "2026-08-02-1",
      "title": "SI derivative and survivor classifications",
      "source": {
        "label": "Form I-360 Instructions for certain Afghan and Iraqi translators",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-360instr.pdf",
        "locator": "Afghanistan or Iraq National Supporting U.S. Armed Forces as a Translator; survivor provisions",
        "supportingExcerpt": "An accompanying spouse or child ordinarily derives through the SI1 principal, while qualifying survivors may petition independently."
      },
      "form": {
        "label": "Form I-360, Petition for Amerasian, Widow(er), or Special Immigrant",
        "shortLabel": "Form I-360",
        "url": "https://www.uscis.gov/i-360"
      },
      "prompt": "which immigrant statuses ordinarily derive from an SI1 principal's {form}, although a qualifying surviving spouse or child may file independently?",
      "answerLabel": "SI-2 and SI-3 derivatives or qualifying survivors of an SI-1 principal",
      "correctSymbols": ["SI2", "SI3"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "derivativeExplanation": "Derivative classification. This status usually derives through the SI1 principal's Form I-360, but a qualifying surviving spouse or child may be eligible to file Form I-360 independently."
      }
    },
    {
      "id": "resource-immigrant-form-i-360-sq-direct",
      "revision": "2026-08-02-1",
      "title": "SQ Form I-360 route",
      "source": {
        "label": "Form I-360 Instructions for Iraqi and Afghan special immigrants",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-360instr.pdf",
        "locator": "Iraq National and Afghan National special-immigrant filing instructions",
        "supportingExcerpt": "Iraqi applicants and qualifying legacy Afghan cases use Form I-360."
      },
      "form": {
        "label": "Form I-360, Petition for Amerasian, Widow(er), or Special Immigrant",
        "shortLabel": "Form I-360",
        "url": "https://www.uscis.gov/i-360"
      },
      "prompt": "which immigrant principal status is petitioned with {form} for Iraqi applicants and qualifying legacy Afghan cases?",
      "answerLabel": "SQ-1 Iraqi or qualifying legacy Afghan principal",
      "correctSymbols": ["SQ1"],
      "card": {
        "fieldLabel": "Initial petition - Iraqi/legacy Afghan route",
        "qualifier": "Route dependent",
        "qualifierExplanation": "Iraqi applicants and qualifying legacy Afghan cases use Form I-360; current Afghan cases generally use Form DS-157."
      }
    },
    {
      "id": "resource-immigrant-form-ds-157-sq-direct",
      "revision": "2026-08-02-1",
      "title": "SQ Form DS-157 route",
      "source": {
        "label": "Form I-360 Instructions - Afghan SIV transition provisions",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-360instr.pdf",
        "locator": "Afghan National special-immigrant transition to DOS and Form DS-157",
        "supportingExcerpt": "An Afghan applicant using the current DOS petition route files Form DS-157."
      },
      "form": {
        "label": "Form DS-157, Supplemental Nonimmigrant Visa Application",
        "shortLabel": "Form DS-157",
        "url": "https://eforms.state.gov/Forms/ds157.PDF"
      },
      "prompt": "which immigrant principal status is petitioned with {form} when the Afghan applicant uses the current DOS petition route?",
      "answerLabel": "SQ-1 current-route Afghan principal",
      "correctSymbols": ["SQ1"],
      "card": {
        "fieldLabel": "Initial petition - current Afghan route",
        "qualifier": "Route dependent",
        "qualifierExplanation": "Afghan applicants who began the SIV process on or after July 20, 2022 generally use Form DS-157; Iraqi and qualifying legacy Afghan cases use Form I-360."
      }
    },
    {
      "id": "resource-immigrant-form-i-360-sq-derivative",
      "revision": "2026-08-02-1",
      "title": "SQ derivatives in the Form I-360 route",
      "source": {
        "label": "Form I-360 Instructions for Iraqi and qualifying legacy Afghan special immigrants",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-360instr.pdf",
        "locator": "Iraqi and Afghan family-member and survivor provisions",
        "supportingExcerpt": "The ordinary spouse or child derives through the SQ1 principal's route; qualifying survivors may petition independently."
      },
      "form": {
        "label": "Form I-360, Petition for Amerasian, Widow(er), or Special Immigrant",
        "shortLabel": "Form I-360",
        "url": "https://www.uscis.gov/i-360"
      },
      "prompt": "which immigrant statuses ordinarily derive through an SQ1 principal's {form} in the Iraqi or qualifying legacy-Afghan route?",
      "answerLabel": "SQ-2 and SQ-3 derivatives in the Iraqi or legacy-Afghan route",
      "correctSymbols": ["SQ2", "SQ3"],
      "card": {
        "fieldLabel": "Underlying principal petition - Iraqi/legacy Afghan route",
        "derivativeExplanation": "Derivative classification. The underlying petition follows the SQ1 principal's Iraqi or qualifying legacy-Afghan Form I-360 route; a qualifying survivor may be eligible to petition independently."
      }
    },
    {
      "id": "resource-immigrant-form-ds-157-sq-derivative",
      "revision": "2026-08-02-1",
      "title": "SQ derivatives in the Form DS-157 route",
      "source": {
        "label": "Form I-360 Instructions - Afghan SIV transition provisions",
        "url": "https://www.uscis.gov/sites/default/files/document/forms/i-360instr.pdf",
        "locator": "Current Afghan DOS route and family-member survivor provisions",
        "supportingExcerpt": "The ordinary spouse or child derives through the SQ1 principal's current Afghan DS-157 route; qualifying survivors may petition independently."
      },
      "form": {
        "label": "Form DS-157, Supplemental Nonimmigrant Visa Application",
        "shortLabel": "Form DS-157",
        "url": "https://eforms.state.gov/Forms/ds157.PDF"
      },
      "prompt": "which immigrant statuses ordinarily derive through an SQ1 principal's {form} in the current Afghan route?",
      "answerLabel": "SQ-2 and SQ-3 derivatives in the current Afghan route",
      "correctSymbols": ["SQ2", "SQ3"],
      "card": {
        "fieldLabel": "Underlying principal petition - current Afghan route",
        "derivativeExplanation": "Derivative classification. The underlying petition follows the SQ1 principal's current Afghan Form DS-157 route; a qualifying survivor may be eligible to petition independently."
      }
    },
    {
      "id": "resource-immigrant-form-i-140-direct",
      "revision": "2026-08-02-1",
      "title": "Direct Form I-140 classifications",
      "source": {
        "label": "USCIS Policy Manual, Volume 7, Part A, Chapter 2, Section C.1",
        "url": "https://www.uscis.gov/node/73605",
        "locator": "Immigrant petition table - Form I-140",
        "supportingExcerpt": "The table assigns Form I-140 to priority workers, advanced-degree or exceptional-ability workers, and skilled, professional, or other workers."
      },
      "form": {
        "label": "Form I-140, Immigrant Petition for Alien Workers",
        "shortLabel": "Form I-140",
        "url": "https://www.uscis.gov/i-140"
      },
      "prompt": "which immigrant statuses have their own underlying {form}?",
      "answerLabel": "Employment-based principal beneficiaries with their own Form I-140",
      "correctSymbols": ["E11", "E12", "E13", "E21", "E31", "E32", "EW3"],
      "card": { "fieldLabel": "Underlying petition" }
    },
    {
      "id": "resource-immigrant-form-i-140-derivative",
      "revision": "2026-08-02-1",
      "title": "Derivative Form I-140 classifications",
      "source": {
        "label": "USCIS Policy Manual, Volume 7, Part A, Chapter 2, Section C.2",
        "url": "https://www.uscis.gov/node/73605",
        "locator": "Section C.2 - Dependents",
        "supportingExcerpt": "Employment-based dependents do not have their own underlying immigrant petition."
      },
      "form": {
        "label": "Form I-140, Immigrant Petition for Alien Workers",
        "shortLabel": "Form I-140",
        "url": "https://www.uscis.gov/i-140"
      },
      "prompt": "which immigrant statuses do not have their own Form I-140 and instead derive from a principal beneficiary's {form}?",
      "answerLabel": "Employment-based derivative beneficiaries relying on a principal's Form I-140",
      "correctSymbols": ["E14", "E15", "E22", "E23", "E34", "E35", "EW4", "EW5"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "derivativeExplanation": "Derivative classification. No separate Form I-140 is filed for this status; it depends on the principal beneficiary's Form I-140."
      }
    },
    {
      "id": "resource-immigrant-form-i-526-direct",
      "revision": "2026-08-02-1",
      "title": "Direct Form I-526 classifications",
      "source": {
        "label": "USCIS EB-5 Reform and Integrity Act policy guidance and 22 CFR 42.11 classification table",
        "url": "https://www.uscis.gov/sites/default/files/document/policy-manual-updates/20221006-EB5ReformAndIntegrityAct.pdf",
        "locator": "Legacy Form I-526 and current standalone-investor filing distinctions",
        "supportingExcerpt": "Legacy EB-5 petitions used Form I-526; after the reform, Form I-526 is the standalone-investor petition."
      },
      "form": {
        "label": "Form I-526, Immigrant Petition by Standalone Investor",
        "shortLabel": "Form I-526",
        "url": "https://www.uscis.gov/i-526"
      },
      "prompt": "which immigrant principal statuses are based on {form}, including legacy regional-center petitions and current standalone-investor petitions?",
      "answerLabel": "Legacy and standalone-investor principals using Form I-526",
      "correctSymbols": ["C51", "T51", "R51", "I51", "NU1", "NR1", "NH1"],
      "card": {
        "fieldLabel": "Underlying petition",
        "valueBySymbol": { "R51": "Form I-526 (legacy)", "I51": "Form I-526 (legacy)" }
      }
    },
    {
      "id": "resource-immigrant-form-i-526-derivative",
      "revision": "2026-08-02-1",
      "title": "Derivative Form I-526 classifications",
      "source": {
        "label": "USCIS EB-5 Reform and Integrity Act policy guidance and USCIS Policy Manual derivative rule",
        "url": "https://www.uscis.gov/sites/default/files/document/policy-manual-updates/20221006-EB5ReformAndIntegrityAct.pdf",
        "locator": "Legacy/current Form I-526 distinction; Volume 7, Part A, Chapter 2, Section C.2",
        "supportingExcerpt": "The spouse and child derive from the principal investor's Form I-526 rather than filing their own underlying petition."
      },
      "form": {
        "label": "Form I-526, Immigrant Petition by Standalone Investor",
        "shortLabel": "Form I-526",
        "url": "https://www.uscis.gov/i-526"
      },
      "prompt": "which immigrant statuses derive from a principal beneficiary's {form} rather than filing their own I-526?",
      "answerLabel": "Derivative investors relying on a principal's Form I-526",
      "correctSymbols": ["C52", "C53", "T52", "T53", "R52", "R53", "I52", "I53", "NU2", "NU3", "NR2", "NR3", "NH2", "NH3"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "valueBySymbol": { "R52": "Form I-526 (legacy)", "R53": "Form I-526 (legacy)", "I52": "Form I-526 (legacy)", "I53": "Form I-526 (legacy)" },
        "derivativeExplanation": "Derivative classification. No separate Form I-526 is filed for this status; it depends on the principal investor's petition."
      }
    },
    {
      "id": "resource-immigrant-form-i-526e-direct",
      "revision": "2026-08-02-1",
      "title": "Direct Form I-526E classifications",
      "source": {
        "label": "USCIS Policy Manual, Volume 7, Part A, Chapter 2, Section C.1",
        "url": "https://www.uscis.gov/node/73605",
        "locator": "Immigrant petition table - Form I-526E",
        "supportingExcerpt": "The table assigns Form I-526E to regional-center investors."
      },
      "form": {
        "label": "Form I-526E, Immigrant Petition by Regional Center Investor",
        "shortLabel": "Form I-526E",
        "url": "https://www.uscis.gov/i-526e"
      },
      "prompt": "which immigrant principal statuses are initially petitioned for with {form}?",
      "answerLabel": "Regional-center investor principals using Form I-526E",
      "correctSymbols": ["RU1", "RR1", "RH1", "RI1"],
      "card": { "fieldLabel": "Underlying petition" }
    },
    {
      "id": "resource-immigrant-form-i-526e-derivative",
      "revision": "2026-08-02-1",
      "title": "Derivative Form I-526E classifications",
      "source": {
        "label": "USCIS Policy Manual, Volume 7, Part A, Chapter 2, Section C.2",
        "url": "https://www.uscis.gov/node/73605",
        "locator": "Section C.2 - Dependents",
        "supportingExcerpt": "The spouse and child derive from the principal regional-center investor's petition."
      },
      "form": {
        "label": "Form I-526E, Immigrant Petition by Regional Center Investor",
        "shortLabel": "Form I-526E",
        "url": "https://www.uscis.gov/i-526e"
      },
      "prompt": "which immigrant statuses derive from a principal beneficiary's {form} rather than filing their own I-526E?",
      "answerLabel": "Derivative regional-center investors relying on a principal's Form I-526E",
      "correctSymbols": ["RU2", "RU3", "RR2", "RR3", "RH2", "RH3", "RI2", "RI3"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "derivativeExplanation": "Derivative classification. No separate Form I-526E is filed for this status; it depends on the principal regional-center investor's petition."
      }
    },
    {
      "id": "resource-immigrant-form-i-600",
      "revision": "2026-08-02-1",
      "title": "Orphan classification petition",
      "source": {
        "label": "8 CFR 204.3",
        "url": "https://www.ecfr.gov/current/title-8/chapter-I/subchapter-B/part-204/subpart-A/section-204.3",
        "locator": "8 CFR 204.3 - Orphan petitions",
        "supportingExcerpt": "The regulation identifies Form I-600 as the petition used to classify an orphan as an immediate relative."
      },
      "form": {
        "label": "Form I-600, Petition to Classify Orphan as an Immediate Relative",
        "shortLabel": "Form I-600",
        "url": "https://www.uscis.gov/i-600"
      },
      "prompt": "which immigrant statuses are initially petitioned for with {form}?",
      "answerLabel": "IR-3 and IR-4 orphan-adoption beneficiaries",
      "correctSymbols": ["IR3", "IR4"],
      "card": { "fieldLabel": "Underlying petition" }
    },
    {
      "id": "resource-immigrant-form-i-800",
      "revision": "2026-08-02-1",
      "title": "Convention adoptee petition",
      "source": {
        "label": "8 CFR 204.1(a)(5)",
        "url": "https://www.ecfr.gov/current/title-8/chapter-I/subchapter-B/part-204/subpart-A/section-204.1",
        "locator": "8 CFR 204.1(a)(5) - Form I-800",
        "supportingExcerpt": "The regulation identifies Form I-800 as the petition to classify a Convention adoptee as an immediate relative."
      },
      "form": {
        "label": "Form I-800, Petition to Classify Convention Adoptee as an Immediate Relative",
        "shortLabel": "Form I-800",
        "url": "https://www.uscis.gov/i-800"
      },
      "prompt": "which immigrant statuses are initially petitioned for with {form}?",
      "answerLabel": "IH-3 and IH-4 Hague Convention adoptee beneficiaries",
      "correctSymbols": ["IH3", "IH4"],
      "card": { "fieldLabel": "Underlying petition" }
    },
    {
      "id": "resource-immigrant-form-ds-1884-direct",
      "revision": "2026-08-02-1",
      "title": "International employee petition",
      "source": {
        "label": "USCIS Policy Manual, Volume 7, Part F, Chapter 3, Section C.1",
        "url": "https://www.uscis.gov/node/73626",
        "locator": "Step Three - Form DS-1884",
        "supportingExcerpt": "The employee seeks special-immigrant classification by filing Form DS-1884 with the Department of State."
      },
      "form": {
        "label": "Form DS-1884, Petition to Classify Special Immigrant",
        "shortLabel": "Form DS-1884",
        "url": "https://eforms.state.gov/Forms/ds1884.PDF"
      },
      "prompt": "which immigrant principal status is initially petitioned for with {form}?",
      "answerLabel": "SE-1 qualifying international-organization employee principal",
      "correctSymbols": ["SE1"],
      "card": { "fieldLabel": "Underlying petition" }
    },
    {
      "id": "resource-immigrant-form-ds-1884-derivative",
      "revision": "2026-08-02-1",
      "title": "International employee derivatives",
      "source": {
        "label": "USCIS Policy Manual, Volume 7, Part F, Chapter 3, Section C.5",
        "url": "https://www.uscis.gov/node/73626",
        "locator": "Treatment of Family Members",
        "supportingExcerpt": "The spouse and child may accompany or follow to join the principal as derivative applicants under the same category and priority date."
      },
      "form": {
        "label": "Form DS-1884, Petition to Classify Special Immigrant",
        "shortLabel": "Form DS-1884",
        "url": "https://eforms.state.gov/Forms/ds1884.PDF"
      },
      "prompt": "which immigrant statuses derive from an SE1 principal's approved {form} rather than filing their own petition?",
      "answerLabel": "SE-2 and SE-3 derivatives of an SE-1 principal",
      "correctSymbols": ["SE2", "SE3"],
      "card": {
        "fieldLabel": "Underlying principal petition",
        "derivativeExplanation": "Derivative classification. No separate Form DS-1884 petition is filed for this status; the spouse or child derives from the SE1 principal's approved petition."
      }
    },
    {
      "id": "resource-immigrant-form-i-929",
      "revision": "2026-08-02-1",
      "title": "Qualifying family members of U-1 nonimmigrants",
      "source": {
        "label": "USCIS Form I-929 webpage",
        "url": "https://www.uscis.gov/i-929",
        "locator": "Form I-929 purpose",
        "supportingExcerpt": "A qualifying U-1 principal or former principal files Form I-929 for a qualifying family member."
      },
      "form": {
        "label": "Form I-929, Petition for Qualifying Family Member of a U-1 Nonimmigrant",
        "shortLabel": "Form I-929",
        "url": "https://www.uscis.gov/i-929"
      },
      "prompt": "which immigrant statuses are petitioned for with {form}?",
      "answerLabel": "SU-2, SU-3, and SU-5 qualifying family members of a U-1 principal",
      "correctSymbols": ["SU2", "SU3", "SU5"],
      "card": {
        "fieldLabel": "Underlying petition",
        "qualifier": "Filed by qualifying U-1 principal",
        "qualifierExplanation": "A qualifying U-1 principal or former principal files a separate Form I-929 for this family member; the beneficiary does not self-petition."
      }
    },
    {
      "id": "resource-immigrant-no-petition-dv1",
      "revision": "2026-08-02-1",
      "title": "Diversity Visa principal",
      "source": {
        "label": "USCIS Policy Manual immigrant-petition table",
        "url": "https://www.uscis.gov/node/73605",
        "locator": "Diversity Immigrant Visa row",
        "supportingExcerpt": "Diversity visas do not require a USCIS-filed petition."
      },
      "form": null,
      "prompt": "which immigrant principal status does not require a USCIS-filed underlying petition because it is based on the Diversity Visa Program?",
      "answerLabel": "DV-1 Diversity Visa principal - no USCIS-filed petition",
      "correctSymbols": ["DV1"],
      "card": { "fieldLabel": "Underlying petition", "value": "No USCIS-filed petition" }
    },
    {
      "id": "resource-immigrant-no-petition-dv-derivative",
      "revision": "2026-08-02-1",
      "title": "Diversity Visa derivatives",
      "source": {
        "label": "USCIS Policy Manual derivative-beneficiary rule",
        "url": "https://www.uscis.gov/node/73605",
        "locator": "Diversity Immigrant Visa row and Section C.2 - Dependents",
        "supportingExcerpt": "Diversity Visa derivatives have no underlying USCIS petition of their own and depend on the DV1 principal."
      },
      "form": null,
      "prompt": "which immigrant statuses have no underlying USCIS petition of their own and instead derive from a DV1 principal?",
      "answerLabel": "DV-2 and DV-3 derivatives - no USCIS-filed petition of their own",
      "correctSymbols": ["DV2", "DV3"],
      "card": {
        "fieldLabel": "Underlying petition",
        "value": "No USCIS-filed petition",
        "derivativeExplanation": "Derivative classification. There is no USCIS-filed underlying petition; eligibility depends on the DV1 principal."
      }
    }
  ]
};
