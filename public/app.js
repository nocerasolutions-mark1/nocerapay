(function(){
"use strict";
/* ---------- state ---------- */
const S = {
  me:null, view:"sell", products:[], orders:[], settings:{shopName:"Nocera Gifts",currency:"SAR"},
  stripeEnabled:false, photosEnabled:false,
  cart:new Map(), discount:0, search:"", cat:"All", range:"30", onlyPending:false, cartOpen:false, loading:true, offline:false
};
const $ = s=>document.querySelector(s);
const app=$("#app"), layer=$("#layer");
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const r2=n=>Math.round((+n||0)*100)/100;
const isOwner=()=>S.me&&S.me.role==="owner";
function money(n){const v=r2(n);try{return new Intl.NumberFormat(undefined,{style:"currency",currency:S.settings.currency||"SAR",minimumFractionDigits:2}).format(v)}catch(e){return (S.settings.currency||"")+" "+v.toFixed(2)}}
const initial=n=>esc((n||"?").trim().charAt(0).toUpperCase());
function toast(msg){const t=document.createElement("div");t.className="toast";t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3000)}
const fmtDate=iso=>new Date(iso).toLocaleDateString(undefined,{day:"numeric",month:"short",year:"numeric"});
const fmtTime=iso=>new Date(iso).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
const orderName=o=>"NG-"+o.no;
const methodLabel=o=>o.method==="cash"?"Cash":o.method==="stripe"?"Stripe":"Bank QR";

/* ---------- API ---------- */
async function api(path,opts){
  opts=opts||{};
  const init={method:opts.method||"GET",headers:{},credentials:"same-origin"};
  if(opts.body instanceof Blob){init.body=opts.body;init.headers["Content-Type"]=opts.body.type}
  else if(opts.body!==undefined){init.body=JSON.stringify(opts.body);init.headers["Content-Type"]="application/json"}
  let res;
  try{res=await fetch(path,init)}catch(e){throw new Error("Can’t reach the server. Check the internet connection.")}
  let data={};try{data=await res.json()}catch(e){}
  if(res.status===401&&path!=="/api/login"){const was=!!S.me;S.me=null;if(was)showLogin();throw new Error(data.error||"Please sign in.")}
  if(!res.ok)throw new Error(data.error||("Request failed ("+res.status+")"));
  return data;
}
async function loadAll(){
  const d=await api("/api/bootstrap");
  S.me=d.me;S.settings=d.settings;S.products=d.products;S.orders=d.orders;S.stripeEnabled=d.stripeEnabled;S.photosEnabled=d.photosEnabled;S.loading=false;
}
function upsert(list,item){const i=list.findIndex(x=>x.id===item.id);if(i>=0)list[i]=item;else list.unshift(item)}

/* ---------- login ---------- */
async function showLogin(){
  $("#top").hidden=true;layer.innerHTML="";
  app.innerHTML=`<div class="login"><div class="empty-state">Loading…</div></div>`;
  let staff=[],needsSetup=false;
  try{const d=await api("/api/login-staff");staff=d.staff;needsSetup=d.needsSetup}catch(e){app.innerHTML=`<div class="login"><div class="empty-state">${esc(e.message)}</div></div>`;return}
  if(needsSetup){app.innerHTML=`<div class="login"><div class="login-card"><img class="logo" src="/logo.png" alt="Nocera Gifts"><h2>Almost ready</h2><p class="hint">No logins exist yet. In Railway, set <b>OWNER_NAME</b> and <b>OWNER_PIN</b> (4–8 digits) on this service and redeploy.</p></div></div>`;return}
  let sel=staff.length===1?staff[0].id:null,pin="",busy=false,err="";
  const draw=()=>{
    app.innerHTML=`<div class="login"><div class="login-card">
      <img class="logo" src="/logo.png" alt="Nocera Gifts">
      <h2>${sel?`Enter PIN for ${esc((staff.find(s=>s.id===sel)||{}).name)}`:"Who’s at the counter?"}</h2>
      <div class="names">${staff.map(s=>`<button data-sid="${s.id}" aria-pressed="${s.id===sel}">${esc(s.name)}</button>`).join("")}</div>
      ${sel?`<div class="dots" aria-label="PIN entered">${Array.from({length:Math.max(4,pin.length)},(_,i)=>`<i class="${i<pin.length?"on":""}"></i>`).join("")}</div>
      <div class="login-err" role="alert">${esc(err)}</div>
      <div class="pad">${[1,2,3,4,5,6,7,8,9].map(n=>`<button data-k="${n}">${n}</button>`).join("")}<button data-k="clr" aria-label="Clear">C</button><button data-k="0">0</button><button data-k="go" aria-label="Sign in" style="background:var(--berry);color:var(--on-berry)">→</button></div>`:""}
    </div></div>`;
    app.querySelectorAll("[data-sid]").forEach(b=>b.onclick=()=>{sel=+b.dataset.sid;pin="";err="";draw()});
    app.querySelectorAll("[data-k]").forEach(b=>b.onclick=()=>press(b.dataset.k));
  };
  const press=async k=>{
    if(busy)return;
    if(k==="clr"){pin="";err="";draw();return}
    if(k==="go"){if(pin.length<4){err="PIN is at least 4 digits.";draw();return}
      busy=true;try{await api("/api/login",{method:"POST",body:{staffId:sel,pin}});document.removeEventListener("keydown",keyh);await start()}catch(e){err=e.message;pin="";busy=false;draw()}return}
    if(pin.length<8){pin+=k;err="";draw()}
  };
  const keyh=e=>{if(!sel||!app.querySelector(".pad"))return;if(/^\d$/.test(e.key))press(e.key);else if(e.key==="Enter")press("go");else if(e.key==="Backspace"){pin=pin.slice(0,-1);draw()}};
  document.addEventListener("keydown",keyh);
  draw();
}

async function start(skipLoad){
  try{if(!skipLoad)await loadAll()}catch(e){if(!S.me)return;app.innerHTML=`<div class="empty-state">${esc(e.message)}</div>`;return}
  $("#top").hidden=false;$("#whoName").textContent=S.me.name+(isOwner()?" · Owner":"");
  document.querySelectorAll("[data-owner]").forEach(b=>b.hidden=!isOwner());
  if(!isOwner()&&S.view==="settings")S.view="sell";
  render();
}
// Keep other devices' changes in view.
setInterval(async()=>{if(!S.me||document.hidden||layer.innerHTML)return;try{await loadAll();render()}catch(e){}},60000);
document.addEventListener("visibilitychange",async()=>{if(!document.hidden&&S.me&&!layer.innerHTML){try{await loadAll();render()}catch(e){}}});

/* ---------- cart ---------- */
function cartLines(){const out=[];S.cart.forEach((q,id)=>{const p=S.products.find(x=>x.id===id);if(p&&q>0)out.push({p,q})});return out}
function cartTotals(){const lines=cartLines();const sub=r2(lines.reduce((s,l)=>s+l.q*(+l.p.price||0),0));const disc=Math.min(r2(S.discount),sub);return {lines,sub,disc,total:r2(sub-disc),count:lines.reduce((s,l)=>s+l.q,0)}}
function addToCart(id,d){const q=(S.cart.get(id)||0)+(d||1);if(q<=0)S.cart.delete(id);else S.cart.set(id,q);render()}
const cartPayload=()=>({items:cartLines().map(({p,q})=>({productId:p.id,qty:q})),discount:cartTotals().disc});

/* ---------- render ---------- */
function render(){
  if(!S.me)return;
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-current",b.dataset.view===S.view?"page":"false"));
  $("#banner").innerHTML=!S.stripeEnabled&&isOwner()?`<div class="banner"><b>Stripe isn’t set up on the server.</b> Add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Railway to turn on Stripe QR payments.</div>`:"";
  const keep=document.querySelector(".lines")?.scrollTop||0;
  ({sell:viewSell,products:viewProducts,sales:viewSales,settings:viewSettings})[S.view]();
  const l=document.querySelector(".lines");if(l)l.scrollTop=keep;
}
const thumb=p=>p.photoUrl?`<img src="${esc(p.photoUrl)}" alt="" loading="lazy">`:initial(p.name);

function viewSell(){
  const cats=["All",...[...new Set(S.products.map(p=>p.category).filter(Boolean))].sort()];
  if(!cats.includes(S.cat))S.cat="All";
  const q=S.search.trim().toLowerCase();
  const list=S.products.filter(p=>(S.cat==="All"||p.category===S.cat)&&(!q||(p.name+" "+(p.sku||"")).toLowerCase().includes(q)));
  const t=cartTotals();
  app.innerHTML=`
  <div class="till">
    <section aria-label="Products">
      <div class="shelf-tools"><input class="inp" id="search" type="search" placeholder="Search name or SKU" value="${esc(S.search)}" aria-label="Search products">
        ${isOwner()?`<button class="btn" data-act="new-product">+ Add product</button>`:""}</div>
      <div class="cats" role="toolbar" aria-label="Categories">${cats.map(c=>`<button class="chip" data-cat="${esc(c)}" aria-pressed="${c===S.cat}">${esc(c)}</button>`).join("")}</div>
      ${S.products.length===0?`<div class="empty-state"><p><b>No products yet.</b></p><p>${isOwner()?"Add your first item with a photo and price to start selling.":"Ask the owner to add products."}</p>${isOwner()?`<button class="btn primary" data-act="new-product">+ Add product</button>`:""}</div>`:
        list.length===0?`<div class="empty-state">Nothing matches “${esc(S.search)}”.</div>`:
      `<div class="grid">${list.map(p=>{const q=S.cart.get(p.id)||0;return `
        <button class="tile" data-add="${p.id}" aria-label="Add ${esc(p.name)}">${q?`<span class="qty num">${q}</span>`:""}
          <div class="ph ${p.photoUrl?"":"empty"}">${p.photoUrl?`<img src="${esc(p.photoUrl)}" alt="" loading="lazy">`:`<span class="mono">${initial(p.name)}</span>`}</div>
          <div class="meta"><span class="nm">${esc(p.name)}</span><span class="pr num">${money(p.price)}</span></div></button>`}).join("")}</div>`}
    </section>
    <aside class="cart ${S.cartOpen?"open":""}" aria-label="Current sale">
      <div class="cart-h"><h3>Current sale</h3><span class="eyebrow num">${t.count} item${t.count===1?"":"s"}</span>
        <button class="x" data-act="close-cart" aria-label="Close cart" style="display:${S.cartOpen?"block":"none"}">×</button></div>
      <div class="lines">${t.lines.length?t.lines.map(({p,q})=>`
        <div class="line"><div class="th">${thumb(p)}</div>
          <div style="min-width:0"><div class="ln">${esc(p.name)}</div><div class="lp num">${money(p.price)} × ${q} = <b>${money(q*p.price)}</b></div></div>
          <div class="step"><button data-dec="${p.id}" aria-label="One less">−</button><span class="num">${q}</span><button data-inc="${p.id}" aria-label="One more">+</button></div></div>`).join(""):`<div class="empty-cart"><div class="bigbow"></div>Tap a product to add it to the sale.</div>`}</div>
      <div class="totals">
        <div class="trow"><span>Subtotal</span><span class="num">${money(t.sub)}</span></div>
        <div class="trow"><span>Discount</span><span class="disc"><input class="inp num" id="disc" type="number" min="0" step="0.5" inputmode="decimal" value="${S.discount||""}" placeholder="0.00" aria-label="Discount amount"></span></div>
        <div class="trow grand"><span>Total</span><span class="num">${money(t.total)}</span></div>
        <div class="cart-actions"><button class="btn" data-act="clear-cart" ${t.count?"":"disabled"}>Clear</button>
          <button class="btn primary lg" data-act="checkout" ${t.count?"":"disabled"}>Checkout · <span class="num">${money(t.total)}</span></button></div>
      </div>
    </aside>
  </div>
  ${t.count&&!S.cartOpen?`<button class="cartbar" data-act="open-cart"><span>${t.count} item${t.count===1?"":"s"} · View sale</span><span class="cb-t num">${money(t.total)}</span></button>`:""}`;
  $("#search").addEventListener("input",e=>{S.search=e.target.value;const pos=e.target.selectionStart;render();const n=$("#search");n.focus();n.setSelectionRange(pos,pos)});
  $("#disc").addEventListener("change",e=>{S.discount=Math.max(0,+e.target.value||0);render()});
}

function stripePill(p){
  if(p.stripeError)return `<span class="pill err" title="${esc(p.stripeError)}">Stripe sync failed</span>`;
  if(p.stripeProductId)return `<span class="pill stripe">In Stripe</span>`;
  return S.stripeEnabled?`<span class="pill todo">Not in Stripe</span>`:"";
}
function viewProducts(){
  const list=[...S.products].sort((a,b)=>(a.category||"").localeCompare(b.category||"")||a.name.localeCompare(b.name));
  app.innerHTML=`
  <div class="sec-head"><div><div class="eyebrow">Catalogue</div><h2 class="sec">Products <span class="num" style="color:var(--muted);font-size:20px">${list.length}</span></h2></div>
  <div class="exports">${isOwner()?`<button class="btn" data-act="export-shopify-products" ${list.length?"":"disabled"}>Export for Shopify</button><button class="btn primary" data-act="new-product">+ Add product</button>`:""}</div></div>
  ${list.length?`<div class="ptable"><div class="prow head"><span></span><span>Item</span><span class="c-cat">Category</span><span class="c-sku">SKU</span><span style="text-align:right">Price</span></div>
    ${list.map(p=>`<div class="prow" ${isOwner()?`data-edit="${p.id}" style="cursor:pointer"`:""}>
      <div class="th">${thumb(p)}</div>
      <div class="t1">${esc(p.name)} ${isOwner()?stripePill(p):""}${p.description?`<div class="t2">${esc(p.description).slice(0,80)}</div>`:""}</div>
      <div class="c-cat t2">${esc(p.category||"—")}</div><div class="c-sku t2 num">${esc(p.sku||"—")}</div>
      <div style="text-align:right;font-weight:700" class="num">${money(p.price)}</div></div>`).join("")}</div>`:`<div class="empty-state"><p><b>The catalogue is empty.</b></p></div>`}`;
}

function inRange(o){
  if(S.range==="all")return true;
  const now=new Date();const start=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  if(S.range==="today")return new Date(o.createdAt)>=start;
  start.setDate(start.getDate()-(+S.range-1));return new Date(o.createdAt)>=start;
}
function niceMax(v){if(v<=0)return 100;const p=Math.pow(10,Math.floor(Math.log10(v)));const m=v/p;return (m<=1?1:m<=2?2:m<=5?5:10)*p}
function spanDays(){if(!S.orders.length)return 7;const first=new Date(S.orders[S.orders.length-1].createdAt);return Math.ceil((Date.now()-first)/864e5)+1}
const currentOrders=()=>S.orders.filter(inRange).filter(o=>!S.onlyPending||!o.shopify);
function viewSales(){
  const orders=currentOrders();
  const rev=r2(orders.reduce((s,o)=>s+(+o.total||0),0));
  const cash=r2(orders.filter(o=>o.method==="cash").reduce((s,o)=>s+(+o.total||0),0));
  const stripe=r2(orders.filter(o=>o.method==="stripe").reduce((s,o)=>s+(+o.total||0),0));
  const bank=r2(rev-cash-stripe);
  const items=orders.reduce((s,o)=>s+(o.items||[]).reduce((a,i)=>a+i.qty,0),0);
  const pending=S.orders.filter(o=>!o.shopify).length;
  const days=S.range==="today"?1:S.range==="all"?Math.min(30,Math.max(7,spanDays())):Math.min(+S.range,30);
  const buckets=[];const base=new Date();base.setHours(0,0,0,0);
  for(let i=days-1;i>=0;i--){const d=new Date(base);d.setDate(d.getDate()-i);buckets.push({d,v:0})}
  orders.forEach(o=>{const d=new Date(o.createdAt);d.setHours(0,0,0,0);const b=buckets.find(x=>x.d.getTime()===d.getTime());if(b)b.v+=+o.total||0});
  const max=niceMax(Math.max(0,...buckets.map(b=>b.v)));const labelEvery=Math.ceil(days/8);
  const tally={};orders.forEach(o=>(o.items||[]).forEach(i=>{tally[i.name]=tally[i.name]||{q:0,v:0};tally[i.name].q+=i.qty;tally[i.name].v+=i.qty*i.price}));
  const top=Object.entries(tally).sort((a,b)=>b[1].v-a[1].v).slice(0,6);const topMax=top.length?top[0][1].v:1;
  const ranges=[["today","Today"],["7","7 days"],["30","30 days"],["90","90 days"],["all","All time"]];
  app.innerHTML=`
  <div class="sec-head"><div><div class="eyebrow">Report</div><h2 class="sec">Sales</h2></div>
    <div class="filters">${ranges.map(([k,l])=>`<button class="chip" data-range="${k}" aria-pressed="${S.range===k}">${l}</button>`).join("")}</div></div>
  <div class="kpis">
    <div class="kpi"><div class="eyebrow">Revenue</div><div class="v num">${money(rev)}</div><div class="s">${orders.length} sale${orders.length===1?"":"s"}</div></div>
    <div class="kpi"><div class="eyebrow">Average sale</div><div class="v num">${money(orders.length?rev/orders.length:0)}</div><div class="s num">${items} items sold</div></div>
    <div class="kpi"><div class="eyebrow">Cash · Stripe · Bank QR</div><div class="v num" style="font-size:15px;margin-top:8px">${money(cash)} · ${money(stripe)} · ${money(bank)}</div>
      <div class="split" aria-hidden="true"><i style="width:${rev?cash/rev*100:0}%;background:var(--good)"></i><i style="width:${rev?stripe/rev*100:0}%;background:var(--berry)"></i><i style="width:${rev?bank/rev*100:0}%;background:var(--gold)"></i></div></div>
    <div class="kpi"><div class="eyebrow">Not yet in Shopify</div><div class="v num">${pending}</div><div class="s">orders waiting to export</div></div>
  </div>
  <div class="panels">
    <div class="panel"><h4>Revenue by day</h4><div class="chart"><div class="yax num"><span>${money(max)}</span><span>${money(max/2)}</span><span>${money(0)}</span></div>
      <div class="plot"><div class="gl" style="top:0"></div><div class="gl" style="top:calc((100% - 20px)/2)"></div>
      ${buckets.map((b,i)=>`<div class="bar ${b.v?"":"zero"}" title="${b.d.toLocaleDateString(undefined,{day:"numeric",month:"short"})}: ${money(b.v)}"><i style="height:${max?b.v/max*100:0}%"></i>${(i%labelEvery===0||i===days-1)?`<span>${b.d.toLocaleDateString(undefined,{day:"numeric",month:"short"})}</span>`:""}</div>`).join("")}</div></div></div>
    <div class="panel"><h4>Best sellers</h4>${top.length?`<div class="top-list">${top.map(([n,v])=>`<div class="top-it"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n)} <span style="color:var(--muted)" class="num">×${v.q}</span></span><b class="num">${money(v.v)}</b><div class="tb"><i style="width:${v.v/topMax*100}%"></i></div></div>`).join("")}</div>`:`<p class="hint">Sales in this period will rank here.</p>`}</div>
  </div>
  <div class="sec-head" style="margin-bottom:10px"><div class="filters"><button class="chip" data-act="toggle-pending" aria-pressed="${S.onlyPending}">Only not in Shopify</button></div>
    ${isOwner()?`<div class="exports"><button class="btn" data-act="export-excel" ${orders.length?"":"disabled"}>Export to Excel</button><button class="btn gold" data-act="export-shopify-orders" ${orders.length?"":"disabled"}>Export orders for Shopify</button></div>`:""}</div>
  ${orders.length?`<div class="otable-wrap"><table class="ot"><thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Paid by</th><th>Staff</th><th>Shopify</th><th class="r">Total</th></tr></thead><tbody>
    ${orders.map(o=>`<tr data-order="${o.id}"><td><b class="num">${orderName(o)}</b></td><td class="num">${fmtDate(o.createdAt)} · ${fmtTime(o.createdAt)}</td><td class="num">${(o.items||[]).reduce((a,i)=>a+i.qty,0)}</td><td><span class="pill ${o.method}">${methodLabel(o)}</span></td><td>${esc(o.staffName||"")}</td><td><span class="pill ${o.shopify?"done":"todo"}">${o.shopify?"Exported":"Pending"}</span></td><td class="r num"><b>${money(o.total)}</b></td></tr>`).join("")}
  </tbody></table></div>`:`<div class="empty-state">No sales in this period yet.</div>`}`;
}

/* ---------- settings & staff ---------- */
let staffCache=null;
function viewSettings(){
  const st=S.settings;
  app.innerHTML=`
  <div class="sec-head"><div><div class="eyebrow">Shop</div><h2 class="sec">Settings</h2></div></div>
  <div style="display:grid;gap:16px">
  <form class="card" id="setForm">
    <div class="form-grid">
      <label class="fld">Shop name<input class="inp" id="s-name" value="${esc(st.shopName)}"></label>
      <label class="fld">Currency<select class="inp" id="s-cur">${["SAR","AED","INR","USD","EUR","GBP","QAR","KWD","BHD","OMR"].map(c=>`<option ${c===st.currency?"selected":""}>${c}</option>`).join("")}</select></label>
    </div>
    <label class="fld">Receipt footer<input class="inp" id="s-foot" value="${esc(st.footer||"")}"></label>
    <label class="fld">Page customers see after paying by Stripe<input class="inp" id="s-succ" value="${esc(st.successUrl||"")}" placeholder="https://noceragifts.com/"></label>
    <div style="display:grid;gap:10px"><div class="eyebrow">Bank or wallet QR (optional)</div>
      <div class="seg" role="group" aria-label="QR type"><button type="button" data-qrmode="image" aria-pressed="${st.qrMode!=="upi"}">My bank / wallet QR</button><button type="button" data-qrmode="upi" aria-pressed="${st.qrMode==="upi"}">UPI with amount</button></div>
      ${st.qrMode==="upi"?`<label class="fld">UPI ID<input class="inp" id="s-upi" value="${esc(st.upiId||"")}" placeholder="yourshop@okbank"></label>`:`
      <div class="photo-drop"><div class="qrprev">${st.qrImageUrl?`<img src="${esc(st.qrImageUrl)}" alt="Payment QR">`:"No QR yet"}</div>
        <div style="display:grid;gap:8px"><span class="hint">Upload the payment QR your bank or wallet gave you.</span><label class="btn" style="width:max-content">Upload QR image<input type="file" id="s-qr" accept="image/*" hidden></label></div></div>`}
    </div>
    <div><button class="btn primary" type="submit">Save settings</button></div>
  </form>
  <section class="card"><div class="sec-head" style="margin:0"><div><div class="eyebrow">Team</div><h3 style="margin:0;font-family:var(--f-display);font-weight:600">Staff logins</h3></div><button class="btn primary" data-act="new-staff">+ Add staff</button></div>
    <div class="staff-list" id="staffList"><p class="hint">Loading…</p></div></section>
  <section class="card"><div class="eyebrow">Move from the Claude app</div>
    <p class="hint" style="margin:0">Import the <b>nocera-import.json</b> file once to bring over products, photos, past sales and settings. Running it again skips anything already imported.</p>
    <label class="btn" style="width:max-content">Import file<input type="file" id="importFile" accept="application/json,.json" hidden></label></section>
  </div>`;
  document.querySelectorAll("[data-qrmode]").forEach(b=>b.onclick=()=>{S.settings.qrMode=b.dataset.qrmode;viewSettings()});
  const qrIn=$("#s-qr");if(qrIn)qrIn.onchange=async e=>{const f=e.target.files[0];if(!f)return;toast("Uploading QR…");try{const up=await uploadImage(f,900);await saveSettings({qrImageKey:up.key});toast("QR saved")}catch(err){toast(err.message)}};
  $("#setForm").onsubmit=async e=>{e.preventDefault();const g=id=>{const el=document.getElementById(id);return el?el.value:undefined};
    const p={shopName:g("s-name"),currency:g("s-cur"),footer:g("s-foot"),successUrl:g("s-succ"),qrMode:S.settings.qrMode};if(g("s-upi")!==undefined)p.upiId=g("s-upi");
    try{await saveSettings(p);toast("Settings saved")}catch(err){toast(err.message)}};
  $("#importFile").onchange=e=>runImport(e.target.files[0]);
  loadStaff();
}
async function saveSettings(patch){const d=await api("/api/settings",{method:"PUT",body:patch});S.settings=d.settings;render()}
async function loadStaff(){
  try{const d=await api("/api/staff");staffCache=d.staff}catch(e){const el=$("#staffList");if(el)el.innerHTML=`<p class="hint">${esc(e.message)}</p>`;return}
  const el=$("#staffList");if(!el)return;
  el.innerHTML=staffCache.map(s=>`<div class="staff-row ${s.active?"":"off"}"><div><b>${esc(s.name)}</b> <span class="hint">· ${s.role==="owner"?"Owner":"Staff"}${s.active?"":" · Turned off"}</span></div>
    <button class="btn" data-staff-pin="${s.id}">Change PIN</button><button class="btn" data-staff-toggle="${s.id}">${s.active?"Turn off":"Turn on"}</button></div>`).join("");
}
function staffModal(s){
  openModal(`<div class="modal-h"><h3>${s?"Change PIN":"Add staff"}</h3><button class="x" data-close aria-label="Close">×</button></div>
  <form class="modal-b" id="stForm">
    ${s?`<p style="margin:0">New PIN for <b>${esc(s.name)}</b>. They’ll be signed out on other devices.</p>`:`<label class="fld">Name<input class="inp" id="stName" required maxlength="60" placeholder="e.g. Shaheena"></label>
    <label class="fld">Role<select class="inp" id="stRole"><option value="staff">Staff · sells and sees sales</option><option value="owner">Owner · everything, incl. products and settings</option></select></label>`}
    <label class="fld">PIN (4–8 digits)<input class="inp num" id="stPin" required inputmode="numeric" pattern="\\d{4,8}" maxlength="8" autocomplete="new-password"></label>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${s?"Save PIN":"Add staff"}</button></div>
  </form>`);
  $("#stForm").onsubmit=async e=>{e.preventDefault();
    try{if(s)await api("/api/staff/"+s.id,{method:"PUT",body:{pin:$("#stPin").value}});
      else await api("/api/staff",{method:"POST",body:{name:$("#stName").value,role:$("#stRole").value,pin:$("#stPin").value}});
      closeModal();toast(s?"PIN changed":"Staff added");loadStaff()}catch(err){toast(err.message)}};
}
async function runImport(file){
  if(!file)return;toast("Importing… this can take a minute");
  try{const data=JSON.parse(await file.text());const r=await api("/api/import",{method:"POST",body:data});
    await loadAll();render();toast(`Imported ${r.products} products, ${r.orders} sales, ${r.photos} photos`)}
  catch(e){toast("Import failed: "+e.message)}
}

/* ---------- images ---------- */
function resize(file,max,q){
  return new Promise((res,rej)=>{const img=new Image();const url=URL.createObjectURL(file);
    img.onload=()=>{const s=Math.min(1,max/Math.max(img.width,img.height));const c=document.createElement("canvas");c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);
      const x=c.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(url);
      c.toBlob(b=>b?res(b):rej(new Error("That image couldn’t be read.")),"image/jpeg",q)};
    img.onerror=()=>rej(new Error("That image couldn’t be read. Try a JPG or PNG."));img.src=url});
}
async function uploadImage(file,max){const blob=await resize(file,max,.85);return api("/api/photos",{method:"POST",body:blob})}

