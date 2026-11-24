import type {
  AccountLimits,
  Bet,
  Conversation,
  CreateDm,
  CreatePost,
  CreateReply,
  DmMessage,
  LeaderboardRow,
  Money,
  OddsTick,
  Performance,
  PlaceBetRequest,
  Post,
  PricedSlip,
  Profile,
  Reply,
  Selection,
  SlipDraft,
  StakeCheckResult,
} from 'sportsbook-contracts';
import { HttpError } from '../src/clients/http.js';
import type { BettingEngine, SelectionRef } from '../src/clients/bettingEngine.js';
import type { Stats } from '../src/clients/stats.js';
import type { PostResult, Thread, Timeline } from '../src/clients/timeline.js';
import type { OddsSource } from '../src/tools/shared.js';

export const NOW = '2025-03-01T12:00:00.000Z';

export const tick = (selectionId: string, overrides: Partial<OddsTick> = {}): OddsTick => ({
  eventId: 'evt-1',
  marketId: 'mkt-1',
  selectionId,
  price: '1.9000',
  status: 'active',
  seq: 1,
  ts: NOW,
  ...overrides,
});

export class FakeOdds implements OddsSource {
  readonly requests: string[] = [];
  private readonly ticks = new Map<string, OddsTick>();

  set(value: OddsTick): void {
    this.ticks.set(value.selectionId, value);
  }

  async current(ref: SelectionRef): Promise<OddsTick> {
    this.requests.push(ref.selectionId);
    return this.ticks.get(ref.selectionId) ?? tick(ref.selectionId);
  }
}

export class FakeEngine implements BettingEngine {
  readonly placeKeys: string[] = [];
  readonly bets = new Map<string, Bet>();
  stakeAllowed = true;
  repriced = false;
  slipValid = true;
  failPlacementWith: Error | undefined;

  async getSelectionTick(ref: SelectionRef): Promise<OddsTick> {
    return tick(ref.selectionId);
  }

  async priceSlip(draft: SlipDraft): Promise<PricedSlip> {
    return {
      slipId: 'slip-1',
      selections: draft.selections.map((selection) => ({ ...selection, repriced: this.repriced })),
      stake: draft.stake,
      potentialReturn: { currency: draft.stake.currency, amount: '19.00' },
      valid: this.slipValid,
      rejections: this.slipValid ? [] : ['market closed'],
    };
  }

  async getAccountLimits(accountId: string): Promise<AccountLimits> {
    const cap: Money = { currency: 'USDT', amount: '1000' };
    return { accountId, maxStakePerBet: cap, dailyCap: cap };
  }

  async checkStakeLimits(
    _accountId: string,
    _stake: Money,
    _selections: readonly Selection[],
  ): Promise<StakeCheckResult> {
    return this.stakeAllowed ? { allowed: true } : { allowed: false, bindingLimit: 'maxStakePerBet' };
  }

  async placeBet(request: PlaceBetRequest, idempotencyKey: string): Promise<Bet> {
    if (this.failPlacementWith) throw this.failPlacementWith;
    this.placeKeys.push(idempotencyKey);
    const existing = this.bets.get(idempotencyKey);
    if (existing) return existing;
    const created: Bet = {
      betId: `bet-${this.bets.size + 1}`,
      accountId: request.onBehalfOf ?? 'unknown',
      selections: [{ eventId: 'evt-1', marketId: 'mkt-1', selectionId: 'sel-1', price: '1.9000' }],
      stake: request.stake,
      status: 'open',
      ...(request.placedBy ? { placedBy: request.placedBy } : {}),
      createdAt: NOW,
    };
    this.bets.set(idempotencyKey, created);
    return created;
  }
}

export class FakeStats implements Stats {
  async getPerformance(handle: string): Promise<Performance> {
    return { handle, settledBets: 40, winRate: 0.55, roi: 0.04 };
  }

  async getLeaderboard(): Promise<LeaderboardRow[]> {
    return [];
  }
}

export class FakeTimeline implements Timeline {
  readonly posts: Post[] = [];
  readonly replies: Reply[] = [];
  readonly dms: DmMessage[] = [];
  readonly results: { postId: string; result: PostResult }[] = [];
  readonly conversations = new Map<string, Conversation>();
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  async createPost(input: CreatePost): Promise<Post> {
    const created: Post = { ...input, postId: this.id('post'), replyCount: 0, createdAt: NOW };
    this.posts.push(created);
    return created;
  }

  async getThread(postId: string): Promise<Thread> {
    const found = this.posts.find((candidate) => candidate.postId === postId);
    if (!found) throw new Error(`No post ${postId}.`);
    return { post: found, replies: this.replies.filter((candidate) => candidate.postId === postId) };
  }

  async createReply(postId: string, input: CreateReply): Promise<Reply> {
    const created: Reply = { ...input, replyId: this.id('reply'), postId, createdAt: NOW };
    this.replies.push(created);
    return created;
  }

  async findPostsByBet(betId: string): Promise<Post[]> {
    return this.posts.filter((candidate) => candidate.betRef?.betId === betId);
  }

  async recordPostResult(postId: string, result: PostResult): Promise<void> {
    this.results.push({ postId, result });
  }

  async getProfile(handle: string): Promise<Profile> {
    return { handle, kind: 'human', displayName: handle };
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    const found = this.conversations.get(conversationId);
    if (!found) throw new Error(`No conversation ${conversationId}.`);
    return found;
  }

  async getDmMessage(conversationId: string, messageId: string): Promise<DmMessage> {
    const found = this.dms.find(
      (candidate) => candidate.conversationId === conversationId && candidate.messageId === messageId,
    );
    if (!found) throw new HttpError(404, `dm/${messageId}`);
    return found;
  }

  async listDmMessages(conversationId: string): Promise<DmMessage[]> {
    return this.dms.filter((candidate) => candidate.conversationId === conversationId);
  }

  async createDm(conversationId: string, input: CreateDm): Promise<DmMessage> {
    const created: DmMessage = { ...input, messageId: this.id('msg'), conversationId, createdAt: NOW };
    this.dms.push(created);
    return created;
  }

  async resolveAccountId(handle: string): Promise<string> {
    return `acct-${handle}`;
  }
}

export class FakeClock {
  constructor(public current = 1_000_000) {}

  now = (): number => this.current;

  advance(ms: number): void {
    this.current += ms;
  }

  sleep = async (ms: number): Promise<void> => {
    this.current += ms;
  };
}
