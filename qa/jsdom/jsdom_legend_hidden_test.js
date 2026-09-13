// Real user report: "'My Garage' still appears as an element in the legend
// even though in the public build it should no longer be there."
//
// app.js already sets lg.hidden = true when no node carries the flag. The
// element still rendered, because .lg{display:flex} is an AUTHOR rule and
// beats the UA stylesheet's own [hidden]{display:none} -- so the property was
// set and had no effect. Every other hideable block in styles.css carries its
// own [hidden] rule for exactly this reason; .lg was missing one.
//
// jsdom does not do layout, so this asserts the CSS rule exists and applies
// rather than measuring a box.
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const APP = path.resolve(__dirname, "..", "..", "app");
const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

t("styles.css gives .lg its own [hidden] rule", /\.lg\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(css));
t("...and it comes after the .lg display rule that would otherwise win",
  css.search(/\.lg\[hidden\]/) > css.search(/\.lg\{display:flex/));

// The two rows in question exist and are the ones app.js targets.
const dom = new JSDOM(html);
for (const id of ["lg-db", "lg-garage"]) {
  const el = dom.window.document.getElementById(id);
  t(`#${id} is in the legend markup`, !!el);
  t(`#${id} carries the .lg class the rule applies to`, el && el.classList.contains("lg"));
}

// The same trap, checked across the file rather than just for .lg: any
// element app.js hides by setting .hidden must not also carry a display rule
// that outranks [hidden], or the assignment silently does nothing. This is a
// guard against the next one, not a style rule -- it only looks at selectors
// app.js genuinely hides.
const appjs = fs.readFileSync(path.join(APP, "app.js"), "utf-8");
const hidden = new Set(
  [...appjs.matchAll(/getElementById\("([a-z0-9-]+)"\)[^;]{0,40}\.hidden\s*=/g)].map(m => "#" + m[1])
);
hidden.add(".lg");
const unguarded = [...hidden].filter(sel => {
  const esc = sel.replace(/[.#]/g, "\\$&");
  const rule = new RegExp(esc + "(?![\\w-])\\s*\\{([^}]*)\\}");
  const m = css.match(rule);
  if (!m || !/display\s*:\s*(flex|block|grid|inline-flex)/.test(m[1])) return false;
  return !new RegExp(esc + "\\[hidden\\]").test(css);
});
t("nothing app.js hides is outranked by its own display rule",
  unguarded.length === 0, unguarded.join(", ") || "none");

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
