/* Transparent, league-relative heuristics. No projected NBA statistics. */
(() => {
 const B=window.Babashop, S=B.state, clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
 function profile(id){
  const meta=B.playerMeta(id), stats=B.playerFantasyInfo(id), pick=S.draftPicks.find(p=>String(p.player_id)===String(id));
  const pool=[...S.playerStats.values()].filter(x=>x.weeks>0).map(x=>x.total/x.weeks).sort((a,b)=>b-a);
  const rosterSize=Math.max(1,S.rosters.reduce((n,r)=>n+(r.players?.length||0),0));
  const pickNo=Number(pick?.pick_no)||0;
  // Draft prior declines nonlinearly: elite assets retain consolidation value.
  const prior=pickNo ? 12+88*Math.exp(-(pickNo-1)/Math.max(12,rosterSize*.28)) : null;
  const baseline=pool.length>=8 ? Math.max(0,pool[Math.floor((pool.length-1)*.8)]) : null;
  const ceiling=pool.length ? Math.max(pool[0]- (baseline||0),1) : 1;
  const weekly=stats?.weekly||[];
  const recent=weekly.slice(-3);
  const recentAvg=recent.length?recent.reduce((n,w)=>n+w.points,0)/recent.length:0;
  const production=stats&&baseline!==null?clamp(12+88*Math.max(0,.75*stats.ppg+.25*recentAvg-baseline)/ceiling,0,100):null;
  const weight=production===null?0:stats.weeks/(stats.weeks+4);
  let unknown=prior===null&&production===null;
  let value=unknown?null:production===null?prior:prior===null?production:prior*(1-weight)+production*weight;
  const status=B.playerStatus(id);
  const explicitlyInactive=meta.active===false||['retired','inactive'].includes(String(meta.status).toLowerCase());
  if(explicitlyInactive){value=0;unknown=false;}
  else if(!status.current && production===null){value=null;unknown=true;}
  const injury=meta.injury_status||(['out','injured','suspended'].includes(String(meta.status).toLowerCase())?meta.status:'');
  const confidence=unknown?'Unknown':injury||!stats||stats.weeks<3?'Low':stats.weeks<7?'Medium':'High';
  return {value,confidence,injury,status,basis:production!==null?`${stats.weeks} scored weeks · ${B.round(stats.ppg)} pts/week`:prior!==null?`Draft pick #${pickNo} · no production sample`:'No reliable production or draft data'};
 }
 function packageValue(ids){
  const rows=ids.map(profile);return {value:rows.reduce((sum,p)=>sum+Math.max(0,(p.value??12)-12),0),unknown:rows.some(p=>p.value===null),confidence:rows.some(p=>p.confidence==='Unknown')?'Unknown':rows.some(p=>p.confidence==='Low')?'Low':rows.some(p=>p.confidence==='Medium')?'Medium':'High'};
 }
 function assess(receive,send,{incomingPicks=[],outgoingPicks=[],faab=0,bid=0}={}){
  const incoming=packageValue(receive),outgoing=packageValue(send);
  const pickValue=p=>Math.max(2,45/Math.pow(Math.max(1,Number(p.round)||1),1.25))*Math.pow(.85,Math.max(0,(Number(p.season)||Number(S.league?.season))-Number(S.league?.season)));
  const budget=Math.max(1,Number(S.league?.settings?.waiver_budget)||100);
  const inValue=incoming.value+incomingPicks.reduce((n,p)=>n+pickValue(p),0)+Math.max(0,faab)/budget*15;
  const outValue=outgoing.value+outgoingPicks.reduce((n,p)=>n+pickValue(p),0)+(Math.max(0,-faab)+bid)/budget*15;
  const delta=inValue-outValue, normalized=delta/Math.max(25,inValue+outValue);
  const uncertain=incoming.unknown||outgoing.unknown||(!receive.length&&!send.length);
  const rawScore=clamp(70+normalized*35,35,98);
  const confidence=incomingPicks.length||outgoingPicks.length?'Low':[incoming.confidence,outgoing.confidence].includes('Low')?'Low':[incoming.confidence,outgoing.confidence].includes('Medium')?'Medium':uncertain?'Unknown':'High';
  const score=70+(rawScore-70)*(confidence==='Low'?.55:confidence==='Medium'?.8:1);
  return {receivedValue:inValue,sentValue:outValue,delta,score,grade:uncertain?'—':B.letterGrade(score),confidence:uncertain?'Unknown':confidence,explanation:uncertain?'Not enough reliable player data to grade.':Math.abs(normalized)<.08?'Close to even on current asset value.':delta>0?'Adds more value above replacement than it gives up.':'Gives up more value above replacement than it adds.'};
 }
 B.assetProfile=profile;B.assessMove=assess;
 B.playerGradeInfo=id=>{const p=profile(id),score=p.value===null?0:50+p.value*.48;return {score,grade:p.value===null?'—':B.letterGrade(score),basis:`${p.basis} · ${p.confidence.toLowerCase()} confidence${p.injury?' · '+p.injury:''}`,status:p.status};};
})();
