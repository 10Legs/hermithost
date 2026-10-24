# Agent instructions — HermitHost

These apply to every agent working in this repository.

## Pull requests

- **Visible changes need a demo video.** Any PR that changes what a user sees or how the UI
  behaves (layout, styling, text/copy, links, navigation, forms, new screens, interactions)
  must embed a 15–60 s demo at the top of its description. Backend-, infra-, docs- or
  test-only PRs don't need one. If unsure, include one.
  - Record from the PR branch: `node demos/record.mjs <scenario> [--before origin/main] [--mobile]`.
    One scenario per visible change in `demos/scenarios/`.
  - Real browser on this PR's build, on-screen captions (`ctx.caption`), the full user path,
    and for bug fixes the case that used to fail (`--before origin/main`).
  - Safe data only: stub the API with `demos/fixtures.mjs`; stub external sites. No real
    personal data, passwords, tokens or secrets in the recording.
  - Watch it yourself before publishing; re-record if it doesn't clearly show the change.
  - Commit the GIF + MP4 to the media-only branch `demos` (never merged) under
    `<pr-branch-with-slashes-as-dashes>/`, then embed by that commit's SHA:
    `![demo](https://github.com/10Legs/hermithost/raw/<sha>/<folder>/<name>.gif)` and
    `[Full video (MP4)](https://github.com/10Legs/hermithost/blob/<sha>/<folder>/<name>.mp4)`,
    followed by a short numbered list of what happens.
  - If the PR changes after review, re-record and update the description.
  - Full how-to: `demos/README.md`.
