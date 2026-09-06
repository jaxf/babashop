const B = window.Babashop;
const $ = (id) => document.getElementById(id);

function setStatus(message, type = '') {
  const el = $('statusBanner');
  if (!el) return;
  el.textContent = message;
  el.className = `status-banner${type ? ` ${type}` : ''}`;
}

function teamCell(team, link = true) {
  const avatar = team.avatar ? `<img class="team-avatar" src="${team.avatar}" alt="" loading="lazy">` : `<div class="team-avatar" aria-hidden="true"></div>`;
  const inner = `${avatar}<div class="team-cell-copy"><span class="team-name">${B.escapeHtml(team.name)}</span><span class="team-owner">${B.escapeHtml(team.owner)}</span></div>`;
  return link ? `<a class="team-cell team-link" href="${B.teamUrl(team)}">${inner}</a>` : `<div class="team-cell">${inner}</div>`;
}

function renderLeagueHeader() {
  if ($('leagueName')) $('leagueName').textContent = B.state.league?.name || 'Babashop Analytics';
  if ($('leagueMeta')) {
    const status = String(B.state.league?.status || 'unknown').replaceAll('_', ' ');
    $('leagueMeta').textContent = `${B.state.league?.season || 'Season'} · ${status} · ${B.state.teams.length} teams`;
  }
  const avatar = $('leagueAvatar');
  if (avatar && B.state.league?.avatar) {
    avatar.src = B.avatarUrl(B.state.league.avatar);
    avatar.classList.remove('hidden');
  }
}

function renderHome() {
  renderLeagueHeader();
  const ranks = B.rankings();
  const leader = ranks[0];
  const scores = B.state.teams.flatMap((t) => t.weeklyScores.map((s) => s.points));
  $('teamCount').textContent = B.state.teams.length;
  $('currentWeek').textContent = B.state.currentWeek || 'Pre';
  $('powerLeader').textContent = leader?.name || '—';
  $('powerLeaderNote').textContent = leader ? `${Math.round(leader.power)} power score` : 'current model leader';
  $('leagueAverage').textContent = scores.length ? B.round(scores.reduce((a, b) => a + b, 0) / scores.length) : '—';
  $('powerPreview').innerHTML = ranks.slice(0, 5).map((team, index) => `
    <a class="ranking-row ranking-link" href="${B.teamUrl(team)}">
      <span class="rank-number">${index + 1}</span>
      <div class="rank-copy"><span class="rank-name">${B.escapeHtml(team.name)}</span><span class="rank-detail">${team.wins}-${team.losses}${team.draftGrade ? ` · Draft ${team.draftGrade}` : ''}</span></div>
      <span class="rank-score">${Math.round(team.power)}</span>
    </a>`).join('');
  $('teamDirectory').innerHTML = B.state.teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((team) => `<a class="directory-card" href="${B.teamUrl(team)}">${teamCell(team, false)}<span class="directory-arrow">→</span></a>`).join('');
  const extras = B.superlatives();
  $('homeExtras').innerHTML = extras.length ? extras.map((row) => `<div class="mini-stat"><span>${B.escapeHtml(row.label)}</span><strong>${B.escapeHtml(row.value)}</strong><small>${B.escapeHtml(row.detail)}</small></div>`).join('') : '<div class="empty-state">League records appear after scored matchups.</div>';
}

function renderStandings() {
  renderLeagueHeader();
  $('standingsBody').innerHTML = B.standings().map((team, index) => `<tr><td>${index + 1}</td><td>${teamCell(team)}</td><td>${team.wins}</td><td>${team.losses}</td><td>${B.round(team.pf)}</td><td>${B.round(team.pa)}</td><td class="${team.diff > 0 ? 'diff-positive' : team.diff < 0 ? 'diff-negative' : ''}">${team.diff > 0 ? '+' : ''}${B.round(team.diff)}</td></tr>`).join('');
  const maxWeek = Math.max(B.state.currentWeek, 1);
  $('weekSelect').innerHTML = Array.from({ length: maxWeek }, (_, i) => i + 1).map((week) => `<option value="${week}" ${week === maxWeek ? 'selected' : ''}>Week ${week}</option>`).join('');
  $('weekSelect').disabled = !B.state.currentWeek;
  renderMatchups(maxWeek);
  const extras = B.superlatives();
  $('superlatives').innerHTML = extras.length ? extras.map((row) => `<div class="mini-stat"><span>${B.escapeHtml(row.label)}</span><strong>${B.escapeHtml(row.value)}</strong><small>${B.escapeHtml(row.detail)}</small></div>`).join('') : '<div class="empty-state">Season records appear after scored matchups.</div>';
}

