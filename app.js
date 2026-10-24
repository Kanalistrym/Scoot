const $ = (id) => document.getElementById(id);
const state = { user: null, authMode: "login", goals: [], earnings: { shifts: [], totals: { total: 0, hours: 0, shifts: 0 } }, activeView: "dashboard", txType: "deposit" };
const money = n => new Intl.NumberFormat("pl-PL",{style:"currency",currency:"PLN",maximumFractionDigits:2}).format(Number(n||0)).replace(/\u00a0/g," ");
const dateFmt = value => {
  if (!value) return "Не задана";
  const d = new Date(value.length === 10 ? value+"T12:00:00" : value);
  return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:"short",year:"numeric"}).format(d);
};
const daysUntil = value => {
  if (!value) return null;
  const target = new Date(value+"T23:59:59");
  return Math.ceil((target - new Date()) / 86400000);
};
const balance = g => Number(g.saved_amount || 0);
const progress = g => Math.min(100, Math.round(balance(g) / Number(g.target_amount) * 100));
const primaryGoal = () => state.goals[0] || null;
const allTx = () => state.goals.flatMap(g => (g.transactions||[]).map(t => ({...t, goal_name:g.name, goal_icon:g.icon}))).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at) || b.id-a.id);

async function api(url, options={}) {
  const res = await fetch(url,{headers:{"Content-Type":"application/json"},...options});
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || "Что-то пошло не так.");
  return data;
}
function notify(message, error=false) {
  const el=$("notice"); el.textContent=message; el.classList.remove("hidden","error");
  if(error) el.classList.add("error");
  clearTimeout(notify.timer); notify.timer=setTimeout(()=>el.classList.add("hidden"),3800);
}
function txMarkup(t) {
  const deposit=t.type==="deposit";
  const note=t.note?.trim() || (deposit?"Пополнение копилки":"Снятие денег");
  return `<div class="transaction"><div class="tx-icon ${t.type}">${deposit?"↙":"↗"}</div><div class="tx-info"><strong>${escapeHtml(note)}</strong><small>${escapeHtml(t.goal_name||"Цель")} · ${dateFmt(t.created_at)}</small></div><div class="tx-amount ${deposit?"plus":"minus"}">${deposit?"+":"−"}${money(t.amount)}</div></div>`;
}
function escapeHtml(s) { return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function emptyMarkup(text="Пока здесь пусто") { return `<div class="empty-state"><span>✧</span>${text}</div>`; }
function pacePlan(g) {
  if (!g.pace_enabled || !g.target_date) return "";
  const left=Math.max(0,Number(g.target_amount)-balance(g));
  const days=Math.max(1, daysUntil(g.target_date) || 1);
  const period=g.pace_period||"daily";
  const amount=left/days*(period==="weekly"?7:period==="monthly"?30:1);
  const labels={daily:"в день",weekly:"в неделю",monthly:"в месяц"};
  return `<div class="goal-pace">${left<=0?"Цель уже достигнута 🎉":`Откладывай <strong>${money(amount)}</strong> ${labels[period]}, чтобы успеть к ${dateFmt(g.target_date)}`}</div>`;
}
function cardMarkup(g) {
  const p=progress(g), left=Math.max(0,Number(g.target_amount)-balance(g));
  return `<article class="goal-card"><div class="goal-card-top"><div class="goal-icon">${escapeHtml(g.icon||"🎯")}</div><div class="goal-card-title"><strong>${escapeHtml(g.name)}</strong><small>${g.target_date?"До "+dateFmt(g.target_date):"Без срока"}</small></div><button class="more-btn" title="Настроить цель" data-edit="${g.id}">···</button></div><div class="goal-card-amount"><strong>${money(balance(g))}</strong><span>из ${money(g.target_amount)}</span></div><div class="progress-track"><div class="progress-fill" style="width:${p}%"></div></div><div class="goal-card-meta"><span>${p}% выполнено</span><span>${left>0?"Ещё "+money(left):"Цель достигнута 🎉"}</span></div><div class="goal-card-actions"><button class="mini-btn" data-add="${g.id}">＋ Пополнить</button><button class="mini-btn" data-edit="${g.id}">Настроить</button></div>${pacePlan(g)}</article>`;
}
function render() {
  const goals=state.goals, goal=primaryGoal(), tx=allTx();
  const saved=goals.reduce((s,g)=>s+balance(g),0);
  const remaining=goals.reduce((s,g)=>s+Math.max(0,Number(g.target_amount)-balance(g)),0);
  $("totalSaved").textContent=money(saved);
  $("goalsDone").innerHTML=`${goals.filter(g=>balance(g)>=Number(g.target_amount)).length} <small>/ ${goals.length}</small>`;
  $("totalRemaining").textContent=money(remaining);
  $("today").textContent=new Intl.DateTimeFormat("ru-RU",{weekday:"short",day:"numeric",month:"short"}).format(new Date());
  $("heroGoal").classList.toggle("hidden",!goal);
  if(goal){
    const p=progress(goal), left=Math.max(0,Number(goal.target_amount)-balance(goal)), days=daysUntil(goal.target_date);
    $("heroName").textContent=goal.name; $("heroSaved").textContent=money(balance(goal)); $("heroTarget").textContent=money(goal.target_amount); $("heroIcon").textContent=goal.icon||"🛴";
    $("heroProgress").style.width=p+"%"; $("heroPercent").textContent=`${p}% выполнено`; $("heroLeft").textContent=left>0?`Осталось ${money(left)}`:"Цель достигнута 🎉";
    if(goal.target_date && days!==null){
      const daily=days>0?left/days:left;
      $("paceMonthly").innerHTML=`${money(daily*30)} <small>/ месяц</small>`;
      $("paceDescription").textContent=left<=0?"Цель уже достигнута — отлично!":days>0?`Откладывай примерно ${money(daily)} в день, чтобы успеть.`:"Срок уже наступил. Выбери новую дату или обнови план.";
      $("daysLeft").textContent=days>=0?`${days} дн.`:`просрочено на ${Math.abs(days)} дн.`;
      $("paceWeekly").textContent=money(days>0?left/days*7:left);
      $("expectedDate").textContent=left<=0?"Уже достигнута":days>0?dateFmt(goal.target_date):"Обнови срок";
    } else {
      $("paceMonthly").innerHTML="— <small>/ месяц</small>"; $("paceDescription").textContent="Укажи дату цели, чтобы увидеть план.";
      $("daysLeft").textContent="—"; $("paceWeekly").textContent="—"; $("expectedDate").textContent="Не задана";
    }
    $("editGoalBtn").disabled=false;
  } else { $("heroName").textContent="Создай первую цель"; $("heroSaved").textContent=money(0); $("heroTarget").textContent=money(0); }
  $("recentTransactions").innerHTML=tx.length?tx.slice(0,5).map(txMarkup).join(""):emptyMarkup("Добавь первый взнос — и начни свой путь");
  $("goalCards").innerHTML=goals.length?goals.slice(0,3).map(cardMarkup).join(""):emptyMarkup("Создай первую цель накопления");
  $("allGoalCards").innerHTML=goals.length?goals.map(cardMarkup).join(""):emptyMarkup("Создай первую цель накопления");
  $("fullTransactions").innerHTML=renderFilteredTx();
  $("moneyGoal").innerHTML=goals.map(g=>`<option value="${g.id}">${escapeHtml(g.icon||"🎯")} ${escapeHtml(g.name)}</option>`).join("");
  $("addMoneyTop").disabled=!goals.length; $("heroAdd").disabled=!goal; $("heroWithdraw").disabled=!goal;
}
function renderFilteredTx(){
  const filter=$("historyFilter").value;
  const tx=allTx().filter(t=>filter==="all"||t.type===filter);
  return tx.length?tx.map(txMarkup).join(""):emptyMarkup("Операций пока нет");
}
async function refresh(){state.goals=await api("/api/goals");render();}
async function refreshEarnings(){state.earnings=await api("/api/earnings");renderEarnings();}
function renderEarnings(){
  const data=state.earnings, shifts=data.shifts||[], totals=data.totals||{};
  $("earningsTotal").textContent=money(totals.total); $("earningsShifts").textContent=totals.shifts||0; $("earningsHours").textContent=`${Number(totals.hours||0).toLocaleString("ru-RU",{maximumFractionDigits:2})} ч`;
  $("earningsCount").textContent=`${shifts.length} ${shifts.length===1?"запись":shifts.length<5?"записи":"записей"}`;
  $("earningsList").innerHTML=shifts.length?shifts.map(x=>`<div class="earnings-row"><div class="shift-badge">#${x.shift_no}</div><div class="earnings-info"><strong>${escapeHtml(x.note?.trim()||`Рабочий день №${x.shift_no}`)}</strong><small>${dateFmt(x.work_date)} · ${Number(x.hours).toLocaleString("ru-RU")} ч × ${money(x.rate)}/ч</small></div><strong class="earnings-amount">${money(Number(x.rate)*Number(x.hours))}</strong><button class="delete-shift" title="Удалить смену" data-delete-shift="${x.id}">×</button></div>`).join(""):emptyMarkup("Добавь первую смену — здесь появится заработок");
}
function updateShiftPreview(){const rate=Number($("shiftRate").value)||0,hours=Number($("shiftHours").value)||0;$("shiftPreview").textContent=money(rate*hours);}
function setView(view){
  state.activeView=view;
  document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  $("dashboardView").classList.toggle("hidden",view!=="dashboard");
  $("goalsView").classList.toggle("hidden",view!=="goals");
  $("historyView").classList.toggle("hidden",view!=="history");
  $("earningsView").classList.toggle("hidden",view!=="earnings");
  if(view==="earnings") renderEarnings();
  if(view==="goals") $("allGoalCards").innerHTML=state.goals.length?state.goals.map(cardMarkup).join(""):emptyMarkup("Создай первую цель накопления");
  if(view==="history") $("fullTransactions").innerHTML=renderFilteredTx();
  if(view==="earnings") renderEarnings();
}
function openMoney(goalId=null,type="deposit"){
  if(!state.goals.length){openGoal();return;}
  $("moneyError").textContent=""; $("moneyAmount").value=""; $("moneyNote").value="";
  if(goalId) $("moneyGoal").value=String(goalId);
  else if(primaryGoal()) $("moneyGoal").value=String(primaryGoal().id);
  setTxType(type); $("moneyDialog").showModal();
}
function setTxType(type){state.txType=type;document.querySelectorAll(".type-btn").forEach(b=>b.classList.toggle("selected",b.dataset.type===type));$("moneyTitle").textContent=type==="deposit"?"Пополнить копилку":"Снять деньги";}
function openGoal(goal=null){
  $("goalForm").reset(); $("goalId").value=goal?.id||""; $("goalName").value=goal?.name||""; $("goalTarget").value=goal?.target_amount??""; $("goalDate").value=goal?.target_date||""; $("goalIcon").value=goal?.icon||"🛴"; $("paceEnabled").checked=!!goal?.pace_enabled; $("pacePeriod").value=goal?.pace_period||"daily"; $("paceSettings").classList.toggle("hidden",!$("paceEnabled").checked); $("goalError").textContent="";
  $("goalModalTitle").textContent=goal?"Настроить цель":"Создать цель"; $("deleteGoalBtn").classList.toggle("hidden",!goal);
  $("goalDialog").showModal();
}
function editGoalById(id){const g=state.goals.find(g=>g.id===Number(id));if(g)openGoal(g);}
function bind(){
  document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
  $("addMoneyTop").onclick=()=>openMoney(); $("heroAdd").onclick=()=>openMoney(primaryGoal()?.id,"deposit"); $("heroWithdraw").onclick=()=>openMoney(primaryGoal()?.id,"withdrawal");
  $("newGoalBtn").onclick=$("newGoalBtn2").onclick=()=>openGoal();
  $("paceEnabled").addEventListener("change",()=>$("paceSettings").classList.toggle("hidden",!$("paceEnabled").checked));
  $("editGoalBtn").onclick=()=>primaryGoal()&&openGoal(primaryGoal());
  $("allHistoryBtn").onclick=()=>setView("history");
  $("historyFilter").onchange=()=>{$("fullTransactions").innerHTML=renderFilteredTx();};
  ["shiftRate","shiftHours"].forEach(id=>$(id).addEventListener("input",updateShiftPreview));
  $("shiftDate").value=new Date().toISOString().slice(0,10);
  $("shiftNo").value=1;
  $("earningsForm").addEventListener("submit",async e=>{
    e.preventDefault(); $("earningsError").textContent="";
    try{
      await api("/api/earnings",{method:"POST",body:JSON.stringify({shift_no:Number($("shiftNo").value),work_date:$("shiftDate").value,rate:Number($("shiftRate").value),hours:Number($("shiftHours").value),note:$("shiftNote").value})});
      const next=Number($("shiftNo").value)+1; $("earningsForm").reset(); $("shiftNo").value=next; $("shiftDate").value=new Date().toISOString().slice(0,10); updateShiftPreview(); await refreshEarnings(); notify("Смена сохранена, заработок пересчитан.");
    }catch(err){$("earningsError").textContent=err.message;}
  });
  $("earningsList").addEventListener("click",async e=>{const b=e.target.closest("[data-delete-shift]");if(!b)return;if(!confirm("Удалить эту смену из истории заработка?"))return;try{await api(`/api/earnings/${b.dataset.deleteShift}`,{method:"DELETE"});await refreshEarnings();notify("Смена удалена.");}catch(err){notify(err.message,true);}});
  $("exportBtn").onclick=()=>{window.location.href="/api/export";notify("Резервная копия скачивается.");};
  $("importBtn").onclick=()=>$("importFile").click();
  $("importFile").onchange=async()=>{
    const file=$("importFile").files[0]; if(!file)return;
    if(!confirm("Импорт заменит все текущие цели и операции данными из файла. Перед продолжением лучше экспортировать текущую копию. Продолжить?")){ $("importFile").value=""; return; }
    try{
      const backup=JSON.parse(await file.text());
      const result=await api("/api/import",{method:"POST",body:JSON.stringify(backup)});
      await refresh(); await refreshEarnings(); notify(`Резервная копия восстановлена: целей — ${result.goals}, смен — ${result.shifts ?? 0}.`);
    }catch(err){notify(err.message || "Не удалось прочитать файл резервной копии.",true);}
    finally{$("importFile").value="";}
  };
  document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>$(b.dataset.close).close());
  document.querySelectorAll(".type-btn").forEach(b=>b.onclick=()=>setTxType(b.dataset.type));
  document.addEventListener("click",e=>{
    const add=e.target.closest("[data-add]"), edit=e.target.closest("[data-edit]");
    if(add)openMoney(add.dataset.add);
    if(edit)editGoalById(edit.dataset.edit);
  });
  $("moneyForm").addEventListener("submit",async e=>{
    e.preventDefault(); $("moneyError").textContent="";
    try{
      await api(`/api/goals/${$("moneyGoal").value}/transactions`,{method:"POST",body:JSON.stringify({amount:Number($("moneyAmount").value),type:state.txType,note:$("moneyNote").value})});
      $("moneyDialog").close();await refresh();notify(state.txType==="deposit"?"Взнос сохранён. Ты стал ближе к цели! ✨":"Снятие сохранено.");
    }catch(err){$("moneyError").textContent=err.message;}
  });
  $("goalForm").addEventListener("submit",async e=>{
    e.preventDefault();$("goalError").textContent="";
    const id=$("goalId").value;
    const payload={name:$("goalName").value,target_amount:Number($("goalTarget").value),target_date:$("goalDate").value||null,icon:$("goalIcon").value||"🎯",pace_enabled:$("paceEnabled").checked,pace_period:$("pacePeriod").value};
    try{
      await api(id?`/api/goals/${id}`:"/api/goals",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});
      $("goalDialog").close();await refresh();notify(id?"Цель обновлена.":"Новая цель создана. ✨");
    }catch(err){$("goalError").textContent=err.message;}
  });
  $("deleteGoalBtn").onclick=async()=>{
    const id=$("goalId").value;if(!id)return;
    if(!confirm("Удалить цель и всю её историю операций? Это действие нельзя отменить."))return;
    try{await api(`/api/goals/${id}`,{method:"DELETE"});$("goalDialog").close();await refresh();notify("Цель удалена.");}
    catch(err){notify(err.message,true);}
  };
}
function showAuth(mode="login") {
  state.authMode=mode;
  $("authScreen").classList.remove("hidden"); document.querySelector(".app-shell").classList.add("hidden");
  $("authTitle").textContent=mode==="register"?"Создай свою копилку ✨":"Твоя копилка мечты ✨";
  $("authSubtitle").textContent=mode==="register"?"Создай аккаунт, чтобы хранить свои цели и заработок отдельно от других пользователей.":"Войди, чтобы продолжить копить. Твои цели и заработок будут доступны только в твоём аккаунте.";
  $("authSubmit").textContent=mode==="register"?"Создать аккаунт":"Войти";
  $("authSwitchText").textContent=mode==="register"?"Уже есть аккаунт?":"Впервые здесь?";
  $("authSwitch").textContent=mode==="register"?"Войти":"Создать аккаунт";
  $("authPassword").autocomplete=mode==="register"?"new-password":"current-password";
  $("authError").textContent="";
}
async function enterApp(user) {
  state.user=user; $("authScreen").classList.add("hidden"); document.querySelector(".app-shell").classList.remove("hidden"); $("profileEmail").textContent=user.email;
  try { await refresh(); await refreshEarnings(); } catch(err) { notify("Не удалось загрузить данные: "+err.message,true); }
}
$("authSwitch").addEventListener("click",()=>showAuth(state.authMode==="login"?"register":"login"));
$("authForm").addEventListener("submit",async e=>{
  e.preventDefault(); $("authError").textContent=""; $("authSubmit").disabled=true;
  try { const result=await api(state.authMode==="register"?"/api/auth/register":"/api/auth/login",{method:"POST",body:JSON.stringify({email:$("authEmail").value.trim(),password:$("authPassword").value})}); await enterApp(result.user); }
  catch(err) { $("authError").textContent=err.message; } finally { $("authSubmit").disabled=false; }
});
$("logoutBtn").addEventListener("click",async()=>{try{await api("/api/auth/logout",{method:"POST",body:"{}"});}catch{}state.user=null;$("authForm").reset();showAuth("login");});
bind();
api("/api/auth/me").then(data=>data.user?enterApp(data.user):showAuth("login")).catch(()=>showAuth("login"));
