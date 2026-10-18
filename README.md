# Ruby Rule Watch

A [Devvit](https://developers.reddit.com/) app that checks new and edited /r/ruby posts and comments against the subreddit's rules using OpenAI's Decisions API (`gpt-6-luna`), and reports likely violations to the mod queue for a human to review. It never removes, approves, locks or bans anything, never replies publicly and never messages anyone.

It is published unlisted on Reddit as `ruby-moderation-noti`. On /r/ruby, processing is on and the Harassment free and No recruiter or work posts rules file reports, capped at 20 a day. The other three rules are assessed and counted, but don't report.

- Privacy policy: https://nateberkopec.github.io/ruby-rule-watch/privacy/
- Terms: https://nateberkopec.github.io/ruby-rule-watch/terms/

## How it works

For every post or comment that is submitted or substantively edited, the app:

1. fetches the current text from Reddit, skipping AutoModerator, the app itself, deleted authors and removed, spam or deleted content;
2. sends the text, plus the parent post and up to three earlier comments for context, to OpenAI as one yes/no question per rule;
3. stores the per-rule estimates and which rules crossed their threshold;
4. if a flagged rule is set to report, re-fetches the item and, if it is unchanged and still up, files a mod-queue report with the reason `Rule Watch: <rule labels>`.

Whitespace-only edits and duplicate events are ignored. Each item is reported at most once in 30 days, even if it's edited later; edits are still reassessed and counted.

The five rules are defined in `src/rules.ts`:

- **Harassment free:** targeted harassment, threats and discriminatory abuse.
- **High standards:** concrete hostility. Ordinary brusqueness doesn't count.
- **Productive disagreement:** trolling, insults, personal attacks and unprofessional conduct.
- **No language bashing:** derogatory attacks on other languages. Technical criticism is fine.
- **No recruiter or work posts:** job offers, job-seeking, freelance solicitation and recruiting outside the work thread. Inside the work thread, job ads must be Ruby jobs with the required fields. Career advice and job-market discussion are fine.

User text is treated as evidence, never as instructions. The model returns probabilities only; reports contain rule labels, not excerpts or explanations.

## Moderator workflow

Rule Watch reports show up in the mod queue like any other report, attributed to `ruby-moderation-noti`. Act on them normally. The app counts those actions as feedback:

- removing or spamming a flagged item counts as a correct flag;
- approving a flagged item counts as a false positive;
- removing an item the app assessed but didn't flag counts as a miss.

Actions by AutoModerator and the app are ignored, and flags nobody acts on don't count toward precision.

**Rule Watch: stats** in the subreddit's mod menu shows the last 30 days privately to the moderator who opens it: items assessed, reported, over the daily cap and failed, then per rule the flagged, removed and approved counts with precision = removed ÷ (removed + approved), plus the number of removals the app missed. Use it to decide when to turn on reporting for another rule or adjust a threshold.

## Backtest

**Rule Watch: open Backtest** in the mod menu of r/ruby_moderation_n_dev opens a moderator-only post that scores /r/ruby's newest 1,000 posts and comments with the live rule wording. It refuses to run on /r/ruby itself. For each rule you can mark the flagged items as worth a look or not, drag the threshold to see what share of flags you'd agree with, and score a rewritten wording against the same items.

Scoring runs as a chain of short scheduler jobs, because Devvit stops each request after about 30 seconds. The first run takes a while; the page shows progress and can be closed.

The **Catches mod removals?** tab lists posts and comments /r/ruby moderators removed or spammed in the last 30 days, with the removal reason if one was given, and whether each wording would have flagged them. The /r/ruby installation keeps a copy of their text for this, in Redis storage shared by all of the app's installations. The copy is deleted after 30 days, when the item is approved, or when it or any post or comment quoted in it is deleted.

To get a push notification for each report, a moderator can open Reddit's notification settings → Mod notifications → the subreddit → Reports, turn on Advanced Setup for Posts and Comments, and set the slider to 1 report.

## Installation settings

Set in the app's settings page for each subreddit:

- **Mod team approved sending content to OpenAI:** off by default. Off means nothing is processed or reported.
- **Rules that report to the mod queue:** none by default. Unselected rules are still assessed and shown in stats.
- **Maximum mod-queue reports per UTC day:** 20 by default. Flags over the cap are recorded as `capped` and not reported.
- **Work thread title:** `Work it Wednesday: Who is hiring? Who is looking?` by default. A post is the work thread when its title matches exactly (ignoring case) and AutoModerator or a current moderator posted it. Saving the settings checks that at least three such posts exist, so a renamed thread can't be saved until Reddit search has indexed three of them. Leave it empty to turn off the work rule.
- **Per-rule flag thresholds:** 0.95 by default. This is a cutoff on the model's estimate, not a measured accuracy.

The OpenAI key is an app-wide secret, set with `devvit-cli settings set openai-api-key`.

## Data

The app sends post and comment text to `api.openai.com`, its only outside domain: the title (up to 500 characters), the body (up to 12,000), and for comments the parent post (up to 6,000) and up to three earlier comments (up to 3,000 each, with their authors' usernames). It never reads account history, modmail, images, video or linked pages.

Redis stores content IDs, permalinks, content digests, scores, flags, report status and moderator outcomes, and no moderator names. The only post and comment text it stores is the copy of removed items described under Backtest. Everything expires after 30 days, and a daily job prunes the index. Logs contain IDs and error details, not content.

See the privacy policy for the full description, including OpenAI's retention.

## Development

Tools are pinned in `mise.toml`: Node.js, the Devvit CLI, [aube](https://aube.sh), gitleaks, [jactionlint](https://github.com/jdx/jactionlint), hk and Pkl.

```fish
mise trust
mise install
aube install --frozen-lockfile
mise exec -- hk install
```

| Task | What it does |
|---|---|
| `mise run lint` | TypeScript, [AntiSlop](tools/oxlint/anti-slop/UPSTREAM.md) oxlint rules, a gitleaks scan and jactionlint |
| `mise run test` | The system test: every trigger, menu, form and scheduler job against simulated Reddit, Redis and OpenAI. No network calls |
| `mise run build` | Builds the Backtest page and server, bundles the actor into `dist/` and checks it advertises all eleven event handlers and the scheduler |

hk runs lint and test before each commit. GitHub Actions runs lint, test and build on every push and pull request. There is no `serve` task: running the app means installing it on a subreddit.

Layout:

```
src/main.ts           settings, triggers, scheduler jobs and the mod menu
src/watch.ts          assessment and reporting
src/evidence.ts       the text and context sent to OpenAI
src/removals.ts       copies of removed items for the Backtest
src/backtest.ts       Backtest scoring job
src/backtest-store.ts Backtest Redis keys and records
src/server/           Backtest web server
src/client/           Backtest page
public/               Backtest HTML, CSS and English strings
src/decisions.ts      OpenAI Decisions API client
src/rules.ts          the five rule questions
src/storage.ts        Redis records and retention
src/stats.ts          stats rows
src/work-threads.ts   work-thread recognition and title validation
src/subreddit.ts      subreddit name and moderator lookups
src/diagnostics.ts    redacted failure logging
tests/                system test and bundle check
docs/                 GitHub Pages site: privacy policy and terms
```

`devvit.json` uses Devvit's `blocks.entry` path, which the current schema marks as deprecated. Event handlers must also be listed in `blocks.triggers`, or the built actor won't advertise them; `mise run build` catches that. Update `docs/privacy.md` and `docs/terms.md` in the same change as any behavior they describe. GitHub Pages publishes `docs/` from `main`.

## Releasing

```fish
mise exec -- devvit-cli publish --version 0.0.15
mise exec -- devvit-cli install ruby_moderation_n_dev ruby-moderation-noti@0.0.15
mise exec -- devvit-cli install ruby ruby-moderation-noti@0.0.15
mise exec -- devvit-cli logs ruby ruby-moderation-noti --since 10m
```

`publish` uploads the source to Reddit and asks for consent each time. The README shown on the developer portal comes from the latest published version. On install or upgrade, the app schedules its retention job and cancels any scheduled job it no longer defines. Test on r/ruby_moderation_n_dev first; its work-thread fixture posts must stay, or its settings can't be saved.

## Not yet known

Real-world precision and miss rates on /r/ruby. The stats will show them as moderators act on reports.

## License

MIT. See `LICENSE`. The vendored AntiSlop code in `tools/oxlint/anti-slop/` keeps its upstream licenses.