/* ---------- product modal ---------- */
function productModal(p){
  const isNew=!p;p=p||{name:"",price:"",sku:"",category:"",description:"",photoUrl:"",photoKey:""};
  let photo={url:p.photoUrl,key:p.photoKey};
  const cats=[...new Set(S.products.map(x=>x.category).filter(Boolean))];
  openModal(`<div class="modal-h"><h3>${isNew?"Add product":"Edit product"}</h3><button class="x" data-close aria-label="Close">×</button></div>
  <form class="modal-b" id="pForm">
    <div class="photo-drop"><div class="ph ${photo.url?"":"empty"}" id="pPh">${photo.url?`<img src="${esc(photo.url)}" alt="">`:`<span class="mono">${initial(p.name||"+")}</span>`}</div>
      <div style="display:grid;gap:8px">${S.photosEnabled?`<label class="btn" style="width:max-content">${photo.url?"Change photo":"Add photo"}<input type="file" id="pFile" accept="image/*" hidden></label><span class="hint" id="pPhMsg">A square photo looks best.</span>`:`<span class="hint">Photo storage isn’t set up on the server yet.</span>`}</div></div>
    <label class="fld">Product name<input class="inp" id="pName" required value="${esc(p.name)}"></label>
    <div class="form-grid"><label class="fld">Sale price (${esc(S.settings.currency)})<input class="inp num" id="pPrice" type="number" min="0" step="0.01" inputmode="decimal" required value="${esc(p.price)}"></label>
      <label class="fld">SKU <span class="hint">optional</span><input class="inp" id="pSku" value="${esc(p.sku||"")}"></label></div>
    <label class="fld">Category<input class="inp" id="pCat" list="catList" value="${esc(p.category||"")}"><datalist id="catList">${cats.map(c=>`<option value="${esc(c)}">`).join("")}</datalist></label>
    <label class="fld">Description <span class="hint">optional, used in Stripe and Shopify</span><textarea class="inp" id="pDesc" rows="2">${esc(p.description||"")}</textarea></label>
    ${S.stripeEnabled?`<label class="chk"><input type="checkbox" id="pStripe" checked> <span>Save to Stripe too ${p.stripeProductId?`<span class="hint">· ${esc(p.stripeProductId)}</span>`:""}</span></label>${p.stripeError?`<div class="banner" style="margin:0">${esc(p.stripeError)}</div>`:""}`:""}
    <div style="display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap">${isNew?"<span></span>":`<button type="button" class="btn danger" id="pDel">Remove</button>`}
      <div style="display:flex;gap:8px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit" id="pSave">${isNew?"Add product":"Save changes"}</button></div></div>
  </form>`);
  const fi=$("#pFile");if(fi)fi.onchange=async e=>{const f=e.target.files[0];if(!f)return;$("#pPhMsg").textContent="Uploading photo…";$("#pSave").disabled=true;
    try{const up=await uploadImage(f,800);photo={url:up.url,key:up.key};$("#pPh").className="ph";$("#pPh").innerHTML=`<img src="${esc(up.url)}" alt="">`;$("#pPhMsg").textContent="Photo ready."}
    catch(err){$("#pPhMsg").textContent=err.message}$("#pSave").disabled=false};
  $("#pForm").onsubmit=async e=>{e.preventDefault();const btn=$("#pSave");btn.disabled=true;btn.textContent="Saving…";
    const body={name:$("#pName").value,price:$("#pPrice").value,sku:$("#pSku").value,category:$("#pCat").value,description:$("#pDesc").value,photoKey:photo.key||"",syncStripe:!!($("#pStripe")&&$("#pStripe").checked)};
    try{const d=isNew?await api("/api/products",{method:"POST",body}):await api("/api/products/"+p.id,{method:"PUT",body});
      upsert(S.products,d.product);closeModal();render();
      toast(d.product.stripeError?"Saved, but Stripe sync failed":body.syncStripe&&S.stripeEnabled?"Saved and synced to Stripe":"Saved")}
    catch(err){btn.disabled=false;btn.textContent=isNew?"Add product":"Save changes";toast(err.message)}};
  const del=$("#pDel");if(del)del.onclick=()=>confirmBox(`Remove “${p.name}”?`,"It leaves the counter only. Stripe isn’t changed, and past sales keep their record.","Remove",async()=>{
    await api("/api/products/"+p.id,{method:"DELETE"});S.products=S.products.filter(x=>x.id!==p.id);S.cart.delete(p.id);render();toast("Removed from the counter")});
}

