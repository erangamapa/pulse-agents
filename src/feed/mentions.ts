import { mentionCreated } from 'sportsbook-contracts';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { Responder } from '../personas/responder.js';
import type { ThreadReplier } from './threads.js';

export interface EtiquetteLimits {
  maxThreadReplies: number;
  cooldownMs: number;
  /** Agent to agent mentions a thread may spend before only a person can restart it. */
  hopBudget: number;
}

export type EtiquetteVerdict =
  | { allow: true }
  | { allow: false; reason: 'self_reply' | 'hop_budget' | 'max_replies' | 'cooldown' };

interface ThreadState {
  hopsLeft: number;
  replies: Map<string, { count: number; lastAt: number }>;
}

/**
 * Thread manners as code. An agent can be told to talk, but this decides
 * whether it may. The hop budget is shared by every agent in a thread, so two
 * agents mentioning each other run out of hops instead of looping.
 */
export class ThreadEtiquette {
  private readonly threads = new Map<string, ThreadState>();

  constructor(
    private readonly limits: EtiquetteLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checks the rules and, when the reply is allowed, spends the hop it needs. */
  admit(input: {
    threadId: string;
    agentHandle: string;
    byHandle: string;
    byKind: 'human' | 'agent';
  }): EtiquetteVerdict {
    const state = this.stateFor(input.threadId);
    if (input.byHandle === input.agentHandle) return { allow: false, reason: 'self_reply' };

    if (input.byKind === 'agent' && state.hopsLeft <= 0) return { allow: false, reason: 'hop_budget' };

    const history = state.replies.get(input.agentHandle);
    if (history && history.count >= this.limits.maxThreadReplies) {
      return { allow: false, reason: 'max_replies' };
    }
    if (history && this.now() - history.lastAt < this.limits.cooldownMs) {
      return { allow: false, reason: 'cooldown' };
    }

    if (input.byKind === 'agent') state.hopsLeft -= 1;
    else state.hopsLeft = this.limits.hopBudget;
    return { allow: true };
  }

  recordReply(threadId: string, agentHandle: string): void {
    const state = this.stateFor(threadId);
    const history = state.replies.get(agentHandle);
    state.replies.set(agentHandle, { count: (history?.count ?? 0) + 1, lastAt: this.now() });
  }

  hopsLeft(threadId: string): number {
    return this.stateFor(threadId).hopsLeft;
  }

  private stateFor(threadId: string): ThreadState {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const created: ThreadState = { hopsLeft: this.limits.hopBudget, replies: new Map() };
    this.threads.set(threadId, created);
    if (this.threads.size > 10_000) {
      const oldest = this.threads.keys().next().value;
      if (oldest !== undefined) this.threads.delete(oldest);
    }
    return created;
  }
}

export type MentionOutcome =
  | { status: 'replied'; replyId: string }
  | { status: 'ignored'; reason: 'invalid_event' | 'unknown_handle' | 'no_reply' }
  | { status: 'blocked'; reason: Extract<EtiquetteVerdict, { allow: false }>['reason'] };

export interface MentionDeps {
  responders: ReadonlyMap<string, Responder>;
  etiquette: ThreadEtiquette;
  replier: ThreadReplier;
  logger: Logger;
  metrics: Metrics;
}

const normalizeHandle = (handle: string): string => handle.replace(/^@/, '').toLowerCase();

export const createMentionConsumer = (deps: MentionDeps) => ({
  async handle(raw: unknown): Promise<MentionOutcome> {
    const parsed = mentionCreated.safeParse(raw);
    if (!parsed.success) return { status: 'ignored', reason: 'invalid_event' };
    const event = parsed.data;

    const responder = deps.responders.get(normalizeHandle(event.mentionedHandle));
    if (!responder) return { status: 'ignored', reason: 'unknown_handle' };

    const byHandle = normalizeHandle(event.byHandle);
    // Only an explicit human kind refills the hop budget. A missing kind must not be a way around it.
    const byKind = event.byKind ?? 'agent';

    const verdict = deps.etiquette.admit({
      threadId: event.postId,
      agentHandle: responder.handle,
      byHandle,
      byKind,
    });
    if (!verdict.allow) {
      deps.metrics.increment('mentions_blocked', { reason: verdict.reason });
      deps.logger.info({ postId: event.postId, agent: responder.handle, reason: verdict.reason }, 'mention blocked');
      return { status: 'blocked', reason: verdict.reason };
    }

    const reply = await deps.replier.reply({
      responder,
      postId: event.postId,
      inReplyTo: event.replyId,
    });
    if (!reply) return { status: 'ignored', reason: 'no_reply' };

    deps.etiquette.recordReply(event.postId, responder.handle);
    return { status: 'replied', replyId: reply.replyId };
  },
});

export type MentionConsumer = ReturnType<typeof createMentionConsumer>;
