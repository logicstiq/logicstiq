/* ============================================================================
   LogicstIQ — Auth + secure per-user storage (Firebase)
   ----------------------------------------------------------------------------
   • Sign-in: Google · Email magic-link (passwordless) · Email + password
   • Signup wall (LIQ.gate) for tools; calculators/blog/case-studies stay public
   • Per-user data stored in Firestore under users/{uid}/... (server-isolated by
     Security Rules) with encryption at rest + TLS in transit.
   • Captures ONLY the signup email (+consent flag) for lead-gen.
   ----------------------------------------------------------------------------
   SETUP: paste your Firebase Web config into FIREBASE_CONFIG below. The web
   apiKey is safe to expose (it is NOT a secret — real security is enforced by
   Firestore Security Rules). Never put an Admin service-account key in here.
   Add to any page:  <script type="module" src="/js/liq-auth.js"></script>
   Gate a tool page: add  data-liq-gate  to <body>  (or call LIQ.gate()).
============================================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  signOut as fbSignOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, serverTimestamp,
  collection, addDoc, getDocs, query, orderBy, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ─── 1. PASTE YOUR FIREBASE WEB CONFIG HERE ─────────────────────────────── */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDZJkIp6X1eeHFabRYXDuGRVjWxdNn4iJo",
  authDomain: "logicstiq2026.firebaseapp.com",         // e.g. logicstiq-xxxx.firebaseapp.com
  projectId: "logicstiq2026",
  storageBucket: "logicstiq2026.firebasestorage.app",
  messagingSenderId: "692280232351",
  appId: "1:692280232351:web:e61d21104e0318f93915aa",
  measurementId: "G-9JFBZB0C52"
};
const CONFIGURED = !String(FIREBASE_CONFIG.apiKey).startsWith("PASTE_");

const app  = CONFIGURED ? initializeApp(FIREBASE_CONFIG) : null;
const auth = app ? getAuth(app) : null;
const db   = app ? getFirestore(app) : null;
if (auth) setPersistence(auth, browserLocalPersistence).catch(()=>{});

let CURRENT_USER = null;
const readyCbs = [];
let authResolved = false;