/* ---------- checkout ---------- */
let payTimer=null,countTimer=null;
function stopTimers(){clearTimeout(payTimer);clearInterval(countTimer);payTimer=countTimer=null}
function quickCash(total){const s=new Set([Math.ceil(total)]);[5,10,20,50,100,200,500].forEach(n=>{const v=Math.ceil(total/n)*n;if(v>=total)s.add(v)});return [...s].sort((a,b)=>a-b).slice(0,5)}
function afterSale(order){S.orders.unshift(order);S.cart.clear();S.discount=0;S.cartOpen=false;render()}
function checkout(){
  const t=cartTotals();if(!t.count)return;
  const st=S.settings;const hasBankQR=(st.qrMode==="upi"&&st.upiId)||(st.qrMode!=="upi"&&st.qrImageUrl);
  let method=S.stripeEnabled?"stripe":(hasBankQR?"qr":"cash");let received="";
  const ss={phase:"idle",session:null,err:"",note:"",order:null};
  const draw=()=>{
    const change=r2((+received||0)-t.total);
    const locked=method==="stripe"&&(ss.phase==="creating"||ss.phase==="waiting");
    const tabs=[S.stripeEnabled?["stripe","Stripe QR"]:null,hasBankQR?["qr","Bank QR"]:null,["cash","Cash"]].filter(Boolean);
    openModal(`<div class="modal-h"><h3>Take payment</h3>${locked?"":`<button class="x" data-close aria-label="Close">×</button>`}</div>
    <div class="modal-b">
      <div class="pay-total"><div class="eyebrow">Amount due · ${t.count} item${t.count===1?"":"s"}</div><div class="v num">${money(t.total)}</div></div>
      ${locked||ss.phase==="paid"?"":`<div class="seg" style="grid-template-columns:repeat(${tabs.length},1fr)" role="group" aria-label="Payment method">${tabs.map(([k,l])=>`<button data-m="${k}" aria-pressed="${method===k}">${l}</button>`).join("")}</div>`}
      ${method==="stripe"?stripeBlock(ss,t):method==="qr"?qrBlock(t.total)+`<button class="btn primary lg" id="paid">Payment received · Save sale</button>`:`
        <label class="fld">Cash received<input class="inp num" id="cashIn" type="number" min="0" step="0.5" inputmode="decimal" value="${esc(received)}" placeholder="${t.total.toFixed(2)}" style="font-size:20px;padding:12px"></label>
        <div class="quick">${quickCash(t.total).map(v=>`<button class="chip num" data-cash="${v}">${money(v)}</button>`).join("")}</div>
        ${received!==""?`<div class="change ${change<0?"short":""}"><span>${change<0?"Still due":"Change to give"}</span><span class="num">${money(Math.abs(change))}</span></div>`:""}
        <button class="btn primary lg" id="paid" ${received!==""&&change<0?"disabled":""}>Cash received · Save sale</button>`}
    </div>`);
    document.querySelectorAll("[data-m]").forEach(b=>b.onclick=()=>{method=b.dataset.m;draw()});
    document.querySelectorAll("[data-cash]").forEach(b=>b.onclick=()=>{received=b.dataset.cash;draw()});
    const ci=$("#cashIn");if(ci)ci.oninput=e=>{received=e.target.value;const p=e.target.selectionStart;draw();const n=$("#cashIn");n.focus();try{n.setSelectionRange(p,p)}catch(_){}};
    if(method==="qr")drawUpiQR(t.total);
    if(method==="stripe"){
      if(ss.phase==="waiting"){drawQR(ss.session.url);startCountdown(ss)}
      const on=(id,fn)=>{const el=document.getElementById(id);if(el)el.onclick=fn};
      on("stCreate",()=>createStripe(ss,t,draw));
      on("stCancel",()=>cancelStripe(ss,draw));
      on("stCheck",()=>pollStripe(ss,draw,true));
      on("stCash",()=>{ss.phase="idle";method="cash";draw()});
      on("stRetry",()=>{ss.phase="idle";ss.err="";ss.note="";draw()});
      on("stDone",()=>{closeModal();receiptModal(ss.order,true)});
    }
    const paid=$("#paid");if(paid)paid.onclick=async()=>{paid.disabled=true;
      try{const d=await api("/api/orders",{method:"POST",body:Object.assign(cartPayload(),{method,received:method==="cash"?(received===""?null:+received):null})});
        afterSale(d.order);closeModal();receiptModal(d.order,true)}
      catch(err){paid.disabled=false;toast(err.message)}};
  };
  draw();
}
function stripeBlock(ss,t){
  if(ss.phase==="idle")return `<div class="stp-card"><p style="margin:0">Make a Stripe payment QR for this cart. The customer scans it and pays by card or Apple Pay on their phone.</p>
    ${ss.err?`<div class="banner" style="margin:0">${esc(ss.err)}</div>`:""}<button class="btn primary lg" id="stCreate">Show payment QR</button></div>`;
  if(ss.phase==="creating")return `<div class="stp-card" style="text-align:center"><div class="spin" aria-hidden="true"></div><p style="margin:0">Creating the Stripe checkout…</p></div>`;
  if(ss.phase==="waiting")return `<div class="qrbox"><div id="qr"></div><div class="cap">Scan to pay <b>${money(ss.session.amountTotal)}</b><br><span id="stCount" class="num">Expires in —</span></div></div>
    <div class="stp-status"><span class="dot" aria-hidden="true"></span><span>Waiting for payment…</span></div>
    ${ss.note?`<div class="banner" style="margin:0">${esc(ss.note)}</div>`:""}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn" id="stCancel">Cancel</button><button class="btn" id="stCheck">Check now</button></div>`;
  if(ss.phase==="paid")return `<div class="result ok"><div class="ico" aria-hidden="true">✓</div><h4>Payment successful</h4><p class="num">${money(ss.order.total)} received through Stripe · ${orderName(ss.order)}</p>
    <p class="thanks">Thank you for shopping at ${esc(S.settings.shopName)}!</p></div><button class="btn primary lg" id="stDone">Show receipt</button>`;
  if(ss.phase==="failed")return `<div class="result bad"><div class="ico" aria-hidden="true">✕</div><h4>Payment not completed</h4><p>${esc(ss.err||"The payment didn’t go through.")}</p></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn" id="stCash">Take cash instead</button><button class="btn primary" id="stRetry">Try a new QR</button></div>`;
  return "";
}
function drawQR(text){const el=document.getElementById("qr");if(!el||!text)return;if(window.QRCode)new QRCode(el,{text,width:440,height:440,correctLevel:QRCode.CorrectLevel.L});else el.textContent="QR library didn’t load. Reload the page."}
function startCountdown(ss){
  clearInterval(countTimer);
  const tick=()=>{const el=document.getElementById("stCount");if(!el){clearInterval(countTimer);return}
    const left=Math.max(0,ss.session.expiresAt-Date.now());el.textContent=`Expires in ${Math.floor(left/60000)}:${String(Math.floor(left%60000/1000)).padStart(2,"0")}`};
  tick();countTimer=setInterval(tick,1000);
}
async function createStripe(ss,t,draw){
  ss.phase="creating";ss.err="";draw();
  try{ss.session=await api("/api/checkout/stripe",{method:"POST",body:cartPayload()});
    ss.note=Math.abs(ss.session.amountTotal-t.total)>0.001?`Stripe’s total is ${money(ss.session.amountTotal)}, not ${money(t.total)}. Check prices before the customer pays.`:"";
    ss.phase="waiting";draw();stopTimers();startCountdown(ss);payTimer=setTimeout(()=>pollStripe(ss,draw,false),2500)}
  catch(e){ss.phase="idle";ss.err=e.message;draw()}
}
async function pollStripe(ss,draw,manual){
  clearTimeout(payTimer);if(ss.phase!=="waiting")return;
  let d;
  try{d=await api("/api/checkout/stripe/"+encodeURIComponent(ss.session.id))}
  catch(e){if(manual)toast(e.message);payTimer=setTimeout(()=>pollStripe(ss,draw,false),5000);return}
  if(ss.phase!=="waiting")return;
  if(d.status==="paid"&&d.order){stopTimers();ss.order=d.order;ss.phase="paid";afterSale(d.order);draw();return}
  if(d.status==="expired"||d.status==="cancelled"){stopTimers();ss.phase="failed";ss.err=d.status==="expired"?"The QR expired before the customer paid.":"This QR was cancelled.";draw();return}
  const note=d.lastError?`Last attempt failed: ${d.lastError}. The customer can try another card on their phone.`:"";
  if(note!==ss.note){ss.note=note;draw()}else if(manual)toast("Not paid yet");
  payTimer=setTimeout(()=>pollStripe(ss,draw,false),2000);
}
async function cancelStripe(ss,draw){
  stopTimers();
  try{const d=await api("/api/checkout/stripe/"+encodeURIComponent(ss.session.id)+"/cancel",{method:"POST"});
    if(d.status==="paid"&&d.order){ss.order=d.order;ss.phase="paid";afterSale(d.order);draw();return}
    ss.phase="failed";ss.err="You cancelled this QR. It can no longer be paid.";draw()}
  catch(e){toast(e.message);payTimer=setTimeout(()=>pollStripe(ss,draw,false),2000)}
}
function qrBlock(total){
  const st=S.settings;
  if(st.qrMode==="upi"&&st.upiId)return `<div class="qrbox"><div id="qr"></div><div class="cap">Scan with any UPI app · ${esc(st.upiId)}<br>Amount ${money(total)} is filled in</div></div>`;
  return `<div class="qrbox"><img class="static" src="${esc(st.qrImageUrl)}" alt="Payment QR code"><div class="cap">Ask the customer to scan and pay <b>${money(total)}</b></div></div>`;
}
function drawUpiQR(total){const st=S.settings;if(st.qrMode!=="upi"||!st.upiId)return;
  drawQR(`upi://pay?pa=${encodeURIComponent(st.upiId)}&pn=${encodeURIComponent(st.shopName)}&am=${total.toFixed(2)}&cu=${encodeURIComponent(st.currency||"INR")}`)}
