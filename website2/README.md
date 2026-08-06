# Clippy website v2

The new landing page for [Clippy](https://github.com/AISocratic/clippy), a tiny
macOS teammate for Claude Code and Codex sessions.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by the development server.

## Build and test

```bash
npm run build
npm test
```

`npm run build:pages` creates the static bundle published to the repository's
`gh-pages` branch.

The site uses the product's real buddy animations and interface captures from
the parent Clippy project.

## Optional website analytics

The landing page supports Umami pageviews and click events without enabling
analytics in the Clippy app. Copy `.env.example` to `.env.local`, set both
`NEXT_PUBLIC_UMAMI_SCRIPT_URL` and `NEXT_PUBLIC_UMAMI_WEBSITE_ID`, and rebuild.
If either variable is absent, the rendered site emits no analytics script.
The tracker respects Do Not Track and records CTA location, never code, prompts,
project names, or app activity.
