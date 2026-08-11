# Clippy Mobile

A native companion for Clippy, built with Expo Router and React Native. The
first release concentrates on the moments that pull you back to a coding
session: permission requests, questions, completed turns, current activity,
context usage, and sending the next prompt.

## Run it

```bash
cd mobile
npm install
npm run ios       # or npm run android / npm run web
```

The app currently starts with a deterministic demo workspace so every state is
available without a running Mac companion. Connection settings and the local
state boundary are intentionally isolated so a LAN relay or hosted sync layer
can replace the fixture without rewriting the screens.

## Structure

- `app/` — Expo Router screens and navigation
- `src/components/` — Clippy-native cards, buttons, and buddy artwork
- `src/store/` — typed session state and interaction actions
- `src/theme.ts` — the mobile version of Clippy's warm-paper design language

