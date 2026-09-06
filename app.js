const LEAGUE_ID = '1401342003886714880';
const API = 'https://api.sleeper.app/v1';

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

const el = (id) => document.getElementById(id);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 1) => Number(value).toFixed(digits).replace(/\.0$/, '');
const safeText = (value, fallback = '—') => value === null || value === undefined || value === '' ? fallback : String(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
  const weeks = Array.from({ length: maxWeek }, (_, index) => index + 1);
  await Promise.all(weeks.map(loadMatchupWeek));
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
      const opponentsBeaten = scored.filter((other) => other.rosterId !== item.rosterId && item.points > other.points).length;
      const opponentsTied = scored.filter((other) => other.rosterId !== item.rosterId && item.points === other.points).length;
      team.allPlayWins += opponentsBeaten + opponentsTied * 0.5;
      team.allPlayGames += Math.max(scored.length - 1, 0);
    });

    const grouped = groupMatchups(scored);
    for (const pair of grouped) {
      if (pair.length !== 2) continue;
      const [a, b] = pair;
      const teamA = teamsById.get(a.rosterId);
      const teamB = teamsById.get(b.rosterId);
      if (!teamA || !teamB) continue;
      if (a.points > b.points) {
        teamA.recentForm.push({ week, result: 'W' });
        teamB.recentForm.push({ week, result: 'L' });
      } else if (b.points > a.points) {
        teamA.recentForm.push({ week, result: 'L' });
        teamB.recentForm.push({ week, result: 'W' });
      } else {
        teamA.recentForm.push({ week, result: 'T' });
        teamB.recentForm.push({ week, result: 'T' });
      }
    }
  }

  state.completedWeeks = completedWeeks;
}

