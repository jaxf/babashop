const LEAGUE_ID = '1401342003886714880';
const API = 'https://api.sleeper.app/v1';
const CACHE_VERSION = '20260906-03';

const state = {
  league: null,
  nbaState: null,
  users: [],
  rosters: [],
  teams: [],
  matchupWeeks: new Map(),
  currentWeek: 0,
  completedWeeks: [],
  drafts: [],
  draft: null,
  draftPicks: [],
  playerRanks: {},
  draftGrades: [],
};

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 1) => Number(value).toFixed(digits).replace(/\.0$/, '');
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function avatarUrl(avatarId) {
  return avatarId ? `https://sleepercdn.com/avatars/thumbs/${avatarId}` : '';
}

async function api(path) {
  const response = await fetch(`${API}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Sleeper returned ${response.status} for ${path}`);
  return response.json();
}

function rosterPoints(roster, against = false) {
  const settings = roster?.settings || {};
  const whole = number(settings[against ? 'fpts_against' : 'fpts']);
  const decimal = number(settings[against ? 'fpts_against_decimal' : 'fpts_decimal']);
  return whole + decimal / 100;
}

function userForRoster(roster) {
  return state.users.find((user) => String(user.user_id) === String(roster.owner_id)) || null;
}

function teamName(roster, user) {
  return roster?.metadata?.team_name || user?.metadata?.team_name || user?.display_name || user?.username || `Team ${roster.roster_id}`;
}

function buildTeams() {
  return state.rosters.map((roster) => {
    const user = userForRoster(roster);
    const settings = roster.settings || {};
    const wins = number(settings.wins);
    const losses = number(settings.losses);
    const ties = number(settings.ties);
    const pf = rosterPoints(roster);
    const pa = rosterPoints(roster, true);
    return {
      roster,
      user,
      rosterId: number(roster.roster_id),
      name: teamName(roster, user),
      owner: user?.display_name || user?.username || 'Unassigned',
      avatar: avatarUrl(user?.avatar),
      wins,
      losses,
      ties,
      pf,
      pa,
      diff: pf - pa,
      winPct: wins + losses + ties > 0 ? (wins + ties * 0.5) / (wins + losses + ties) : 0,
      weeklyScores: [],
      recentForm: [],
      allPlayWins: 0,
      allPlayGames: 0,
      allPlayPct: 0,
      expectedWins: wins,
      luck: 0,
      ppg: 0,
      recentAvg: 0,
      draftScore: null,
      draftGrade: null,
      power: 0,
    };
  });
}

function getCurrentWeek(league, nbaState) {
  const status = String(league?.status || '').toLowerCase();
  if (status === 'pre_draft' || status === 'drafting') return 0;
  const leagueWeek = Math.max(number(league?.settings?.leg, 0), number(league?.settings?.week, 0));
  if (leagueWeek > 0) return leagueWeek;
  if (league?.season && nbaState?.season && String(league.season) !== String(nbaState.season)) return 0;
  return Math.max(number(nbaState?.week, 0), number(nbaState?.leg, 0));
}

async function loadMatchupWeek(week) {
  if (!week || week < 1) return [];
  if (state.matchupWeeks.has(week)) return state.matchupWeeks.get(week);
  try {
    const matchups = await api(`/league/${LEAGUE_ID}/matchups/${week}`);
    const normalized = Array.isArray(matchups) ? matchups : [];
    state.matchupWeeks.set(week, normalized);
    return normalized;
  } catch (error) {
    console.warn(`Could not load week ${week}`, error);
    state.matchupWeeks.set(week, []);
    return [];
  }
}

async function loadHistoricalMatchups() {
  if (!state.currentWeek) return;
  const maxWeek = Math.min(state.currentWeek, 30);
  await Promise.all(Array.from({ length: maxWeek }, (_, index) => loadMatchupWeek(index + 1)));
}

