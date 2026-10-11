# Ruby Rule Watch terms

Ruby Rule Watch is a moderation-assistance tool for authorized subreddit moderators. It identifies possible rule violations, displays moderator-only reports, and can send private live alerts. All moderation decisions remain with human moderators.

## Authorized use

Install and enable processing only with the mod team's approval and required Reddit platform permissions. Disclose external processing to the community. Use an authorized OpenAI API project and configure its secret through Devvit. The project owner is responsible for OpenAI charges and compliance with applicable Reddit and OpenAI terms.

Access to moderator actions requires current moderator membership. Reports are displayed privately to the requesting moderator. Live alerts are addressed to `nateberkopec`. Do not broaden access or redistribute community data in ways inconsistent with the privacy policy and platform terms.

## Limitations

AI assessments can be wrong. A returned probability is an estimate, not a guarantee. Do not treat alerts as evidence warranting an automatic removal, ban, or accusation. Review the actual content and context.

Coverage is limited to available text and bounded conversation context. The app does not inspect media or linked content, guarantee delivery of every event, perform historical backfill, guarantee message delivery, or provide operational failure notifications. Work-rule assessment remains disabled until moderators confirm an actual scheduled-thread pattern.

Shadow mode sends content to OpenAI even though it sends no automatic alerts. Live mode must be explicitly enabled after review and a successful private-message receipt check. Delivery claims suppress duplicate attempts; failed message delivery is not retried by the app.

## Data and service availability

Use is subject to the accompanying privacy policy and third-party platform policies. Private alert excerpts are retained separately from the app's expiring assessment metadata. External APIs, beta endpoint behavior, pricing, SDK compatibility and platform permissions may change. The app may be disabled or uninstalled by moderators.

The app is provided as-is without warranties of accuracy, completeness, availability, or suitability. Contact the /r/ruby moderator team through Reddit modmail with questions about the installation.
