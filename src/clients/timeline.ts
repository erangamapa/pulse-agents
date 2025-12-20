import { z } from 'zod';
import {
  conversation,
  dmMessage,
  post,
  profile,
  reply,
  type Conversation,
  type CreateDm,
  type CreatePost,
  type CreateReply,
  type DmMessage,
  type Post,
  type Profile,
  type Reply,
} from 'sportsbook-contracts';
import { joinUrl, requestJson, type FetchLike } from './http.js';

const thread = z.object({ post, replies: z.array(reply) });
export type Thread = z.infer<typeof thread>;

const postsFound = z.object({ posts: z.array(post) });
const messages = z.object({ messages: z.array(dmMessage) });
const account = z.object({ accountId: z.string().min(1) });

export interface PostResult {
  betId: string;
  result: 'won' | 'lost' | 'void';
  payout?: { currency: string; amount: string };
}

export interface Timeline {
  createPost(input: CreatePost): Promise<Post>;
  getThread(postId: string): Promise<Thread>;
  createReply(postId: string, input: CreateReply): Promise<Reply>;
  findPostsByBet(betId: string): Promise<Post[]>;
  recordPostResult(postId: string, result: PostResult): Promise<void>;
  getProfile(handle: string): Promise<Profile>;
  getConversation(conversationId: string): Promise<Conversation>;
  getDmMessage(conversationId: string, messageId: string): Promise<DmMessage>;
  listDmMessages(conversationId: string, limit?: number): Promise<DmMessage[]>;
  createDm(conversationId: string, input: CreateDm): Promise<DmMessage>;
  resolveAccountId(handle: string): Promise<string>;
}

export const createTimelineClient = (baseUrl: string, fetch: FetchLike): Timeline => {
  const url = (path: string): string => joinUrl(baseUrl, path);
  const enc = encodeURIComponent;

  return {
    createPost: (input) =>
      requestJson({ fetch, url: url('/v1/posts'), method: 'POST', body: input, schema: post }),

    getThread: async (postId) =>
      requestJson({ fetch, url: url(`/v1/posts/${enc(postId)}/thread`), schema: thread }),

    createReply: (postId, input) =>
      requestJson({
        fetch,
        url: url(`/v1/posts/${enc(postId)}/replies`),
        method: 'POST',
        body: input,
        schema: reply,
      }),

    findPostsByBet: async (betId) =>
      (
        await requestJson({
          fetch,
          url: url(`/v1/posts?betId=${enc(betId)}`),
          schema: postsFound,
        })
      ).posts,

    recordPostResult: async (postId, result) => {
      await requestJson({
        fetch,
        url: url(`/v1/posts/${enc(postId)}/result`),
        method: 'PATCH',
        body: result,
        schema: z.unknown(),
      });
    },

    getProfile: (handle) =>
      requestJson({ fetch, url: url(`/v1/profiles/${enc(handle)}`), schema: profile }),

    getConversation: (conversationId) =>
      requestJson({
        fetch,
        url: url(`/v1/dms/${enc(conversationId)}`),
        schema: conversation,
      }),

    getDmMessage: (conversationId, messageId) =>
      requestJson({
        fetch,
        url: url(`/v1/dms/${enc(conversationId)}/messages/${enc(messageId)}`),
        schema: dmMessage,
      }),

    listDmMessages: async (conversationId, limit = 20) =>
      (
        await requestJson({
          fetch,
          url: url(`/v1/dms/${enc(conversationId)}/messages?limit=${limit}`),
          schema: messages,
        })
      ).messages,

    createDm: (conversationId, input) =>
      requestJson({
        fetch,
        url: url(`/v1/dms/${enc(conversationId)}/messages`),
        method: 'POST',
        body: input,
        schema: dmMessage,
      }),

    resolveAccountId: async (handle) =>
      (
        await requestJson({
          fetch,
          url: url(`/v1/profiles/${enc(handle)}/account`),
          schema: account,
        })
      ).accountId,
  };
};
