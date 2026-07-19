/* ============================================================================
   LogicstIQ — Icon System (Lucide line icons, MIT license)
   Auto-generated. Replaces functional emoji in nav menus and tool cards with a
   uniform line-icon set (single stroke weight, single accent, tinted tile).
   Resolves by TOOL NAME, not emoji, so it is correct even where the same emoji
   is reused for different tools. Non-destructive to body copy. Reversible:
   remove the <script> tag and original emoji return.

   Add to any page:  <script src="/js/liq-icons.js?v=3" defer></script>
============================================================================ */
(function () {
  "use strict";

  var P = {"sparkles":"<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\" /><path d=\"M20 2v4\" /><path d=\"M22 4h-4\" /><circle cx=\"4\" cy=\"20\" r=\"2\" />","line-chart":"<path d=\"M3 3v16a2 2 0 0 0 2 2h16\" /><path d=\"m19 9-5 5-4-4-3 3\" />","file-text":"<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" /><path d=\"M14 2v5a1 1 0 0 0 1 1h5\" /><path d=\"M10 9H8\" /><path d=\"M16 13H8\" /><path d=\"M16 17H8\" />","clipboard-list":"<rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\" /><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\" /><path d=\"M12 11h4\" /><path d=\"M12 16h4\" /><path d=\"M8 11h.01\" /><path d=\"M8 16h.01\" />","store":"<path d=\"M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5\" /><path d=\"M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244\" /><path d=\"M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05\" />","package-check":"<path d=\"M12 22V12\" /><path d=\"m16 17 2 2 4-4\" /><path d=\"M21 11.127V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.32-.753\" /><path d=\"M3.29 7 12 12l8.71-5\" /><path d=\"m7.5 4.27 8.997 5.148\" />","book-open":"<path d=\"M12 7v14\" /><path d=\"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z\" />","badge-check":"<path d=\"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z\" /><path d=\"m9 12 2 2 4-4\" />","shopping-bag":"<path d=\"M16 10a4 4 0 0 1-8 0\" /><path d=\"M3.103 6.034h17.794\" /><path d=\"M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z\" />","warehouse":"<path d=\"M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11\" /><path d=\"M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z\" /><path d=\"M6 13h12\" /><path d=\"M6 17h12\" />","undo-2":"<path d=\"M9 14 4 9l5-5\" /><path d=\"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11\" />","truck":"<path d=\"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2\" /><path d=\"M15 18H9\" /><path d=\"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14\" /><circle cx=\"17\" cy=\"18\" r=\"2\" /><circle cx=\"7\" cy=\"18\" r=\"2\" />","boxes":"<path d=\"M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z\" /><path d=\"m7 16.5-4.74-2.85\" /><path d=\"m7 16.5 5-3\" /><path d=\"M7 16.5v5.17\" /><path d=\"M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z\" /><path d=\"m17 16.5-5-3\" /><path d=\"m17 16.5 4.74-2.85\" /><path d=\"M17 16.5v5.17\" /><path d=\"M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z\" /><path d=\"M12 8 7.26 5.15\" /><path d=\"m12 8 4.74-2.85\" /><path d=\"M12 13.5V8\" />","zap":"<path d=\"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z\" />","package-x":"<path d=\"M12 22V12\" /><path d=\"m16.5 14.5 5 5\" /><path d=\"m16.5 19.5 5-5\" /><path d=\"M21 10.5V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.13-.074\" /><path d=\"M3.29 7 12 12l8.71-5\" /><path d=\"m7.5 4.27 8.997 5.148\" />","shield-check":"<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\" /><path d=\"m9 12 2 2 4-4\" />","rotate-cw":"<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\" /><path d=\"M21 3v5h-5\" />","bar-chart-3":"<path d=\"M3 3v16a2 2 0 0 0 2 2h16\" /><path d=\"M18 17V9\" /><path d=\"M13 17V5\" /><path d=\"M8 17v-3\" />","refresh-cw":"<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /><path d=\"M21 3v5h-5\" /><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /><path d=\"M8 16H3v5\" />","layers":"<path d=\"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z\" /><path d=\"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12\" /><path d=\"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17\" />","timer":"<line x1=\"10\" x2=\"14\" y1=\"2\" y2=\"2\" /><line x1=\"12\" x2=\"15\" y1=\"14\" y2=\"11\" /><circle cx=\"12\" cy=\"14\" r=\"8\" />","percent":"<line x1=\"19\" x2=\"5\" y1=\"5\" y2=\"19\" /><circle cx=\"6.5\" cy=\"6.5\" r=\"2.5\" /><circle cx=\"17.5\" cy=\"17.5\" r=\"2.5\" />","star":"<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\" />","activity":"<path d=\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\" />","list-checks":"<path d=\"M13 5h8\" /><path d=\"M13 12h8\" /><path d=\"M13 19h8\" /><path d=\"m3 17 2 2 4-4\" /><path d=\"m3 7 2 2 4-4\" />","globe":"<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\" /><path d=\"M2 12h20\" />","receipt-indian-rupee":"<path d=\"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z\" /><path d=\"M8 11h8\" /><path d=\"M8 7h8\" /><path d=\"M9 7a4 4 0 0 1 0 8H8l3 2\" />","coins":"<path d=\"M13.744 17.736a6 6 0 1 1-7.48-7.48\" /><path d=\"M15 6h1v4\" /><path d=\"m6.134 14.768.866-.5 2 3.464\" /><circle cx=\"16\" cy=\"8\" r=\"6\" />","trending-up":"<path d=\"M16 7h6v6\" /><path d=\"m22 7-8.5 8.5-5-5L2 17\" />","scale":"<path d=\"M12 3v18\" /><path d=\"m19 8 3 8a5 5 0 0 1-6 0zV7\" /><path d=\"M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1\" /><path d=\"m5 8 3 8a5 5 0 0 1-6 0zV7\" /><path d=\"M7 21h10\" />","landmark":"<path d=\"M10 18v-7\" /><path d=\"M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z\" /><path d=\"M14 18v-7\" /><path d=\"M18 18v-7\" /><path d=\"M3 22h18\" /><path d=\"M6 18v-7\" />","wallet":"<path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\" /><path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\" />","triangle-alert":"<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /><path d=\"M12 9v4\" /><path d=\"M12 17h.01\" />","calendar-days":"<path d=\"M8 2v4\" /><path d=\"M16 2v4\" /><rect width=\"18\" height=\"18\" x=\"3\" y=\"4\" rx=\"2\" /><path d=\"M3 10h18\" /><path d=\"M8 14h.01\" /><path d=\"M12 14h.01\" /><path d=\"M16 14h.01\" /><path d=\"M8 18h.01\" /><path d=\"M12 18h.01\" /><path d=\"M16 18h.01\" />","repeat":"<path d=\"m17 2 4 4-4 4\" /><path d=\"M3 11v-1a4 4 0 0 1 4-4h14\" /><path d=\"m7 22-4-4 4-4\" /><path d=\"M21 13v1a4 4 0 0 1-4 4H3\" />","package":"<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\" /><path d=\"M12 22V12\" /><polyline points=\"3.29 7 12 12 20.71 7\" /><path d=\"m7.5 4.27 9 5.15\" />","ruler":"<path d=\"M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z\" /><path d=\"m14.5 12.5 2-2\" /><path d=\"m11.5 9.5 2-2\" /><path d=\"m8.5 6.5 2-2\" /><path d=\"m17.5 15.5 2-2\" />","leaf":"<path d=\"M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z\" /><path d=\"M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12\" />","clock":"<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M12 6v6l4 2\" />","gauge":"<path d=\"m12 14 4-4\" /><path d=\"M3.34 19a10 10 0 1 1 17.32 0\" />","indian-rupee":"<path d=\"M6 3h12\" /><path d=\"M6 8h12\" /><path d=\"m6 13 8.5 8\" /><path d=\"M6 13h3\" /><path d=\"M9 13c6.667 0 6.667-10 0-10\" />","receipt":"<path d=\"M12 17V7\" /><path d=\"M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8\" /><path d=\"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z\" />","ship":"<path d=\"M12 10.189V14\" /><path d=\"M12 2v3\" /><path d=\"M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6\" /><path d=\"M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76\" /><path d=\"M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1\" />","clipboard-check":"<rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\" /><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\" /><path d=\"m9 14 2 2 4-4\" />","calculator":"<rect width=\"16\" height=\"20\" x=\"4\" y=\"2\" rx=\"2\" /><line x1=\"8\" x2=\"16\" y1=\"6\" y2=\"6\" /><line x1=\"16\" x2=\"16\" y1=\"14\" y2=\"18\" /><path d=\"M16 10h.01\" /><path d=\"M12 10h.01\" /><path d=\"M8 10h.01\" /><path d=\"M12 14h.01\" /><path d=\"M8 14h.01\" /><path d=\"M12 18h.01\" /><path d=\"M8 18h.01\" />"};
  var MAP = [["ai demand planner","sparkles"],["demand forecast","line-chart"],["sourcing","clipboard-list"],["paperwork hub","file-text"],["ecommerce suite","store"],["fba restock","package-check"],["fba planner","package-check"],["blog","book-open"],["why logicstiq","badge-check"],["order management","shopping-bag"],["oms","shopping-bag"],["warehouse management","warehouse"],["wms","warehouse"],["returns","undo-2"],["tms","truck"],["big billion days","boxes"],["blinkit","zap"],["cut dead stock","package-x"],["eoq","boxes"],["safety stock","shield-check"],["reorder point","rotate-cw"],["abc analysis","bar-chart-3"],["inventory turnover","refresh-cw"],["moq","layers"],["dead stock","package-x"],["otif","timer"],["fill rate","percent"],["supplier scorecard","star"],["lead time variability","activity"],["cycle count","list-checks"],["landed cost","globe"],["gst","receipt-indian-rupee"],["cogs","coins"],["gross margin","trending-up"],["break-even","scale"],["break even","scale"],["working capital","landmark"],["carrying cost","wallet"],["stockout","triangle-alert"],["days inventory outstanding","calendar-days"],["cash conversion","repeat"],["freight","truck"],["warehouse space","warehouse"],["shipping cost","package"],["volumetric","ruler"],["pick","package-check"],["carbon","leaf"],["disruption","zap"],["lead time","clock"],["inventory & planning","boxes"],["performance & suppliers","gauge"],["costing & finance","indian-rupee"],["logistics & warehouse","warehouse"],["business billing","receipt"],["supply chain & exim","ship"],["plan & book","truck"],["execute & audit","clipboard-check"],["guides","book-open"],["31 calculators","calculator"],["calculators","calculator"],["calculator","calculator"]];

  function norm(s) { return (s || "").toLowerCase().replace(/\s+/g, " ").trim(); }

  function pick(name) {
    name = norm(name);
    if (!name) return null;
    for (var i = 0; i < MAP.length; i++) {
      if (name.indexOf(MAP[i][0]) !== -1) return MAP[i][1];
    }
    return null;
  }

  function svg(n, size) {
    if (!P[n]) return "";
    return '<svg class="liq-ic" viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + P[n] + "</svg>";
  }

  var CSS =
    ".liq-ic{display:inline-block;vertical-align:middle;color:var(--liq-accent,#5b8dff);flex:0 0 auto}" +
    ".calc-ico{display:inline-flex;align-items:center;justify-content:center}" +
    ".calc-ico.liq-tile,.ico.liq-tile{display:inline-flex;align-items:center;justify-content:center;" +
    "width:52px;height:52px;border-radius:14px;font-size:0;" +
    "background:linear-gradient(135deg,rgba(79,107,255,.12),rgba(155,107,255,.12))}" +
    "html[data-theme='dark'] .calc-ico.liq-tile,html[data-theme='dark'] .ico.liq-tile{background:linear-gradient(135deg,rgba(91,141,255,.18),rgba(192,123,255,.18))}" +
    ".lnav-col a .liq-ic,.lnav-colt .liq-ic{margin-right:8px}" +
    ".lnav-colt .liq-ic{color:#5b8dff}";

  function injectCSS() {
    if (document.getElementById("liq-icons-css")) return;
    var st = document.createElement("style");
    st.id = "liq-icons-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // Find the first non-empty leading text node of an element.
  function leadTextNode(el) {
    var node = el.firstChild;
    while (node && node.nodeType === 3 && !node.textContent.trim()) node = node.nextSibling;
    return node && node.nodeType === 3 ? node : null;
  }

  // If el's text starts with a non-alphanumeric glyph (emoji/symbol), replace it
  // with the mapped icon. Resolves the icon from the element's full text.
  function swapNav(el, size) {
    var node = leadTextNode(el);
    if (!node) return;
    var t = node.textContent;
    var i = 0;
    while (i < t.length && /\s/.test(t[i])) i++;      // skip leading spaces
    if (i >= t.length) return;
    if (/[0-9A-Za-z]/.test(t[i])) return;             // no leading glyph
    var name = pick(el.textContent);
    if (!name) return;                                // unmapped -> leave as-is
    var j = i;
    while (j < t.length && !/[0-9A-Za-z]/.test(t[j])) j++; // end of glyph run
    node.textContent = t.slice(j).replace(/^\s+/, "");
    var span = document.createElement("span");
    span.innerHTML = svg(name, size);
    if (span.firstChild) el.insertBefore(span.firstChild, node);
  }

  function run() {
    injectCSS();

    // 1) Tool / calculator cards
    document.querySelectorAll(".calc-ico").forEach(function (ico) {
      if (ico.getAttribute("data-liq-ic") === "1") return;
      if (!ico.textContent.trim()) return;
      var card = ico.closest(".calc-card") || ico.parentElement;
      var nameEl = card && card.querySelector(".calc-name");
      var name = pick(nameEl ? nameEl.textContent : "");
      if (!name) return;
      ico.setAttribute("data-liq-ic", "1");
      ico.classList.add("liq-tile");
      ico.innerHTML = svg(name, 26);
    });

    // 1b) Hub "hero" cards: <a class="card"><div class="ico">🤖</div><h3>Name</h3></a>
    document.querySelectorAll(".card .ico, .ico").forEach(function (ico) {
      if (ico.getAttribute("data-liq-ic") === "1") return;
      if (ico.classList.contains("calc-ico")) return;   // handled above
      if (!ico.textContent.trim()) return;
      var card = ico.closest(".card") || ico.parentElement;
      var nameEl = card && (card.querySelector("h3") || card.querySelector(".calc-name"));
      var name = pick(nameEl ? nameEl.textContent : "");
      if (!name) return;
      ico.setAttribute("data-liq-ic", "1");
      ico.classList.add("liq-tile");
      ico.innerHTML = svg(name, 26);
    });

    // 2) Nav headers + featured links (only those with a leading glyph)
    document.querySelectorAll(".lnav-colt, .lnav-col a").forEach(function (el) {
      if (el.getAttribute("data-liq-ic") === "1") return;
      el.setAttribute("data-liq-ic", "1");
      swapNav(el, 16);
    });
  }

  if (document.readyState !== "loading") run();
  else document.addEventListener("DOMContentLoaded", run);
})();