/* ─── 2. STYLES (brand-matched, light + dark) ────────────────────────────── */
function injectStyles(){
  if (document.getElementById("liq-auth-css")) return;
  const s = document.createElement("style"); s.id = "liq-auth-css";
  s.textContent = `
  .liqa-ov{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;padding:20px;
    background:rgba(8,10,18,.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  .liqa-ov.on{display:flex}
  .liqa-card{width:100%;max-width:420px;background:var(--card,#fff);color:var(--text,#0F1729);
    border:1px solid var(--border,#E6EAF2);border-radius:18px;padding:26px 24px;position:relative;overflow:hidden;
    box-shadow:0 30px 80px rgba(0,0,0,.45);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}
  .liqa-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#3A55FF,#9B6BFF)}
  .liqa-x{position:absolute;top:12px;right:12px;border:none;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:var(--text3,#64708A);display:none}
  .liqa-ov.dismissable .liqa-x{display:block}
  .liqa-logo{display:flex;align-items:center;gap:8px;margin-bottom:14px}
  .liqa-logo b{font-family:'Plus Jakarta Sans','Inter';font-weight:800;font-size:17px;letter-spacing:-.02em}
  .liqa-logo b i{font-style:normal;color:#7C3AED}
  [data-theme="dark"] .liqa-logo b i{color:#B69BFF}
  .liqa-h{font-family:'Plus Jakarta Sans','Inter';font-weight:800;font-size:19px;margin:2px 0 4px}
  .liqa-sub{font-size:12.5px;color:var(--text3,#64708A);line-height:1.55;margin-bottom:16px}
  .liqa-btn{width:100%;border-radius:11px;padding:11px 14px;font-size:13.5px;font-weight:700;cursor:pointer;
    display:flex;align-items:center;justify-content:center;gap:9px;border:1px solid var(--border2,#D9DFEA);
    background:var(--card,#fff);color:var(--text,#0F1729);margin-bottom:10px;font-family:inherit;transition:.15s}
  [data-theme="dark"] .liqa-btn{background:#0E1320;border-color:#2B3654;color:#EAEEF7}
  .liqa-btn:hover{border-color:#3A55FF}
  .liqa-btn.pri{background:linear-gradient(135deg,#3A55FF,#770BFF);color:#fff;border:none;box-shadow:0 10px 24px rgba(58,85,255,.32)}
  .liqa-btn.pri:hover{transform:translateY(-1px)}
  .liqa-or{display:flex;align-items:center;gap:10px;color:var(--text4,#93A0B7);font-size:11px;margin:6px 0 12px}
  .liqa-or::before,.liqa-or::after{content:"";flex:1;height:1px;background:var(--border,#E6EAF2)}
  .liqa-in{width:100%;padding:10px 12px;border:1px solid var(--border2,#D9DFEA);border-radius:10px;font-size:13px;margin-bottom:10px;
    background:var(--card2,#F2F5FB);color:var(--text,#0F1729);font-family:inherit}
  [data-theme="dark"] .liqa-in{background:#0E1320;border-color:#2B3654;color:#EAEEF7}
  .liqa-in:focus{outline:none;border-color:#3A55FF;box-shadow:0 0 0 3px rgba(58,85,255,.2)}
  .liqa-consent{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;color:var(--text3,#64708A);line-height:1.5;margin:2px 0 14px}
  .liqa-consent input{margin-top:2px}
  .liqa-consent a{color:#3A55FF;font-weight:600}
  .liqa-msg{font-size:12px;border-radius:9px;padding:9px 11px;margin-bottom:10px;display:none;line-height:1.5}
  .liqa-msg.err{display:block;background:#FCEAEA;border:1px solid #f0c2c2;color:#9b1c1c}
  .liqa-msg.ok{display:block;background:#E7F6EC;border:1px solid #a7e0bd;color:#0f7a44}
  .liqa-foot{font-size:11px;text-align:center;color:var(--text4,#93A0B7);margin-top:6px}
  .liqa-foot a{color:#3A55FF;cursor:pointer;font-weight:600}
  .liqa-tabs{display:flex;gap:6px;margin-bottom:14px}
  .liqa-tab{flex:1;text-align:center;font-size:12px;font-weight:700;padding:8px;border-radius:9px;cursor:pointer;
    border:1px solid var(--border,#E6EAF2);color:var(--text3,#64708A);background:transparent}
  .liqa-tab.on{background:var(--b50,#EEF1FF);color:#2E42D6;border-color:#c3ccff}
  [data-theme="dark"] .liqa-tab.on{background:#171C2E;color:#B9C6FF;border-color:#2B3654}
  .liqa-lock{filter:blur(7px);pointer-events:none;user-select:none}
  .liqa-chip{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;cursor:pointer;
    border:1px solid var(--border,#E6EAF2);border-radius:30px;padding:6px 12px;color:var(--text,#0F1729);background:var(--card,#fff)}
  [data-theme="dark"] .liqa-chip{background:#141824;border-color:#242C3D;color:#EAEEF7}
  .liqa-av{width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#3A55FF,#770BFF);color:#fff;
    display:grid;place-items:center;font-size:11px;font-weight:800}
  `;
  document.head.appendChild(s);
}

