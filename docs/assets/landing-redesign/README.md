# Landing redesign evidence

The base is `13f7fa7f478982ed9316f2348f2ee5f61214bd00`. The verified code commit is `aeb8fe4cf43aba880e2bb91673ff81eb537d3cbe`, tree `e34dd62a070da565c8aa05b6006fa001a35edd56`, identical to local audit snapshot `3eb603f1ca099b27db9508699ae0767f2d0b1ea1`. Local audit snapshots named in the reports are provenance identifiers, not published branch commits.

Before images and the before recording show the actual base. After images and recording show the verified code tree. Desktop captures are 1440x900; mobile captures are 390x844. Recordings are H.264/yuv420p, 1280x800 at 12fps. The before recording lasts 10.33 seconds; after lasts 7.75 seconds. The local development indicator is present in both. Demo data is synthetic.

- [Before desktop](before-desktop-hero.png), [after desktop](after-desktop-hero.png)
- [Before mobile](before-mobile-hero.png), [after mobile](after-mobile-hero.png)
- [Before scroll recording](before-desktop-scroll.mp4), [after motion recording](after-desktop-motion.mp4)
- [Verification](final-code-verification.md), [guard mutation evidence](mutation-verification.md)
- [Before capture provenance](before-visual-evidence.md), [after capture provenance](after-visual-evidence.md)
- [Independent repair assessment](independent-repair-assessment.md), [checker correction assessment](headline-check-independent-assessment.md)
- [Smoke scenario matrix](smoke-coverage.tsv), [media sizes and hashes](media-manifest.tsv)

Full lint, typecheck, all 5,168 tests including DB, and web build passed on local snapshot `3b64508784ed6da28bbad3630b053c56ba1cef2f`. The final code tree differs only in the manual browser checker. Product source, configuration and collected tests are identical. Those execution results retain their original SHA; current lint and revised browser checks ran on `3eb603f1`. The commit hooks then passed on the code checkpoint: Biome, all workspace/root typechecks and 270 affected tests in 25 files.

Sixteen responsive smoke scenarios cover both manual checkers at 1440x900, 1024x768, 390x844 and 320x667 with ordinary/reduced motion. Six isolated native mutations and three browser mutations were caught and restored. Reports distinguish observed failures, driver issues and historical results. Read the verification report for exact scope and limitations.

Published copies redact local home/repository/run paths as `<home>`, `<repo>` and `<run>`. Raw logs, full manifests, drivers and recording frames remain in the local run archive; references to those files are archival pointers, not promises of published links. No funded model, sandbox or real reservation workflow was exercised. The walkthrough uses frontend fixtures; authenticated flows were covered by native component controls rather than a new live user session.
