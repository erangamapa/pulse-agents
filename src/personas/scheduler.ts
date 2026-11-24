import type { Persona } from './definitions.js';

const HOUR_MS = 3_600_000;

const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

/** A value in [0, 1) that depends only on the seed. Same seed, same value, on any machine. */
export const seededJitter = (seed: string): number => {
  let state = hashSeed(seed) + 0x6d2b79f5;
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
};

export const slotOf = (epochMs: number): number => Math.floor(epochMs / HOUR_MS);

/** Milliseconds into the hour at which a persona posts, so personas never fire together. */
export const offsetInSlot = (handle: string, slot: number): number =>
  Math.floor(seededJitter(`${handle}:${slot}:offset`) * HOUR_MS);

const postsInSlot = (persona: Persona, slot: number): boolean => {
  const [start, end] = persona.cadence.activeHoursUtc;
  const hour = ((slot % 24) + 24) % 24;
  if (hour < start || hour >= end) return false;
  const chance = persona.cadence.postsPerDay / (end - start);
  return seededJitter(`${persona.handle}:${slot}:post`) < chance;
};

export interface PostSlot {
  handle: string;
  slot: number;
  at: number;
}

/** Every slot that falls in [fromMs, toMs), earliest first. */
export const nextSlots = (
  personas: readonly Persona[],
  fromMs: number,
  toMs: number,
): PostSlot[] => {
  const slots: PostSlot[] = [];
  for (let slot = slotOf(fromMs); slot <= slotOf(toMs); slot += 1) {
    for (const persona of personas) {
      if (!postsInSlot(persona, slot)) continue;
      const at = slot * HOUR_MS + offsetInSlot(persona.handle, slot);
      if (at >= fromMs && at < toMs) slots.push({ handle: persona.handle, slot, at });
    }
  }
  return slots.sort((a, b) => a.at - b.at || a.handle.localeCompare(b.handle));
};
