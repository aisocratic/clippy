# Clippy Mobile

A native companion for Clippy, built with Expo Router and React Native.

**One agent, when one needs you.** The app has a single screen and no
navigation. When an agent is waiting — a permission request, a question, a
finished turn — it shows that one agent and the one decision it is blocked on.
When nothing is waiting it says so and gets out of the way.

That is the whole design. A session list, an activity feed and a settings page
were all in here once, and every one of them was a reason to open the app and
then *read* it rather than answer something. A phone app for coding agents
should be empty almost always, and when it isn't, ask exactly one question.

Which agent gets the screen is decided in exactly one place — `focusOf` in
`src/store/model.ts` — and it takes the one that has been waiting longest, so
answering one never reshuffles what comes next and a new arrival cannot starve
an older one.

## Run it

```bash
cd mobile
npm install
npm run ios       # or npm run android / npm run web
```

The app starts from a deterministic fixture, so every state is reachable
without a Mac running Clippy. On the empty screen, **Demo · send me one** pushes
a fresh request through the same path a relayed one would take.

## Notifications

Local notifications, scheduled by the app itself the moment something starts
waiting (`src/notifications.ts`). The badge always matches what the screen
would show, and clears when nothing is left.

They are local rather than remote because the state is a fixture in this
bundle: there is no server to push from yet. `registerForPush` is the seam for
when there is one — the Mac takes that token and the notification arrives from
outside instead. Nothing else about the flow changes.

Two things worth knowing while testing:

- **Expo Go cannot do remote push** (dropped in SDK 53) and no push token is
  issued on a simulator. Local notifications work in both, which is what this
  app currently sends.
- In Expo Go the permission dialog and the banner say **Expo Go**. A dev or
  TestFlight build says Clippy and carries the clip icon.

## Structure

- `app/_layout.tsx` — providers, status bar, toast
- `app/index.tsx` — the screen
- `src/notifications.ts` — permission, scheduling, badge
- `src/store/` — typed state, `focusOf`, and the interaction actions
- `src/components/` — the buddy, the pending card, the shared primitives
- `src/theme.ts` — the mobile version of Clippy's warm-paper design language

Artwork is generated, not hand-committed: `npm run make-mobile-icons` from the
repo root draws the icons and the notification silhouette from the same clip
sprite the desktop app's `.icns` is built from.
