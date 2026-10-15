// A mentioned car with no make in front is filed under a make the graph knows,
// not given a make of its own. After the October 2026 depth-7 runs there were
// makes called "Corolla", "Yaris", "Fairlady", "Mazda2" and "Taurus", each from
// a mention like "Corolla II" in a Toyota's article. The owner's rule: led by
// one of the origin car's make's model names, it is that make's car; and a
// make and a number written as one word ("Mazda2") is that make.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", runScripts: "outside-only" });
const w = dom.window; global.window = w; global.document = w.document;
w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
w.LLM_FAMILIES = { families: {}, __serverAvailable: false };
w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
const LF = w.LlmFamilies;
const nodes = [
  { id: "mk-toyota", type: "make", label: "Toyota" }, { id: "mk-mazda", type: "make", label: "Mazda" },
  { id: "m-tercel", type: "model", label: "Tercel", make: "Toyota" },
  { id: "m-corolla", type: "model", label: "Corolla", make: "Toyota" },
];
const links = [];
const a = LF.mintRelatedNode(nodes, links, "Corolla II (EL30)", null, "m-tercel");
t("\"Corolla II\" in a Toyota's article is a Toyota", a && a.make === "Toyota" && a.label === "Corolla II (EL30)", a && a.make + " / " + a.label);
t("...and no make called Corolla is made", !nodes.some(n => n.type === "make" && n.label === "Corolla"));
const b = LF.mintRelatedNode(nodes, links, "Mazda2 Hybrid", null, "m-tercel");
t("\"Mazda2 Hybrid\" is a Mazda", b && b.make === "Mazda" && b.label === "2 Hybrid", b && b.make + " / " + b.label);
const c = LF.mintRelatedNode(nodes, links, "Meridian Sport", null, "m-tercel");
t("a first word that is no model of the make still makes a make, as before", c && c.make === "Meridian");
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