function groupMatchups(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = item.matchupId ?? `solo-${item.rosterId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.values()];
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

function draftPlayerName(pick) {
  const player = state.playerRanks?.[String(pick?.player_id)] || {};
  const metadata = pick?.metadata || {};
  const first = player.first_name || metadata.first_name || '';
  const last = player.last_name || metadata.last_name || '';
  return `${first} ${last}`.trim() || metadata.full_name || `Player ${pick?.player_id || ''}`.trim();
}

function draftPlayerRank(pick) {
  const player = state.playerRanks?.[String(pick?.player_id)] || {};
  const metadata = pick?.metadata || {};
  const rank = number(player.search_rank || metadata.search_rank, 0);
  return rank > 0 ? rank : null;
}

function draftPlayerPositions(pick) {
  const player = state.playerRanks?.[String(pick?.player_id)] || {};
  const metadata = pick?.metadata || {};
  const positions = player.fantasy_positions || metadata.fantasy_positions || [];
  if (Array.isArray(positions) && positions.length) return positions.map(String);
  const position = player.position || metadata.position;
  return position ? [String(position)] : [];
}

function loadCachedPlayers() {
  try {
    const raw = localStorage.getItem('babashop:nba-player-ranks');
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
    localStorage.setItem('babashop:nba-player-ranks', JSON.stringify({ savedAt: Date.now(), players }));
  } catch (_) {
    // Storage is optional; the dashboard still works without it.
  }
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
      };
    });
    cachePlayers(compact);
    return compact;
  } catch (error) {
    console.warn('Could not load Sleeper NBA player ranks', error);
    return {};
  }
}

async function loadDraftData(initialDrafts = null) {
  state.drafts = Array.isArray(initialDrafts) ? initialDrafts : [];
  state.draft = null;
  state.draftPicks = [];
  state.playerRanks = {};
  state.draftGrades = [];

  if (!state.drafts.length) return;
  const season = String(state.league?.season || '');
  state.draft = state.drafts.find((draft) => String(draft?.season || '') === season && String(draft?.status || '').toLowerCase() === 'complete')
    || state.drafts.find((draft) => String(draft?.season || '') === season)
    || state.drafts[0];

  if (!state.draft?.draft_id) return;
  try {
    const [picks, playerRanks] = await Promise.all([
      api(`/draft/${state.draft.draft_id}/picks`).catch(() => []),
      loadPlayerRanks(),
    ]);
    state.draftPicks = Array.isArray(picks) ? picks : [];
    state.playerRanks = playerRanks || {};
    calculateDraftGrades();
  } catch (error) {
    console.warn('Could not load draft analytics', error);
  }
}

function positionalBalanceScore(picks) {
  if (!picks.length) return 50;
  const buckets = { G: 0, F: 0, C: 0 };
  picks.forEach((pick) => {
    const positions = draftPlayerPositions(pick);
    if (positions.some((position) => /PG|SG|(^|\/)G($|\/)/.test(position))) buckets.G += 1;
    if (positions.some((position) => /SF|PF|(^|\/)F($|\/)/.test(position))) buckets.F += 1;
    if (positions.some((position) => /(^|\/)C($|\/)/.test(position))) buckets.C += 1;
  });

  const represented = Object.values(buckets).filter((count) => count > 0).length;
  const counts = Object.values(buckets).filter((count) => count > 0);
  if (!counts.length) return 60;
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const spreadPenalty = Math.min(18, Math.max(0, max - min - 2) * 4);
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

  const teamRows = state.teams.map((team) => {
    const picks = state.draftPicks
      .filter((pick) => draftRosterId(pick) === team.rosterId)
      .sort((a, b) => number(a.pick_no) - number(b.pick_no));

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

    const weightedTotal = ranked.reduce((sum, row) => sum + row.efficiency * row.weight, 0);
    const totalWeight = ranked.reduce((sum, row) => sum + row.weight, 0);
    const valueScore = totalWeight ? weightedTotal / totalWeight : 55;
    const balanceScore = positionalBalanceScore(picks);
    const coverage = picks.length ? ranked.length / picks.length : 0;
    const raw = valueScore * 0.82 + balanceScore * 0.18;
    const best = [...ranked].sort((a, b) => b.delta - a.delta)[0] || null;
    const reach = [...ranked].sort((a, b) => a.delta - b.delta)[0] || null;
    return { team, picks, ranked, valueScore, balanceScore, coverage, raw, best, reach };
  }).filter((row) => row.picks.length);

  if (!teamRows.length) return;
  const rawValues = teamRows.map((row) => row.raw);
  const rawMin = Math.min(...rawValues);
  const rawMax = Math.max(...rawValues);

  state.draftGrades = teamRows.map((row) => {
    const relative = rawMax === rawMin ? 0.5 : (row.raw - rawMin) / (rawMax - rawMin);
    const score = clamp(69 + relative * 25, 60, 96);
    const grade = letterGrade(score);
    row.team.draftScore = score;
    row.team.draftGrade = grade;
    return { ...row, score, grade };
  }).sort((a, b) => b.score - a.score);
}

function calculatePowerRankings() {
  const teams = state.teams;
  const ppg = teams.map((team) => team.weeklyScores.length ? team.weeklyScores.reduce((sum, item) => sum + item.points, 0) / team.weeklyScores.length : team.pf);
  const recent = teams.map((team) => {
    const scores = team.weeklyScores.slice(-3);
    return scores.length ? scores.reduce((sum, item) => sum + item.points, 0) / scores.length : (team.weeklyScores.length ? ppg[teams.indexOf(team)] : team.pf);
  });
  const ppgNorm = normalizedScores(ppg);
  const recentNorm = normalizedScores(recent);
  const weeks = state.completedWeeks?.length || 0;

  teams.forEach((team, index) => {
    const allPlayPct = team.allPlayGames ? team.allPlayWins / team.allPlayGames : team.winPct;
    const winScore = team.winPct * 100;
    team.ppg = ppg[index];
    team.recentAvg = recent[index];
    team.allPlayPct = allPlayPct;
    team.expectedWins = team.allPlayGames && weeks ? allPlayPct * weeks : team.wins;
    team.luck = team.wins - team.expectedWins;

    if (!weeks) {
      team.power = team.draftScore ?? 50;
      return;
    }

    const performance = 0.25 * winScore + 0.30 * ppgNorm[index] + 0.25 * (allPlayPct * 100) + 0.20 * recentNorm[index];
    const draftWeight = team.draftScore === null ? 0 : clamp((5 - weeks) / 5, 0, 1) * 0.22;
    team.power = performance * (1 - draftWeight) + (team.draftScore ?? performance) * draftWeight;
  });
}

function teamByRosterId(id) {
  return state.teams.find((team) => team.rosterId === number(id));
}

function renderHeader() {
  const league = state.league;
  el('leagueName').textContent = league?.name || 'Babashop Analytics';
  const status = safeText(league?.status, 'unknown').replaceAll('_', ' ');
  const season = safeText(league?.season, 'Season');
  el('leagueMeta').textContent = `${season} · ${status} · ${state.teams.length} teams`;
  el('teamCount').textContent = state.teams.length;
  el('currentWeek').textContent = state.currentWeek || 'Pre';
  el('weekNote').textContent = state.currentWeek ? 'Sleeper NBA state' : 'season has not started';

  if (league?.avatar) {
    el('leagueAvatar').src = avatarUrl(league.avatar);
    el('leagueAvatar').classList.remove('hidden');
  }
}

function renderSummary() {
  const sortedByPoints = [...state.teams].sort((a, b) => b.pf - a.pf);
  const top = sortedByPoints[0];
  const hasScoring = top && top.pf > 0;
  el('topScorer').textContent = hasScoring ? top.name : '—';
  el('topScorerNote').textContent = hasScoring ? `${round(top.pf)} total points` : 'season points';

  const weeklyScores = state.teams.flatMap((team) => team.weeklyScores.map((entry) => entry.points));
  const average = weeklyScores.length ? weeklyScores.reduce((sum, value) => sum + value, 0) / weeklyScores.length : 0;
  el('leagueAverage').textContent = weeklyScores.length ? round(average) : '—';
}

function createTeamCell(team) {
  const avatar = team.avatar
    ? `<img class="team-avatar" src="${team.avatar}" alt="" loading="lazy">`
    : `<div class="team-avatar" aria-hidden="true"></div>`;
  return `<div class="team-cell">${avatar}<div class="team-cell-copy"><span class="team-name">${escapeHtml(team.name)}</span><span class="team-owner">${escapeHtml(team.owner)}</span></div></div>`;
}

function renderStandings() {
  const standings = [...state.teams].sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.pf - a.pf);
  el('standingsBody').innerHTML = standings.map((team, index) => {
    const diffClass = team.diff > 0 ? 'diff-positive' : team.diff < 0 ? 'diff-negative' : '';
    return `<tr>
      <td>${index + 1}</td>
      <td>${createTeamCell(team)}</td>
      <td>${team.wins}</td>
      <td>${team.losses}</td>
      <td>${round(team.pf)}</td>
      <td>${round(team.pa)}</td>
      <td class="${diffClass}">${team.diff > 0 ? '+' : ''}${round(team.diff)}</td>
    </tr>`;
  }).join('');
}

function renderPowerRankings() {
  const rankings = [...state.teams].sort((a, b) => b.power - a.power || b.pf - a.pf);
  if (!rankings.length) {
    el('powerRankings').innerHTML = '<div class="empty-state">No roster data yet.</div>';
    return;
  }

  const preseason = !state.completedWeeks?.length;
  if (preseason && !state.draftGrades.length) {
    el('powerRankings').innerHTML = '<div class="empty-state">Preseason power rankings will appear after the draft. In-season rankings begin after scored matchups.</div>';
    return;
  }

  el('powerRankings').innerHTML = rankings.map((team, index) => {
    const detail = preseason
      ? `Preseason · draft ${team.draftGrade || '—'}`
      : `${team.wins}-${team.losses} · ${round(team.ppg || 0)} PPG · ${Math.round(team.allPlayPct * 100)}% all-play${team.draftGrade && state.completedWeeks.length < 5 ? ` · draft ${team.draftGrade}` : ''}`;
    return `<div class="ranking-row">
      <span class="rank-number">${index + 1}</span>
      <div class="rank-copy"><span class="rank-name">${escapeHtml(team.name)}</span><span class="rank-detail">${escapeHtml(detail)}</span></div>
      <span class="rank-score">${Math.round(team.power)}</span>
    </div>`;
  }).join('');
}

function renderDraftGrades() {
  const container = el('draftGrades');
  if (!state.draft) {
    container.innerHTML = '<div class="empty-state">No Sleeper draft is attached to this league yet.</div>';
    return;
  }
  if (!state.draftPicks.length) {
    const status = safeText(state.draft.status, 'not started').replaceAll('_', ' ');
    container.innerHTML = `<div class="empty-state">Draft grades will populate when picks are available. Draft status: ${escapeHtml(status)}.</div>`;
    return;
  }
  if (!state.draftGrades.length) {
    container.innerHTML = '<div class="empty-state">Draft picks loaded, but there was not enough rank data to calculate grades.</div>';
    return;
  }

  container.innerHTML = state.draftGrades.map((row, index) => {
    const best = row.best ? `${draftPlayerName(row.best.pick)} at ${row.best.pickNo}` : 'No ranked steal available';
    const reach = row.reach && row.reach.delta < -2 ? `${draftPlayerName(row.reach.pick)} at ${row.reach.pickNo}` : 'No major reach flagged';
    const coverage = Math.round(row.coverage * 100);
    return `<div class="ranking-row">
      <span class="rank-number">${index + 1}</span>
      <div class="rank-copy">
        <span class="rank-name">${escapeHtml(row.team.name)}</span>
        <span class="rank-detail">Best value: ${escapeHtml(best)} · ${escapeHtml(reach)} · ${coverage}% rank coverage</span>
      </div>
      <span class="rank-score">${escapeHtml(row.grade)}</span>
    </div>`;
  }).join('');
}

function buildWeekSelect() {
  const select = el('weekSelect');
  const maxWeek = Math.max(state.currentWeek, 1);
  select.innerHTML = Array.from({ length: maxWeek }, (_, index) => index + 1)
    .map((week) => `<option value="${week}" ${week === maxWeek ? 'selected' : ''}>${week}</option>`)
    .join('');
  select.disabled = state.currentWeek < 1;
}

async function renderMatchups(week) {
  const container = el('matchups');
  if (!state.currentWeek) {
    container.innerHTML = '<div class="empty-state">Matchups will appear here once the season starts.</div>';
    return;
  }
  container.innerHTML = '<div class="empty-state">Loading matchups…</div>';
  const raw = await loadMatchupWeek(week);
  if (!raw.length) {
    container.innerHTML = '<div class="empty-state">No matchup data is available for this week yet.</div>';
    return;
  }

  const groups = new Map();
  raw.forEach((matchup) => {
    const key = matchup.matchup_id ?? `solo-${matchup.roster_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(matchup);
  });

  container.innerHTML = [...groups.values()].map((pair) => {
    const sortedPair = [...pair].sort((a, b) => number(b.points) - number(a.points));
    return `<div class="matchup-card">${sortedPair.map((matchup) => {
      const team = teamByRosterId(matchup.roster_id);
      const points = Number.isFinite(Number(matchup.points)) ? number(matchup.points) : null;
      const isWinner = pair.length === 2 && points !== null && points > number(pair.find((item) => item !== matchup)?.points);
      return `<div class="matchup-team"><span class="matchup-team-name">${escapeHtml(team?.name || `Team ${matchup.roster_id}`)}</span><span class="matchup-score ${isWinner ? 'winner' : ''}">${points === null ? '—' : round(points)}</span></div>`;
    }).join('')}</div>`;
  }).join('');
}

