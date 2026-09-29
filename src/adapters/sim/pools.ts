// Týmy/hráči pro simulátor. První položka = kanonické jméno, další = varianty, jak je píšou sázkovky.
import type { Sport } from '../../core/types.js';

export interface League {
  sport: Sport;
  /** Názvy soutěže u různých sázkovek. */
  names: string[];
  country: string;
  teams: string[][];
  /** basket: NBA má jiné tempo i délku čtvrtin */
  nba?: boolean;
}

export const LEAGUES: League[] = [
  {
    sport: 'football',
    names: ['Chance Liga', 'Česko 1. liga', '1. česká liga'],
    country: 'Česko',
    teams: [
      ['AC Sparta Praha', 'Sparta Praha', 'Sparta', 'AC Sparta Praha'],
      ['SK Slavia Praha', 'Slavia Praha', 'Slavia', 'SK Slavia Praha'],
      ['FC Viktoria Plzeň', 'Plzeň', 'Viktoria Plzeň', 'FC Viktoria Plzeň', 'Viktoria Plzen'],
      ['FC Baník Ostrava', 'Baník Ostrava', 'Ostrava', 'FC Baník Ostrava'],
      ['FK Jablonec', 'Jablonec', 'FK Jablonec', 'Jablonek'],
      ['FC Slovan Liberec', 'Liberec', 'Slovan Liberec'],
      ['SK Sigma Olomouc', 'Olomouc', 'Sigma Olomouc'],
      ['FC Hradec Králové', 'Hradec Králové', 'FC Hradec Králové', 'Hradec Kr.'],
      ['Bohemians Praha 1905', 'Bohemians', 'Bohemians 1905', 'Bohemians Praha'],
      ['FK Mladá Boleslav', 'Mladá Boleslav', 'Ml. Boleslav', 'FK Mladá Boleslav'],
      ['1. FC Slovácko', 'Slovácko', '1. FC Slovácko'],
      ['FK Teplice', 'Teplice', 'FK Teplice'],
    ],
  },
  {
    sport: 'football',
    names: ['Premier League', 'Anglie 1. liga', 'Anglická Premier League'],
    country: 'Anglie',
    teams: [
      ['Manchester United', 'Manchester Utd', 'Man. United', 'Manchester United'],
      ['Manchester City', 'Manchester City', 'Man. City'],
      ['Liverpool FC', 'Liverpool', 'FC Liverpool'],
      ['Arsenal FC', 'Arsenal', 'Arsenal Londýn'],
      ['Chelsea FC', 'Chelsea', 'Chelsea Londýn'],
      ['Tottenham Hotspur', 'Tottenham', 'Tottenham Hotspur'],
      ['Newcastle United', 'Newcastle', 'Newcastle Utd'],
      ['Aston Villa', 'Aston Villa', 'Aston Villa FC'],
    ],
  },
  {
    sport: 'football',
    names: ['Liga mistrů', 'Liga mistrů UEFA', 'UEFA Champions League'],
    country: 'Evropa',
    teams: [
      ['Real Madrid', 'Real Madrid', 'R. Madrid'],
      ['FC Barcelona', 'Barcelona', 'FC Barcelona'],
      ['Bayern Mnichov', 'Bayern Mnichov', 'Bayern', 'FC Bayern Mnichov'],
      ['Borussia Dortmund', 'Dortmund', 'Borussia Dortmund', 'B. Dortmund'],
      ['Inter Milán', 'Inter Milán', 'Inter', 'Internazionale'],
      ['Juventus Turín', 'Juventus', 'Juventus Turín'],
      ['SSC Neapol', 'Neapol', 'SSC Neapol', 'Napoli'],
      ['Paris Saint-Germain', 'Paris Saint-Germain', 'PSG', 'Paris SG'],
    ],
  },
  {
    sport: 'hockey',
    names: ['Tipsport extraliga', 'Česko extraliga', 'Extraliga ledního hokeje'],
    country: 'Česko',
    teams: [
      ['HC Sparta Praha', 'Sparta Praha', 'HC Sparta Praha'],
      ['HC Oceláři Třinec', 'Třinec', 'Oceláři Třinec', 'HC Oceláři Třinec'],
      ['HC Dynamo Pardubice', 'Pardubice', 'Dynamo Pardubice', 'HC Dynamo Pardubice'],
      ['Bílí Tygři Liberec', 'Liberec', 'Bílí Tygři Liberec'],
      ['HC Kometa Brno', 'Kometa Brno', 'Brno', 'HC Kometa Brno'],
      ['HC Vítkovice Ridera', 'Vítkovice', 'HC Vítkovice'],
      ['Mountfield HK', 'Hradec Králové', 'Mountfield HK', 'Mountfield Hradec Králové'],
      ['HC Energie Karlovy Vary', 'Karlovy Vary', 'Energie Karlovy Vary'],
      ['HC Verva Litvínov', 'Litvínov', 'HC Litvínov'],
      ['HC Škoda Plzeň', 'Plzeň', 'HC Škoda Plzeň'],
      ['Rytíři Kladno', 'Kladno', 'Rytíři Kladno'],
      ['HC Motor České Budějovice', 'České Budějovice', 'Motor České Budějovice', 'Č. Budějovice'],
    ],
  },
  {
    sport: 'hockey',
    names: ['NHL', 'USA NHL', 'National Hockey League'],
    country: 'USA',
    teams: [
      ['Toronto Maple Leafs', 'Toronto', 'Toronto Maple Leafs'],
      ['Montreal Canadiens', 'Montreal', 'Montréal Canadiens'],
      ['Boston Bruins', 'Boston', 'Boston Bruins'],
      ['New York Rangers', 'NY Rangers', 'New York Rangers'],
      ['Pittsburgh Penguins', 'Pittsburgh', 'Pittsburgh Penguins'],
      ['Edmonton Oilers', 'Edmonton', 'Edmonton Oilers'],
      ['Colorado Avalanche', 'Colorado', 'Colorado Avalanche'],
      ['Florida Panthers', 'Florida', 'Florida Panthers'],
    ],
  },
  {
    sport: 'basketball',
    names: ['NBA', 'USA NBA', 'NBA - základní část'],
    country: 'USA',
    nba: true,
    teams: [
      ['Los Angeles Lakers', 'LA Lakers', 'Los Angeles Lakers', 'L.A. Lakers'],
      ['Boston Celtics', 'Boston', 'Boston Celtics'],
      ['Golden State Warriors', 'Golden State', 'Golden State Warriors', 'GS Warriors'],
      ['Milwaukee Bucks', 'Milwaukee', 'Milwaukee Bucks'],
      ['Denver Nuggets', 'Denver', 'Denver Nuggets'],
      ['Phoenix Suns', 'Phoenix', 'Phoenix Suns'],
      ['Miami Heat', 'Miami', 'Miami Heat'],
      ['Dallas Mavericks', 'Dallas', 'Dallas Mavericks'],
    ],
  },
  {
    sport: 'basketball',
    names: ['Euroliga', 'Evropa Euroliga', 'Turkish Airlines Euroleague'],
    country: 'Evropa',
    teams: [
      ['Real Madrid', 'Real Madrid', 'Real Madrid Baloncesto'],
      ['Fenerbahçe', 'Fenerbahce', 'Fenerbahçe Istanbul'],
      ['Olympiacos', 'Olympiakos Pireus', 'Olympiacos'],
      ['Panathinaikos', 'Panathinaikos', 'Panathinaikos Atény'],
      ['Žalgiris Kaunas', 'Žalgiris', 'Zalgiris Kaunas'],
      ['Partizan Bělehrad', 'Partizan', 'Partizan Bělehrad'],
      ['ERA Nymburk', 'Nymburk', 'ERA Nymburk'],
      ['FC Barcelona', 'Barcelona', 'FC Barcelona'],
    ],
  },
  {
    sport: 'tennis',
    names: ['ATP Vídeň', 'ATP 500 Vídeň', 'Vídeň (ATP)'],
    country: 'Rakousko',
    teams: [
      ['Novak Djokovic', 'Djokovic N.', 'Novak Djokovic', 'Djokovič N.', 'N. Djokovic'],
      ['Carlos Alcaraz', 'Alcaraz C.', 'Carlos Alcaraz', 'C. Alcaraz'],
      ['Jannik Sinner', 'Sinner J.', 'Jannik Sinner', 'J. Sinner'],
      ['Alexander Zverev', 'Zverev A.', 'Alexander Zverev'],
      ['Jiří Lehečka', 'Lehečka J.', 'Jiří Lehečka', 'Lehecka J.'],
      ['Tomáš Macháč', 'Macháč T.', 'Tomáš Macháč', 'Machac T.'],
      ['Jakub Menšík', 'Menšík J.', 'Jakub Menšík', 'Mensik J.'],
      ['Casper Ruud', 'Ruud C.', 'Casper Ruud'],
      ['Holger Rune', 'Rune H.', 'Holger Rune'],
      ['Taylor Fritz', 'Fritz T.', 'Taylor Fritz'],
      ['Stefanos Tsitsipas', 'Tsitsipas S.', 'Stefanos Tsitsipas'],
      ['Daniil Medvedev', 'Medvedev D.', 'Daniil Medvedev'],
    ],
  },
  {
    sport: 'tennis',
    names: ['WTA Ostrava', 'WTA 500 Ostrava', 'Ostrava (WTA)'],
    country: 'Česko',
    teams: [
      ['Iga Świątek', 'Swiatek I.', 'Iga Świątek', 'Šwiateková I.'],
      ['Aryna Sabalenka', 'Sabalenka A.', 'Aryna Sabalenka', 'Sabalenková A.'],
      ['Coco Gauff', 'Gauff C.', 'Coco Gauff'],
      ['Karolína Muchová', 'Muchová K.', 'Karolína Muchová', 'Muchova K.'],
      ['Barbora Krejčíková', 'Krejčíková B.', 'Barbora Krejčíková'],
      ['Markéta Vondroušová', 'Vondroušová M.', 'Markéta Vondroušová'],
      ['Linda Nosková', 'Nosková L.', 'Linda Nosková'],
      ['Karolína Plíšková', 'Plíšková Ka.', 'Karolína Plíšková'],
      ['Jelena Rybakina', 'Rybakina J.', 'Jelena Rybakinová'],
      ['Jessica Pegula', 'Pegula J.', 'Jessica Pegulová'],
    ],
  },
];
