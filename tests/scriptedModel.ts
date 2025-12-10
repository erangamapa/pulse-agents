import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { DEFAULT_ROUTER_POLICY, ModelRouter } from 'agentloop';

export class ScriptedModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  private cursor = 0;

  constructor(private readonly script: readonly AIMessage[]) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const scripted = this.script[this.cursor];
    if (!scripted) throw new Error('Scripted model ran out of messages.');
    const message = new AIMessage({
      content: scripted.content,
      tool_calls: (scripted.tool_calls ?? []).map((call) => ({ ...call, id: `${call.id}-${this.cursor}` })),
    });
    this.cursor += 1;
    return { generations: [{ text: String(message.content), message }] };
  }

  get calls(): number {
    return this.cursor;
  }
}

export const toolCall = (id: string, name: string, args: Record<string, unknown>): AIMessage =>
  new AIMessage({ content: '', tool_calls: [{ id, name, args, type: 'tool_call' }] });

export const finalAnswer = (text: string): AIMessage => new AIMessage({ content: text });

export const routerFor = (model: ScriptedModel): ModelRouter =>
  new ModelRouter(DEFAULT_ROUTER_POLICY, { open: () => model, cheap: () => model, strong: () => model });
