# Ruby Rule Watch privacy policy

Draft for moderator review and hosting before installation.

## Purpose and access

Ruby Rule Watch helps subreddit moderators identify possible rule violations for human review. It does not automatically remove content, ban users, or make public replies. Processing is disabled until the installing moderators explicitly approve it. Shadow mode also requires approval.

Only current subreddit moderators can request reports, record feedback, configure authorized work-thread recognition, or change delivery mode. Reports and alerts are sent to the Reddit account `nateberkopec`.

## Data processed

The app reads post titles, post self-text, comment bodies, limited ancestor-comment context, usernames needed for thread context and exclusions, and content identifiers/permalinks. For work-thread verification it reads historical post titles, authors and creation times. It does not process private modmail, account histories, image/video contents or the contents of linked websites.

Selected text and limited context are sent to OpenAI's Decisions API for classification. Classification instructions treat community text as evidence rather than instructions. No anonymity guarantee is made; Reddit text can contain personal information supplied by its authors.

## App storage

Reddit-hosted Redis storage contains content identifiers, permalinks, content digests, assessment timestamps, rule/configuration versions, estimates, flags, delivery status and moderator feedback. This assessment and deduplication metadata expires after 30 days. Index entries are pruned daily and when reports are requested.

The app does not persist copies of source post/comment bodies. Digests are not guaranteed to be anonymous. Configuration, delivery mode, a confirmed work-thread pattern and private-message test confirmation persist until changed or the app installation is removed. The OpenAI API key is held in Devvit's encrypted app-secret settings, not Redis or source code.

App error logs are intended to contain identifiers and error information, not source content. Logs are subject to Reddit's platform retention policies rather than the app's assessment cleanup.

## Private messages

Live alerts include short original-content excerpts and permalinks. Manually requested shadow reports include identifiers, links, rule labels and assessment metadata, but no body excerpts. Work-thread inspection reports include title, author and creation-time metadata. These Reddit messages are retained separately from Redis records and are not automatically deleted by the app's 30-day cleanup.

## OpenAI retention

According to OpenAI's published API data controls, API data is not used for model training by default. Default abuse-monitoring logs may be retained up to 30 days, subject to policy/legal exceptions. Zero Data Retention is available only to eligible, approved customers with appropriate configuration and exceptions. This app does not assume or promise ZDR. Moderators must verify their OpenAI project's data controls before enabling processing.

See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and [Reddit's privacy policy](https://www.reddit.com/policies/privacy-policy).

## Questions and removal

Contact the /r/ruby moderator team through Reddit modmail with questions about this installation. Deleting Reddit content does not recall previously delivered messages or data already sent to OpenAI. App assessment metadata expires under the policy above. Moderators can disable processing or uninstall the app.
