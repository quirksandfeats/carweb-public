// The loading screen. Real user request: "Is there a way to add a progress
// bar when I refresh the page, since it still takes a while due to the large
// number of nodes... preferably with a percentage or progress bar."
//
// Checked in a real browser when it was built (the bar keeps moving while the
// graph is being built, all three ways the page is opened work). What is
// pinned here is the structure that makes that true, and that everything
// driving the page headlessly now waits for the right signal.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "app", "index.html"), "utf-8");

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
};

const tpl = /<template id="boot-scripts">([\s\S]*?)<\/template>/.exec(html);
check("the page's scripts are listed in one template", !!tpl);
const listed = tpl ? [...tpl[1].matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]) : [];
check("...in the order the page depends on",
      listed.join(",") === "d3.min.js,data.js,llm_families_data.js,llm_families.js,app.js,timeline.js,sixdeg.js",
      listed.join(","));
const outside = html.replace(tpl ? tpl[0] : "", "");
check("no script is loaded by a plain tag any more -- the loader runs them one at a time",
      !/<script src=/.test(outside));
check("the regression suite's own reader still finds the same list, in order",
      [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]).join(",") === listed.join(","));

check("the loading screen is in the markup, so it is there at the first paint",
      /<div id="bootloader"/.test(html) && html.indexOf('id="bootloader"') < html.indexOf("<template"));
check("its styling is inline in the head, not waiting on a stylesheet",
      /<head>[\s\S]*#bootloader\{[\s\S]*<\/head>/.test(html));
check("the bar moves by transform, which keeps animating while the page is busy",
      /\.bl-bar\{[^}]*transform-origin[^}]*\}/.test(html) && /scaleX\(/.test(html) && !/bar\.style\.width/.test(html));
check("a long step says how long it took last time rather than a number it cannot keep current",
      /"about " \+ secs \+ " s"/.test(html));
check("serve.py is asked first, and the 5.7 MB mirror only loaded when it is not there",
      /\/api\/llm-families/.test(html) && /loadScript\("llm_families_data\.js"\)/.test(html) &&
      /src === "llm_families_data\.js"\) await loadLlmLayer\(\)/.test(html));
check("the page says when it is ready", /window\.__carwebReady = true/.test(html));
check("...and a failed step stays on screen saying which it was", /failed\(label, e\)/.test(html));

// Everything that opens the page headlessly waits for that, not for
// DOMContentLoaded, which now only means loading has STARTED.
for (const f of ["scripts/llm_agent.py", "qa/qa_run.py", "qa/qa_families.py",
                 "qa/qa_follow_none.py", "qa/qa_llm_families.py"]) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf-8");
  const loads = (src.match(/\.(goto|reload)\(/g) || []).length;
  const waits = (src.match(/__carwebReady/g) || []).length;
  check(`${f} waits for the graph to be ready after every load`, loads > 0 && waits >= loads,
        `${loads} load(s), ${waits} wait(s)`);
}

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
