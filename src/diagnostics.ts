import { z } from 'zod';

export const failureMetadata = z.object({
  code: z.union([
    z.enum([
      'canceled', 'unknown', 'invalid_argument', 'malformed', 'deadline_exceeded', 'not_found',
      'bad_route', 'already_exists', 'permission_denied', 'unauthenticated', 'resource_exhausted',
      'failed_precondition', 'aborted', 'out_of_range', 'unimplemented', 'internal', 'unavailable', 'data_loss',
    ]),
    z.number().int().min(0).max(599),
  ]).optional(),
  status: z.number().int().min(100).max(599).optional(),
}).catch({});

const reasons = [
  { name: 'rate_limited', pattern: /RATELIMIT|rate.limit|too many requests/i },
  { name: 'authentication', pattern: /UNAUTHENTICATED|USER_REQUIRED|not authenticated|unauthorized/i },
  { name: 'permission', pattern: /PERMISSION_DENIED|forbidden|insufficient.scope|not permitted|not allowed/i },
  { name: 'unimplemented', pattern: /UNIMPLEMENTED|not implemented|unknown method/i },
];

export const failureReason = z.object({ message: z.string().optional(), details: z.string().optional() })
  .transform(({ message, details }) => reasons.find(({ pattern }) => pattern.test(`${message ?? ''} ${details ?? ''}`))?.name ?? 'unclassified')
  .catch('unclassified');

export const failureDisplay = z.object({ message: z.string().optional(), details: z.string().optional() })
  .transform(({ message, details }) => (message || details || 'Action failed; inspect the diagnostic logs.')
    .replace(/(?:Bearer|Basic)\s+\S+/gi, '[REDACTED]')
    .replace(/(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/[A-Za-z0-9_./+~=-]{24,}/g, '[REDACTED]')
    .slice(0, 1200))
  .catch('Action failed; inspect the diagnostic logs.');

type FailureMetadata = z.infer<typeof failureMetadata>;

type FailureReason = z.infer<typeof failureReason>;

export function diagnosticFailure(stage: string, metadata: FailureMetadata, reason: FailureReason = 'unclassified'): void {
  console.error(`[rule-watch] ${stage}`, { ...metadata, reason });
}
