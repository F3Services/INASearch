# Legal-source evidence

This directory contains the immutable raw artifacts used to audit an INASearch
legal corpus release. The files are source evidence, not runtime application
assets.

The capture has three independent roles:

- House Title 8 USLM is the source for U.S. Code text, hierarchy, editorial
  notes, and source-authored links.
- The USCIS INA page is the source for the agency's INA-to-U.S.C. crosswalk.
- GovInfo COMPS-1376 is an independent compilation used to validate the INA
  section inventory and each crosswalk pairing.

Capture a new reviewed set only when preparing a new corpus release:

```bash
python3 tools/capture-legal-sources.py capture --capture-date YYYY-MM-DD --refresh
```

Verify the committed bytes without network access:

```bash
python3 tools/capture-legal-sources.py verify
```

`source-manifest.json` records every requested and final URL, release/package
identifier, byte count, and SHA-256 hash. A live URL changing later therefore
cannot silently change the evidence underlying an existing build.