function getAllCompletedPairs() {
  const pairs = [];
  for (const [week, raw] of state.matchupWeeks.entries()) {
    const byMatchup = new Map();
    raw.forEach((matchup) => {
      if (!Number.isFinite(Number(matchup.points))) return;
      const key = matchup.matchup_id;
      if (key === null || key === undefined) return;
      if (!byMatchup.has(key)) byMatchup.set(key, []);
      byMatchup.get(key).push(matchup);
    });
    for (const group of byMatchup.values()) {
      if (group.length !== 2 || group.every((item) => number(item.points) === 0)) continue;
      pairs.push({ week, a: group[0], b: group[1] });
    }
  }
  return pairs;
}

function renderSuperlatives() {
  const pairs = getAllCompletedPairs();
  const allScores = state.teams.flatMap((team) => team.weeklyScores.map((score) => ({ ...score, team })));
  if (!allScores.length) {
    el('superlatives').innerHTML = '<div class="empty-state">Season records will populate after completed matchups.</div>';
    return;
  }

  const highest = [...allScores].sort((a, b) => b.points - a.points)[0];
  const lowest = [...allScores].sort((a, b) => a.points - b.points)[0];
  const closest = [...pairs].sort((x, y) => Math.abs(number(x.a.points) - number(x.b.points)) - Math.abs(number(y.a.points) - number(y.b.points)))[0];
  const biggest = [...pairs].sort((x, y) => Math.abs(number(y.a.points) - number(y.b.points)) - Math.abs(number(x.a.points) - number(x.b.points)))[0];

  const rows = [
    ['Highest score', `${highest.team.name} · ${round(highest.points)}`, `Week ${highest.week}`],
    ['Lowest score', `${lowest.team.name} · ${round(lowest.points)}`, `Week ${lowest.week}`],
  ];

  if (closest) {
    const a = teamByRosterId(closest.a.roster_id);
    const b = teamByRosterId(closest.b.roster_id);
    rows.push(['Closest matchup', `${a?.name || 'Team'} vs ${b?.name || 'Team'}`, `Week ${closest.week} · ${round(Math.abs(number(closest.a.points) - number(closest.b.points)))} pts`]);
  }
  if (biggest) {
    const a = teamByRosterId(biggest.a.roster_id);
    const b = teamByRosterId(biggest.b.roster_id);
    rows.push(['Biggest blowout', `${a?.name || 'Team'} vs ${b?.name || 'Team'}`, `Week ${biggest.week} · ${round(Math.abs(number(biggest.a.points) - number(biggest.b.points)))} pts`]);
  }

  el('superlatives').innerHTML = rows.map(([label, value, detail]) => `<div class="superlative-row"><span class="superlative-label">${escapeHtml(label)}</span><span class="superlative-value">${escapeHtml(value)}</span><span class="superlative-detail">${escapeHtml(detail)}</span></div>`).join('');
}

