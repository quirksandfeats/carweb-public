// Precompute the force layout for app/cars.json + app/data.js.
// Run: node layout.mjs   (uses the same d3 bundle the app ships)
// d3-force from the local node_modules (npm install once in data_src/)
import fs from "fs";
import * as d3 from "d3-force";

const data = JSON.parse(fs.readFileSync("../app/cars.json", "utf-8"));
const nodes = data.nodes, links = data.links.map(l => ({ ...l }));
const byId = new Map(nodes.map(n => [n.id, n]));
const adj = new Map(nodes.map(n => [n.id, []]));
for (const l of links) {
  adj.get(l.source).push(byId.get(l.target));
  adj.get(l.target).push(byId.get(l.source));
}
nodes.forEach(n => n.deg = adj.get(n.id).length);

// ----- seed positions: country ring for makes, satellites for the rest -----
const countryOrder = ["Italy","Germany","United Kingdom","France","Sweden","Spain","Netherlands",
 "Belgium","Switzerland","Austria","Denmark","Norway","Czech Republic","Poland","Serbia","Romania",
 "Ukraine","Russia","Turkey","Iran","Japan","South Korea","China","Taiwan","India","Malaysia",
 "Vietnam","United States","Canada","Mexico","Brazil","Argentina","Australia","South Africa"];
const R_BASE = 2300;
const makes = nodes.filter(n => n.type === "make");
const byCountry = new Map();
makes.forEach(m => {
  const c = countryOrder.includes(m.country) ? m.country : "zz";
  if (!byCountry.has(c)) byCountry.set(c, []);
  byCountry.get(c).push(m);
});
let idx = 0;
const total = makes.length;
const order = [...countryOrder, "zz"];
order.forEach(c => {
  (byCountry.get(c) || []).sort((a, b) => b.deg - a.deg).forEach(m => {
    const a = (idx / total) * 2 * Math.PI - Math.PI / 2;
    const r = R_BASE + (idx % 5) * 260;
    m.x = Math.cos(a) * r; m.y = Math.sin(a) * r * 0.72;
    idx++;
  });
});
nodes.filter(n => n.type === "model").forEach(n => {
  const mk = adj.get(n.id).find(o => o.type === "make") || { x: 0, y: 0 };
  n.x = mk.x + (Math.random() - .5) * 420;
  n.y = mk.y + (Math.random() - .5) * 420;
});
nodes.filter(n => n.type === "person").forEach(n => {
  const ms = adj.get(n.id).filter(m => m.x !== undefined);
  if (ms.length) {
    n.x = ms.reduce((s, m) => s + m.x, 0) / ms.length + (Math.random() - .5) * 120;
    n.y = ms.reduce((s, m) => s + m.y, 0) / ms.length + (Math.random() - .5) * 120;
  } else { n.x = (Math.random() - .5) * 800; n.y = (Math.random() - .5) * 800; }
});

// ----- node radius (same formula the app uses) -----
function radius(n) {
  if (n.type === "make") return Math.min(9 + n.deg * 0.18, 26);
  if (n.type === "person") return Math.min(4.5 + n.deg * 0.5, 13);
  return 3.6 + Math.min(n.deg, 8) * 0.55;
}
nodes.forEach(n => n.r = radius(n));

// ----- simulate -----
console.time("layout");
const sim = d3.forceSimulation(nodes)
  .force("link", d3.forceLink(links).id(d => d.id)
    .distance(l => l.type === "made" ? 60 : l.type === "designed" || l.type === "engineered" ? 110
             : l.type === "succession" ? 34 : 46)
    .strength(l => l.type === "made" ? 0.55 : l.type === "designed" || l.type === "engineered" ? 0.08
             : l.type === "succession" ? 0.5 : 0.35))
  .force("charge", d3.forceManyBody()
    .strength(d => d.type === "make" ? -900 : d.type === "person" ? -160 : -46)
    .theta(0.95).distanceMax(1400))
  .force("collide", d3.forceCollide(d => d.r + 2.5).iterations(1))
  .force("x", d3.forceX(0).strength(0.018))
  .force("y", d3.forceY(0).strength(0.026))
  .stop();
const TICKS = 320;
for (let i = 0; i < TICKS; i++) {
  sim.tick();
  if (i % 40 === 0) console.error("tick", i);
}
console.timeEnd("layout");

// bake positions (1 decimal is plenty)
for (const n of nodes) {
  n.x = Math.round(n.x * 10) / 10;
  n.y = Math.round(n.y * 10) / 10;
  delete n.vx; delete n.vy; delete n.index; delete n.deg; delete n.r;
}
data.meta.layout = "precomputed";
fs.writeFileSync("../app/cars.json", JSON.stringify(data, null, 1));
fs.writeFileSync("../app/data.js", "window.CARDATA = " + JSON.stringify(data) + ";\n");
console.error("wrote positions for", nodes.length, "nodes");
