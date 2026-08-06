# Contributing

Thanks for helping Clippy become more reliable and less distracting.

1. Search existing issues before filing a new one.
2. For a bug, include a minimal safe reproduction and the compatibility details
   requested by the issue form. Never post private code, prompts, or secrets.
3. For code changes, create a focused branch and keep unrelated formatting or
   generated files out of the diff.
4. Run `npm test` for the app. If the landing page changed, also run
   `npm run test:website`.
5. Add or update a test when behavior changes. Update the demo/show run for new
   user-visible states.
6. Open a pull request explaining the user problem, the trust/safety impact,
   and how the change was verified.

Use private vulnerability reporting instead of issues or pull requests for
security-sensitive findings. See [SECURITY.md](SECURITY.md).
