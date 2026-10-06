# Committed visual baselines

The PNGs here are the expected rendering of every webview screen, driven by
`test/e2e/screenshots.spec.ts`. They exist because
`webview-ui/src/styles/theme.css` is the second most-edited file in this repo
(45 commits in 3 months) and had no automated visual coverage at all: a colour,
spacing or RTL regression shipped on a fully green build.

`npx playwright test -c test/e2e/playwright.config.ts` compares the live page
against these files and fails with a `*-diff.png` on a mismatch.

## Only the `-linux` baselines are real

Font rasterization, subpixel antialiasing and scrollbar rendering differ per OS,
so a PNG generated on Linux does not match Windows or macOS. The comparison is
skipped off Linux (`test.skip(process.platform !== 'linux')` in the spec) while
every other assertion in the e2e suite keeps running on all three CI legs. The
file names carry the platform because Playwright appends it, so a Windows run
could never silently compare against a Linux baseline even if the gate changed.

## Regenerating

```bash
npm run build:webview
npx playwright test -c test/e2e/playwright.config.ts --update-snapshots   # LINUX ONLY
```

Treat the result as a REVIEW ARTIFACT, not a chore: `--update-snapshots`
rewrites every baseline it re-runs, so a careless regen rubber-stamps whatever
happens to be on screen - including a regression committed next to its own fix.
Read the PNG diff in the PR, screen by screen, and say in the PR description
what changed visually and why.

Never regenerate on Windows or macOS: those rasterizations cannot be matched by
the Linux CI leg, so the commit would turn every future run red.

A regeneration is also the ONLY correct response to a font-availability change
on the CI image (`--vscode-font-family` resolves to the machine's `system-ui`).
That is a deliberate, reviewed diff - do not "fix" a red baseline by widening a
tolerance; a tolerance is how a real regression gets waved through.
