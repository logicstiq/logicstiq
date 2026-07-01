/* LogicstIQ AI Copilot — embeddable widget (vanilla JS, zero dependencies)
 * ------------------------------------------------------------------------
 * DROP-IN USAGE on any static HTML page:
 *   <script
 *     src="/copilot-widget.js"
 *     data-endpoint="/.netlify/functions/copilot"
 *     data-title="LogicstIQ Copilot"
 *     defer></script>
 *
 * It injects a floating button (bottom-right). No frameworks, no build step.
 * All styling is scoped inside a Shadow DOM so it can't clash with your site's CSS.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var ENDPOINT = (script && script.getAttribute("data-endpoint")) || "/api/copilot";
  var TITLE = (script && script.getAttribute("data-title")) || "LogicstIQ Copilot";
  var ACCENT = (script && script.getAttribute("data-accent")) || "#1D9E75"; // teal, matches brand

  var STARTERS = [
    "How do I calculate safety stock?",
    "How much inventory before Big Billion Days?",
    "Reduce my Amazon FBA stockouts",
    "What is a good OTIF target?",
  ];

  // --- Deep-link map: when a question matches, show a button to the matching LogicstIQ tool.
  // Ordered MOST-SPECIFIC first (first match wins). Edit labels/URLs here anytime — one place.
  // URLs are site-relative, so they work on any LogicstIQ page.
  var TOOLS = [
    [["reorder point", "when to reorder", "when to place"], "Reorder Point Calculator", "/reorder-point-calculator"],
    [["safety stock", "buffer stock"], "Safety Stock Calculator", "/safety-stock-calculator"],
    [["eoq", "economic order", "order quantity"], "EOQ Calculator", "/eoq-calculator"],
    [["abc analysis", "abc classification"], "ABC Analysis Calculator", "/abc-analysis-calculator"],
    [["inventory turnover", "turnover ratio", "stock turn"], "Inventory Turnover Calculator", "/inventory-turnover-calculator"],
    [["moq", "minimum order quantity"], "MOQ Calculator", "/moq-calculator"],
    [["dead stock", "non-moving", "obsolete stock"], "Dead Stock Calculator", "/dead-stock-calculator"],
    [["otif", "on-time in-full", "on time in full"], "OTIF Calculator", "/otif-calculator"],
    [["fill rate"], "Fill Rate Calculator", "/fill-rate-calculator"],
    [["supplier scorecard", "rate suppliers", "compare suppliers"], "Supplier Scorecard", "/supplier-scorecard-calculator"],
    [["cycle count", "physical count", "stock count"], "Cycle Count Calculator", "/cycle-count-calculator"],
    [["lead time variability", "lead-time spread", "supplier reliability"], "Lead Time Variability Calculator", "/supplier-lead-time-variability-calculator"],
    [["landed cost", "duties and freight", "true cost"], "Landed Cost Calculator", "/landed-cost-calculator"],
    [["gst", "hsn", "cgst", "sgst", "igst"], "GST Calculator", "/gst-calculator-logistics"],
    [["working capital"], "Working Capital Calculator", "/working-capital-calculator"],
    [["carrying cost", "holding cost"], "Carrying Cost Calculator", "/carrying-cost-calculator"],
    [["stockout cost", "cost of stockout", "lost sales"], "Stockout Cost Calculator", "/stockout-cost-calculator"],
    [["cogs", "cost of goods"], "COGS Calculator", "/cogs-calculator"],
    [["gross margin", "profit margin"], "Gross Margin Calculator", "/gross-margin-calculator"],
    [["break-even", "break even", "breakeven"], "Break-Even Calculator", "/break-even-calculator"],
    [["days inventory outstanding", "dio"], "Days Inventory Outstanding Calculator", "/days-inventory-outstanding-calculator"],
    [["cash conversion cycle", "ccc"], "Cash Conversion Cycle Calculator", "/cash-conversion-cycle-calculator"],
    [["freight cost", "carrier rate", "carrier rates"], "Freight Cost Calculator", "/freight-cost-calculator"],
    [["carbon", "co2", "emission", "footprint"], "Carbon Footprint Calculator", "/carbon-footprint-logistics"],
    [["warehouse space", "storage requirement", "storage space"], "Warehouse Space Calculator", "/warehouse-space-calculator"],
    [["disruption", "supply chain risk"], "Disruption Impact Calculator", "/disruption-impact-calculator"],
    [["shipping cost per unit", "per-unit shipping", "outbound shipping"], "Shipping Cost / Unit Calculator", "/shipping-cost-per-unit-calculator"],
    [["volumetric", "dimensional weight", "dim weight"], "Volumetric Weight Calculator", "/volumetric-weight-calculator"],
    [["pick and pack", "pick & pack", "pick pack", "fulfilment cost", "fulfillment cost"], "Pick & Pack Cost Calculator", "/pick-pack-cost-calculator"],
    [["lead time"], "Lead Time Calculator", "/lead-time-calculator"],
    [["fba", "long-term storage", "long term storage", "aged inventory", "disposition", "liquidate", "restock limit"], "FBA Planner", "/fba-disposition.html"],
    [["invoice", "purchase order", " po ", "proforma", "quotation", "delivery challan", "packing list", "certificate of origin", "bill of lading", "shipping bill", "bill of entry", "ebrc", "rodtep", "exim", "commercial invoice", "customs doc"], "Documents Generator", "/documents-generator.html"],
    [["forecast", "demand plan", "demand planning", "reorder suggestion", "predict demand", "upload"], "AI Demand Planner", "/#liq-planner"],
  ];

  function findTool(text) {
    var t = " " + String(text).toLowerCase() + " ";
    for (var i = 0; i < TOOLS.length; i++) {
      var kws = TOOLS[i][0];
      for (var j = 0; j < kws.length; j++) {
        if (t.indexOf(kws[j]) !== -1) return { label: TOOLS[i][1], url: TOOLS[i][2] };
      }
    }
    return null;
  }

  var messages = []; // {role, content}
  var busy = false;

  var host = document.createElement("div");
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.fab{position:fixed;bottom:20px;right:20px;z-index:2147483000;width:58px;height:58px;border-radius:50%;' +
    'background:' + ACCENT + ';color:#fff;border:none;cursor:pointer;font-size:24px;display:flex;align-items:center;' +
    'justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.18)}' +
    '.fab:hover{filter:brightness(1.05)}' +
    '.panel{position:fixed;bottom:88px;right:20px;z-index:2147483000;width:380px;max-width:calc(100vw - 32px);' +
    'height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;overflow:hidden;display:none;' +
    'flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.22);border:1px solid #e6e6e6}' +
    '.panel.open{display:flex}' +
    '.hd{background:' + ACCENT + ';color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}' +
    '.hd b{font-size:15px;font-weight:600}.hd small{display:block;font-size:11px;opacity:.85;font-weight:400}' +
    '.x{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1}' +
    '.body{flex:1;overflow-y:auto;padding:16px;background:#f7f8f7}' +
    '.msg{margin:0 0 12px;display:flex}' +
    '.msg.u{justify-content:flex-end}' +
    '.bub{padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.5;max-width:85%;white-space:pre-wrap;word-wrap:break-word}' +
    '.msg.a .bub{background:#fff;border:1px solid #eaeaea;color:#1a1a1a;border-bottom-left-radius:4px}' +
    '.msg.u .bub{background:' + ACCENT + ';color:#fff;border-bottom-right-radius:4px}' +
    '.intro{color:#555;font-size:14px;line-height:1.5;margin-bottom:14px}' +
    '.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px}' +
    '.chip{background:#fff;border:1px solid #dcdcdc;color:#333;border-radius:16px;padding:7px 12px;font-size:12.5px;' +
    'cursor:pointer;text-align:left}.chip:hover{border-color:' + ACCENT + ';color:' + ACCENT + '}' +
    '.dots span{display:inline-block;width:6px;height:6px;border-radius:50%;background:#bbb;margin-right:3px;' +
    'animation:b 1s infinite}.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}' +
    '@keyframes b{0%,80%,100%{opacity:.3}40%{opacity:1}}' +
    '.ft{padding:10px;border-top:1px solid #eee;background:#fff;display:flex;gap:8px}' +
    '.ft input{flex:1;border:1px solid #d8d8d8;border-radius:20px;padding:10px 14px;font-size:14px;outline:none}' +
    '.ft input:focus{border-color:' + ACCENT + '}' +
    '.send{background:' + ACCENT + ';color:#fff;border:none;border-radius:50%;width:40px;height:40px;cursor:pointer;font-size:16px}' +
    '.send:disabled{opacity:.5;cursor:default}' +
    '.dis{font-size:10.5px;color:#999;text-align:center;padding:6px 10px;background:#fff}' +
    '</style>' +
    '<button class="fab" aria-label="Open Copilot">&#9673;</button>' +
    '<div class="panel" role="dialog" aria-label="' + TITLE + '">' +
      '<div class="hd"><div><b>' + TITLE + '</b><small>End-to-end e-commerce supply chain</small></div>' +
      '<button class="x" aria-label="Close">&times;</button></div>' +
      '<div class="body"><div class="intro">Hi! Ask me anything about inventory, demand forecasting, ' +
      'logistics, or marketplace operations.</div><div class="chips"></div></div>' +
      '<div class="ft"><input type="text" placeholder="Ask about your supply chain..." aria-label="Message"/>' +
      '<button class="send" aria-label="Send">&#8593;</button></div>' +
      '<div class="dis">AI-generated. Verify important decisions. Not financial advice.</div>' +
    '</div>';

  var fab = root.querySelector(".fab");
  var panel = root.querySelector(".panel");
  var closeBtn = root.querySelector(".x");
  var bodyEl = root.querySelector(".body");
  var chipsEl = root.querySelector(".chips");
  var input = root.querySelector(".ft input");
  var sendBtn = root.querySelector(".send");

  STARTERS.forEach(function (s) {
    var c = document.createElement("button");
    c.className = "chip";
    c.textContent = s;
    c.onclick = function () { send(s); };
    chipsEl.appendChild(c);
  });

  function toggle(open) {
    panel.classList.toggle("open", open);
    if (open) input.focus();
  }
  fab.onclick = function () { toggle(!panel.classList.contains("open")); };
  closeBtn.onclick = function () { toggle(false); };

  function addBubble(role, text) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "u" : "a");
    var b = document.createElement("div");
    b.className = "bub";
    b.textContent = text;
    wrap.appendChild(b);
    bodyEl.appendChild(wrap);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return b;
  }

  function typing() {
    var wrap = document.createElement("div");
    wrap.className = "msg a";
    wrap.innerHTML = '<div class="bub dots"><span></span><span></span><span></span></div>';
    bodyEl.appendChild(wrap);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return wrap;
  }

  function addToolButton(tool) {
    var wrap = document.createElement("div");
    wrap.className = "msg a";
    var a = document.createElement("a");
    a.href = tool.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open the " + tool.label + " ↗";
    a.style.cssText =
      "display:inline-block;text-decoration:none;background:" + ACCENT + ";color:#fff;" +
      "border-radius:14px;padding:9px 14px;font-size:13px;font-weight:600;max-width:85%";
    wrap.appendChild(a);
    bodyEl.appendChild(wrap);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function send(text) {
    text = (text || input.value || "").trim();
    if (!text || busy) return;
    if (chipsEl.parentNode) { var i = root.querySelector(".intro"); if (i) i.remove(); chipsEl.remove(); }
    input.value = "";
    addBubble("user", text);
    messages.push({ role: "user", content: text });
    busy = true;
    sendBtn.disabled = true;
    var t = typing();

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        t.remove();
        if (!res.ok) { addBubble("assistant", res.j.error || "Something went wrong. Please try again."); return; }
        var reply = res.j.reply || "Sorry, I couldn't generate a response.";
        addBubble("assistant", reply);
        messages.push({ role: "assistant", content: reply });
        var tool = findTool(text + " " + reply);
        if (tool) addToolButton(tool);
      })
      .catch(function () { t.remove(); addBubble("assistant", "Network error. Please try again."); })
      .finally(function () { busy = false; sendBtn.disabled = false; input.focus(); });
  }

  sendBtn.onclick = function () { send(); };
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
})();
