# Ruby Rule Watch

A moderator-only Devvit automation app for /r/ruby. It uses OpenAI's Decisions API with `gpt-6-luna` to assess posts and comments against subreddit rules, and reports likely violations to the mod queue for human review. It never removes, approves, locks or bans anything, and never replies publicly.

**Published unlisted as `ruby-moderation-noti` and installed on /r/ruby.** Processing is off until a moderator turns on **Mod team approved sending content to OpenAI**. Reporting is off for every rule until a moderator selects it.

## Development

Tool versions are managed by `mise.toml` (Node.js 26.10.0, Devvit CLI 0.14.7, aube, gitleaks, hk and Pkl). Dependencies are pinned in `aube-lock.yaml` and installed with [aube](https://aube.sh). The system-test harness requires Node.js 22.15+.

```fish
mise trust
mise install
aube install --frozen-lockfile
mise exec -- hk install
mise run lint
mise run test
mise run build
devvit-cli --help
```

`lint` runs TypeScript, Dillon Mulroy's AntiSlop rules and a redacted gitleaks working-tree scan. All 18 generic AntiSlop rules are enabled; source/tests/local configuration are linted, while upstream vendored code is excluded as upstream recommends. Provenance and licenses are in `tools/oxlint/anti-slop/`. Oxlint and `@oxlint/plugins` are pinned together. No rules are disabled to accommodate application findings; external API and stored JSON are validated with Zod.

hk runs the standard lint and test tasks on pre-commit and `hk check`, using your managed user hooks. GitHub Actions runs lint, test and build on every push and pull request. Mise loads `.env`; no local environment variables are required, so `.env.example` is intentionally empty. The OpenAI key stays in Devvit's encrypted app settings, never `.env`. `build` writes an ignored local actor bundle to `dist/` without uploading or installing it. There is no local server/serve task: Devvit playtesting would install the app and must be separately authorized.

The system test exercises the registered events, menus, forms and scheduler jobs with simulated Reddit, Redis, and OpenAI services. It makes no network requests, uses no real credentials, and does not establish model accuracy or actual Devvit behavior. Its failure logs exercise intentional refusal, report-failure and authorization scenarios.

`devvit.json` uses Devvit's supported `blocks.entry` compatibility path for SDK-defined moderator menus, forms, triggers, and scheduler jobs. The nine event handlers must also be declared in `blocks.triggers`; SDK registration alone does not advertise them in the built actor. An empty `scheduler.tasks` config enables the SDK-defined retention job without replacing its callback. The build verifies the actor's actual advertised event and scheduler methods. No custom post, public webview, or dashboard is created. This compatibility path is marked deprecated in the current schema; migrating to server endpoints is separate work, not an implicit guarantee of indefinite support.

## Fetch Domains

- `api.openai.com` — Required for inference-only classification of bounded Reddit text and context using the Decisions API. The app does not train or fine-tune models.

## Before installing

1. Obtain mod-team approval for OpenAI processing and disclose this practice to the community.
2. This project is registered as `ruby-moderation-noti`. Keep `devvit.json` aligned with that name. The app skips content authored by its runtime app slug.
3. The privacy policy and terms live in `docs/` and are published by GitHub Pages (main branch, `/docs`). They are the app's developer-details URLs:
   - Privacy: `https://nateberkopec.github.io/ruby-rule-watch/privacy/`
   - Terms: `https://nateberkopec.github.io/ruby-rule-watch/terms/`
   Update them in the same change as any behavior they describe. They are not legal advice.
4. Configure `openai-api-key` as an encrypted app secret with `devvit-cli settings set openai-api-key`. Never put the key in source or a Reddit form.

Upload, publication and installation are intentionally not automated.

## Installation settings

- **Mod team approved sending content to OpenAI:** off means no processing or reports.
- **Rules that report to the mod queue:** selected rules file a mod-queue report. Unselected rules are still assessed and counted in stats. Start with one rule and add others once its precision holds up.
- **Maximum mod-queue reports per UTC day:** default 20. Flags beyond the cap are recorded as `capped` and not reported.
- **Work thread title:** default `Work it Wednesday: Who is hiring? Who is looking?`. A post is the work thread when its title matches exactly (case-insensitive) and its author is AutoModerator or a current moderator. Saving settings searches the subreddit and requires at least three such past posts; Reddit search can lag several minutes behind new posts. Empty disables the work rule. There is no schedule matching: /r/ruby's thread has run every two, four and six weeks at different times.
- **Per-rule flag thresholds:** initially 0.95, a provisional cutoff on a model estimate, not measured accuracy. Tune using the stats precision.

## Moderator workflow

Flagged items appear in the mod queue with the report reason `Rule Watch: <rule labels>`, attributed to the app. Moderators act on them normally. The app learns from those actions:

- removing or spamming a flagged item counts as a correct flag;
- approving a flagged item counts as a false positive;
- removing an assessed item the app did not flag counts as a miss.

Actions by AutoModerator and the app itself are ignored. Only the latest assessment of each item, within the 30-day retention window, receives an outcome. Flags nobody acts on are excluded from precision.

The moderator-only subreddit menu item **Rule Watch: stats** shows the last 30 days privately: items assessed, reported, capped and failed, then per rule the flagged, removed and approved counts with precision = removed ÷ (removed + approved), and a count of removals the app did not flag. Mod-queue reports are the app's only outgoing Reddit communication.

The menu callback independently verify current moderator membership on the server.

## Evaluation

`src/rules.ts` defines five separate predicate questions. Important interpretations:

- Ordinary brusqueness is not a High standards violation. That interpretation is provisional.
- Substantive technical criticism is not language bashing.
- Career advice, Ruby job-market discussion and genuinely noncommercial collaboration are allowed.
- Job offers, job-seeking advertisements, freelance/commercial solicitations and recruiting promotion outside the work thread are flagged. Job advertisements inside the work thread must be specifically Ruby jobs and provide the required fields.
- There is no separate serious-harm path.

The app registers Submit, Create and Update events for posts and comments. It fetches current Reddit content rather than trusting event body snapshots. Whitespace-only changes and duplicate delivery are suppressed. It skips AutoModerator, its own app account, removed/spam/deleted content and deleted authors. Human moderators are not exempt.

Evidence includes the target title/body, the parent post for comments, and up to three ancestor comments, ordered oldest first. It excludes account history, private modmail and link/media contents. Limits are 500 title characters, 12,000 target body characters, 6,000 context-post body characters, and 3,000 characters per parent comment. Truncation/missing context is identified. All user content is explicitly treated as untrusted evidence, not instructions.

Before reporting, the app re-fetches the item and suppresses the report if it has been removed, deleted or changed since evaluation. Report reasons contain only rule labels: no excerpts, generated explanations or probabilities.

## Storage and failure behavior

Redis stores content IDs, permalinks, content digests, timestamps, configuration versions, per-rule estimates, flags, report state and moderator-action outcome. It does not store moderator names. Assessment, revision, report-claim and latest-assessment keys expire after 30 days; daily report counters expire after two days. A daily scheduled job prunes expired index entries. No API key or source content is stored in Redis. Digests are not an anonymity guarantee.

Each item is reported at most once during retention, including after edits; edits are still reassessed and counted. The report claim is taken before the daily-cap check and the report call, so a capped or failed report is not retried. There is no fallback channel, retry subsystem, dashboard or historical backfill.

API refusals, invalid answers and request failures are errors, never clean assessments. Failed classifications do not get a successful revision marker. Failure logs contain content IDs and error categories/messages, not source content. Platform redelivery may occur; the small processing lock prevents concurrent duplicate evaluations, not duplicate event delivery.

OpenAI retention is separate: default abuse-monitoring logs can be retained up to 30 days, with policy exceptions; Zero Data Retention is not assumed.

## Verified on Reddit

In /r/ruby_moderation_n_dev: the approval gate, edit reassessment, duplicate-event suppression, mod-queue reports with app attribution, outcomes from moderator remove/approve actions, the work rule inside and outside a moderator-authored work thread, work-title validation on save, and the stats form.

Not established: real-world precision and miss rates on /r/ruby, which need weeks of moderator actions.

## References

- [Devvit triggers](https://developers.reddit.com/docs/capabilities/server/triggers)
- [Devvit HTTP Fetch](https://developers.reddit.com/docs/capabilities/server/http-fetch)
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

## License

MIT. See `LICENSE`. Vendored AntiSlop code in `tools/oxlint/anti-slop/` keeps its upstream licenses.
