# Ruby Rule Watch privacy policy

## Purpose and access

Ruby Rule Watch helps subreddit moderators find possible rule violations for human review. It reports likely violations to the subreddit's mod queue. It does not remove, approve or lock content, ban users, or reply publicly. Processing is disabled until the installing moderators explicitly approve it.

Only current subreddit moderators can change the app's settings, view its stats, or send stats to the mod inbox.

## Data processed

The app reads post titles, post self-text, comment bodies, limited ancestor-comment context, usernames needed for thread context and exclusions, and content identifiers/permalinks. To recognize the subreddit's work thread it reads historical post titles and authors, and checks whether an author is a current moderator. It reads moderator approve, remove and spam actions on posts and comments: the target identifier, the action and the acting moderator's username, which is used only to ignore actions by AutoModerator and the app. It does not process private modmail, account histories, image/video contents or the contents of linked websites.

Selected text and limited context are sent to OpenAI's Decisions API for classification. Classification instructions treat community text as evidence rather than instructions. No anonymity guarantee is made; Reddit text can contain personal information supplied by its authors.

## App storage

Reddit-hosted Redis storage contains content identifiers, permalinks, content digests, assessment timestamps, rule/configuration versions, estimates, flags, report status, and whether a moderator later removed or approved the item. Moderator usernames are not stored. This metadata expires after 30 days; daily report counters expire after two days. Index entries are pruned daily.

The app does not persist copies of source post/comment bodies. Digests are not guaranteed to be anonymous. Installation settings persist until changed or the app is uninstalled. The OpenAI API key is held in Devvit's encrypted app-secret settings, not Redis or source code.

App error logs are intended to contain identifiers and error information, not source content. Logs are subject to Reddit's platform retention policies rather than the app's cleanup.

## Reports and notifications

Mod-queue reports are visible to the subreddit's moderators and contain only rule labels. The stats view, and the stats notification sent to the subreddit's modmail weekly or on request, contain only aggregate counts. Reports and modmail are retained by Reddit and are not deleted by the app's 30-day cleanup.

## OpenAI retention

According to OpenAI's published API data controls, API data is not used for model training by default. Default abuse-monitoring logs may be retained up to 30 days, subject to policy/legal exceptions. Zero Data Retention is available only to eligible, approved customers with appropriate configuration and exceptions. This app does not assume or promise ZDR. Moderators must verify their OpenAI project's data controls before enabling processing.

See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and [Reddit's privacy policy](https://www.reddit.com/policies/privacy-policy).

## Questions and removal

Contact the /r/ruby moderator team through Reddit modmail with questions about this installation. Deleting Reddit content does not recall reports already filed or data already sent to OpenAI. App metadata expires under the policy above. Moderators can disable processing or uninstall the app.