function receiptModal(o,fresh){
  openModal(`<div class="modal-h"><h3>${fresh?"Sale saved":orderName(o)}</h3><button class="x" data-close aria-label="Close">×</button></div>
  <div class="modal-b"><div class="receipt">
      <div class="rh"><img src="/logo.png" alt="" style="height:36px;width:auto;margin:0 auto 6px;background:#fff;padding:6px 12px;border-radius:10px;box-sizing:content-box"><b style="font-size:16px">${esc(S.settings.shopName)}</b><span class="hint num">${orderName(o)} · ${fmtDate(o.createdAt)} ${fmtTime(o.createdAt)}${o.staffName?` · ${esc(o.staffName)}`:""}</span></div>
      ${(o.items||[]).map(i=>`<div class="trow"><span>${esc(i.name)} <span class="hint num">× ${i.qty}</span></span><span class="num">${money(i.qty*i.price)}</span></div>`).join("")}
      <div style="border-top:1px dashed var(--line);margin:6px 0"></div>
      <div class="trow"><span>Subtotal</span><span class="num">${money(o.subtotal)}</span></div>
      ${o.discount?`<div class="trow"><span>Discount</span><span class="num">−${money(o.discount)}</span></div>`:""}
      <div class="trow grand"><span>Total</span><span class="num">${money(o.total)}</span></div>
      <div class="trow"><span>Paid by</span><span><span class="pill ${o.method}">${methodLabel(o)}</span></span></div>
      ${o.method==="cash"?`<div class="trow"><span>Received · Change</span><span class="num">${money(o.received)} · ${money(o.change)}</span></div>`:""}
      ${S.settings.footer?`<div class="hint" style="text-align:center;margin-top:6px">${esc(S.settings.footer)}</div>`:""}
    </div>
    <button class="btn primary lg" data-close>${fresh?"Start next sale":"Done"}</button></div>`);
}

