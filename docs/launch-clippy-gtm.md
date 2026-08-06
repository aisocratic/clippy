# Launch Clippy — GTM strategy

**Prepared:** August 5, 2026  
**Recommended public launch:** Wednesday, August 26, 2026, 12:01 a.m. PT  
**Fallback date:** Wednesday, September 2, 2026, if any launch gate is still red on August 21

## Executive decision

Do not treat the current draft release as the public launch. Use it for a small, high-touch beta, remove the install/trust friction, collect proof from real multi-agent users, and then coordinate a public launch around one clear promise:

> **Answer Claude Code and Codex without finding the right terminal tab.**

Clippy should not position itself as another session monitor. That category is already crowded, and Anthropic now includes a native Agent View that shows multiple sessions and supports inline replies. Clippy's defensible launch wedge is the **complete attention-and-response loop**—permission, plan, question, and review cards—delivered by a distinct, delightful buddy on the session's own window, across Claude Code and Codex, while remaining free, open source, local, and quiet by default.

The launch is successful if it creates an initial group of retained advocates, not merely a high Product Hunt rank. Product Hunt is the public moment; founder-led distribution, AI Socratic, Reddit, GitHub, and direct beta outreach are the acquisition engine.

## Goals and scorecard

The product has no app telemetry, and that privacy promise should remain intact. Measure the website and public distribution funnel, not private in-app behavior.

| Window | Minimum | Target | Stretch |
|---|---:|---:|---:|
| Pre-launch beta | 10 installs, 5 interviews | 20 installs, 10 interviews, 3 quotes | 40 installs, 15 interviews, 5 quotes |
| Launch day | 75 DMG downloads, 25 stars, 10 substantive comments | 200 downloads, 75 stars, 25 comments, Product Hunt top 10 | 500 downloads, 200 stars, 50 comments, Product Hunt top 5 |
| First 7 days | 150 downloads, 50 stars, 10 feedback events | 400 downloads, 150 stars, 25 feedback events | 1,000 downloads, 500 stars, 50 feedback events |
| First 30 days | 300 cumulative downloads, 5 contributors/issues | 750 downloads, 250 stars, 10 contributors/issues, 5 public advocates | 2,000 downloads, 750 stars, 25 contributors/issues, 15 advocates |

**Primary KPI:** qualified downloads—unique clicks from the landing page to the DMG/release, segmented by source.  
**Quality KPI:** people who reply with evidence that they used Clippy with two or more active sessions. Collect this through interviews, support conversations, GitHub issues/discussions, and a voluntary one-click feedback link—never app surveillance.  
**Supporting metrics:** landing sessions, hero-to-download conversion, release asset downloads, GitHub stars, issues/discussions, Product Hunt visitors/comments, Reddit saves/comments, and earned mentions.

## Ideal customer and job to be done

### Primary user

A macOS developer, technical founder, or AI engineer who runs two or more local Claude Code and/or Codex sessions, frequently changes windows or Spaces, and keeps discovering that an agent has been blocked on a small decision.

**Trigger:** “I came back ten minutes later and the agent had been waiting for me the whole time.”  
**Job:** “When several coding agents are working, tell me only when one needs me and let me resolve it immediately without reconstructing which tab it belongs to.”  
**Current alternatives:** checking terminals, native notifications, `claude agents`, a terminal multiplexer, a dashboard/notch app, or auto-approving more actions.  
**Why Clippy:** it preserves the user's existing terminal workflow, makes concurrent sessions visually distinct, and puts the decision—not merely a notification—where the user already is.

### Secondary users

- Claude Code power users who want plan, question, and review loops outside the terminal.
- Developers switching between Claude Code and Codex who want one local interaction layer.
- Open-source/privacy-sensitive users who prefer inspectable hooks and no account or cloud relay.
- Mac utility enthusiasts attracted by the character design and per-window behavior.

### Not the launch audience

- People running only one foreground agent and rarely leaving its terminal.
- Windows/Linux users, mobile-first remote-control users, and teams seeking a cloud control plane.
- Users looking for an agent launcher, transcript browser, full IDE, or unattended auto-approval.

Being explicit about these exclusions makes the promise more credible.

## Market reality and positioning

