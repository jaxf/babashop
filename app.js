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
};

const el = (id) => document.getElementById(id);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 1) => Number(value).toFixed(digits).replace(/\.0$/, '');
const safeText = (value, fallback = '—') => value === null || value === undefined || value === '' ? fallback : String(value);

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

function calculatePowerRankings() {
  const teams = state.teams;
  const ppg = teams.map((team) => team.weeklyScores.length ? team.weeklyScores.reduce((sum, item) => sum + item.points, 0) / team.weeklyScores.length : team.pf);
  const recent = teams.map((team) => {
    const scores = team.weeklyScores.slice(-3);
    return scores.length ? scores.reduce((sum, item) => sum + item.points, 0) / scores.length : (team.weeklyScores.length ? ppg[teams.indexOf(team)] : team.pf);
  });
  const ppgNorm = normalizedScores(ppg);
  const recentNorm = normalizedScores(recent);

  teams.forEach((team, index) => {
    const allPlayPct = team.allPlayGames ? team.allPlayWins / team.allPlayGames : team.winPct;
    const winScore = team.winPct * 100;
    team.ppg = ppg[index];
    team.recentAvg = recent[index];
    team.allPlayPct = allPlayPct;
    team.expectedWins = team.allPlayGames && state.completedWeeks?.length ? allPlayPct * state.completedWeeks.length : team.wins;
    team.luck = team.wins - team.expectedWins;
    team.power = 0.35 * winScore + 0.30 * ppgNorm[index] + 0.20 * (allPlayPct * 100) + 0.15 * recentNorm[index];
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
  if (!state.completedWeeks?.length) {
    el('powerRankings').innerHTML = '<div class="empty-state">Power rankings activate after the first scored matchup week.</div>';
    return;
  }
  if (!rankings.length) {
    el('powerRankings').innerHTML = '<div class="empty-state">No roster data yet.</div>';
    return;
  }
  el('powerRankings').innerHTML = rankings.map((team, index) => {
    const allPlay = team.allPlayGames ? `${Math.round(team.allPlayPct * 100)}% all-play` : 'waiting for matchups';
    return `<div class="ranking-row">
      <span class="rank-number">${index + 1}</span>
      <div class="rank-copy"><span class="rank-name">${escapeHtml(team.name)}</span><span class="rank-detail">${team.wins}-${team.losses} · ${round(team.ppg || 0)} PPG · ${allPlay}</span></div>
      <span class="rank-score">${Math.round(team.power)}</span>
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
        <div class="team-metric"><span class="team-metric-label">Luck</span><span class="team-metric-value ${luckClass}">${luck === null ? '—' : `${luck > 0 ? '+' : ''}${round(luck, 2)}`}</span></div>
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
    const [league, rosters, users, nbaState] = await Promise.all([
      api(`/league/${LEAGUE_ID}`),
      api(`/league/${LEAGUE_ID}/rosters`),
      api(`/league/${LEAGUE_ID}/users`),
      api('/state/nba').catch(() => null),
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
    setStatus('League loaded. Calculating matchup analytics…');

    await loadHistoricalMatchups();
    enrichTeamsFromMatchups();
    calculatePowerRankings();
    renderSummary();
    renderStandings();
    renderPowerRankings();
    renderSuperlatives();
    renderTeamGrid();
    await renderMatchups(Math.max(state.currentWeek, 1));

    setStatus(`Updated from Sleeper${state.completedWeeks?.length ? ` · ${state.completedWeeks.length} scored weeks analyzed` : ''}.`, 'success');
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

loadDashboard();
