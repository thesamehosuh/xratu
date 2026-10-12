# README walkthrough

The demo is a scripted walkthrough of the current, built Xratu webview.
It uses an illustrative issue-board project, synthetic agent/tool events,
and captured browser frames. It does not run a model or benchmark an engine.
No keys, account data, or user workspaces are involved.

The opening follows Start free through OpenCode installation and free model
selection. Installation and availability are simulated, not measured. The next
scene explicitly switches to Xratu's built-in engine with a local model for the
coding workflow; it does not imply that OpenCode supports Xratu subagents.

## Story and pacing

One task connects the scenes: add issue search, test it, and inspect the result.
Keep the Xratu brand in the upper left and a small, muted scene label on the
right. No subtitle or tagline. The actual webview occupies the remaining space.

| Scene | Visible action | Reading time |
| --- | --- | --- |
| Connect | Choose Start free, install OpenCode, show the free model picker | About 5 seconds including pointer movement and simulated progress |
| Task | Type the request, then send it | 0.9 seconds after typing |
| Agents | Stream the response, open a tool result, inspect the other agent | 1.8 and 1.4 seconds on the results |
| Review | Approve the edit, inspect its diff, add a test, reopen the earlier turn | 2.5 seconds before approval; 1.7 seconds on the diff; 1.4 seconds on history |
| Terminal | Open Background and let the dev-server log update | 3.1 seconds including the update |
| Browser | Drag Conversation into the sidebar, inspect the board, filter issues, type a follow-up | 1.4 seconds before search; 1.7 seconds on the result |

Pointer movement leads each interaction. Docking uses the real drag/drop event
handlers and the app's drop highlight. The browser opens before Conversation
moves, keeping the main pane stable throughout the drop. There is no cloned
floating tab. Changes is already visible in the wide sidebar, so no extra tab
click is needed. After the scripted drop, the fixture clears synthetic tab
focus so it does not leave a keyboard outline around a pointer action. Typing
and response streaming are gradual. Holds follow
meaningful changes rather than an equal delay per page. The timing lives in
`test/e2e/readmeDemo.ts` and uses a shared 1.3× playback speed.

## Rebuild and preview

```sh
npm run build:webview
node test/e2e/readme-demo.mjs
node test/e2e/serve.mjs out/readme-demo 4174
```

Open `http://127.0.0.1:4174/` in the collaborative T3 browser. Use
`?locale=fa` for Persian. Click **Play walkthrough** to see the paced sequence.
**Next scene** advances without the reading delays for inspection.
`?inspect=1&locale=en` removes the presentation frame for layout checks.

The page installs the shared Dark Modern fixture from `test/e2e/vscodeTheme.ts`
before the bundled app loads. It records outbound host messages and responds
to checkpoint requests with their actual request IDs.

Before recording, open `/board.html` at 760 × 560. Capture the page with an
empty search as `out/readme-demo/board-all.png`, then type `keyboard` and capture
`out/readme-demo/board-search.png`. Use viewport screenshots, with neither
annotations nor a mouse pointer over the search field. These files are generated
artifacts; the editable source is `test/e2e/readmeDemoBoard.html`.

Record the walkthrough at 1280 × 800. Hide the inspection controls before
starting, then launch playback without awaiting the entire sequence in a
browser automation call:

```js
document.body.classList.add('recording');
void window.xratuDemo.play();
```

Stop after `#demo-status` reads `Complete`. Waiting for the whole playback in
a single T3 evaluate call exceeds its 15-second timeout. The async playback
continues even if that evaluate call times out.

If the T3 recorder is unavailable, Playwright CLI can record the same served
page with `video-start ... --size 1280x800 --fps 24`. Inspect all six scenes,
plus the diff, at 420 and 1280 pixels in both locales before replacing media.

## Export

FFmpeg must be installed and available on PATH. Trim recorder setup time and
excess trailing idle time with the optional start/duration arguments.

```sh
node test/e2e/encode-readme-demo.mjs recording-en.webm assets/brand/xratu-demo.gif
node test/e2e/encode-readme-demo.mjs recording-fa.webm assets/brand/xratu-demo-fa.gif
```

The encoder produces a looping, 1080-pixel GIF at 16 fps with a palette selected
from changed pixels. Inspect the exported animation for cursor jumps, dropped
frames, clipping, legible diff colors, and a clean restart. Keep video masters
under `out/readme-demo`; they are not shipped. Brand media is excluded from the
VSIX by `.vscodeignore`.