function renderTeamGrid() {
  const teams = [...state.teams].sort((a, b) => b.power - a.power || b.pf - a.pf);
  el('teamGrid').innerHTML = teams.map((team) => {
    const avatar = team.avatar ? `<img class="team-avatar" src="${team.avatar}" alt="" loading="lazy">` : `<div class="team-avatar" aria-hidden="true"></div>`;
    const luck = team.allPlayGames ? team.luck : null;
    const luckClass = luck > 0.15 ? 'diff-positive' : luck < -0.15 ? 'diff-negative' : '';
    const form = team.recentForm.slice(-5).map((item) => `<span class="form-dot ${item.result === 'W' ? 'win' : item.result === 'L' ? 'loss' : 'tie'}" title="Week ${item.week}">${item.result}</span>`).join('');
    return `<article class="team-card">
      <div class="team-card-top">${avatar}<div class="team-card-copy"><span class="team-card-name">${escapeHtml(team.name)}</span><span class="team-card-owner">${escapeHtml(team.owner)}</span></div></div>
      <div class="team-metrics">
        <div class="team-metric"><span class="team-metric-label">Record</span><span class="team-metric-value">${team.wins}-${team.losses}</span></div>
        <div class="team-metric"><span class="team-metric-label">PPG</span><span class="team-metric-value">${team.weeklyScores.length ? round(team.ppg) : '—'}</span></div>
        <div class="team-metric"><span class="team-metric-label">${state.completedWeeks.length ? 'Luck' : 'Draft'}</span><span class="team-metric-value ${luckClass}">${state.completedWeeks.length ? (luck === null ? '—' : `${luck > 0 ? '+' : ''}${round(luck, 2)}`) : (team.draftGrade || '—')}</span></div>
      </div>
      <div class="form-row">${form || '<span class="team-owner">Recent form will appear after games.</span>'}</div>
    </article>`;
  }).join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setStatus(message, type = '') {
  const banner = el('statusBanner');
  banner.textContent = message;
  banner.className = `status-banner${type ? ` ${type}` : ''}`;
}

async function loadDashboard() {
  el('refreshButton').disabled = true;
  setStatus('Connecting to Sleeper…');
  try {
    state.matchupWeeks.clear();
    const [league, rosters, users, nbaState, drafts] = await Promise.all([
      api(`/league/${LEAGUE_ID}`),
      api(`/league/${LEAGUE_ID}/rosters`),
      api(`/league/${LEAGUE_ID}/users`),
      api('/state/nba').catch(() => null),
      api(`/league/${LEAGUE_ID}/drafts`).catch(() => []),
    ]);

    if (!league || !Array.isArray(rosters) || !Array.isArray(users)) throw new Error('Sleeper returned incomplete league data.');
    state.league = league;
    state.rosters = rosters;
    state.users = users;
    state.nbaState = nbaState;
    state.currentWeek = getCurrentWeek(league, nbaState);
    state.teams = buildTeams();

    renderHeader();
    buildWeekSelect();
    el('dashboard').classList.remove('hidden');
    setStatus('League loaded. Calculating draft and matchup analytics…');

    await Promise.all([
      loadDraftData(drafts),
      loadHistoricalMatchups(),
    ]);
    enrichTeamsFromMatchups();
    calculatePowerRankings();
    renderSummary();
    renderStandings();
    renderPowerRankings();
    renderDraftGrades();
    renderSuperlatives();
    renderTeamGrid();
    await renderMatchups(Math.max(state.currentWeek, 1));

    const notes = [];
    if (state.draftPicks.length) notes.push(`${state.draftPicks.length} draft picks graded`);
    if (state.completedWeeks?.length) notes.push(`${state.completedWeeks.length} scored weeks analyzed`);
    setStatus(`Updated from Sleeper${notes.length ? ` · ${notes.join(' · ')}` : ''}.`, 'success');
  } catch (error) {
    console.error(error);
    setStatus(`Could not load this league from Sleeper. ${error.message}`, 'error');
  } finally {
    el('refreshButton').disabled = false;
  }
}

el('refreshButton').addEventListener('click', loadDashboard);
el('weekSelect').addEventListener('change', (event) => renderMatchups(number(event.target.value, 1)));
el('powerInfoButton').addEventListener('click', () => el('powerInfo').classList.toggle('hidden'));
el('draftInfoButton').addEventListener('click', () => el('draftInfo').classList.toggle('hidden'));

loadDashboard();
