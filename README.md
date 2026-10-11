# Ruby Rule Watch

A moderator-only Devvit automation app for /r/ruby. It uses OpenAI's Decisions API with `gpt-6-luna` to flag possible rule violations for human review. It never removes content, reports users, replies publicly, or bans anyone.

**Published unlisted as `ruby-moderation-noti` and installed on /r/ruby. Processing is disabled by default.** Even shadow mode requires mod-team approval because it sends community text to OpenAI.

## Development

Tool versions are managed by `mise.toml` (Node.js 26.10.0, Devvit CLI 0.14.7, hk and Pkl). Dependencies are pinned; this checkout uses Nate's npm-compatible aube and includes `aube-lock.yaml`. The system-test harness requires Node.js 22.15+.

```fish
mise trust
mise install
npm install
mise exec -- hk install
mise run lint
mise run test
mise run build
devvit-cli --help
```

`lint` runs TypeScript, Dillon Mulroy's AntiSlop rules and a redacted gitleaks working-tree scan. All 18 generic AntiSlop rules are enabled; source/tests/local configuration are linted, while upstream vendored code is excluded as upstream recommends. Provenance and licenses are in `tools/oxlint/anti-slop/`. Oxlint and `@oxlint/plugins` are pinned together. No rules are disabled to accommodate application findings; external API and stored JSON are validated with Zod.

hk runs the standard lint and test tasks on pre-commit and `hk check`, using your managed user hooks. Mise loads `.env`; no local environment variables are required, so `.env.example` is intentionally empty. The OpenAI key stays in Devvit's encrypted app settings, never `.env`. `build` writes an ignored local actor bundle to `dist/` without uploading or installing it. There is no local server/serve task: Devvit playtesting would install the app and must be separately authorized.

The system test exercises the registered events, menus and forms with simulated Reddit, Redis, and OpenAI services. It makes no network requests, uses no real credentials, and does not establish model accuracy or actual Devvit delivery behavior. Its failure logs exercise intentional refusal, delivery-failure and authorization scenarios.

`devvit.json` uses Devvit's supported `blocks.entry` compatibility path for SDK-defined moderator menus, forms, triggers, and scheduler jobs. The eight event handlers must also be declared in `blocks.triggers`; SDK registration alone does not advertise them in the built actor. An empty `scheduler.tasks` config enables the SDK-defined retention job without replacing its callback. The build verifies the actor's actual advertised event and scheduler methods. No custom post, public webview, or dashboard is created. This compatibility path is marked deprecated in the current schema; migrating to server endpoints is separate work, not an implicit guarantee of indefinite support.

## Fetch Domains

- `api.openai.com` — Required for inference-only classification of bounded Reddit text and context using the Decisions API. The app does not train or fine-tune models. Installation approval and published privacy/terms documents do not substitute for any permissions or consent Reddit requires for this use case.

## Before installing

1. Obtain mod-team approval for OpenAI processing, including shadow mode, and disclose this practice to the community.
2. This project is registered as `ruby-moderation-noti`. Keep `devvit.json` aligned with that registered name. The app skips content authored by its runtime app slug.
3. Review `PRIVACY.md` and `TERMS.md`, then enter their hosted URLs in the app's developer details. Hosting is prepared in [ruby-rule-watch-policies](https://github.com/nateberkopec/ruby-rule-watch-policies). Enable Settings → Pages → Deploy from a branch → main → / (root), and verify deployment before using these URLs:
   - Privacy: `https://nateberkopec.github.io/ruby-rule-watch-policies/privacy/`
   - Terms: `https://nateberkopec.github.io/ruby-rule-watch-policies/terms/`
   Keep the remote policy text synchronized with these local files. The policies describe this implementation; they are not legal advice.
4. Log in through Devvit and configure `openai-api-key` as an encrypted app secret. Never put the key in source or a Reddit form.
5. Obtain Reddit approval for the app and `api.openai.com` access. Uploaded, unpublished apps are restricted to small test subreddits; a shadow installation on /r/ruby needs the applicable review/publication permissions. This project does not bypass that restriction.
6. Install only after approval. Leave live alerts disabled. Turn on the installation setting **Mod team approved sending content to OpenAI** when ready to start the approved shadow run.

CLI commands, when authorized:

```fish
devvit-cli login
devvit-cli settings set openai-api-key
```

The secret command prompts for the value. Upload, publication, installation, and live activation are intentionally not automated.

## Moderator workflow

Select **Rule Watch: tools** in the subreddit menu, then choose an action and submit. All seven actions are available in that form; opening it does not enable processing, change delivery mode, or send a message. The actions are:

