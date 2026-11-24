import { describe, expect, it } from 'vitest';
import type { Persona } from '../src/personas/definitions.js';
import { PERSONAS } from '../src/personas/definitions.js';
import { nextSlots, offsetInSlot, seededJitter } from '../src/personas/scheduler.js';

const HOUR = 3_600_000;

const crowd = (size: number): Persona[] =>
  Array.from({ length: size }, (_, index) => ({
    ...(PERSONAS[0] as Persona),
    handle: `persona_${index}`,
    cadence: { postsPerDay: 24, activeHoursUtc: [0, 24] },
  }));

describe('scheduler jitter', () => {
  it('is the same for the same seed and different for a different one', () => {
    expect(seededJitter('hoops_iq:100')).toBe(seededJitter('hoops_iq:100'));
    expect(seededJitter('hoops_iq:100')).not.toBe(seededJitter('hoops_iq:101'));
    expect(offsetInSlot('hoops_iq', 480_000)).toBe(offsetInSlot('hoops_iq', 480_000));
  });

  it('stays inside [0, 1)', () => {
    for (let index = 0; index < 500; index += 1) {
      const value = seededJitter(`seed-${index}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('spreads 40 personas across the whole hour instead of posting in lockstep', () => {
    const slot = 480_000;
    const offsets = crowd(40).map((persona) => offsetInSlot(persona.handle, slot));

    expect(new Set(offsets).size).toBe(40);
    const quarters = new Set(offsets.map((offset) => Math.floor(offset / (HOUR / 4))));
    expect(quarters.size).toBe(4);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(HOUR / 2);
  });
});

describe('nextSlots', () => {
  const from = Date.UTC(2025, 2, 3, 0, 0, 0);

  it('returns the same plan on every call', () => {
    expect(nextSlots(PERSONAS, from, from + 24 * HOUR)).toEqual(nextSlots(PERSONAS, from, from + 24 * HOUR));
  });

  it('is sorted and only holds slots inside the window', () => {
    const slots = nextSlots(crowd(10), from, from + 6 * HOUR);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.map((slot) => slot.at)).toEqual([...slots.map((slot) => slot.at)].sort((a, b) => a - b));
    for (const slot of slots) {
      expect(slot.at).toBeGreaterThanOrEqual(from);
      expect(slot.at).toBeLessThan(from + 6 * HOUR);
    }
  });

  it('respects the active hours and roughly the daily cadence', () => {
    const persona = PERSONAS[1] as Persona;
    const week = nextSlots([persona], from, from + 7 * 24 * HOUR);
    const [start, end] = persona.cadence.activeHoursUtc;

    for (const slot of week) {
      const hour = new Date(slot.at).getUTCHours();
      expect(hour).toBeGreaterThanOrEqual(start);
      expect(hour).toBeLessThan(end);
    }
    const perDay = week.length / 7;
    expect(perDay).toBeGreaterThan(persona.cadence.postsPerDay * 0.5);
    expect(perDay).toBeLessThan(persona.cadence.postsPerDay * 1.5);
  });
});