/* ─── 3. WALL / AUTH MODAL ───────────────────────────────────────────────── */
let ov, msgEl, mode = "signup", dismissable = false;
function buildModal(){
  if (ov) return;
  injectStyles();
  ov = document.createElement("div"); ov.className = "liqa-ov";
  ov.innerHTML = `
    <div class="liqa-card" role="dialog" aria-modal="true" aria-label="Sign in to LogicstIQ">
      <button class="liqa-x" aria-label="Close">×</button>
      <div class="liqa-logo"><span class="liqa-av">Q</span><b>Logicst<i>IQ</i></b></div>
      <div class="liqa-tabs">
        <div class="liqa-tab on" data-m="signup">Create account</div>
        <div class="liqa-tab" data-m="login">Sign in</div>
      </div>
      <div class="liqa-h" id="liqaH">Create your free account</div>
      <div class="liqa-sub" id="liqaSub">Free forever. Save your work and get better AI forecasts over time. We only ask for your email.</div>
      <div class="liqa-msg" id="liqaMsg"></div>
      <button class="liqa-btn" data-a="google">
        <svg width="17" height="17" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.1 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.8 6.1C12.2 13.2 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.4-4.6 7.1l7.1 5.5c4.2-3.9 6.2-9.6 6.2-16.1z"/><path fill="#FBBC05" d="M10.3 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.8-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.5 10.7l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.1-5.5c-2 1.3-4.5 2.1-8.8 2.1-6.4 0-11.8-3.7-13.7-9.9l-7.8 6.1C6.4 42.6 14.6 48 24 48z"/></svg>
        Continue with Google
      </button>
      <div class="liqa-or">or</div>
      <input class="liqa-in" id="liqaEmail" type="email" placeholder="you@company.com" autocomplete="email">
      <input class="liqa-in" id="liqaPass" type="password" placeholder="Password (min 8 characters)" autocomplete="current-password">
      <label class="liqa-consent" id="liqaConsentWrap">
        <input type="checkbox" id="liqaConsent">
        <span>Email me occasional product updates &amp; tips. I agree to the
          <a href="/terms.html" target="_blank">Terms</a> and
          <a href="/privacy-policy.html" target="_blank">Privacy Policy</a>. My data is encrypted and private to my account.</span>
      </label>
      <button class="liqa-btn pri" data-a="email">Create account</button>
      <button class="liqa-btn" data-a="magic">✉️ Email me a magic sign-in link</button>
      <div class="liqa-foot"><a data-a="reset">Forgot password?</a></div>
    </div>`;
  document.body.appendChild(ov);
  msgEl = ov.querySelector("#liqaMsg");
  ov.querySelector(".liqa-x").onclick = () => { if (dismissable) hideModal(); };
  ov.addEventListener("click", e => { if (e.target === ov && dismissable) hideModal(); });
  ov.querySelectorAll(".liqa-tab").forEach(t => t.onclick = () => setMode(t.dataset.m));
  ov.querySelector('[data-a="google"]').onclick = doGoogle;
  ov.querySelector('[data-a="email"]').onclick  = doEmail;
  ov.querySelector('[data-a="magic"]').onclick  = doMagic;
  ov.querySelector('[data-a="reset"]').onclick  = doReset;
  setMode("signup");
}
function setMode(m){
  mode = m;
  if (!ov) return;
  ov.querySelectorAll(".liqa-tab").forEach(t => t.classList.toggle("on", t.dataset.m === m));
  const H = ov.querySelector("#liqaH"), S = ov.querySelector("#liqaSub"),
        E = ov.querySelector('[data-a="email"]'), C = ov.querySelector("#liqaConsentWrap"),
        P = ov.querySelector("#liqaPass");
  if (m === "signup"){ H.textContent="Create your free account"; S.textContent="Free forever. Save your work and get better AI forecasts over time. We only ask for your email."; E.textContent="Create account"; C.style.display="flex"; P.setAttribute("autocomplete","new-password"); }
  else { H.textContent="Welcome back"; S.textContent="Sign in to reach your saved data and tools."; E.textContent="Sign in"; C.style.display="none"; P.setAttribute("autocomplete","current-password"); }
  showMsg("");
}
function showMsg(t, kind){ if(!msgEl) return; msgEl.textContent=t||""; msgEl.className="liqa-msg"+(t?(" "+(kind||"err")):""); }
function showModal(canDismiss){ buildModal(); dismissable=!!canDismiss; ov.classList.toggle("dismissable",dismissable); ov.classList.add("on"); }
function hideModal(){ if(ov) ov.classList.remove("on"); }

