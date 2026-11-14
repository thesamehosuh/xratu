# README showcases

Both READMEs use 60-second walkthroughs of the current built Xratu webview.
The GIF previews link to full-quality, 1080p/30fps H.264 videos:

| Locale | Preview | Video |
| --- | --- | --- |
| English | `xratu-demo.gif` | `xratu-showcase.mp4` |
| Persian | `xratu-demo-fa.gif` | `xratu-showcase-fa.mp4` |

The conversation and tool timeline is a scripted reconstruction, labelled in the
video. The demo website runs locally; filtering, project details and mobile
checks execute through Xratu's real shared-browser controller. No model keys or
personal workspaces are used. The studio and projects are fictional, with
supplied generated architecture imagery and illustrative stock photos.

The walkthrough starts typing in an empty chat with the sessions sidebar open.
It adds Browser and Activity through the real tab picker, shows the website
being built, checks its interactions and mobile layout, then applies an Iranian
architecture refinement. The browser stays beside Conversation. There are no
subagents, version badges, end cards, voiceovers or music.

Capture uses the shared VS Code theme fixture with a neutral charcoal palette,
16px interface text, 18px conversation text and 16px code. Captions are single
lines at the top right. Cursor travel, hover and result holds are deliberately
paced; menus scroll their target into view before selection. The app runs in an
iframe so fixed navigation stays inside the presentation window.

## Re-encode previews

FFmpeg must be available on PATH. The MP4 files above are the delivered masters.
The encoder produces looping 1080px previews at 16fps. Full-frame palette
sampling without dithering keeps flat UI surfaces clean:

```sh
node test/e2e/encode-readme-demo.mjs assets/brand/xratu-showcase.mp4 assets/brand/xratu-demo.gif
node test/e2e/encode-readme-demo.mjs assets/brand/xratu-showcase-fa.mp4 assets/brand/xratu-demo-fa.gif
```

Editable session projects and source archives are kept under `output/showcase-en`
and `output/showcase-fa`, outside version control. The older
`test/e2e/readme-demo.mjs` generates the legacy issue-board walkthrough.
Brand media is excluded from the VSIX by `.vscodeignore`.