function groupMatchups(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = item.matchupId ?? item.matchup_id ?? `solo-${item.rosterId ?? item.roster_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.values()];
}

function enrichTeamsFromMatchups() {
  const teamsById = new Map(state.teams.map((team) => [team.rosterId, team]));
  const completedWeeks = [];
  for (const [week, matchups] of [...state.matchupWeeks.entries()].sort((a, b) => a[0] - b[0])) {
    const scored = matchups
      .filter((matchup) => matchup && matchup.roster_id !== undefined && Number.isFinite(Number(matchup.points)))
      .map((matchup) => ({ rosterId: number(matchup.roster_id), points: number(matchup.points), matchupId: matchup.matchup_id }));
    if (scored.length < 2 || scored.every((item) => item.points === 0)) continue;
    completedWeeks.push(week);
    scored.forEach((item) => {
      const team = teamsById.get(item.rosterId);
      if (!team) return;
      team.weeklyScores.push({ week, points: item.points });
      const beaten = scored.filter((other) => other.rosterId !== item.rosterId && item.points > other.points).length;
      const tied = scored.filter((other) => other.rosterId !== item.rosterId && item.points === other.points).length;
      team.allPlayWins += beaten + tied * 0.5;
      team.allPlayGames += Math.max(scored.length - 1, 0);
    });
    groupMatchups(scored).forEach((pair) => {
      if (pair.length !== 2) return;
      const [a, b] = pair;
      const teamA = teamsById.get(a.rosterId);
      const teamB = teamsById.get(b.rosterId);
      if (!teamA || !teamB) return;
      const resultA = a.points > b.points ? 'W' : a.points < b.points ? 'L' : 'T';
      const resultB = resultA === 'W' ? 'L' : resultA === 'L' ? 'W' : 'T';
      teamA.recentForm.push({ week, result: resultA, opponentId: teamB.rosterId, points: a.points, opponentPoints: b.points });
      teamB.recentForm.push({ week, result: resultB, opponentId: teamA.rosterId, points: b.points, opponentPoints: a.points });
    });
  }
  state.completedWeeks = completedWeeks;
}

function normalizedScores(values) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 50);
  return values.map((value) => ((value - min) / (max - min)) * 100);
}

function draftRosterId(pick) {
  const direct = number(pick?.roster_id, 0);
  if (direct) return direct;
  const slot = String(pick?.draft_slot ?? '');
  return number(state.draft?.slot_to_roster_id?.[slot], 0);
}

function playerMeta(id) {
  return state.playerRanks?.[String(id)] || {};
}

function playerNameFromId(id) {
  const player = playerMeta(id);
  return `${player.first_name || ''} ${player.last_name || ''}`.trim() || `Player ${id}`;
}

function draftPlayerName(pick) {
  const player = playerMeta(pick?.player_id);
  const metadata = pick?.metadata || {};
  const first = player.first_name || metadata.first_name || '';
  const last = player.last_name || metadata.last_name || '';
  return `${first} ${last}`.trim() || metadata.full_name || `Player ${pick?.player_id || ''}`.trim();
}

function draftPlayerRank(pick) {
  const player = playerMeta(pick?.player_id);
  const metadata = pick?.metadata || {};
  const rank = number(player.search_rank || metadata.search_rank, 0);
  return rank > 0 ? rank : null;
}

function draftPlayerPositions(pick) {
  const player = playerMeta(pick?.player_id);
  const metadata = pick?.metadata || {};
  const positions = player.fantasy_positions || metadata.fantasy_positions || [];
  if (Array.isArray(positions) && positions.length) return positions.map(String);
  const position = player.position || metadata.position;
  return position ? [String(position)] : [];
}

function loadCachedPlayers() {
  try {
    const raw = localStorage.getItem(`babashop:nba-player-ranks:${CACHE_VERSION}`);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached?.savedAt || Date.now() - cached.savedAt > 24 * 60 * 60 * 1000) return null;
    return cached.players || null;
  } catch (_) {
    return null;
  }
}

function cachePlayers(players) {
  try {
    localStorage.setItem(`babashop:nba-player-ranks:${CACHE_VERSION}`, JSON.stringify({ savedAt: Date.now(), players }));
  } catch (_) {}
}

async function loadPlayerRanks() {
  const cached = loadCachedPlayers();
  if (cached) return cached;
  try {
    const players = await api('/players/nba?active=true');
    const compact = {};
    Object.entries(players || {}).forEach(([id, player]) => {
      compact[id] = {
        search_rank: player?.search_rank ?? null,
        first_name: player?.first_name || '',
        last_name: player?.last_name || '',
        fantasy_positions: player?.fantasy_positions || [],
        position: player?.position || '',
        team: player?.team || '',
      };
    });
    cachePlayers(compact);
    return compact;
  } catch (error) {
    console.warn('Could not load Sleeper NBA player metadata', error);
    return {};
  }
}

function positionalBalanceScore(picks) {
  if (!picks.length) return 50;
  const buckets = { G: 0, F: 0, C: 0 };
  picks.forEach((pick) => {
    const positions = draftPlayerPositions(pick);
    if (positions.some((p) => /PG|SG|(^|\/)G($|\/)/.test(p))) buckets.G += 1;
    if (positions.some((p) => /SF|PF|(^|\/)F($|\/)/.test(p))) buckets.F += 1;
    if (positions.some((p) => /(^|\/)C($|\/)/.test(p))) buckets.C += 1;
  });
  const represented = Object.values(buckets).filter((count) => count > 0).length;
  const counts = Object.values(buckets).filter((count) => count > 0);
  if (!counts.length) return 60;
  const spreadPenalty = Math.min(18, Math.max(0, Math.max(...counts) - Math.min(...counts) - 2) * 4);
  return clamp(55 + represented * 12 - spreadPenalty, 45, 91);
}

function letterGrade(score) {
  if (score >= 94) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 87) return 'A-';
  if (score >= 84) return 'B+';
  if (score >= 80) return 'B';
  if (score >= 77) return 'B-';
  if (score >= 74) return 'C+';
  if (score >= 70) return 'C';
  if (score >= 67) return 'C-';
  if (score >= 63) return 'D+';
  if (score >= 60) return 'D';
  return 'F';
}

function calculateDraftGrades() {
  if (!state.draftPicks.length) return;
  const rows = state.teams.map((team) => {
    const picks = state.draftPicks.filter((pick) => draftRosterId(pick) === team.rosterId).sort((a, b) => number(a.pick_no) - number(b.pick_no));
    const ranked = picks.map((pick) => {
      const pickNo = Math.max(1, number(pick.pick_no, 1));
      const rank = draftPlayerRank(pick);
      if (!rank) return null;
      const delta = pickNo - rank;
      const roundNo = Math.max(1, number(pick.round, 1));
      const weight = roundNo <= 3 ? 1.35 : roundNo <= 6 ? 1 : 0.72;
      const efficiency = clamp(50 + (delta / Math.max(8, pickNo)) * 58, 5, 98);
      return { pick, pickNo, rank, delta, weight, efficiency };
    }).filter(Boolean);
    const totalWeight = ranked.reduce((sum, row) => sum + row.weight, 0);
    const valueScore = totalWeight ? ranked.reduce((sum, row) => sum + row.efficiency * row.weight, 0) / totalWeight : 55;
    const balanceScore = positionalBalanceScore(picks);
    const coverage = picks.length ? ranked.length / picks.length : 0;
    const raw = valueScore * 0.82 + balanceScore * 0.18;
    return { team, picks, ranked, coverage, raw, best: [...ranked].sort((a, b) => b.delta - a.delta)[0] || null, reach: [...ranked].sort((a, b) => a.delta - b.delta)[0] || null };
  }).filter((row) => row.picks.length);
  if (!rows.length) return;
  const rawValues = rows.map((row) => row.raw);
  const min = Math.min(...rawValues);
  const max = Math.max(...rawValues);
  state.draftGrades = rows.map((row) => {
    const percentile = max === min ? 50 : ((row.raw - min) / (max - min)) * 100;
    const score = clamp(62 + percentile * 0.31, 60, 93);
    const grade = letterGrade(score);
    row.team.draftScore = score;
    row.team.draftGrade = grade;
    return { ...row, score, grade };
  }).sort((a, b) => b.score - a.score);
}

async function loadDraftData(initialDrafts = null, needPlayers = false) {
  state.drafts = Array.isArray(initialDrafts) ? initialDrafts : [];
  state.draft = null;
  state.draftPicks = [];
  state.draftGrades = [];
  if (!state.drafts.length && !needPlayers) return;
  if (state.drafts.length) {
    const season = String(state.league?.season || '');
    state.draft = state.drafts.find((d) => String(d?.season || '') === season && String(d?.status || '').toLowerCase() === 'complete')
      || state.drafts.find((d) => String(d?.season || '') === season)
      || state.drafts[0];
  }
  const [playerRanks, picks] = await Promise.all([
    loadPlayerRanks(),
    state.draft?.draft_id ? api(`/draft/${state.draft.draft_id}/picks`).catch(() => []) : Promise.resolve([]),
  ]);
  state.playerRanks = playerRanks || {};
  state.draftPicks = Array.isArray(picks) ? picks : [];
  calculateDraftGrades();
}

function calculatePowerRankings() {
  const teams = state.teams;
  const ppg = teams.map((team) => team.weeklyScores.length ? team.weeklyScores.reduce((sum, x) => sum + x.points, 0) / team.weeklyScores.length : team.pf);
  const recent = teams.map((team, index) => {
    const scores = team.weeklyScores.slice(-3);
    return scores.length ? scores.reduce((sum, x) => sum + x.points, 0) / scores.length : ppg[index];
  });
  const ppgNorm = normalizedScores(ppg);
  const recentNorm = normalizedScores(recent);
  const weeks = state.completedWeeks.length;
  teams.forEach((team, index) => {
    const allPlayPct = team.allPlayGames ? team.allPlayWins / team.allPlayGames : team.winPct;
    team.ppg = ppg[index];
    team.recentAvg = recent[index];
    team.allPlayPct = allPlayPct;
    team.expectedWins = team.allPlayGames && weeks ? allPlayPct * weeks : team.wins;
    team.luck = team.wins - team.expectedWins;
    if (!weeks) {
      team.power = team.draftScore ?? 50;
      return;
    }
    const seasonPower = 0.32 * (team.winPct * 100) + 0.30 * ppgNorm[index] + 0.23 * (allPlayPct * 100) + 0.15 * recentNorm[index];
    const draftWeight = team.draftScore == null ? 0 : clamp((6 - weeks) / 6, 0, 1) * 0.25;
    team.power = seasonPower * (1 - draftWeight) + (team.draftScore ?? seasonPower) * draftWeight;
  });
}

function getAllCompletedPairs() {
  const pairs = [];
  for (const [week, raw] of state.matchupWeeks.entries()) {
    const groups = new Map();
    raw.forEach((m) => {
      if (!Number.isFinite(Number(m.points)) || m.matchup_id == null) return;
      if (!groups.has(m.matchup_id)) groups.set(m.matchup_id, []);
      groups.get(m.matchup_id).push(m);
    });
    groups.forEach((group) => {
      if (group.length === 2 && !group.every((m) => number(m.points) === 0)) pairs.push({ week, a: group[0], b: group[1] });
    });
  }
  return pairs;
}

function teamByRosterId(id) {
  return state.teams.find((team) => team.rosterId === number(id)) || null;
}
function standings() { return [...state.teams].sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.pf - a.pf); }
function rankings() { return [...state.teams].sort((a, b) => b.power - a.power || b.pf - a.pf); }
function teamUrl(team) { return `team.html?roster=${encodeURIComponent(team.rosterId)}&v=${CACHE_VERSION}`; }

function superlatives() {
  const allScores = state.teams.flatMap((team) => team.weeklyScores.map((score) => ({ ...score, team })));
  const pairs = getAllCompletedPairs();
  if (!allScores.length) return [];
  const highest = [...allScores].sort((a, b) => b.points - a.points)[0];
  const lowest = [...allScores].sort((a, b) => a.points - b.points)[0];
  const closest = [...pairs].sort((x, y) => Math.abs(number(x.a.points) - number(x.b.points)) - Math.abs(number(y.a.points) - number(y.b.points)))[0];
  const biggest = [...pairs].sort((x, y) => Math.abs(number(y.a.points) - number(y.b.points)) - Math.abs(number(x.a.points) - number(x.b.points)))[0];
  const rows = [
    { label: 'Highest score', value: `${highest.team.name} · ${round(highest.points)}`, detail: `Week ${highest.week}` },
    { label: 'Lowest score', value: `${lowest.team.name} · ${round(lowest.points)}`, detail: `Week ${lowest.week}` },
  ];
  if (closest) rows.push({ label: 'Closest matchup', value: `${teamByRosterId(closest.a.roster_id)?.name || 'Team'} vs ${teamByRosterId(closest.b.roster_id)?.name || 'Team'}`, detail: `Week ${closest.week} · ${round(Math.abs(number(closest.a.points) - number(closest.b.points)))} pts` });
  if (biggest) rows.push({ label: 'Biggest blowout', value: `${teamByRosterId(biggest.a.roster_id)?.name || 'Team'} vs ${teamByRosterId(biggest.b.roster_id)?.name || 'Team'}`, detail: `Week ${biggest.week} · ${round(Math.abs(number(biggest.a.points) - number(biggest.b.points)))} pts` });
  return rows;
}

async function loadData({ needPlayers = false } = {}) {
  state.matchupWeeks.clear();
  const [league, rosters, users, nbaState, drafts] = await Promise.all([
    api(`/league/${LEAGUE_ID}`),
    api(`/league/${LEAGUE_ID}/rosters`),
    api(`/league/${LEAGUE_ID}/users`),
    api('/state/nba').catch(() => null),
    api(`/league/${LEAGUE_ID}/drafts`).catch(() => []),
  ]);
  state.league = league;
  state.rosters = Array.isArray(rosters) ? rosters : [];
  state.users = Array.isArray(users) ? users : [];
  state.nbaState = nbaState;
  state.currentWeek = getCurrentWeek(league, nbaState);
  state.teams = buildTeams();
  await Promise.all([loadHistoricalMatchups(), loadDraftData(drafts, needPlayers)]);
  enrichTeamsFromMatchups();
  calculatePowerRankings();
  return state;
}

window.Babashop = {
  LEAGUE_ID, CACHE_VERSION, state, loadData, loadMatchupWeek, teamByRosterId, rankings, standings,
  teamUrl, superlatives, playerNameFromId, playerMeta, draftPlayerName, draftPlayerRank,
  round, number, escapeHtml, avatarUrl, groupMatchups,
};