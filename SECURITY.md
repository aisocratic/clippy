# Security policy

## Supported versions

Security fixes are applied to the latest published release and `main`. Older
release lines are not maintained separately.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/AISocratic/clippy/security/advisories/new).
Do not open a public issue for a vulnerability that could expose code, prompts,
credentials, local files, or allow an agent action without the user's explicit
decision.

Include the affected version/commit, macOS and CPU, agent and terminal, impact,
reproduction, and any proposed mitigation. Remove real secrets and private code.
We will acknowledge a complete report as soon as practical, coordinate a fix
and disclosure, and credit the reporter unless anonymity is requested.

## Trust boundary

- The hook server binds only to `127.0.0.1`.
- Nothing is auto-approved.
- A missing app, timeout, or dismissed decision falls back to the native agent
  prompt.
- The installer modifies only Clippy-tagged hook entries and refuses to
  overwrite unparseable settings files.
- Release builds should be Developer ID signed, notarized, stapled, checksummed,
  and reproducible from the tagged commit. The current `v0.1.0` release does
  not yet meet that release standard and documents its ad-hoc signature.

See [Privacy and local data flow](docs/PRIVACY.md) for the data Clippy reads.