function niceErr(e){
  const c=(e&&e.code)||""; const map={
    "auth/invalid-email":"That email address looks invalid.",
    "auth/missing-password":"Please enter a password.",
    "auth/weak-password":"Use at least 8 characters for your password.",
    "auth/email-already-in-use":"That email already has an account — switch to Sign in.",
    "auth/invalid-credential":"Email or password is incorrect.",
    "auth/wrong-password":"Email or password is incorrect.",
    "auth/user-not-found":"No account with that email — create one first.",
    "auth/popup-closed-by-user":"Google sign-in was cancelled.",
    "auth/too-many-requests":"Too many attempts — please wait a minute and retry."
  };
  return map[c] || (CONFIGURED ? "Something went wrong. Please try again." : "Auth is not configured yet — paste your Firebase config in js/liq-auth.js.");
}
function guardConfig(){ if(!CONFIGURED){ showMsg("Auth is not set up yet — add your Firebase config in js/liq-auth.js.","err"); return false;} return true; }

async function doGoogle(){ if(!guardConfig())return; showMsg("");
  try{ await signInWithPopup(auth, new GoogleAuthProvider()); hideModal(); }
  catch(e){ showMsg(niceErr(e)); } }

async function doEmail(){ if(!guardConfig())return;
  const email=ov.querySelector("#liqaEmail").value.trim(), pass=ov.querySelector("#liqaPass").value;
  if(!email){ showMsg("Enter your email."); return; }
  if(mode==="signup"){
    if(pass.length<8){ showMsg("Use at least 8 characters for your password."); return; }
    if(!ov.querySelector("#liqaConsent").checked){ showMsg("Please tick the box to agree to the Terms & Privacy Policy."); return; }
    try{ await createUserWithEmailAndPassword(auth,email,pass); hideModal(); }catch(e){ showMsg(niceErr(e)); }
  } else {
    try{ await signInWithEmailAndPassword(auth,email,pass); hideModal(); }catch(e){ showMsg(niceErr(e)); }
  }
}

const MAGIC_KEY="liq_magic_email";
async function doMagic(){ if(!guardConfig())return;
  const email=ov.querySelector("#liqaEmail").value.trim();
  if(!email){ showMsg("Enter your email first, then request the link."); return; }
  if(mode==="signup" && !ov.querySelector("#liqaConsent").checked){ showMsg("Please tick the box to agree to the Terms & Privacy Policy."); return; }
  try{
    await sendSignInLinkToEmail(auth,email,{ url:location.origin+"/login.html", handleCodeInApp:true });
    try{ localStorage.setItem(MAGIC_KEY,email); }catch(_){}
    showMsg("Check your inbox — we've sent you a one-tap sign-in link.","ok");
  }catch(e){ showMsg(niceErr(e)); }
}
async function completeMagicLink(){
  if(!auth || !isSignInWithEmailLink(auth, location.href)) return;
  let email=null; try{ email=localStorage.getItem(MAGIC_KEY); }catch(_){}
  if(!email) email=window.prompt("Confirm your email to finish signing in:");
  if(!email) return;
  try{ await signInWithEmailLink(auth,email,location.href); try{localStorage.removeItem(MAGIC_KEY);}catch(_){}
       history.replaceState({},"",location.pathname); }catch(e){ console.warn("magic link:",e); }
}
async function doReset(){ if(!guardConfig())return;
  const email=ov.querySelector("#liqaEmail").value.trim();
  if(!email){ showMsg("Enter your email, then tap Forgot password."); return; }
  try{ await sendPasswordResetEmail(auth,email); showMsg("Password reset link sent — check your inbox.","ok"); }
  catch(e){ showMsg(niceErr(e)); }
}

/* ─── 4. USER RECORD + LEAD CAPTURE (email only) ─────────────────────────── */
async function upsertUser(u){
  if(!db||!u) return;
  try{
    const uref=doc(db,"users",u.uid);
    const snap=await getDoc(uref);
    if(!snap.exists()){
      await setDoc(uref,{ email:u.email||null, displayName:u.displayName||null,
        consentMarketing:true, createdAt:serverTimestamp(), lastLogin:serverTimestamp() });
      // lead-gen record (email only) — readable to you via Firebase console
      if(u.email) await setDoc(doc(db,"leads",u.uid),{ email:u.email, source:location.pathname, createdAt:serverTimestamp() });
    } else {
      await setDoc(uref,{ lastLogin:serverTimestamp() },{merge:true});
    }
  }catch(e){ console.warn("user record:",e); }
}