/* ---------- modal helpers ---------- */
function openModal(html){layer.innerHTML=`<div class="ov" data-ovl><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;const f=layer.querySelector("input:not([type=file]):not([type=checkbox]),button");if(f)setTimeout(()=>f.focus(),10)}
function closeModal(){stopTimers();layer.innerHTML=""}
const payLocked=()=>!!(document.getElementById("stCancel")||layer.querySelector(".spin"));
function confirmBox(title,body,okLabel,fn){
  openModal(`<div class="modal-h"><h3>${esc(title)}</h3></div><div class="modal-b"><p style="margin:0;color:var(--muted)">${esc(body)}</p>
  <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn primary" id="okBtn">${esc(okLabel)}</button></div></div>`);
  $("#okBtn").onclick=async()=>{$("#okBtn").disabled=true;try{await fn()}catch(e){toast(e.message)}closeModal()};
}

/* ---------- exports ---------- */
const csvCell=v=>{const s=String(v==null?"":v);return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
const toCSV=rows=>rows.map(r=>r.map(csvCell).join(",")).join("\r\n");
const slug=s=>String(s||"").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g,"").trim().replace(/[\s_]+/g,"-").replace(/-+/g,"-")||"item";
const stamp=()=>new Date().toISOString().slice(0,10);
function save(filename,data,type){const blob=data instanceof Blob?data:new Blob([data],{type:type||"text/csv;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)}
function exportExcel(){
  const orders=currentOrders();
  const sum=orders.map(o=>({"Order":orderName(o),"Date":fmtDate(o.createdAt),"Time":fmtTime(o.createdAt),"Staff":o.staffName||"","Items":(o.items||[]).reduce((a,i)=>a+i.qty,0),"Subtotal":o.subtotal,"Discount":o.discount||0,"Total":o.total,"Payment":methodLabel(o),"Cash received":o.method==="cash"?o.received:"","Change":o.method==="cash"?o.change:"","Stripe payment":o.stripePaymentIntent||"","Currency":o.currency,"In Shopify":o.shopify?"Yes":"No"}));
  const lines=[];orders.forEach(o=>(o.items||[]).forEach(i=>lines.push({"Order":orderName(o),"Date":fmtDate(o.createdAt),"Product":i.name,"SKU":i.sku,"Category":i.category,"Qty":i.qty,"Unit price":i.price,"Line total":r2(i.qty*i.price),"Payment":methodLabel(o)})));
  if(!window.XLSX){save(`nocera-sales-${stamp()}.csv`,toCSV([Object.keys(sum[0]),...sum.map(Object.values)]));return}
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(sum),"Orders");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(lines),"Line items");
  save(`nocera-sales-${stamp()}.xlsx`,new Blob([XLSX.write(wb,{type:"array",bookType:"xlsx"})],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));toast("Excel file downloaded");
}
async function exportShopifyOrders(){
  const orders=currentOrders().slice().reverse();
  const head=["Name","Command","Send Receipt","Inventory Behaviour","Processed At","Currency","Source","Tags","Note","Price: Total Line Items","Order Discount Amount","Price: Total","Financial: Status","Fulfillment: Status","Line: Type","Line: Title","Line: SKU","Line: Quantity","Line: Price","Transaction: Kind","Transaction: Status","Transaction: Amount","Transaction: Gateway","Transaction: Processed At"];
  const rows=[head];
  orders.forEach(o=>(o.items||[]).forEach((i,ix)=>{const f=ix===0;
    rows.push([orderName(o),"NEW","FALSE","bypass",o.createdAt,o.currency,"POS","in-store, nocera-counter",f?`Paid by ${methodLabel(o)} at counter`:"",o.subtotal,o.discount||0,o.total,"paid","fulfilled","Line Item",i.name,i.sku,i.qty,i.price,f?"sale":"",f?"success":"",f?o.total:"",f?methodLabel(o):"",f?o.createdAt:""])}));
  save(`shopify-orders-${stamp()}.csv`,toCSV(rows));
  const ids=orders.filter(o=>!o.shopify).map(o=>o.id);
  if(ids.length){try{await api("/api/orders/mark-exported",{method:"POST",body:{ids}});orders.forEach(o=>o.shopify=true);render()}catch(e){toast(e.message)}}
  toast(`${orders.length} orders exported`);
}
function exportShopifyProducts(){
  const head=["Handle","Title","Body (HTML)","Vendor","Type","Tags","Published","Option1 Name","Option1 Value","Variant SKU","Variant Inventory Policy","Variant Fulfillment Service","Variant Price","Variant Requires Shipping","Variant Taxable","Image Src","Status"];
  const seen={};const rows=[head];
  S.products.forEach(p=>{let h=slug(p.name);if(seen[h])h+="-"+(++seen[h]);else seen[h]=1;
    rows.push([h,p.name,p.description?`<p>${esc(p.description)}</p>`:"",S.settings.shopName,p.category||"",p.category||"","TRUE","Title","Default Title",p.sku||"","deny","manual",p.price,"TRUE","TRUE",p.photoUrl?location.origin+p.photoUrl:"","active"])});
  save(`shopify-products-${stamp()}.csv`,toCSV(rows));toast("Product file downloaded");
}

/* ---------- events ---------- */
document.addEventListener("click",e=>{
  const t=e.target.closest("button,[data-edit],[data-order],[data-ovl]");if(!t)return;
  if(t.matches("[data-ovl]")){if(e.target===t&&!payLocked())closeModal();return}
  if(t.closest("nav.tabs")&&t.dataset.view){S.view=t.dataset.view;S.cartOpen=false;render();window.scrollTo(0,0);return}
  if(t.dataset.add){addToCart(t.dataset.add);return}
  if(t.dataset.inc){addToCart(t.dataset.inc,1);return}
  if(t.dataset.dec){addToCart(t.dataset.dec,-1);return}
  if(t.dataset.cat!==undefined){S.cat=t.dataset.cat;render();return}
  if(t.dataset.range){S.range=t.dataset.range;render();return}
  if(t.dataset.edit){productModal(S.products.find(p=>p.id===t.dataset.edit));return}
  if(t.dataset.order){receiptModal(S.orders.find(o=>o.id===t.dataset.order));return}
  if(t.dataset.staffPin){staffModal((staffCache||[]).find(s=>s.id==t.dataset.staffPin));return}
  if(t.dataset.staffToggle){const s=(staffCache||[]).find(x=>x.id==t.dataset.staffToggle);if(s)api("/api/staff/"+s.id,{method:"PUT",body:{active:!s.active}}).then(loadStaff).catch(err=>toast(err.message));return}
  if(t.hasAttribute("data-close")){closeModal();return}
  switch(t.dataset.act){
    case "new-product":productModal();break;
    case "new-staff":staffModal();break;
    case "checkout":checkout();break;
    case "clear-cart":S.cart.clear();S.discount=0;render();break;
    case "open-cart":S.cartOpen=true;render();break;
    case "close-cart":S.cartOpen=false;render();break;
    case "toggle-pending":S.onlyPending=!S.onlyPending;render();break;
    case "export-excel":exportExcel();break;
    case "export-shopify-orders":exportShopifyOrders();break;
    case "export-shopify-products":exportShopifyProducts();break;
    case "lock":api("/api/logout",{method:"POST"}).catch(()=>{}).then(()=>{S.me=null;S.cart.clear();showLogin()});break;
  }
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&layer.innerHTML&&!payLocked())closeModal()});

/* ---------- boot ---------- */
(async()=>{try{await loadAll();await start(true)}catch(e){if(!S.me)showLogin();else app.innerHTML=`<div class="empty-state">${esc(e.message)}</div>`}})();
})();
