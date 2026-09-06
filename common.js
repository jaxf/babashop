const LEAGUE_ID = '1401342003886714880';
const API = 'https://api.sleeper.app/v1';
const CACHE_VERSION = '20260906-04';

const NBA_TEAMS = new Set([
  'ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM',
  'MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'
]);

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
  playerStats: new Map(),
  draftGrades: [],
  transactions: [],
  transactionGrades: [],
  playerRanksPromise: null,
};

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 1) => Number(value).toFixed(digits).replace(/\.0$/, '');
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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
      schedule: null,
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

function regularSeasonWeeks() {
  const playoffStart = number(state.league?.settings?.playoff_week_start, 0);
  if (playoffStart > 1) return clamp(playoffStart - 1, 1, 30);
  const numWeeks = number(state.league?.settings?.num_weeks, 0);
  if (numWeeks > 0) return clamp(numWeeks, 1, 30);
  return clamp(Math.max(state.currentWeek, 20), 1, 24);
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

async function loadScheduleData() {
  const maxWeek = regularSeasonWeeks();
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

function addPlayerFantasyPoints(matchup, week) {
  const points = matchup?.players_points;
  if (!points || typeof points !== 'object') return;
  Object.entries(points).forEach(([playerId, rawPoints]) => {
    if (!Number.isFinite(Number(rawPoints))) return;
    const current = state.playerStats.get(String(playerId)) || { total: 0, weeks: 0, weekly: [] };
    current.total += number(rawPoints);
    current.weeks += 1;
    current.weekly.push({ week, points: number(rawPoints) });
    state.playerStats.set(String(playerId), current);
  });
}

function enrichTeamsFromMatchups() {
  const teamsById = new Map(state.teams.map((team) => [team.rosterId, team]));
  const completedWeeks = [];
  state.playerStats = new Map();

  for (const [week, matchups] of [...state.matchupWeeks.entries()].sort((a, b) => a[0] - b[0])) {
    const scored = matchups
      .filter((matchup) => matchup && matchup.roster_id !== undefined && Number.isFinite(Number(matchup.points)))
      .map((matchup) => ({ rosterId: number(matchup.roster_id), points: number(matchup.points), matchupId: matchup.matchup_id, raw: matchup }));
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
      addPlayerFantasyPoints(item.raw, week);
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
  state.completedWeeks = [...new Set(completedWeeks)].sort((a, b) => a - b);
}

function normalizedScores(values) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 50);
  return values.map((value) => ((value - min) / (max - min)) * 100);
}

function playerMeta(id) {
  return state.playerRanks?.[String(id)] || {};
}

function playerNameFromId(id) {
  const player = playerMeta(id);
  return `${player.first_name || ''} ${player.last_name || ''}`.trim() || `Player ${id}`;
}

function playerStatus(id) {
  const player = playerMeta(id);
  const status = String(player.status || '').toLowerCase();
  const team = String(player.team || '').toUpperCase();
  const activeFlag = player.active;

  if (activeFlag === false || ['inactive', 'retired', 'suspended-retired'].includes(status)) {
    return { current: false, kind: 'inactive', label: 'Inactive' };
  }
  if (activeFlag === true && NBA_TEAMS.has(team)) {
    return { current: true, kind: 'active', label: team };
  }
  if (status === 'active' && NBA_TEAMS.has(team)) {
    return { current: true, kind: 'active', label: team };
  }
  if (activeFlag === true && !NBA_TEAMS.has(team)) {
    return { current: false, kind: 'free_agent', label: 'No NBA team' };
  }
  if (!activeFlag && NBA_TEAMS.has(team) && status === 'active') {
    return { current: true, kind: 'active', label: team };
  }
  return { current: false, kind: 'inactive', label: team ? `${team} · inactive` : 'Inactive / no NBA team' };
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
  if (Object.keys(state.playerRanks).length) return state.playerRanks;
  if (state.playerRanksPromise) return state.playerRanksPromise;

  state.playerRanksPromise = (async () => {
    const cached = loadCachedPlayers();
    if (cached) return cached;
    try {
      const players = await api('/players/nba');
      const compact = {};
      Object.entries(players || {}).forEach(([id, player]) => {
        compact[id] = {
          search_rank: player?.search_rank ?? null,
          first_name: player?.first_name || '',
          last_name: player?.last_name || '',
          fantasy_positions: player?.fantasy_positions || [],
          position: player?.position || '',
          team: player?.team || '',
          active: player?.active,
          status: player?.status || '',
          injury_status: player?.injury_status || '',
          years_exp: player?.years_exp ?? null,
        };
      });
      cachePlayers(compact);
      return compact;
    } catch (error) {
      console.warn('Could not load Sleeper NBA player metadata', error);
      return {};
    }
  })();

  state.playerRanks = await state.playerRanksPromise;
  state.playerRanksPromise = null;
  return state.playerRanks;
}

function draftRosterId(pick) {
  const direct = number(pick?.roster_id, 0);
  if (direct) return direct;
  const slot = String(pick?.draft_slot ?? '');
  return number(state.draft?.slot_to_roster_id?.[slot], 0);
}

function draftPlayerName(pick) {
  const player = playerMeta(pick?.player_id);
  const metadata = pick?.metadata || {};
  const first = player.first_name || metadata.first_name || '';
  const last = player.last_name || metadata.last_name || '';
  return `${first} ${last}`.trim() || metadata.full_name || `Player ${pick?.player_id || ''}`.trim();
}

function draftPlayerRank(pick) {
  const status = playerStatus(pick?.player_id);
  if (!status.current) return null;
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

function positionalBalanceScore(picks) {
  const activePicks = picks.filter((pick) => playerStatus(pick.player_id).current);
  if (!activePicks.length) return 45;
  const buckets = { G: 0, F: 0, C: 0 };
  activePicks.forEach((pick) => {
    const positions = draftPlayerPositions(pick);
    if (positions.some((p) => /PG|SG|(^|\/)G($|\/)/.test(p))) buckets.G += 1;
    if (positions.some((p) => /SF|PF|(^|\/)F($|\/)/.test(p))) buckets.F += 1;
    if (positions.some((p) => /(^|\/)C($|\/)/.test(p))) buckets.C += 1;
  });
  const represented = Object.values(buckets).filter((count) => count > 0).length;
  const counts = Object.values(buckets).filter((count) => count > 0);
  if (!counts.length) return 50;
  const spreadPenalty = Math.min(18, Math.max(0, Math.max(...counts) - Math.min(...counts) - 2) * 4);
  return clamp(55 + represented * 12 - spreadPenalty, 42, 91);
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
    const picks = state.draftPicks
      .filter((pick) => draftRosterId(pick) === team.rosterId)
      .sort((a, b) => number(a.pick_no) - number(b.pick_no));

    const evaluated = picks.map((pick) => {
      const pickNo = Math.max(1, number(pick.pick_no, 1));
      const roundNo = Math.max(1, number(pick.round, 1));
      const weight = roundNo <= 3 ? 1.4 : roundNo <= 6 ? 1 : 0.72;
      const status = playerStatus(pick.player_id);
      if (!status.current) {
        return { pick, pickNo, rank: null, delta: null, weight, efficiency: 5, current: false, status };
      }
      const rank = draftPlayerRank(pick);
      if (!rank) return { pick, pickNo, rank: null, delta: null, weight: weight * 0.45, efficiency: 50, current: true, status };
      const delta = pickNo - rank;
      const efficiency = clamp(50 + (delta / Math.max(12, pickNo)) * 58, 8, 98);
      return { pick, pickNo, rank, delta, weight, efficiency, current: true, status };
    });

    const totalWeight = evaluated.reduce((sum, row) => sum + row.weight, 0);
    const valueScore = totalWeight ? evaluated.reduce((sum, row) => sum + row.efficiency * row.weight, 0) / totalWeight : 45;
    const balanceScore = positionalBalanceScore(picks);
    const inactive = evaluated.filter((row) => !row.current);
    const ranked = evaluated.filter((row) => row.current && row.rank);
    const coverage = picks.length ? ranked.length / picks.length : 0;
    const inactivePenalty = picks.length ? (inactive.length / picks.length) * 22 : 0;
    const raw = valueScore * 0.84 + balanceScore * 0.16 - inactivePenalty;
    const best = [...ranked].sort((a, b) => b.delta - a.delta)[0] || null;
    const reach = [...ranked].sort((a, b) => a.delta - b.delta)[0] || null;
    const concern = inactive[0] || reach || null;
    return { team, picks, evaluated, ranked, inactive, coverage, raw, best, reach, concern };
  }).filter((row) => row.picks.length);

  if (!rows.length) return;
  const rawValues = rows.map((row) => row.raw);
  const min = Math.min(...rawValues);
  const max = Math.max(...rawValues);
  state.draftGrades = rows.map((row) => {
    const percentile = max === min ? 50 : ((row.raw - min) / (max - min)) * 100;
    const score = clamp(58 + percentile * 0.35, 48, 93);
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

  if (state.drafts.length) {
    const season = String(state.league?.season || '');
    state.draft = state.drafts.find((d) => String(d?.season || '') === season && String(d?.status || '').toLowerCase() === 'complete')
      || state.drafts.find((d) => String(d?.season || '') === season)
      || state.drafts[0];
  }

  if (!state.draft?.draft_id && !needPlayers) return;
  const [playerRanks, picks] = await Promise.all([
    loadPlayerRanks(),
    state.draft?.draft_id ? api(`/draft/${state.draft.draft_id}/picks`).catch(() => []) : Promise.resolve([]),
  ]);
  state.playerRanks = playerRanks || {};
  state.draftPicks = Array.isArray(picks) ? picks : [];
  calculateDraftGrades();
}

function playerDraftPick(playerId) {
  return state.draftPicks.find((pick) => String(pick.player_id) === String(playerId)) || null;
}

function playerFantasyInfo(playerId) {
  const stats = state.playerStats.get(String(playerId));
  if (!stats || !stats.weeks) return null;
  return { ...stats, ppg: stats.total / stats.weeks };
}

function playerGradeInfo(playerId) {
  const status = playerStatus(playerId);
  const meta = playerMeta(playerId);
  if (!status.current) {
    return { score: status.kind === 'free_agent' ? 52 : 28, grade: 'F', basis: status.label, status };
  }

  const fantasy = playerFantasyInfo(playerId);
  const allFantasy = [...state.playerStats.entries()]
    .map(([id, info]) => ({ id, ppg: info.weeks ? info.total / info.weeks : 0, status: playerStatus(id) }))
    .filter((row) => row.status.current && row.ppg > 0)
    .sort((a, b) => b.ppg - a.ppg);

  if (fantasy && fantasy.ppg > 0 && allFantasy.length >= 8) {
    const rank = allFantasy.findIndex((row) => row.id === String(playerId)) + 1;
    const percentile = rank > 0 ? 1 - (rank - 1) / Math.max(allFantasy.length - 1, 1) : 0.5;
    const score = clamp(58 + percentile * 40, 55, 98);
    return { score, grade: letterGrade(score), basis: `${round(fantasy.ppg)} fantasy PPG · #${rank} in league pool`, status, ppg: fantasy.ppg, productionRank: rank };
  }

  const pick = playerDraftPick(playerId);
  if (pick && state.draftPicks.length) {
    const maxPick = Math.max(...state.draftPicks.map((p) => number(p.pick_no, 1)), 1);
    const pickNo = Math.max(1, number(pick.pick_no, 1));
    const percentile = 1 - (pickNo - 1) / Math.max(maxPick - 1, 1);
    const score = clamp(54 + percentile * 42, 52, 96);
    return { score, grade: letterGrade(score), basis: `Drafted #${pickNo}`, status, pickNo };
  }

  const searchRank = number(meta.search_rank, 0);
  if (searchRank > 0) {
    const score = clamp(80 - Math.log10(Math.max(searchRank, 1)) * 10, 55, 82);
    return { score, grade: letterGrade(score), basis: `Sleeper rank fallback #${searchRank}`, status, lowConfidence: true };
  }

  return { score: 62, grade: 'D', basis: 'Active · limited data', status, lowConfidence: true };
}

function playerAssetValue(playerId) {
  const info = playerGradeInfo(playerId);
  if (!info.status.current) return info.status.kind === 'free_agent' ? 10 : 0;
  return Math.pow(info.score, 2) / 100;
}

function calculatePowerRankings() {
  const teams = state.teams;
  const ppg = teams.map((team) => team.weeklyScores.length ? average(team.weeklyScores.map((x) => x.points)) : team.pf);
  const recent = teams.map((team, index) => {
    const scores = team.weeklyScores.slice(-3);
    return scores.length ? average(scores.map((x) => x.points)) : ppg[index];
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

function scheduleGamesForTeam(teamId) {
  const games = [];
  for (const [week, raw] of [...state.matchupWeeks.entries()].sort((a, b) => a[0] - b[0])) {
    const groups = new Map();
    raw.forEach((m) => {
      if (m?.matchup_id == null || m?.roster_id == null) return;
      if (!groups.has(m.matchup_id)) groups.set(m.matchup_id, []);
      groups.get(m.matchup_id).push(m);
    });
    groups.forEach((pair) => {
      if (pair.length !== 2) return;
      const mine = pair.find((m) => number(m.roster_id) === number(teamId));
      if (!mine) return;
      const other = pair.find((m) => m !== mine);
      const opponent = teamByRosterId(other?.roster_id);
      if (!opponent) return;
      const hasScores = Number.isFinite(Number(mine.points)) && Number.isFinite(Number(other.points));
      const completed = hasScores && !(number(mine.points) === 0 && number(other.points) === 0);
      games.push({ week, opponent, completed, points: completed ? number(mine.points) : null, opponentPoints: completed ? number(other.points) : null });
    });
  }
  return games;
}

function calculateScheduleStrength() {
  const rows = state.teams.map((team) => {
    const games = scheduleGamesForTeam(team.rosterId);
    const completed = games.filter((g) => g.completed);
    const remaining = games.filter((g) => !g.completed);
    const allOpp = games.map((g) => g.opponent.power);
    const playedOpp = completed.map((g) => g.opponent.power);
    const remainingOpp = remaining.map((g) => g.opponent.power);
    return {
      team,
      games,
      completed,
      remaining,
      overall: allOpp.length ? average(allOpp) : null,
      played: playedOpp.length ? average(playedOpp) : null,
      remainingStrength: remainingOpp.length ? average(remainingOpp) : null,
    };
  });

  const valid = rows.filter((row) => row.overall != null).sort((a, b) => b.overall - a.overall);
  valid.forEach((row, index) => {
    row.rank = index + 1;
    row.team.schedule = row;
  });
  rows.filter((row) => row.overall == null).forEach((row) => { row.team.schedule = row; });
  return valid;
}

async function loadTransactionsData() {
  const maxRound = clamp(Math.max(state.currentWeek, 1), 1, 30);
  const rounds = [0, ...Array.from({ length: maxRound }, (_, index) => index + 1)];
  const results = await Promise.all(rounds.map(async (roundNo) => {
    try {
      const txns = await api(`/league/${LEAGUE_ID}/transactions/${roundNo}`);
      return Array.isArray(txns) ? txns : [];
    } catch (_) {
      return [];
    }
  }));
  const byId = new Map();
  results.flat().forEach((txn) => {
    const id = txn?.transaction_id || `${txn?.created || ''}-${JSON.stringify(txn?.adds || {})}`;
    if (id) byId.set(String(id), txn);
  });
  state.transactions = [...byId.values()]
    .filter((txn) => !txn?.status || String(txn.status).toLowerCase() === 'complete')
    .sort((a, b) => number(b.status_updated || b.created) - number(a.status_updated || a.created));
}

function draftPickAssetValue(pick) {
  const roundNo = Math.max(1, number(pick?.round, 1));
  const base = { 1: 78, 2: 58, 3: 44, 4: 34, 5: 27 }[roundNo] || Math.max(12, 30 - roundNo * 3);
  return base;
}

function transactionPlayerIdsForRoster(map, rosterId) {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .filter(([, value]) => number(value) === number(rosterId))
    .map(([playerId]) => String(playerId));
}

function gradeTransactionParty(txn, rosterId, type) {
  const receivedPlayers = transactionPlayerIdsForRoster(txn.adds, rosterId);
  const sentPlayers = transactionPlayerIdsForRoster(txn.drops, rosterId);
  const draftPicks = Array.isArray(txn.draft_picks) ? txn.draft_picks : [];
  const receivedPicks = draftPicks.filter((pick) => number(pick.owner_id || pick.roster_id) === number(rosterId));
  const sentPicks = draftPicks.filter((pick) => number(pick.previous_owner_id) === number(rosterId) && number(pick.owner_id || pick.roster_id) !== number(rosterId));

  const receivedValue = receivedPlayers.reduce((sum, id) => sum + playerAssetValue(id), 0) + receivedPicks.reduce((sum, pick) => sum + draftPickAssetValue(pick), 0);
  const sentValue = sentPlayers.reduce((sum, id) => sum + playerAssetValue(id), 0) + sentPicks.reduce((sum, pick) => sum + draftPickAssetValue(pick), 0);
  const meaningful = receivedPlayers.length + sentPlayers.length + receivedPicks.length + sentPicks.length > 0;

  let score = 72;
  if (!meaningful) score = 60;
  else if (type === 'trade') {
    const denominator = Math.max(24, receivedValue + sentValue);
    score = clamp(82 + ((receivedValue - sentValue) / denominator) * 56, 48, 97);
  } else {
    const avgAdded = receivedPlayers.length ? average(receivedPlayers.map((id) => playerGradeInfo(id).score)) : 55;
    const avgDropped = sentPlayers.length ? average(sentPlayers.map((id) => playerGradeInfo(id).score)) : 50;
    score = clamp(74 + (avgAdded - avgDropped) * 0.45 + Math.max(0, avgAdded - 72) * 0.18, 50, 96);
  }

  return {
    rosterId: number(rosterId),
    team: teamByRosterId(rosterId),
    receivedPlayers,
    sentPlayers,
    receivedPicks,
    sentPicks,
    receivedValue,
    sentValue,
    score,
    grade: letterGrade(score),
  };
}

function calculateTransactionGrades() {
  state.transactionGrades = state.transactions.map((txn) => {
    const rosterIds = new Set((Array.isArray(txn.roster_ids) ? txn.roster_ids : []).map(number));
    Object.values(txn.adds || {}).forEach((id) => rosterIds.add(number(id)));
    Object.values(txn.drops || {}).forEach((id) => rosterIds.add(number(id)));
    (txn.draft_picks || []).forEach((pick) => {
      if (pick?.owner_id) rosterIds.add(number(pick.owner_id));
      if (pick?.previous_owner_id) rosterIds.add(number(pick.previous_owner_id));
    });
    rosterIds.delete(0);
    const explicitType = String(txn.type || '').toLowerCase();
    const type = explicitType === 'trade' || rosterIds.size > 1 ? 'trade' : explicitType === 'waiver' ? 'waiver' : 'free_agent';
    const parties = [...rosterIds].map((rosterId) => gradeTransactionParty(txn, rosterId, type));
    return {
      txn,
      type,
      parties,
      created: number(txn.status_updated || txn.created),
    };
  }).filter((row) => row.parties.length);
}

function teamByRosterId(id) {
  return state.teams.find((team) => team.rosterId === number(id)) || null;
}
function standings() { return [...state.teams].sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.pf - a.pf); }
function rankings() { return [...state.teams].sort((a, b) => b.power - a.power || b.pf - a.pf); }
function scheduleRankings() { return state.teams.filter((t) => t.schedule?.overall != null).sort((a, b) => b.schedule.overall - a.schedule.overall); }
function teamUrl(team) { return `team.html?roster=${encodeURIComponent(team.rosterId)}&v=${CACHE_VERSION}`; }

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

async function loadData({ needPlayers = false, needSchedule = false, needTransactions = false } = {}) {
  state.matchupWeeks.clear();
  state.transactions = [];
  state.transactionGrades = [];
  state.playerStats = new Map();

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

  await Promise.all([
    needSchedule ? loadScheduleData() : loadHistoricalMatchups(),
    loadDraftData(drafts, needPlayers || needTransactions),
    needTransactions ? loadTransactionsData() : Promise.resolve(),
  ]);

  enrichTeamsFromMatchups();
  calculatePowerRankings();
  if (needSchedule) calculateScheduleStrength();
  if (needTransactions) calculateTransactionGrades();
  return state;
}

window.Babashop = {
  LEAGUE_ID, CACHE_VERSION, state, loadData, loadMatchupWeek, teamByRosterId, rankings, standings,
  scheduleRankings, teamUrl, superlatives, playerNameFromId, playerMeta, playerStatus, playerGradeInfo,
  playerFantasyInfo, playerAssetValue, draftPlayerName, draftPlayerRank, round, number, escapeHtml,
  avatarUrl, groupMatchups, letterGrade, scheduleGamesForTeam,
};