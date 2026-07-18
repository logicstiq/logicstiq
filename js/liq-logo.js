/* ============================================================================
   LogicstIQ — animated header logo (Style 1: Draw-on)
   Replaces the mark inside every  a.nav-logo / a.lnav-logo  with the new
   self-drawing check-arrow + "LogicstIQ" wordmark + tagline.
   • Draws the intro on every page load.
   • Respects prefers-reduced-motion. Theme-aware wordmark.
   Add to any page:  <script src="/js/liq-logo.js" defer></script>
============================================================================ */
(function(){
  var CSS = `
  .liqlogo{display:inline-flex;align-items:center;gap:9px}
  .liqlogo-mk{height:34px;width:auto;overflow:visible;flex:0 0 auto}
  .liqlogo-a1,.liqlogo-a2{fill:none;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
  .liqlogo-col{display:flex;flex-direction:column;line-height:1}
  .liqlogo-w{font-family:'Plus Jakarta Sans','Inter',sans-serif;font-weight:800;font-size:19px;letter-spacing:-.02em;white-space:nowrap}
  .liqlogo-w i{font-style:normal;display:inline-block;color:var(--navtext,var(--ink,#0F1729))}
  html[data-theme="dark"] .liqlogo-w i{color:#FFFFFF}
  .liqlogo-w i.iq{background:linear-gradient(120deg,#5b8dff,#c07bff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
  .liqlogo-tag{font-family:'Inter',sans-serif;font-size:9px;letter-spacing:.02em;color:var(--muted,#64708A);margin-top:4px;white-space:nowrap}
  @media(max-width:600px){.liqlogo-mk{height:30px}.liqlogo-w{font-size:17px}.liqlogo-tag{display:none}}
  @keyframes liqlogoDraw{to{stroke-dashoffset:0}}
  @keyframes liqlogoUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .liqlogo.play .liqlogo-a1{stroke-dasharray:100;stroke-dashoffset:100;animation:liqlogoDraw .9s ease forwards}
  .liqlogo.play .liqlogo-a2{stroke-dasharray:100;stroke-dashoffset:100;animation:liqlogoDraw .4s ease .85s forwards}
  .liqlogo.play .liqlogo-w i{opacity:0;animation:liqlogoUp .45s ease forwards;animation-delay:calc(1.2s + var(--i)*.05s)}
  .liqlogo.play .liqlogo-tag{opacity:0;animation:liqlogoUp .5s ease forwards;animation-delay:1.75s}
  @media(prefers-reduced-motion:reduce){.liqlogo.play .liqlogo-a1,.liqlogo.play .liqlogo-a2,.liqlogo.play .liqlogo-w i,.liqlogo.play .liqlogo-tag{animation:none!important;opacity:1!important;stroke-dashoffset:0!important}}
  `;
  var LETTERS = "Logicst".split("").map(function(c,i){return '<i style="--i:'+i+'">'+c+'</i>';}).join("")
              + '<i class="iq" style="--i:7">I</i><i class="iq" style="--i:8">Q</i>';
  var TEMPLATE = ''
    + '<span class="liqlogo">'
    +   '<svg class="liqlogo-mk" viewBox="0 0 56 52" aria-hidden="true">'
    +     '<defs><linearGradient id="liqlg" x1="6" y1="40" x2="49" y2="9" gradientUnits="userSpaceOnUse">'
    +       '<stop stop-color="#4F6BFF"/><stop offset="1" stop-color="#9B6BFF"/></linearGradient></defs>'
    +     '<path class="liqlogo-a1" pathLength="100" d="M8 30 L22 41 L50 8" stroke="url(#liqlg)"/>'
    +     '<path class="liqlogo-a2" pathLength="100" d="M37 13 L50 8 L47 22" stroke="url(#liqlg)"/>'
    +   '</svg>'
    +   '<span class="liqlogo-col"><span class="liqlogo-w">'+LETTERS+'</span>'
    +   '<span class="liqlogo-tag">Where Logistics Meets Intelligence</span></span>'
    + '</span>';

  function run(){
    if(document.getElementById("liq-logo-css")===null || !document.getElementById("liq-logo-css")){
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
