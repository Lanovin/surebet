import { describe, expect, it } from 'vitest';
import { groupDef, groupsForMarket, isThreeWayScope } from '../../src/core/groups.js';

describe('skupiny ekvivalentních trhů', () => {
  it('rozsahy s remízou', () => {
    expect(isThreeWayScope('football', 'REG')).toBe(true);
    expect(isThreeWayScope('hockey', 'P2')).toBe(true);
    expect(isThreeWayScope('hockey', 'MATCH')).toBe(false);
    expect(isThreeWayScope('tennis', 'S1')).toBe(false);
    expect(isThreeWayScope('volleyball', 'REG')).toBe(false);
  });

  it('změna trhu přehodnotí správné skupiny', () => {
    expect(groupsForMarket('football', '1X2|REG')).toEqual(['1X2|REG', 'H_DA|REG', 'A_HD|REG', 'D_HA|REG']);
    expect(groupsForMarket('football', 'DC|H1')).toEqual(['H_DA|H1', 'A_HD|H1', 'D_HA|H1']);
    expect(groupsForMarket('football', 'AH|REG|-0.5')).toEqual(['1X2|REG', 'H_DA|REG']);
    expect(groupsForMarket('football', 'AH|REG|0.5')).toEqual(['1X2|REG', 'A_HD|REG']);
    expect(groupsForMarket('football', 'AH|REG|0')).toEqual(['DNB|REG']);
    expect(groupsForMarket('football', 'AH|REG|-1.5')).toEqual(['AH|REG|-1.5']);
    expect(groupsForMarket('hockey', 'AH|MATCH|-0.5')).toEqual(['ML|MATCH']);
    expect(groupsForMarket('hockey', 'AH|MATCH|-1.5')).toEqual(['AH|MATCH|-1.5']);
    // tenis: handicap na gemy ±0.5 není vítěz zápasu
    expect(groupsForMarket('tennis', 'AH|MATCH|-0.5')).toEqual(['AH|MATCH|-0.5']);
    // americký fotbal: zápas může skončit remízou i po prodloužení → bez ekvivalence
    expect(groupsForMarket('american_football', 'AH|MATCH|0.5')).toEqual(['AH|MATCH|0.5']);
    expect(groupsForMarket('tennis', 'DC|MATCH')).toEqual([]);
  });

  it('zdroje výsledků', () => {
    const h = groupDef('football', 'H_DA|REG')!;
    expect(h.legs.map((l) => [l.sel, l.sources.map((s) => `${s.market}:${s.sel}`)])).toEqual([
      ['HOME', ['1X2|REG:HOME', 'AH|REG|-0.5:HOME']],
      ['DRAW_AWAY', ['DC|REG:DRAW_AWAY', 'AH|REG|-0.5:AWAY']],
    ]);
    const dnb = groupDef('football', 'DNB|REG')!;
    expect(dnb.legs[0].sources.map((s) => s.market)).toEqual(['DNB|REG', 'AH|REG|0']);
    const ml = groupDef('basketball', 'ML|MATCH')!;
    expect(ml.legs[1].sources.map((s) => `${s.market}:${s.sel}`)).toEqual(['ML|MATCH:AWAY', 'AH|MATCH|-0.5:AWAY', 'AH|MATCH|0.5:AWAY']);
    // běžný trh bez ekvivalentů
    expect(groupDef('tennis', 'OU|MATCH|22.5')!.legs.map((l) => l.sources.length)).toEqual([1, 1]);
    expect(groupDef('football', 'DC|REG')).toBeNull();
  });
});
