# Bare-section cycle 2 — Luna review shard 1

Reviewed all 92 reassigned rows in `tmp/ina-bare-section-cycle2/review/shard-1.json`. Every ID is represented in `cycle2-review-1.json`, with the original, before, and after field context considered for each occurrence.

89 rows pass. The cycle correctly fixes the cross-title “section 220 of Title 42” target, corrects the Title 28 “section 1361” target, adds explicit Title 5/18/28 references, repairs the subsection “(b)” target in 8 U.S.C. 1324a, and renders INA conversions with the redundant authority tails removed.

Three rows flag removals of explicit Title 18/37 citations: IDs 4 (18 U.S.C. 1546(a)) and 52/55 (37 U.S.C. 551(2)). Their source fields clearly contain the references, but the after records are null, so the citations disappear and require preservation as official-source-only links.

Verdict counts: **89 pass, 3 flag**.