async function renderMatchups(week) {
  if (!$('matchups')) return;
  if (!B.state.currentWeek) {
    $('matchups').innerHTML = '<div class="empty-state">Matchups appear once the season starts.</div>';
    return;
  }
  const raw = await B.loadMatchupWeek(week);
  const groups = new Map();
  raw.forEach((m) => {
    const key = m.matchup_id ?? `solo-${m.roster_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  $('matchups').innerHTML = [...groups.values()].map((pair) => `<div class="matchup-card">${pair.map((m) => {
    const team = B.teamByRosterId(m.roster_id);
    return `<div class="matchup-team"><a href="${team ? B.teamUrl(team) : '#'}">${B.escapeHtml(team?.name || `Team ${m.roster_id}`)}</a><strong>${Number.isFinite(Number(m.points)) ? B.round(m.points) : '—'}</strong></div>`;
  }).join('')}</div>`).join('') || '<div class="empty-state">No matchup data for this week yet.</div>';
}

function renderPower() {
  renderLeagueHeader();
  $('powerRankings').innerHTML = B.rankings().map((team, index) => `
    <a class="ranking-row ranking-link ranking-row-large" href="${B.teamUrl(team)}">
      <span class="rank-number">${index + 1}</span>
      <div class="rank-copy"><span class="rank-name">${B.escapeHtml(team.name)}</span><span class="rank-detail">${team.wins}-${team.losses} · ${team.weeklyScores.length ? `${B.round(team.ppg)} PPG · ${Math.round(team.allPlayPct * 100)}% all-play` : `${team.draftGrade ? `Draft ${team.draftGrade}` : 'preseason'}`}</span></div>
      <span class="rank-score">${Math.round(team.power)}</span>
    </a>`).join('');
}

function renderDraft() {
  renderLeagueHeader();
  if (!B.state.draftGrades.length) {
    $('draftGrades').innerHTML = '<div class="empty-state">No completed draft data is available yet.</div>';
    return;
  }
  $('draftGrades').innerHTML = B.state.draftGrades.map((row, index) => {
    const best = row.best ? `${B.draftPlayerName(row.best.pick)} (+${Math.round(row.best.delta)})` : '—';
    const reach = row.reach ? `${B.draftPlayerName(row.reach.pick)} (${Math.round(row.reach.delta)})` : '—';
    return `<a class="draft-card" href="${B.teamUrl(row.team)}">
      <div class="draft-rank">${index + 1}</div>
      <div class="draft-main"><strong>${B.escapeHtml(row.team.name)}</strong><span>${B.escapeHtml(row.team.owner)}</span><small>Best value: ${B.escapeHtml(best)} · Biggest reach: ${B.escapeHtml(reach)}</small></div>
      <div class="draft-grade"><strong>${row.grade}</strong><span>${Math.round(row.score)}</span></div>
    </a>`;
  }).join('');
}

function renderTeam() {
  const rosterId = B.number(new URLSearchParams(location.search).get('roster'), 0);
  const team = B.teamByRosterId(rosterId);
  if (!team) {
    $('teamPage').innerHTML = '<div class="empty-state">Team not found. Go back to the league home page.</div>';
    return;
  }
  document.title = `${team.name} — Babashop`;
  $('teamName').textContent = team.name;
  $('teamOwner').textContent = team.owner;
  if (team.avatar) { $('teamAvatar').src = team.avatar; $('teamAvatar').classList.remove('hidden'); }
  const rank = B.rankings().findIndex((t) => t.rosterId === team.rosterId) + 1;
  $('teamRecord').textContent = `${team.wins}-${team.losses}`;
  $('teamPower').textContent = `#${rank}`;
  $('teamPPG').textContent = team.weeklyScores.length ? B.round(team.ppg) : '—';
  $('teamDraft').textContent = team.draftGrade || '—';
  const form = team.recentForm.slice(-5);
  $('teamForm').innerHTML = form.length ? form.map((item) => {
    const opp = B.teamByRosterId(item.opponentId);
    return `<div class="form-game"><span class="form-badge ${item.result === 'W' ? 'win' : item.result === 'L' ? 'loss' : 'tie'}">${item.result}</span><div><strong>Week ${item.week} vs ${B.escapeHtml(opp?.name || 'Opponent')}</strong><small>${B.round(item.points)} - ${B.round(item.opponentPoints)}</small></div></div>`;
  }).join('') : '<div class="empty-state">No completed matchups yet.</div>';
  const maxScore = Math.max(...team.weeklyScores.map((x) => x.points), 1);
  $('scoreTrend').innerHTML = team.weeklyScores.length ? team.weeklyScores.map((item) => `<div class="score-bar-row"><span>W${item.week}</span><div class="score-bar-track"><div class="score-bar" style="width:${Math.max(4, (item.points / maxScore) * 100)}%"></div></div><strong>${B.round(item.points)}</strong></div>`).join('') : '<div class="empty-state">Weekly scoring appears once games start.</div>';
  $('teamAnalytics').innerHTML = `
    <div class="mini-stat"><span>All-play</span><strong>${team.allPlayGames ? `${Math.round(team.allPlayPct * 100)}%` : '—'}</strong><small>How often this score beats the league</small></div>
    <div class="mini-stat"><span>Expected wins</span><strong>${team.allPlayGames ? B.round(team.expectedWins, 2) : '—'}</strong><small>Based on all-play performance</small></div>
    <div class="mini-stat"><span>Luck</span><strong class="${team.luck > 0.15 ? 'diff-positive' : team.luck < -0.15 ? 'diff-negative' : ''}">${team.allPlayGames ? `${team.luck > 0 ? '+' : ''}${B.round(team.luck, 2)}` : '—'}</strong><small>Actual wins minus expected wins</small></div>`;
  const draftRow = B.state.draftGrades.find((row) => row.team.rosterId === team.rosterId);
  if (draftRow) {
    $('draftReport').innerHTML = `
      <div class="mini-stat"><span>Grade</span><strong>${draftRow.grade}</strong><small>${Math.round(draftRow.score)} / 100</small></div>
      <div class="mini-stat"><span>Best value</span><strong>${draftRow.best ? B.escapeHtml(B.draftPlayerName(draftRow.best.pick)) : '—'}</strong><small>${draftRow.best ? `Pick ${draftRow.best.pickNo}, rank ${draftRow.best.rank}` : 'No rank data'}</small></div>
      <div class="mini-stat"><span>Biggest reach</span><strong>${draftRow.reach ? B.escapeHtml(B.draftPlayerName(draftRow.reach.pick)) : '—'}</strong><small>${draftRow.reach ? `Pick ${draftRow.reach.pickNo}, rank ${draftRow.reach.rank}` : 'No rank data'}</small></div>`;
  } else {
    $('draftReport').innerHTML = '<div class="empty-state">No draft report available.</div>';
  }
  const players = Array.isArray(team.roster?.players) ? team.roster.players : [];
  $('rosterList').innerHTML = players.length ? players.map((id) => {
    const meta = B.playerMeta(id);
    const pos = Array.isArray(meta.fantasy_positions) ? meta.fantasy_positions.join('/') : meta.position || '';
    return `<div class="roster-row"><strong>${B.escapeHtml(B.playerNameFromId(id))}</strong><span>${B.escapeHtml([pos, meta.team].filter(Boolean).join(' · '))}</span></div>`;
  }).join('') : '<div class="empty-state">No roster players found.</div>';
}

async function boot() {
  setStatus('Loading Sleeper data…');
  try {
    const page = document.body.dataset.page;
    await B.loadData({ needPlayers: page === 'team' });
    document.body.classList.remove('loading');
    if (page === 'home') renderHome();
    if (page === 'standings') renderStandings();
    if (page === 'power') renderPower();
    if (page === 'draft') renderDraft();
    if (page === 'team') renderTeam();
    setStatus(`Updated from Sleeper · cache ${B.CACHE_VERSION}`, 'success');
  } catch (error) {
    console.error(error);
    setStatus(`Could not load Sleeper data. ${error.message}`, 'error');
  }
}

if ($('weekSelect')) $('weekSelect').addEventListener('change', (event) => renderMatchups(B.number(event.target.value, 1)));
boot();