# Releasing Clippy for macOS

Public binaries must be traceable to `main`, Developer ID signed, notarized by
Apple, stapled, and accompanied by a SHA-256 checksum. Local ad-hoc builds are
useful for testing but are not release artifacts.

## GitHub Actions credentials

The tag-triggered `Release macOS installer` workflow is the source of truth for
public artifacts. Add these repository secrets before creating the first
release tag:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded Developer ID Application certificate and private key (`.p12`) |
| `MACOS_CERTIFICATE_PASSWORD` | Password used to export that `.p12` |
| `MACOS_SIGNING_IDENTITY` | Full Developer ID Application common name |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER_ID` | App Store Connect API issuer ID |
| `APPLE_API_PRIVATE_KEY_BASE64` | Base64-encoded App Store Connect API `.p8` key |

The workflow imports these values into a temporary runner keychain. Never
commit certificates, passwords, API keys, or exported keychains.

## Local verification

For an emergency local release, install the Developer ID certificate and store
an App Store Connect API-key credential profile named `clippy-notary` in the
login keychain, then run:

```bash
CLIPPY_SIGN_IDENTITY="Developer ID Application: …" \
CLIPPY_NOTARY_PROFILE="clippy-notary" \
npm run package:release
npm run verify:release
```

Local output must not be uploaded manually; publish a version tag so the CI
workflow builds and verifies the exact release asset.

## Release checklist

1. Merge all release PRs and check out an up-to-date `main` with no local
   changes.
2. Update `package.json` and release notes, then run:

   ```bash
   npm ci
   npm run test:all
   ```

3. Create and push an annotated tag matching `package.json` exactly (for
   example, package version `0.3.1` requires tag `v0.3.1`). The release workflow
   runs the test suite, signs and notarizes the app and DMG, staples both
   tickets, verifies the mounted app with Gatekeeper, and publishes the release
   only after every check passes.

4. Release notes must state architecture, minimum macOS version, tested agent
   versions, known limitations, and the exact commit. Download the draft assets
   once and verify their checksum before publishing.
5. After publishing, test the landing-page `releases/latest/download/...` URL
   and preserve the previous release as the rollback artifact.