Anthropic's May 2026 Agent View now manages background Claude Code sessions, shows which need input, and supports inline replies. It validates the pain but removes “multi-session visibility” as a differentiated position ([Anthropic announcement](https://claude.com/blog/agent-view-in-claude-code), [documentation](https://code.claude.com/docs/en/agent-view)).

The independent Mac category is also mature:

| Alternative | What it owns | Clippy's answer |
|---|---|---|
| Claude Code Agent View | Native session list, background agents, peek/reply | Desktop-level response loop for existing terminal sessions; Claude + Codex; per-window visual identity |
| AgentPeek / Assist / Claude Pulse | Notch-native monitoring and approvals, broad agent coverage | Works without a notch; lives on the relevant window; open source; story-driven character UX; plan/review flow |
| AgentManager / Chive / Conan | Dashboards, state, usage, and session navigation | Quiet-by-default, actionable cards instead of another dashboard to watch |
| Redlight Greenlight | Focused permission overlay | Permission + plan + question + end-of-turn review; multi-session characters; Codex |
| Codync / remote tools | Phone/watch status and remote control | Entirely local, immediate desktop response, no remote infrastructure |

Comparable Product Hunt launches show real but bounded demand: Chive reached #7 with 152 points, AgentManager #11 with 144 points, and Redlight Greenlight #8 with 125 points ([Chive](https://www.producthunt.com/products/chive), [AgentManager](https://www.producthunt.com/products/agentmanager), [Redlight Greenlight](https://www.producthunt.com/products/redlight-greenlight-for-claude-code)). A top-10 goal is ambitious and realistic; “Product of the Day or failure” is not.

### Positioning statement

For Mac developers juggling multiple local coding agents, Clippy is the tiny desktop teammate that appears only when an agent needs a human and lets them approve, answer, or review in place. Unlike session dashboards and native Agent View, Clippy stays in the existing workflow, identifies the exact session on its own window, works across Claude Code and Codex, and is free, local, and open source.

### Message hierarchy

1. **Outcome:** Answer your coding agents without hunting through terminal tabs.
2. **Proof:** Approve commands, revise plans, answer questions, and review completed work directly from the floating card.
3. **Parallel-work proof:** One recognizable buddy per session, attached to the correct terminal/editor window.
4. **Trust:** Free, MIT licensed, local-only, no account, no app telemetry, never auto-approves.
5. **Delight:** The useful infrastructure is wrapped in a memorable, ownable character experience.

Avoid leading with token gauges, sprite packs, Drive mode, hook internals, or the nostalgic Clippy joke. They are supporting texture. The opening five seconds must show an agent blocked, the right buddy appearing, one click, and the agent continuing.

## Launch gates

The public launch happens only if every P0 item is green by **Friday, August 21**.

### P0: required

- Merge the launch-critical PR chain to `main`; the public binary must be reproducible from the tagged commit, not a WIP branch.
- Publish a stable `v0.1.0` (or `v1.0.0`) GitHub release with the DMG, checksum, concise release notes, and one-click in-app hook installation.
- Remove the first-open security warning by signing and notarizing the app. If this genuinely cannot ship in time, make the right-click-open step unmissable and accept a materially lower conversion rate. Do not hide it.
- Make the landing-page primary CTA a direct **Download for macOS** action. “View on GitHub” becomes secondary.
- State compatibility precisely: macOS version, Apple Silicon/Intel status, Claude Code/Codex versions, local sessions only, and known Codex limitations.
- Add a 30–45 second silent-caption demo showing three moments: permission, question/plan, and finished review. The first five seconds show the problem and resolution.
- Run a clean-machine install test on at least three Macs and a five-session stress test. Verify install, hook upgrade, uninstall, Gatekeeper behavior, failure-safe fallback, and both agent integrations.
- Add support paths: GitHub Issues, a short troubleshooting page, and a feedback/contact link monitored throughout launch week.
- Add privacy-respecting website analytics and source attribution. Plausible or Umami is appropriate; track `download_click`, `github_click`, `demo_play`, and `install_help_click`. App telemetry remains off.
- Recruit at least 10 external beta users; obtain three specific quotes or screen recordings and close every launch-blocking issue.

### P1: strongly recommended