/* ─── 5. NAV ACCOUNT CHIP ────────────────────────────────────────────────── */
function initials(u){ const s=(u.displayName||u.email||"U").trim(); return (s[0]||"U").toUpperCase(); }
function renderChip(){
  injectStyles();
  let host=document.querySelector(".topbar")||document.querySelector(".nav")||document.querySelector("header nav")||document.querySelector("header");
  let chip=document.getElementById("liqaChip");
  if(!chip){
    chip=document.createElement(host?"span":"div"); chip.id="liqaChip"; chip.className="liqa-chip";
    if(!host){ chip.style.cssText="position:fixed;top:12px;right:12px;z-index:9998"; document.body.appendChild(chip); }
    else host.appendChild(chip);
    chip.onclick=()=>{ if(CURRENT_USER) location.href="/account.html"; else showModal(true); };
  }
  if(CURRENT_USER){ chip.innerHTML=`<span class="liqa-av">${initials(CURRENT_USER)}</span><span>${(CURRENT_USER.email||"Account").split("@")[0]}</span>`; }
  else{ chip.innerHTML=`<span>🔒</span><span>Sign in</span>`; }
}

/* ─── 6. PUBLIC API ──────────────────────────────────────────────────────── */
function onReady(cb){ if(authResolved) cb(CURRENT_USER); else readyCbs.push(cb); }

// Gate: blur/hide protected content until signed in; show wall (non-dismissable).
function gate(opts){
  opts=opts||{}; const sel=opts.protect||"[data-liq-protected]";
  onReady(u=>{
    const nodes=document.querySelectorAll(sel);
    if(u){ nodes.forEach(n=>n.classList.remove("liqa-lock")); hideModal(); }
    else{ nodes.forEach(n=>n.classList.add("liqa-lock")); showModal(false); }
  });
}

async function saveDoc(sub, data){
  if(!db) throw new Error("not-configured");
  if(!CURRENT_USER) throw new Error("not-signed-in");
  const col=collection(db,"users",CURRENT_USER.uid,sub);
  const ref=await addDoc(col,{ ...data, savedAt:serverTimestamp() });
  return ref.id;
}
async function listDocs(sub){
  if(!db||!CURRENT_USER) return [];
  const col=collection(db,"users",CURRENT_USER.uid,sub);
  let q; try{ q=query(col,orderBy("savedAt","desc")); }catch(_){ q=col; }
  const snap=await getDocs(q); const out=[]; snap.forEach(d=>out.push({id:d.id,...d.data()})); return out;
}
async function deleteUserDoc(sub,id){ if(!db||!CURRENT_USER)return; await deleteDoc(doc(db,"users",CURRENT_USER.uid,sub,id)); }

window.LIQ = {
  configured: CONFIGURED,
  get user(){ return CURRENT_USER; },
  onReady,
  openAuth: ()=>showModal(true),
  gate,
  signOut: ()=>auth&&fbSignOut(auth),
  saveDoc, listDocs, deleteUserDoc
};

/* ─── 7. BOOT ────────────────────────────────────────────────────────────── */
function boot(){
  injectStyles();
  if(auth){
    completeMagicLink();
    onAuthStateChanged(auth, async (u)=>{
      CURRENT_USER=u||null;
      if(u) await upsertUser(u);
      authResolved=true;
      renderChip();
      readyCbs.splice(0).forEach(cb=>{ try{cb(CURRENT_USER);}catch(e){console.warn(e);} });
      document.dispatchEvent(new CustomEvent("liq-auth",{detail:{user:CURRENT_USER}}));
    });
  } else {
    authResolved=true; renderChip();
    readyCbs.splice(0).forEach(cb=>{ try{cb(null);}catch(e){} });
  }
  // Auto-gate if <body data-liq-gate>
  if(document.body && document.body.hasAttribute("data-liq-gate")) gate();
}
if(document.readyState!=="loading") boot(); else document.addEventListener("DOMContentLoaded",boot);
