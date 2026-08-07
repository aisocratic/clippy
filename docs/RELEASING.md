# Releasing Clippy for macOS

Public binaries must be traceable to `main`, Developer ID signed, notarized by
Apple, stapled, and accompanied by a SHA-256 checksum. Local ad-hoc builds are
useful for testing but are not release artifacts.

## One-time signing setup

1. Install an Apple **Developer ID Application** certificate and its private
   key in the login keychain.
2. Store App Store Connect notarization credentials in the keychain. The
   profile name is a local label of your choosing — whatever you pick here is
   what `CLIPPY_NOTARY_PROFILE` has to say at build time. Authenticate with an
   app-specific password (created at account.apple.com) for the Apple ID
   enrolled in the signing team, or with an App Store Connect API key:

   ```bash
   xcrun notarytool store-credentials clippy-notary \
     --apple-id you@example.com --team-id TEAMID
   ```

3. Confirm the signing identity appears in:

   ```bash
   security find-identity -v -p codesigning
   ```

Never commit certificates, passwords, API keys, or exported keychains.

## Release checklist

1. Merge all release PRs and check out an up-to-date `main` with no local
   changes.
2. Update `package.json` and release notes, then run:

   ```bash
   npm ci
   npm run test:all
   ```

3. Build the release. Unlike `npm run package`, this command fails closed if
   either signing or notarization is not configured:

   ```bash
   CLIPPY_SIGN_IDENTITY="Developer ID Application: …" \
   CLIPPY_NOTARY_PROFILE="clippy-notary" \
   npm run package:release
   ```

4. Confirm the output reports Developer ID signing, accepted notarization, a
   successful staple validation, and a checksum file. Mount the DMG on a clean
   Mac and verify drag-to-Applications, first launch without a Gatekeeper
   bypass, one-click hook installation, one Claude session, one Codex session,
   hook update, and uninstall.
5. Create the annotated version tag on the tested commit. Draft the GitHub
   release from that tag and upload both:

   - `Clippy-for-Claude-Code.dmg`
   - `Clippy-for-Claude-Code.dmg.sha256`

6. Release notes must state architecture, minimum macOS version, tested agent
   versions, known limitations, and the exact commit. Download the draft assets
   once and verify their checksum before publishing.
7. After publishing, test the landing-page `releases/latest/download/...` URL
   and preserve the previous release as the rollback artifact.

## Current blocker

The development Mac audited on August 6, 2026 has no valid code-signing
identity. The public `v0.1.0` DMG is arm64, ad-hoc signed, not notarized, and was
built from an unmerged branch stack. It should be replaced by a new release
from merged `main`; do not silently replace its asset with different bytes.
