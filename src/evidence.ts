import type { Comment, Post } from '@devvit/public-api';
import type { Evidence } from './decisions.js';

export function isGone(item: { removed: boolean; spam: boolean; body?: string | undefined }): boolean {
  return item.removed || item.spam || ['[deleted]', '[removed]'].includes(item.body ?? '');
}

export function isExcludedAuthor(authorName: string, appSlug: string): boolean {
  return ['automoderator', appSlug.toLowerCase(), '[deleted]'].includes(authorName.toLowerCase());
}

export async function buildEvidence(
  item: Post | Comment,
  post: Post,
  verifiedWorkThread: boolean,
  lookup: (id: string) => Promise<Comment>,
): Promise<Evidence> {
  const body = item.body ?? '';

  const evidence: Evidence = {
    target: { kind: 'parentId' in item ? 'comment' : 'post', body: body.slice(0, 12_000) },
    context: { parents: [], truncated: body.length > 12_000 || post.title.length > 500 },
    verifiedWorkThread,
  };

  if (!('parentId' in item)) {
    evidence.target.title = post.title.slice(0, 500);

    return evidence;
  }

  const postBody = post.removed || post.spam ? '' : post.body ?? '';
  evidence.context.post = { title: post.title.slice(0, 500), body: postBody.slice(0, 6_000) };
  evidence.context.truncated ||= postBody.length > 6_000;
  let parentId: string = item.parentId;

  for (let depth = 0; depth < 3 && parentId.startsWith('t1_'); depth++) {
    try {
      const parent = await lookup(parentId);

      if (!isGone(parent)) {
        evidence.context.parents.unshift({ body: parent.body.slice(0, 3_000), author: parent.authorName });
        evidence.context.truncated ||= parent.body.length > 3_000;
      }

      parentId = parent.parentId;
    } catch {
      evidence.context.truncated = true;
      break;
    }
  }

  evidence.context.truncated ||= parentId.startsWith('t1_');

  return evidence;
}