- **Request review report:** displays a moderator-only form containing up to 20 recent flags plus five randomly selected unflagged assessments from the latest 200 records. No content excerpts, messages or OpenAI calls. Each entry has a permalink, rule labels, mode, delivery state, feedback and assessment ID.
- **Record feedback:** paste an assessment ID and choose useful/not useful. Feedback applies to that assessed revision. For an unflagged sample, "not useful" means a missed violation. Reports exclude unflagged assessments from flag-usefulness counts.
- **Test private message:** manually sends a content-free delivery test. A successful API response is not proof of inbox receipt.
- **Delivery mode:** explicitly switch between shadow and live. Live requires processing approval, an API key, a submitted PM test and moderator confirmation of its receipt. It never automatically enables itself or sends a backlog.
- **Inspect work-thread history:** displays a moderator-only form with title/author/date metadata for candidate posts matching `title:work`. Candidates are not automatically trusted. Search coverage is not exhaustive.
- **Confirm work-thread pattern:** configure a title prefix, optional suffix, trusted moderator author, observed scheduled UTC anchor, and a 0–60 minute tolerance. Three distinct historical posts must match this subreddit and pattern, and a moderator must confirm they are authorized work threads. This is a one-time bootstrap, not a recurring post-ID allowlist.
- **Disable work-rule assessment:** removes the confirmed pattern and stops evaluating the work rule.

The work rule is **disabled until a historical pattern is confirmed**. Do not advertise all-five-rule coverage before then. Matching uses the verified title/author plus a fortnightly UTC schedule anchored to an actual post. Any matching historical thread qualifies; there is no age cutoff. If real history does not fit that schedule, revise the matcher before enabling the rule rather than weakening verification.

All menus are moderator-filtered and all menu/form callbacks independently verify current moderator membership on the server. Reports are shown privately to the requesting moderator. Live alerts and manually requested PM tests remain addressed to `nateberkopec`; actual PM delivery remains unverified, so live activation is not ready.

## Evaluation and alerts

`src/rules.ts` defines five separate predicate questions. Important interpretations:

- Ordinary brusqueness is not a High standards violation. That interpretation is provisional.
- Substantive technical criticism is not language bashing.
- Career advice, Ruby job-market discussion and genuinely noncommercial collaboration are allowed.
- Job offers, job-seeking advertisements, freelance/commercial solicitations and recruiting promotion outside an authorized thread are flagged. Actual job advertisements inside a verified thread must be specifically Ruby jobs and provide the required fields.
- There is no separate serious-harm path.

The app registers Submit, Create and Update events for posts and comments. It fetches current Reddit content rather than trusting event body snapshots. Whitespace-only changes and duplicate delivery are suppressed. It skips AutoModerator, its own app account, removed/spam/deleted content and deleted authors. Human moderators are not exempt.

Evidence includes the target title/body, the parent post for comments, and up to three ancestor comments, ordered oldest first. It excludes account history, private modmail and link/media contents. Limits are 500 title characters, 12,000 target body characters, 6,000 context-post body characters, and 3,000 characters per parent comment. Truncation/missing context is identified. All user content is explicitly treated as untrusted evidence, not instructions.

Each enabled rule has its own installation threshold, initially **0.95**. This is a provisional cutoff on a model estimate, **not** measured 95% accuracy. Review about 50 flags plus unflagged samples, tune the rules/thresholds, and aim for nine out of ten alerts worth reviewing before manually enabling live alerts. Human feedback does not automatically retrain or adjust thresholds.

Live alerts contain rule labels, a permalink, an original-content excerpt of up to 800 characters, and the assessment ID. There are no generated explanations or probability claims. Before sending, the app re-fetches the item and suppresses alerts if it has been removed, deleted, or changed since evaluation.

## Storage and failure behavior

Redis stores content IDs, permalinks, content digests, timestamps, configuration versions, per-rule estimates, flags, delivery state and feedback. Assessment/revision/deduplication metadata expires after 30 days. A daily scheduled job prunes expired index entries; report requests also prune. Moderator configuration, delivery mode, the work pattern and PM-test confirmation persist until changed or the installation is removed. No API key is stored in Redis.

There are no persistent copies of source content in app storage. Digests are not an anonymity guarantee. Delivered alert excerpts are retained in Reddit messages outside the app's cleanup. Manually requested reports appear in app forms, not messages. OpenAI retention is separate: default abuse-monitoring logs can be retained up to 30 days, with policy exceptions; eligible ZDR requires approval/configuration and is not assumed here.

Live delivery uses an atomic per-item claim, suppressing subsequent notifications for that item, including edits, within the 30-day retention window. Once deduplication metadata expires, a later edit can produce another alert. A failure after the delivery claim is not retried: at-most-once attempts favor avoiding duplicate messages, not guaranteed delivery. There is no fallback channel, retry subsystem, health dashboard or historical backfill.

API refusals, invalid answers and request failures are errors, never clean assessments. Failed classifications do not get a successful revision marker. Trigger failures log content IDs and error categories/messages, not source content. Platform redelivery may occur; the app has no independent retry queue. The small processing lock prevents concurrent duplicate evaluations; it does not establish exactly-once event delivery.

## Verification still required on Reddit

- Actual PM delivery to `nateberkopec` and platform messaging restrictions/rate limits.
- Menu/form behavior and trigger coverage for edits, filtered content, safety delays and unsupported communities. Registered events do not promise every edit will arrive.
- The actual historical work-thread pattern and scheduled author.
- App/domain review, approved installation, secret configuration and OpenAI project access/retention settings.
- Real-world usefulness and missed-violation rates.

No Reddit mutation, app upload/installation, or OpenAI content request was performed during implementation.

## References

- [Devvit triggers](https://developers.reddit.com/docs/capabilities/server/triggers)
- [Devvit HTTP Fetch](https://developers.reddit.com/docs/capabilities/server/http-fetch)
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
