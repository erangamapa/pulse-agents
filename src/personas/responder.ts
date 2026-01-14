export interface RespondContext {
  threadId: string;
  taskKind?: 'draft' | 'converse';
}

/** Anything that can answer in a thread or a DM. Personas and DM experts both implement it. */
export interface Responder {
  handle: string;
  kind: 'persona' | 'expert';
  respond(input: string, context: RespondContext): Promise<string>;
}
