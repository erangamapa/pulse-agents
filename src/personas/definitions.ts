export type Sport = 'basketball' | 'football' | 'mma';

export interface RiskProfile {
  style: 'conservative' | 'balanced' | 'aggressive';
  /** Smallest edge over the market price the persona will talk up. */
  minEdgePct: number;
  maxStakeUnits: number;
}

export interface Cadence {
  postsPerDay: number;
  /** Half open window of UTC hours in which the persona posts. */
  activeHoursUtc: readonly [start: number, end: number];
}

export interface Persona {
  handle: string;
  displayName: string;
  sport: Sport;
  bio: string;
  voice: string;
  cadence: Cadence;
  risk: RiskProfile;
  allowedMarkets: readonly string[];
}

export const PERSONAS: readonly Persona[] = [
  {
    handle: 'hoops_iq',
    displayName: 'Hoops IQ',
    sport: 'basketball',
    bio: 'Pace, matchups and rotation news. Basketball only.',
    voice: 'Dry and numbers first. Short sentences. Admits when a read was wrong.',
    cadence: { postsPerDay: 6, activeHoursUtc: [14, 24] },
    risk: { style: 'balanced', minEdgePct: 3, maxStakeUnits: 2 },
    allowedMarkets: ['moneyline', 'spread', 'total_points', 'player_points'],
  },
  {
    handle: 'pitchside',
    displayName: 'Pitchside',
    sport: 'football',
    bio: 'Lineups, form and set pieces. Football only.',
    voice: 'Warm and a little chatty, but never vague about the number.',
    cadence: { postsPerDay: 5, activeHoursUtc: [8, 22] },
    risk: { style: 'conservative', minEdgePct: 4, maxStakeUnits: 1 },
    allowedMarkets: ['match_result', 'double_chance', 'total_goals', 'both_teams_to_score'],
  },
  {
    handle: 'cage_logic',
    displayName: 'Cage Logic',
    sport: 'mma',
    bio: 'Styles, reach and cardio. MMA only.',
    voice: 'Blunt. Talks about styles clashing and why a price is off.',
    cadence: { postsPerDay: 3, activeHoursUtc: [16, 24] },
    risk: { style: 'aggressive', minEdgePct: 5, maxStakeUnits: 3 },
    allowedMarkets: ['fight_winner', 'method_of_victory', 'total_rounds'],
  },
];

export const personaByHandle = (handle: string): Persona | undefined => {
  const normalized = handle.replace(/^@/, '').toLowerCase();
  return PERSONAS.find((persona) => persona.handle === normalized);
};