- Add Homebrew Cask installation after the signed/notarized release is stable.
- Add a GitHub social preview, repository topics, screenshots near the README top, `SECURITY.md`, `CONTRIBUTING.md`, and issue templates. GitHub notes that the README should quickly explain what a project does, why it is useful, and how to start ([GitHub README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)).
- Put a 20-second looping product GIF above the README fold.
- Add a comparison/FAQ section: Agent View, notch apps, remote tools, security, and why permissions are never automatic.
- Prepare a rollback binary and a same-day hotfix procedure.

### Current readiness snapshot

As of August 5, the local suite passes **108/108 tests**, but the repo has only one GitHub star, no published release, a draft DMG built from an unmerged branch chain, an unsigned/ad-hoc-signed install path, multiple launch-critical PRs, and no visible landing funnel analytics. The fundamentals are promising; the distribution surface is not yet launch-ready.

## Three-phase launch plan

### Phase 1 — Proof beta: August 6–14

Goal: turn product claims into observed outcomes.

1. Invite 20–30 people personally from AI Socratic, the founder's LinkedIn network, and known Claude Code/Codex power users. Target 10–20 completed installs.
2. Use the draft release only through a clearly labeled beta link. Offer a 15-minute setup call; watch the install rather than explaining it.
3. Ask each user to run two sessions and complete one permission, one question/plan, and one review. Record: install failure, time to first card, confusing copy, false/missed alerts, and whether they would keep it running.
4. End with four questions: “What almost stopped you?”, “What would you use instead?”, “Which moment felt most valuable?”, and “Who else has this exact problem?”
5. Turn the best observed moment into the demo and launch copy. Ask permission for a concrete quote.

### Phase 2 — Build demand: August 15–25

- Fix P0 beta findings and freeze launch scope on August 21.
- Publish the stable release and landing page privately; verify every source link and event.
- Schedule the Product Hunt page, upload all media, and enable the coming-soon teaser.
- Post one founder story on LinkedIn: the “ten-minute problem,” a short native video, and an invitation for 20 beta testers. Do not announce the full launch yet.
- Share a technical build note about safely turning lifecycle hooks into decisions. This becomes the source material for Reddit and Show HN, not an SEO article padded with marketing copy.
- Personally notify 40–60 relevant supporters in three groups: beta users, AI Socratic builders, and developer-tool peers. Ask them to try it or join the conversation on launch day—never to upvote.
- Prepare all posts, replies, screenshots, tracking links, support macros, and a live scorecard.

### Phase 3 — Coordinated public launch: August 26 onward

Use one story across channels but stagger distribution so the maker can participate deeply in each community.

| Date | Channel | Purpose |
|---|---|---|
| Wed Aug 26 | Product Hunt, founder LinkedIn, AI Socratic email/community, X | Coordinated public moment and social proof |
| Thu Aug 27 | r/ClaudeCode weekly showcase or approved standalone post | Highest-intent user feedback |
| Fri Aug 28 | Show HN | Technical credibility and open-source users |
| Sat Aug 29 | r/codex | Codex-specific feedback and compatibility discovery |
| Mon Aug 31 | r/MacApps, if account eligibility is met | Mac utility enthusiasts |
| Tue Sep 1 | DevHunt, Uneed, relevant directories | Durable discovery/backlinks |
| Thu Sep 3 | Console.dev and targeted newsletters | Earned editorial reach |
| Week 2 | Build retrospective with real metrics | Second founder/LinkedIn and community wave |

If the current r/ClaudeCode showcase thread timing changes, use the next moderator-designated thread. Rules and pinned threads must be rechecked on the day of posting.

## Product Hunt playbook

