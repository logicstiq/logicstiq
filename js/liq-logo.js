/* ============================================================================
   LogicstIQ — animated header logo (Draw-on)
   Uses the ORIGINAL LogicstIQ checkmark-arrow mark (√ + arrowhead + 2 dots),
   with a self-drawing intro + "LogicstIQ" wordmark + tagline.
   • Draws the intro on every page load.
   • Respects prefers-reduced-motion. Theme-aware wordmark.
   Add to any page:  <script src="/js/liq-logo.js" defer></script>
============================================================================ */
(function(){
  var CSS = `
  .liqlogo{display:inline-flex;align-items:center;gap:11px}
  .liqlogo-mk{height:36px;width:auto;overflow:visible;flex:0 0 auto}
  .liqlogo-a1,.liqlogo-a2{fill:none;stroke-linecap:round;stroke-linejoin:round}
  .liqlogo-a1{stroke-width:5}.liqlogo-a2{stroke-width:4.5}
  .liqlogo-dot{transform-box:fill-box;transform-origin:center}
  .liqlogo-col{display:flex;flex-direction:column;line-height:1}
  .liqlogo-w{font-family:'Plus Jakarta Sans','Inter',sans-serif;font-weight:800;font-size:20px;letter-spacing:-.02em;white-space:nowrap}
  .liqlogo-w i{font-style:normal;display:inline-block;color:var(--navtext,var(--ink,#0F1729))}
  html[data-theme="dark"] .liqlogo-w i{color:#f4f7fb}
  .liqlogo-w i.iq{background:linear-gradient(120deg,#5b8dff,#c07bff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
  .liqlogo-tag{font-family:'Inter',sans-serif;font-size:9.5px;letter-spacing:.02em;color:var(--muted,#64708A);margin-top:5px;white-space:nowrap}
  @media(max-width:600px){.liqlogo-mk{height:32px}.liqlogo-w{font-size:18px}.liqlogo-tag{display:none}}
  @keyframes liqlogoDraw{to{stroke-dashoffset:0}}
  @keyframes liqlogoUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @keyframes liqlogoDot{from{opacity:0;transform:scale(.3)}to{opacity:1;transform:none}}
  .liqlogo.play .liqlogo-a1{stroke-dasharray:100;stroke-dashoffset:100;animation:liqlogoDraw .9s ease forwards}
  .liqlogo.play .liqlogo-a2{stroke-dasharray:100;stroke-dashoffset:100;animation:liqlogoDraw .4s ease .85s forwards}
  .liqlogo.play .liqlogo-dot{opacity:0;animation:liqlogoDot .4s ease 1.1s forwards}
  .liqlogo.play .liqlogo-w i{opacity:0;animation:liqlogoUp .45s ease forwards;animation-delay:calc(1.25s + var(--i)*.05s)}
  .liqlogo.play .liqlogo-tag{opacity:0;animation:liqlogoUp .5s ease forwards;animation-delay:1.8s}
  @media(prefers-reduced-motion:reduce){.liqlogo.play .liqlogo-a1,.liqlogo.play .liqlogo-a2,.liqlogo.play .liqlogo-dot,.liqlogo.play .liqlogo-w i,.liqlogo.play .liqlogo-tag{animation:none!important;opacity:1!important;stroke-dashoffset:0!important;transform:none!important}}
  `;
  var LETTERS = "Logicst".split("").map(function(c,i){return '<i style="--i:'+i+'">'+c+'</i>';}).join("")
              + '<i class="iq" style="--i:7">I</i><i class="iq" style="--i:8">Q</i>';
  var TEMPLATE = ''
    + '<span class="liqlogo">'
    +   '<svg class="liqlogo-mk" viewBox="0 0 92 80" aria-hidden="true">'
    +     '<defs><linearGradient id="liqlg" x1="10" y1="70" x2="82" y2="14" gradientUnits="userSpaceOnUse">'
    +       '<stop stop-color="#4F6BFF"/><stop offset="1" stop-color="#9B6BFF"/></linearGradient></defs>'
    +     '<path class="liqlogo-a1" pathLength="100" d="M10 40 L26 40 L42 66 L64 22 L80 22" stroke="url(#liqlg)"/>'
    +     '<path class="liqlogo-a2" pathLength="100" d="M74 14 L82 22 L74 30" stroke="#9B6BFF"/>'
    +     '<circle class="liqlogo-dot" cx="42" cy="66" r="4.5" fill="#4F6BFF"/>'
    +     '<circle class="liqlogo-dot" cx="64" cy="22" r="4.5" fill="#9B6BFF"/>'
    +   '</svg>'
    +   '<span class="liqlogo-col"><span class="liqlogo-w">'+LETTERS+'</span>'
    +   '<span class="liqlogo-tag">Where Logistics Meets Intelligence</span></span>'
    + '</span>';

  function run(){
    if(!document.getElementById("liq-logo-css")){
      var st=document.createElement("style"); st.id="liq-logo-css"; st.textContent=CSS; document.head.appendChild(st);
    }
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var links=document.querySelectorAll("a.nav-logo, a.lnav-logo");
    links.forEach(function(a){
      if(a.getAttribute("data-liq-logo")==="1") return;
      a.setAttribute("data-liq-logo","1");
      a.setAttribute("aria-label","LogicstIQ — home");
      a.innerHTML=TEMPLATE;
      if(!reduce){ var l=a.querySelector(".liqlogo"); if(l) l.classList.add("play"); }
    });
  }
  if(document.readyState!=="loading") run(); else document.addEventListener("DOMContentLoaded", run);
})();
