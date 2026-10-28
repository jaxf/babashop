window.setupExperience=()=>{
 const B=window.Babashop,$=id=>document.getElementById(id),esc=B.escapeHtml;
 if($('teamSearch')) $('teamSearch').oninput=e=>{
  const q=e.target.value.toLowerCase();let count=0;
  document.querySelectorAll('.directory-card').forEach(card=>{card.hidden=!card.textContent.toLowerCase().includes(q);if(!card.hidden)count++;});
  let note=$('searchEmpty');if(!note){note=document.createElement('p');note.id='searchEmpty';note.className='muted';$('teamDirectory').after(note);}note.textContent=count?'':'No squads match that search.';
 };
 if($('moveTeam')){
  const options=B.state.teams.map(t=>`<option value="${t.rosterId}">${esc(t.name)}</option>`).join('');
  $('moveTeam').innerHTML='<option value="all">All squads</option>'+options;
  ['moveType','moveTeam'].forEach(id=>$(id).onchange=()=>renderTransactions());$('moveSearch').oninput=()=>renderTransactions();
  $('tradeA').innerHTML=options;$('tradeB').innerHTML=options;
  if(B.state.teams.length>1)$('tradeB').selectedIndex=1;
  function chosen(side){return [...document.querySelectorAll(`#players${side} input:checked`)].map(x=>x.value);}
  function renderPicker(side){
   const team=B.teamByRosterId($('trade'+side).value);
   $('players'+side).innerHTML=(team?.roster.players||[]).map(id=>({id,p:B.assetProfile(id)})).sort((a,b)=>(b.p.value??-1)-(a.p.value??-1)).map(({id,p})=>`<label class="player-option"><input type="checkbox" value="${esc(id)}"><span>${esc(B.playerNameFromId(id))}<small>${esc(B.playerMeta(id).position||'')} · ${esc(p.confidence)} confidence${p.injury?' · '+esc(p.injury):''}</small></span><span class="value" title="Asset value, 0–100">${p.value===null?'—':Math.round(p.value)}</span></label>`).join('')||'<div class="empty-state">No roster players available.</div>';
   $('players'+side).onchange=update;
  }
  function update(){
   const a=chosen('A'),b=chosen('B');
   if($('tradeA').value===$('tradeB').value){$('tradeResult').textContent='Choose two different squads to build a trade.';return;}
   if(!a.length||!b.length){$('tradeResult').textContent='Select at least one player on each side. Checked players are sent to the other squad.';return;}
   const ra=B.assessMove(b,a),rb=B.assessMove(a,b),ta=B.teamByRosterId($('tradeA').value),tb=B.teamByRosterId($('tradeB').value);
   const title=ra.grade==='—'?'MORE SCOUTING NEEDED':Math.abs(ra.delta)<Math.max(3,(ra.receivedValue+ra.sentValue)*.08)?'A FAIR SHAKE.':ra.delta>0?`EDGE: ${ta.name}`:`EDGE: ${tb.name}`;
   $('tradeResult').innerHTML=`<h3>${esc(title)}</h3><div class="result-grid">${[[ta,ra],[tb,rb]].map(([t,r])=>`<div><strong>${esc(t.name)} · ${r.grade}${r.grade==='—'?'':' / '+Math.round(r.score)}</strong><span>${B.round(r.receivedValue)} in / ${B.round(r.sentValue)} out</span><p>${esc(r.explanation)} ${r.confidence} confidence.</p></div>`).join('')}</div><p>Value above replacement, not projected points. An extra roster spot may require a drop; check eligibility and injuries before sending.</p>`;
  }
  for(const side of ['A','B']){$('trade'+side).onchange=()=>{renderPicker(side);update();};renderPicker(side);}
  $('resetTrade').onclick=()=>{document.querySelectorAll('.player-picker input').forEach(c=>c.checked=false);update();};update();
 }
 if($('standingsBody')){
  const toolbar=document.createElement('div');toolbar.className='toolbar';toolbar.innerHTML='<label>Sort table <select id="standingsSort"><option value="record">Record</option><option value="pf">Points for</option><option value="diff">Point differential</option></select></label>';
  $('standingsBody').closest('.table-wrap').before(toolbar);
  $('standingsSort').onchange=e=>{const key=e.target.value;const teams=key==='record'?B.standings():[...B.state.teams].sort((a,b)=>b[key]-a[key]);$('standingsBody').innerHTML=teams.map((t,i)=>`<tr><td>${i+1}</td><td>${teamCell(t)}</td><td>${t.wins}</td><td>${t.losses}</td><td>${B.round(t.pf)}</td><td>${B.round(t.pa)}</td><td class="${t.diff>=0?'diff-positive':'diff-negative'}">${t.diff>0?'+':''}${B.round(t.diff)}</td></tr>`).join('');};
 }
 if($('powerRankings')){
  document.querySelectorAll('#powerRankings .ranking-row').forEach((row,i)=>{const t=B.rankings()[i];const note=document.createElement('span');note.className='model-note';note.textContent=t.weeklyScores.length?`Recent scoring: ${B.round(t.recentAvg)} · Expected wins: ${B.round(t.expectedWins)} · Luck: ${t.luck>0?'+':''}${B.round(t.luck)}`:'Preseason estimate · rankings will sharpen with completed matchups';row.querySelector('.rank-copy').append(note);});
 }
};
