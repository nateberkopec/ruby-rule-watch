import { z } from 'zod';
import { evaluationInstructions, rules, type RuleName } from './rules.js';
import { diagnosticFailure, failureMetadata } from './diagnostics.js';

const decisionResponse = z.object({
  answers: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('predicate'), name: z.string(), probability: z.number().min(0).max(1) }),
    z.object({ type: z.literal('refusal'), name: z.string() }),
  ])),
});

export type Evidence = {
  target: { kind: 'post' | 'comment'; title?: string; body: string };
  context: {
    post?: { title: string; body: string };
    parents: { body: string; author: string }[];
    truncated: boolean;
  };
  verifiedWorkThread: boolean;
};

export type Question<Name extends string> = { name: Name; instructions: string };

export function liveQuestions(workRuleEnabled: boolean): Question<RuleName>[] {
  return rules.filter((rule) => workRuleEnabled || rule.name !== 'work_posts')
    .map((rule) => ({ name: rule.name, instructions: `${evaluationInstructions} ${rule.instructions}` }));
}

export async function assess<Name extends string>(
  apiKey: string,
  input: Evidence,
  questions: Question<Name>[],
): Promise<Partial<Record<Name, number>>> {

  const response = await fetch('https://api.openai.com/v1/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-6-luna',
      input: JSON.stringify(input),
      questions: questions.map((question) => ({ type: 'predicate', ...question })),
    }),
  }).catch((error) => {
    diagnosticFailure('decisions_request_rejected', failureMetadata.parse(error));
    throw error;
  });

  console.log('[rule-watch] decisions_response', { status: response.status });

  if (!response.ok) throw new Error(`Decisions HTTP ${response.status}`);
  const parsed = decisionResponse.safeParse(await response.json());

  if (!parsed.success) {
    console.error('[rule-watch] decisions_response_invalid');
    throw new Error('Invalid Decisions response');
  }

  const result = parsed.data;

  const scores: Partial<Record<Name, number>> = {};

  for (const question of questions) {
    const matches = result.answers.filter((answer) => answer.name === question.name);
    const answer = matches[0];

    if (matches.length !== 1 || !answer) throw new Error(`Missing or duplicate answer: ${question.name}`);

    if (answer.type === 'refusal') throw new Error(`Decisions refusal: ${question.name}`);


    scores[question.name] = answer.probability;
  }

  return scores;
}
