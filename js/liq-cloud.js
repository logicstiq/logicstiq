/* ============================================================================
   LogicstIQ — cloud sync bridge
   Mirrors each signed-in user's business data (supplier directory, company
   profile/GSTIN, PO/GRN tracker) to their private Firebase account, so it is
   saved, encrypted, and available on any device. Falls back to normal browser
   storage when signed out. Reuses the Firebase app started by liq-auth.js —
   requires no config here and does NOT modify liq-auth.js.

   Load AFTER liq-auth.js:  <script type="module" src="/js/liq-cloud.js"></script>
============================================================================ */
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDocs, collection, deleteDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* business data keys to sync (NOT theme / UI prefs) */
const KEYS = ["liq_sp_suppliers","liq_sp_ledger","liq_doc_profile"];

let app=null, auth=null, db=null, uid=null;
function grabApp(){ try{ app=getApp(); auth=getAuth(app); db=getFirestore(app); return true; }catch(e){ return false; } }
grabApp();

/* ---- mirror localStorage writes for the watched keys up to the account ---- */
const _set = Storage.prototype.setItem;
const _rem = Storage.prototype.removeItem;
const timers = {};
function pushCloud(key){
  if(!db||!uid) return;
  clearTimeout(timers[key]);
  timers[key]=setTimeout(async()=>{
    try{ const v=localStorage.getItem(key); await setDoc(doc(db,"users",uid,"kv",key),{v:(v==null?"":v),at:serverTimestamp()}); }catch(e){}
  },700);
}
Storage.prototype.setItem=function(k,v){ _set.call(this,k,v); if(this===window.localStorage && KEYS.indexOf(k)>=0) pushCloud(k); };
Storage.prototype.removeItem=function(k){ _rem.call(this,k); if(this===window.localStorage && KEYS.indexOf(k)>=0 && db && uid){ try{ deleteDoc(doc(db,"users",uid,"kv",k)); }catch(e){} } };

/* ---- on sign-in: pull the account copy down (or migrate this device up) ---- */
async function hydrate(){
  if(!db||!uid) return;
  let cloud={};
  try{ const snap=await getDocs(collection(db,"users",uid,"kv")); snap.forEach(d=>{cloud[d.id]=(d.data()||{}).v;}); }catch(e){ return; }
  let changed=false;
  for(const k of KEYS){
    let local=null; try{ local=localStorage.getItem(k); }catch(e){}
    const hasCloud = Object.prototype.hasOwnProperty.call(cloud,k) && cloud[k]!=null && cloud[k]!=="";
    if(hasCloud){
      if(local!==cloud[k]){ try{ _set.call(localStorage,k,cloud[k]); }catch(e){} changed=true; }   // account is source of truth
    } else if(local!=null && local!==""){
      try{ await setDoc(doc(db,"users",uid,"kv",k),{v:local,at:serverTimestamp()}); }catch(e){}      // first-time migrate device -> account
    }
  }
  // if the account had newer data than this device, reload once so the tool re-reads it
  if(changed){
    try{ if(!sessionStorage.getItem("liq_cloud_synced")){ sessionStorage.setItem("liq_cloud_synced","1"); location.reload(); } }catch(e){}
  }
}

function boot(){
  if(!auth && !grabApp()) return false;
  onAuthStateChanged(auth, u=>{ uid = u ? u.uid : null; if(uid) hydrate(); });
  return true;
}
if(!boot()){
  let n=0; const iv=setInterval(()=>{ if(boot()||++n>40) clearInterval(iv); }, 150);
}
