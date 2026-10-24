# PR demo videos

Every pull request that changes something a user can see — layout, styling, text, links,
navigation, forms, new screens, changed interactions — must include a short demo video in the
PR description. Approving a PR ships it to production, so the video is how the reviewer checks
the change works. Backend-, infrastructure-, docs- or test-only PRs don't need one. If unsure,
include one.

## Record

```bash
node demos/record.mjs <scenario> [--before origin/main] [--mobile] [--out <dir>]
```

- Runs from the PR branch checkout. It builds this checkout's frontend, serves it locally,
  drives Chromium through `demos/scenarios/<scenario>.mjs`, and writes
  `<scenario>.mp4` and `<scenario>.gif` (default `.scratch/demos/<scenario>/`).
- `--before origin/main` records the same scenario on `main` first. Use it for bug fixes so
  the video shows the case that used to fail, then the fix.
- `--mobile` adds a phone-viewport segment. The HermitHost dashboard is a desktop admin UI,
  so it's only needed for screens meant to be used on phones.
- Needs: `npm ci` at the repo root, `npx playwright install chromium-headless-shell`, `ffmpeg`.
  `DEMO_CHROMIUM=<path>` points at an already-installed Chromium/headless-shell binary instead.

## Write a scenario

One file per visible change in `demos/scenarios/`, exporting `{ setup(context), run(page, ctx) }`:

- **Safe data only.** The HermitHost API is stubbed in the browser with `stubApi()` and the
  made-up fixtures in `demos/fixtures.mjs`. No real domains, personal data, passwords, tokens
  or secrets may appear anywhere in a recording.
- **Stand-ins for external services.** `stubGithub()` replaces github.com; add similar stubs
  for any other third-party site.
- **Captions on screen.** Use `ctx.caption('what you're doing and what to notice')` for every
  step, and `highlight(locator)` to point at the change.
- **Show the full path** a user takes to reach the change, and the result.
- Aim for **15–60 seconds**.

Watch the MP4 yourself before publishing. If it doesn't clearly show the change working, fix
the scenario and record again. If the PR changes after review, record again and update the
description.

## Publish

Media never goes on `main`. Commit the GIF and MP4 to the media-only branch **`demos`** (never
merged), in a folder named after the PR branch (slashes → `-`), then put this at the top of the
PR description, using the `demos` branch **commit SHA** so the links never change:

```markdown
![demo](https://github.com/10Legs/hermithost/raw/<sha>/<branch-folder>/<scenario>.gif)
[Full video (MP4)](https://github.com/10Legs/hermithost/blob/<sha>/<branch-folder>/<scenario>.mp4)

1. What happens first…
2. …
```

`demos/` is excluded from Docker builds (`.dockerignore`) and isn't imported by the app.
