import { describe, expect, it } from 'vitest';
import { fold, nameSimilarity, normalizeName, pairSimilarity } from '../../src/core/names.js';

describe('name normalization', () => {
  it('folds diacritics and punctuation', () => {
    expect(fold('FC Viktoria Plzeň')).toBe('fc viktoria plzen');
    expect(fold('Šťastný, Ondřej')).toBe('stastny ondrej');
  });
  it('strips club noise but keeps distinguishing tags', () => {
    expect(normalizeName('AC Sparta Praha', 'football').core).toBe('sparta praha');
    expect(normalizeName('Česko U21', 'football').tags).toEqual(['u21']);
    expect(normalizeName('Slavia Praha (Ž)', 'football').tags).toEqual(['women']);
    expect(normalizeName('Sparta Praha B', 'football').tags).toEqual(['reserve']);
  });
});

describe('name similarity', () => {
  it('tenis: jednopísmenná iniciála Z./W. není značka žen', () => {
    expect(normalizeName('Bergs Z.', 'tennis').tags).toEqual([]);
    expect(nameSimilarity('Bergs Z.', 'Bergs, Zizou', 'tennis')).toBeGreaterThan(0.95);
    expect(nameSimilarity('Bergs Z.', 'Zizou Bergs', 'tennis')).toBeGreaterThan(0.95);
    expect(nameSimilarity('Kwon S. W.', 'Kwon, Soon-woo', 'tennis')).toBeGreaterThan(0.8);
  });
  it('matches common Czech variants', () => {
    expect(nameSimilarity('Viktoria Plzeň', 'FC Viktoria Plzen', 'football')).toBe(1);
    expect(nameSimilarity('Plzeň', 'Viktoria Plzeň', 'football')).toBeGreaterThan(0.8);
    expect(nameSimilarity('Man. Utd', 'Manchester United', 'football')).toBeGreaterThan(0.85);
    expect(nameSimilarity('Sparta Praha', 'Slavia Praha', 'football')).toBeLessThan(0.7);
  });
  it('never matches different youth/women/reserve tags', () => {
    expect(nameSimilarity('Česko U21', 'Česko', 'football')).toBe(0);
    expect(nameSimilarity('Slavia Praha', 'Slavia Praha (ž)', 'football')).toBe(0);
    expect(nameSimilarity('Sparta Praha B', 'Sparta Praha', 'football')).toBe(0);
  });
  it('handles tennis name orders and initials', () => {
    expect(nameSimilarity('Djokovic N.', 'Novak Djokovic', 'tennis')).toBeGreaterThan(0.9);
    expect(nameSimilarity('Djokovič, Novak', 'N. Djokovic', 'tennis')).toBeGreaterThan(0.9);
    expect(nameSimilarity('Pliskova Ka.', 'Karolina Pliskova', 'tennis')).toBeGreaterThan(0.85);
    expect(nameSimilarity('Pliskova Ka.', 'Kristyna Pliskova', 'tennis')).toBeLessThan(0.86);
    expect(nameSimilarity('Muller B.', 'Alexandre Muller', 'tennis')).toBeLessThan(0.86);
  });
  it('detects swapped order', () => {
    const r = pairSimilarity({ home: 'Alcaraz C.', away: 'Sinner J.' }, { home: 'Jannik Sinner', away: 'Carlos Alcaraz' }, 'tennis');
    expect(r.swapped).toBe(true);
    expect(r.score).toBeGreaterThan(0.9);
  });
});

describe('matching edge cases seen in simulation', () => {
  it('scores containment of a distinctive token high', () => {
    expect(nameSimilarity('Liberec', 'Bílí Tygři Liberec', 'hockey')).toBeGreaterThanOrEqual(0.86);
    expect(nameSimilarity('Mountfield HK', 'Mountfield Hradec Králové', 'hockey')).toBeGreaterThanOrEqual(0.86);
    expect(nameSimilarity('Toronto', 'Toronto Maple Leafs', 'hockey')).toBeGreaterThanOrEqual(0.86);
  });
  it('handles short abbreviations and city synonyms', () => {
    expect(nameSimilarity('Ml. Boleslav', 'Mladá Boleslav', 'football')).toBeGreaterThanOrEqual(0.86);
    expect(nameSimilarity('NY Rangers', 'New York Rangers', 'hockey')).toBeGreaterThanOrEqual(0.86);
    expect(nameSimilarity('LA Lakers', 'Los Angeles Lakers', 'basketball')).toBeGreaterThanOrEqual(0.86);
    expect(nameSimilarity('GS Warriors', 'Golden State Warriors', 'basketball')).toBeGreaterThanOrEqual(0.86);
  });
  it('handles Czech feminine surnames in tennis', () => {
    expect(nameSimilarity('Sabalenková A.', 'Aryna Sabalenka', 'tennis')).toBeGreaterThanOrEqual(0.86);
    expect(nameSimilarity('Jessica Pegulová', 'Pegula J.', 'tennis')).toBeGreaterThanOrEqual(0.86);
    expect(nameSimilarity('Šwiateková I.', 'Iga Świątek', 'tennis')).toBeGreaterThanOrEqual(0.86);
  });
  it('keeps genuinely different teams apart', () => {
    expect(nameSimilarity('Sparta Praha', 'Dukla Praha', 'football')).toBeLessThan(0.86);
    // "Milán" ⊂ "Inter Milán" projde jako obsažené jméno – chrání až párování obou týmů + čas výkopu
    expect(pairSimilarity({ home: 'Inter Milán', away: 'AC Milán' }, { home: 'AC Milán', away: 'Inter Milán' }, 'football').swapped).toBe(true);
    expect(nameSimilarity('Manchester City', 'Manchester United', 'football')).toBeLessThan(0.86);
  });
});