Product Hunt allows makers to self-hunt, says there is no discernible third-party-hunter advantage, and prohibits directly asking people to upvote. Ask people to visit, try, and comment instead ([official launch guide](https://www.producthunt.com/launch)). Schedule for 12:01 a.m. PT to receive the full 24-hour cycle unless a stronger external event dictates otherwise. Product Hunt supports scheduling up to one month in advance ([preparation guide](https://www.producthunt.com/launch/preparing-for-launch)).

### Listing copy

**Name:** Clippy  
**Tagline (56 characters):** Answer Claude Code + Codex without finding the right tab  
**Pricing:** Free  
**Suggested tags:** AI Coding Agents, Developer Tools, Mac  
**Primary URL:** the landing page, with no UTM parameters because Product Hunt does not accept tracked URLs; attribute the referrer on the landing page.

**Description (under 500 characters):**

> Clippy is a free, open-source Mac app that appears only when a local Claude Code or Codex session needs you. Approve or deny a command, revise a plan, answer a question, or review finished work from a floating card—then the right agent continues. Every session gets a distinct buddy on its own window. Everything stays local; there is no account, cloud relay, app telemetry, or auto-approval.

### Gallery story

Product Hunt requires at least two gallery images and recommends 1270×760; the required thumbnail should be square, ideally 240×240 and under 3 MB. It reports that 53% of Product-of-the-Day winners since 2021 included video and 70% of Product-of-Day/Week/Month launches included a maker first comment ([official content checklist](https://www.producthunt.com/launch/preparing-for-launch)). Prepare:

1. **Hero/video:** “Your agent isn't slow. It's waiting for you.” Show a card resolved in one click.
2. **Complete loop:** permission → plan/question → review, with minimal labels.
3. **Parallel sessions:** three named buddies attached to three windows.
4. **Trust:** local hook flow, no cloud/account/telemetry, never auto-approves.
5. **Open source:** GitHub, MIT, easy install, exact platform support.

Use an animated Clippy thumbnail only if its first frame communicates the product at rest; GIF animation does not autoplay until hover.

### Maker first comment

> Hey Product Hunt—I'm Federico. I built Clippy after repeatedly doing the same ridiculous thing: start several coding agents, switch to other work, and return later to find one had been waiting on a tiny permission prompt the whole time.
>
> Clippy gives every local Claude Code or Codex session a small buddy. It stays out of the way while the agent works, appears on that session's window when a human is needed, and lets you approve, answer, revise a plan, or review the result right there.
>
> I care about the trust boundary: Clippy is free and MIT licensed, runs locally, has no account or app telemetry, and never auto-approves. If it is closed or a hook times out, the normal terminal prompt takes over.
>
> The question I'm trying to answer today is: **does this make running 3–5 agents feel calmer, or is it one more thing on your screen?** I'd especially value feedback from people using Claude Code and Codex side by side. Try it and tell me what feels useful, distracting, or unclear.

### Launch-day operating rhythm

- 12:01 a.m. PT: confirm listing, links, video, download, and first comment.
- 12:15 a.m.: notify beta users and close peers with the live link; ask for honest experience/questions.
- 6:30–9:00 a.m.: founder LinkedIn, AI Socratic, X, and direct messages in small batches.
- Every 30 minutes through 6:00 p.m.: respond substantively to every Product Hunt comment and support issue.
- 9:00 a.m., noon, 4:00 p.m.: record source traffic, conversion, downloads, stars, comment themes, and incidents.
- End of day: thank contributors, publish a small real metric or lesson, and triage bugs. Do not celebrate rank without sharing user value.

## Reddit playbook

Reddit is not a broadcast channel. Reddit's own small-business guidance says to be human before being a salesperson and notes that every community has its own promotion rules ([Reddit guidance](https://www.business.reddit.com/learning-hub/articles/smb-how-to-use-reddit)). Participate before launch, disclose affiliation, post natively, tailor the story, and remain available for replies. Never paste the same launch copy across communities.

### Priority communities

| Community | Approach | Draft angle | Gate |
|---|---|---|---|
| r/ClaudeCode | Highest priority. Use the weekly showcase, or a substantive standalone post with the current “Built with Claude Code” flair if allowed. | Hook architecture, the ten-minute waiting problem, and what was built with Claude Code/Codex | Recheck pinned thread/rules; include what it is, problem, how Claude Code was used, repo/demo, and creator disclosure |
| r/ClaudeAI | Post only if it adds a different technical lesson or use the designated showcase route. | Why explicit permission prompts beat auto-approval and how the fail-safe works | Current automated rule examples require creator disclosure, how Claude helped, what it does, free access, and minimal marketing |
| r/codex | A Codex-specific compatibility post, not a cross-post. | What Codex lifecycle hooks can and cannot support; request test cases from multi-session users | Verify rules/modmail; disclose current question-card limitation |
| r/MacApps | Mac utility story with real product screenshots. | `[OS] Clippy — a free local buddy for Claude Code + Codex sessions` | Current rules require 10 community karma, `[OS]` prefix for open source, correct pricing flair, and roughly 30 days between promotions ([rule update](https://www.reddit.com/r/macapps/comments/1qghsc5/new_post_guidelines_and_updates_on_rmacapps/)) |
| r/SideProject | Optional and lower intent. Use only after the specialist communities. | What launching into a suddenly crowded category changed about the positioning | Value-first retrospective, not “please support my launch” |

Do not post in r/macOS: its current self-promotion policy permits only Mac App Store apps and points direct-distribution developers to r/macapps ([policy](https://www.reddit.com/r/MacOS/comments/1ntopuw/new_rules_for_app_self_promotion/)). Avoid r/programming and broad AI communities unless a moderator explicitly approves a genuinely technical post.

### r/ClaudeCode draft

**Title:** I built a local Clippy that answers Claude Code's permission, plan, question, and review prompts

> I kept running 3–5 Claude Code sessions, switching away, and finding one had been blocked on a small question for ten minutes. Notifications told me something happened, but I still had to find the right terminal.
>
> I built Clippy, a free MIT-licensed Mac app that uses lifecycle hooks on localhost. Each session gets a different pixel buddy attached to its own terminal/editor window. It stays hidden while Claude works and appears only when the session needs a decision. The card can feed an approval, revised plan, AskUserQuestion answer, or end-of-turn feedback back through the hook. If the app is closed or the hold times out, it returns no decision and Claude's normal terminal UI takes over.
>
> Claude Code helped build and test the hook state machine, especially the failure-safe and multi-session cases; Codex was used to add and test the second integration. The repo and DMG are here: [link]. No account, cloud relay, app telemetry, or auto-approval.
>
> I'm looking for blunt feedback from people who actually run several sessions: does the per-window buddy reduce tab hunting, or would you prefer a single list/notch UI? Also interested in terminal/IDE combinations that fail to attach to the right window.

### r/codex draft

**Title:** I added Codex to an open-source Mac overlay for multi-agent approvals—looking for hook edge cases

Lead with the exact Codex implementation: permission and Stop decisions work in the same cards as Claude Code, local rollout transcripts provide context/token totals, non-zero shell exits are inferred from `PostToolUse`, and `request_user_input` remains a read-only card that jumps to Codex's native picker. Ask users which missing native hook matters most. This honesty is more useful than pretending the integrations are identical.

## Show HN

Post only after the signed/notarized binary is immediately usable. Show HN requires something people can try, discourages signup/email barriers, and explicitly says not to ask friends to vote or comment ([Show HN guidelines](https://news.ycombinator.com/showhn.html)).

**Title:** `Show HN: Clippy – a local, open-source Mac buddy for Claude Code and Codex`

The first comment should be technical and compact: why terminal notifications were insufficient; localhost hook/decision architecture; timeout/no-op safety; how a session maps to a terminal window; why Electron was chosen; what remains imperfect; and a direct request for architecture, security, and terminal-compatibility feedback. Link to the GitHub repo as the submission URL so the product is immediately inspectable and runnable.

Do not submit Show HN on Product Hunt day. The same maker needs to be present for both conversations.

## Founder, AI Socratic, and owned distribution

This is the highest-leverage channel set. The founder's public LinkedIn profile has roughly 10,000 followers, and AI Socratic already convenes AI engineers and founders. Use that trust carefully: demonstrate a useful build, do not turn a community into an upvote pool.

### LinkedIn launch post

Use a native 30–45 second captioned video. Suggested opening:

> Coding agents aren't always slow. Sometimes they're waiting for you.
>
> I kept starting several Claude Code and Codex sessions, moving on to other work, and coming back ten minutes later to find one blocked on a permission prompt. So I brought back Clippy—but this time he is useful.

Then show the action loop, state that it is free/local/open source, and ask: “If you run more than one coding agent on a Mac, try it and tell me the first moment that feels annoying.” Put the download in the post and a source-tagged link in the first comment only if current LinkedIn behavior makes that preferable; test both during beta rather than relying on folklore.

### AI Socratic

- Recruit beta users from people who have already attended Claude Code/Codex workshops.
- Run a five-minute live demo at the next relevant event and invite hands-on testers via QR code.
- Send one launch email/community message framed as an open-source member build and feedback request.
- Ask chapter ambassadors for **testers**, not reposts. Give them a demo clip only after they have used it or want to share it authentically.
- Host a 30-minute launch-week session: “Managing five coding agents without auto-approving everything.” Clippy is the demo, while the content remains useful without it.

### X and direct outreach

Use a short native loop with one sentence: “Your coding agent wasn't slow. It was waiting for you.” Follow with a technical thread on the hook safety model. Direct outreach should be individual and relevant: beta users, people who have publicly complained about blocked agents, Mac developer-tool reviewers, and maintainers of Claude Code resource lists. Never automate replies or promote into unrelated complaint threads.

## GitHub and durable discovery

- Publish a real GitHub Release with binary and checksum; GitHub Releases are specifically designed to package software, release notes, and binary assets ([GitHub Releases docs](https://docs.github.com/en/repositories/releasing-projects-on-github)).
- Make the repo's first screen conversion-oriented: outcome headline, demo GIF, Download button, compatibility, trust claims, three steps, and technical details below.
- Add topics: `claude-code`, `openai-codex`, `coding-agents`, `macos`, `electron`, `developer-tools`, `hooks`, `open-source`.
- Add a 1280×640 social preview; GitHub recommends this size for best display ([GitHub social preview guidance](https://docs.github.com/en/enterprise-server@3.17/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)).
- Submit a small PR to genuinely relevant curated lists such as Awesome Claude Code only after verifying its contribution rules. Avoid mass directory PRs.
- Keep Issues and Discussions active during launch. Label `good first issue`, `terminal compatibility`, `agent integration`, and `launch feedback`.

## Secondary launch surfaces and earned media

Prioritize by audience fit, not the number of directory logos accumulated.

1. **Console.dev** — pitch after the stable release with the technical differentiator, demo, and repo. It reviews 2–3 tools weekly and accepts submissions at `hello@console.dev` ([selection criteria](https://console.dev/selection-criteria)).
2. **DevHunt** — developer-tool audience; submit the week after Product Hunt using the technical gallery and open-source positioning.
3. **Uneed** — lower priority, useful for durable discovery; queue without paying unless launch data shows general-maker demand. Its own guidance says it can complement Product Hunt rather than replace it ([Uneed comparison](https://help.uneed.best/getting-started/uneed-vs-product-hunt-the-differences)).
4. **Claude Code resource lists/community newsletters** — send a one-paragraph factual pitch and demo. Ask to be evaluated, not guaranteed coverage.
5. **Mac app reviewers/YouTubers** — target 10 people who already cover developer utilities. Offer a build and direct access to the maker; no paid endorsement in the initial launch.
6. **Indie Hackers/dev.to/Hashnode** — republish a real technical retrospective after launch data exists. Do not spend launch week manufacturing generic content.

Skip BetaList for this release: the product is already usable and there is no waitlist objective. Skip paid Product Hunt hunters, mass directory-submission services, broad press releases, cold influencer blasts, and paid Reddit ads until organic conversion identifies a repeatable audience/message.

## Asset checklist

- 30–45 second captioned hero demo in 16:9, 1:1, and vertical crops.
- 5–8 second loop showing blocked → buddy appears → approve → agent continues.
- Product Hunt 240×240 thumbnail under 3 MB, two or more 1270×760 gallery images, YouTube demo, description, first comment, makers, tags, and teaser.
- GitHub 1280×640 social preview, README GIF, release notes, checksum, install/uninstall and troubleshooting docs.
- Three real beta quotes with role/use case and permission.
- Product screenshots with no simulated claim that the product does not support.
- LinkedIn post, X post/thread, AI Socratic email/community post, Reddit-native drafts, Show HN first comment, Console.dev pitch.
- Support macros for Gatekeeper, hook install, port collision, Accessibility, terminal mapping, Codex trust, uninstall, and “app not running.”
- Live source/metric dashboard and incident log.

## Measurement and experiments

Use first-party landing events with source parameters on links you control. Product Hunt itself rejects tracked listing URLs, so use referrer attribution there. Reconcile website events with GitHub release asset download counts daily.

### Funnel

`source impression → landing visit → demo play → DMG click → release download → voluntary feedback/star/issue`

The final installation/activation step remains intentionally unobserved. Ask beta users directly and use aggregate public proxies after launch.

### First four experiments

| Hypothesis | Test | Success condition |
|---|---|---|
| Action beats monitoring | Hero A: “watch every session”; Hero B: “approve, answer, review without the tab hunt” | B raises download-click conversion by 20%+ |
| Per-window identity is meaningful | Demo A: one generic card; Demo B: three named buddies on three windows | B raises 75%-video completion or qualitative preference |
| Open source/local overcomes trust friction | Trust block near CTA vs below features | Near-CTA version raises DMG clicks and reduces security objections |
| Gatekeeper destroys conversion | Compare beta completion before and after signing/notarization | Clean-install completion improves by 25%+ |

Do not split-test tiny traffic forever. Use beta interviews to choose first, then confirm on public traffic.

## Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Seen as a nostalgic gimmick | Medium / high | Lead with the one-click response loop; use the character as proof of session identity and delight |
| “Anthropic already built this” | High / high | Acknowledge Agent View; compare honestly; focus on desktop-local, cross-agent, actionable cards, and existing terminal workflow |
| Dense competitor category | High / high | Avoid generic monitor language; demonstrate plan/question/review and per-window identity in the first ten seconds |
| Unsigned 104 MB Electron app undermines trust | High / high | Sign/notarize, publish checksum/source tag, document data flow; pursue native size/performance later only if retention justifies it |
| Hook/API changes break launch | Medium / high | Pin tested agent versions, compatibility matrix, smoke tests, failure-safe fallback, rollback build |
| Permission UI raises security concern | Medium / high | Show exact command/context, never auto-approve, timeout to native prompt, security documentation and responsible disclosure path |
| Launch spike without retention | High / medium | Beta cohort, feedback loop, issue triage, week-two retrospective, and a 30-day roadmap based on observed use |
| Reddit removal/backlash | Medium / medium | Build community participation first, recheck rules, ask modmail when uncertain, disclose affiliation, stagger and tailor posts |
| Product Hunt rank becomes the goal | Medium / medium | Manage against downloads, qualified feedback, advocates, and contributor activity; rank is supporting evidence only |

## Budget and ownership

Recommended cash budget: **$300–$1,000**, mostly Apple Developer Program/signing, a simple analytics service if needed, caption/video tooling, and optional device testing. Do not buy votes, hunters, reviews, directory bundles, or launch-day ads.

One launch owner should control the calendar and go/no-go decision. Assign explicit owners for release engineering, landing/analytics, demo/assets, beta/support, Product Hunt, Reddit/HN, community/earned media, and measurement. On launch day, no owner should be responsible for both production incidents and channel replies.

## Execution backlog

1. Stabilize, sign/notarize, tag, and publish the reproducible macOS release.
2. Convert the landing page from GitHub/source-first to direct-download-first and add disclosed web analytics.
3. Complete compatibility, security, troubleshooting, support, and open-source repo hygiene.
4. Recruit and run the 10–20 person proof beta; capture issues, observed activation, and quotes.
5. Produce the hero video, short loop, screenshots, social previews, and testimonial assets.
6. Build and schedule the Product Hunt listing; prepare the first comment and launch-day response desk.
7. Prepare the founder/AI Socratic launch sequence and personalized supporter outreach.
8. Establish Reddit participation, verify rules/modmail, and finalize community-specific posts.
9. Prepare Show HN, DevHunt, Uneed, resource-list, newsletter, and Mac reviewer submissions.
10. Build the live scorecard, source links, support macros, incident plan, and daily launch-week reporting.
11. Publish the launch, run support/replies, and issue a transparent week-one retrospective.
12. Evaluate the 30-day outcome and create the next epic based on retention evidence and repeated user requests.

## Source notes

This strategy uses current platform policies and market evidence as of August 5, 2026. Channel rules and product capabilities change quickly; recheck Product Hunt, subreddit, HN, and agent compatibility rules immediately before publishing. The most decision-relevant sources are linked inline, especially Product Hunt's official guide, HN's official Show HN rules, Anthropic's Agent View materials, current subreddit policy announcements, GitHub documentation, and live competitor pages.