describe('dotted initials', () => {
  it('collapses L.A. to LA', () => {
    expect(nameSimilarity('L.A. Lakers', 'Los Angeles Lakers', 'basketball')).toBeGreaterThanOrEqual(0.86);
    expect(nameSimilarity('Djokovic N.', 'N. Djokovic', 'tennis')).toBeGreaterThan(0.9);
  });
});

describe('real-world variants from Kingsbet vs BetX', () => {
  const cases: [string, string, 'football' | 'hockey' | 'basketball'][] = [
    ['Bayern München', 'Bayern Munich', 'football'],
    ['Dinamo Zagreb', 'Dinamo Záhřeb', 'football'],
    ['Libérie', 'Liberia', 'football'],
    ['Moldavsko', 'Moldávie', 'football'],
    ['Sochi', 'HC Sochi', 'hockey'],
    ['Salavat Julajev Ufa', 'Salavat Yulaev UFA', 'hockey'],
    ['Krasnoyarsk', 'Sokol Krasnojarsk', 'hockey'],
    ['Tractor Chelyabinsk', 'Traktor Čeljabinsk', 'hockey'],
    ['Izhevsk', 'Ižstal Iževsk', 'hockey'],
    ['FC Gifu', 'FC Gifu', 'football'],
    ['Yokohama FC', 'Jokohama FC', 'football'],
    ['SA Spurs', 'San Antonio Spurs', 'basketball'],
    ['PHX Suns', 'Phoenix Suns', 'basketball'],
    ['CD Universidad Catolica', 'U. Catolica', 'football'],
    ['Club Brugge', 'Bruggy', 'football'],
    ['Kongo', 'Congo Republic', 'football'],
  ];
  for (const [a, b, sport] of cases)
    it(`${a} ~ ${b}`, () => expect(nameSimilarity(a, b, sport)).toBeGreaterThanOrEqual(0.86));
});

describe('second real-world batch (Fortuna/Kingsbet/BetX)', () => {
  const cases: [string, string, 'football' | 'hockey' | 'basketball'][] = [
    ['Sev.Makedonie', 'Severní Makedonie', 'football'],
    ['Din.Moskva', 'Dynamo Moskva', 'football'],
    ['QPR', 'Queens Park Rangers FC', 'football'],
    ['RW Essen', 'Rot-Weiss Essen', 'football'],
    ['Scunthrope', 'Scunthorpe United FC', 'football'],
    ['Calgary Wranglers', 'Calgary Wrabglers', 'hockey'],
    ['Stamfort AFC', 'Stamford AFC', 'football'],
    ['Kurhan', 'Zauralje Kurgan', 'hockey'],
    ['Gomel', 'HK Homel', 'hockey'],
    ['Novopolotsk', 'Chimik-SKA Novopolock', 'hockey'],
    ['Voronezh', 'Buran Voroněž', 'hockey'],
    ['Namibie', 'Namibia', 'football'],
    ['Kuvajt', 'Kuwait', 'football'],
    ['Kajrat', 'FC Kairat Almaty', 'football'],
    ['Somálsko', 'Somalia', 'football'],
    ['HC Yugra', 'HK Jugra', 'hockey'],
  ];
  for (const [a, b, sport] of cases)
    it(`${a} ~ ${b}`, () => expect(nameSimilarity(a, b, sport)).toBeGreaterThanOrEqual(0.86));
  it('tennis doubles with multi-initials', () => {
    expect(nameSimilarity('Goffin D. / Herbert P.H.', 'Goffin, D/Pierre-Hugues Herbert', 'tennis')).toBeGreaterThanOrEqual(0.86);
    expect(nameSimilarity('Valeria Savinychová', 'Savinykh, Valeria', 'tennis')).toBeGreaterThanOrEqual(0.86);
  });
  it('still separates different clubs', () => {
    expect(nameSimilarity('Sparta Praha', 'Spartak Moskva', 'football')).toBeLessThan(0.86);
    expect(nameSimilarity('Dynamo Moskva', 'Dynamo Kyjev', 'football')).toBeLessThan(0.86);
    expect(nameSimilarity('Real Madrid', 'Real Sociedad', 'football')).toBeLessThan(0.86);
    expect(nameSimilarity('Slavia Praha', 'Slavia Sofia', 'football')).toBeLessThan(0.86);
  });
});
