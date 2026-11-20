/* ===== 00-header.js ===== */
/*!
 * Limitless Elements — a Sandboxels mod
 * https://github.com/R74nCom/sandboxels
 *
 * Adds a large real-world material pack, universal pair fusion/alloying,
 * a sourced physics audit for the base game, and a "limitless" config.
 *
 * No UI is changed: no DOM nodes are created by this mod, and generated
 * mixture elements are hidden so the element picker stays as it is.
 *
 * Built file. Source lives in src/parts/.

 * Changelog
 * 1.0.0  2026-11-20  first build
 */
(function () {
"use strict";

/* Guard: only run inside the game (or a test harness that stubs the engine). */
if (typeof window === "undefined") { return; }
if (typeof elements === "undefined" || typeof behaviors === "undefined") {
  if (typeof console !== "undefined") { console.warn("[Limitless] engine globals missing, aborting"); }
  return;
}
if (window.LimitlessMod && window.LimitlessMod.loaded) {
  if (typeof logMessage === "function") { logMessage("Limitless Elements is already enabled."); }
  return;
}

var LM = {
  version: "1.0.0",
  name: "Limitless Elements",
  config: {
    // "Limitless" feel. 250k pixels is ~18x the vanilla cap and still playable.
    maxPixelCount: 250000,
    brushCeiling: 64,
    // Chance per contact. Fusion must feel like chemistry, not a converter.
    chances: {
      liquidLiquid: 0.10,
      liquidPowder: 0.06,
      powderPowder: 0.025,
      gasLiquid: 0.03,
      gasGas: 0.01,
      solidSolid: 0.02,
      solidPowder: 0.015
    },
    // Solid + solid metal alloying needs this fraction of the lower melting point.
    solidHeatRatio: 0.5,
    solidColdFloor: 350,
    // Fusion generations before a mixture becomes inert.
    maxFusionDepth: 2,
    // Hard ceiling on generated elements. Each mixture may also spawn one molten
    // or gas variant through autogen, so the element count can double this.
    maxGenerated: 1500,
    // Static neighbour samples per tick (covers pixels that never move).
    staticSamplesPerTick: 64,
    // Physics audit behaviour.
    audit: {
      enabled: true,
      // "report"  = measure only, never overwrite.
      // "trusted" = apply the vetted list below (default).
      // "all"     = apply every high/medium reference value (aggressive).
      mode: "trusted",
      // Only trust these reference confidences when overwriting the game.
      minConfidence: "medium",
      densityTolerance: 0.15,
      temperatureTolerance: 2
    },
    logSummary: true
  },
  stats: { generated: 0, fused: 0, corrected: 0, added: 0 },
  util: {},
  fusion: {},
  triggers: {},
  physics: { reference: {}, audit: { corrected: [], skipped: [], missing: [] } },
  materials: { pending: [], registered: [] },
  define: null
};
window.LimitlessMod = LM;

/* Small helpers that every part uses. */
LM.log = function (msg) {
  if (typeof logMessage === "function") { logMessage(msg); }
  else if (typeof console !== "undefined") { console.log("[Limitless] " + msg); }
};
LM.warn = function (msg) {
  if (typeof console !== "undefined") { console.warn("[Limitless] " + msg); }
};

/* ===== 10-util.js ===== */
/* Utilities: colour math, ids, state ranking, engine-safe accessors. */

function lmClamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

function lmParseColor(c) {
  // Vanilla elements are hex before load and "rgb(r,g,b)" after finalizeColor.
  if (c && typeof c === "object" && typeof c.r === "number") {
    return { r: lmClamp(Math.round(c.r), 0, 255), g: lmClamp(Math.round(c.g), 0, 255), b: lmClamp(Math.round(c.b), 0, 255) };
  }
  if (typeof c !== "string") { return { r: 200, g: 200, b: 200 }; }
  var s = c.trim();
  if (s.charAt(0) === "#") {
    var hex = s.substring(1);
    if (hex.length === 3) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    }
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.substring(0, 2), 16) || 0,
        g: parseInt(hex.substring(2, 4), 16) || 0,
        b: parseInt(hex.substring(4, 6), 16) || 0
      };
    }
  }
  var m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) { return { r: +m[1], g: +m[2], b: +m[3] }; }
  return { r: 200, g: 200, b: 200 };
}

function lmToHex(rgb) {
  var r = lmClamp(Math.round(rgb.r), 0, 255);
  var g = lmClamp(Math.round(rgb.g), 0, 255);
  var b = lmClamp(Math.round(rgb.b), 0, 255);
  var h = function (n) { var s = n.toString(16); return s.length === 1 ? "0" + s : s; };
  return "#" + h(r) + h(g) + h(b);
}

function lmWeightedAverage(colors) {
  return lmBlendColors(colors, colors.map(function () { return 1; }));
}

function lmElementColor(el, id) {
  // Vanilla elements with several colours store an ARRAY in colorObject.
  if (el && Object.prototype.toString.call(el.colorObject) === "[object Array]" && el.colorObject.length) {
    return lmWeightedAverage(el.colorObject);
  }
  if (el && el.colorObject) { return lmParseColor(el.colorObject); }
  if (el && Object.prototype.toString.call(el.color) === "[object Array]" && el.color.length) {
    return lmWeightedAverage(el.color);
  }
  if (el && typeof el.color === "string") { return lmParseColor(el.color); }
  return { r: 200, g: 200, b: 200 };
}

function lmBlendColors(colors, weights) {
  var r = 0, g = 0, b = 0, total = 0;
  for (var i = 0; i < colors.length; i++) {
    var w = weights && weights[i] !== undefined ? weights[i] : 1;
    var c = lmParseColor(colors[i]);
    r += c.r * w; g += c.g * w; b += c.b * w; total += w;
  }
  if (total === 0) { return { r: 200, g: 200, b: 200 }; }
  return { r: r / total, g: g / total, b: b / total };
}

function lmSanitizeId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function lmHash(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
  return h.toString(36).slice(0, 5);
}

/* Deterministic, order-independent id for a pair. */
function lmPairKey(a, b) {
  var x = String(a), y = String(b);
  if (x > y) { var t = x; x = y; y = t; }
  var raw = "mix_" + lmSanitizeId(x) + "__" + lmSanitizeId(y);
  if (raw.length > 34) {
    // Long parent ids get a short stable form: first parent + hash.
    raw = "mix_" + lmSanitizeId(x).substring(0, 12) + "_" + lmHash(x + "|" + y);
  }
  return raw;
}

/* Deterministic id for a mixture with three or more base components. */
function lmMultiKey(parts) {
  var clean = [];
  var joined = "";
  for (var i = 0; i < parts.length; i++) {
    clean.push(lmSanitizeId(parts[i]));
    joined += (i ? "|" : "") + parts[i];
  }
  var raw = "mix_" + clean.join("__");
  if (raw.length > 22) {
    // Three or more components get a short, stable id: first component + hash.
    // The readable list of components lives in the display name.
    raw = "mix_" + (clean[0] || "x").slice(0, 8) + "_" + lmHash(joined);
  }
  if (raw.length > 22) { raw = "mix_" + lmHash(joined); }
  return raw;
}

/* Higher rank wins when deciding what a mixture behaves like. */
function lmStateRank(el) {
  if (!el) { return 0; }
  if (el.state === "gas") { return 4; }
  if (el.state === "liquid") { return 3; }
  var b = el.behavior;
  if (typeof b === "function") {
    if (b === behaviors.GAS || b === behaviors.DGAS) { return 4; }
    if (b === behaviors.LIQUID || b === behaviors.SUPERFLUID) { return 3; }
    if (b === behaviors.POWDER || b === behaviors.STURDYPOWDER || b === behaviors.AGPOWDER) { return 2; }
    return 1;
  }
  if (Array.isArray(b) && b.length === 3) {
    var bottom = b[2];
    if (typeof bottom === "string") { return bottom.indexOf("M2") !== -1 || bottom.indexOf("M1") !== -1 ? 2 : 1; }
  }
  return 1;
}

LM.util.hexToRgb = lmParseColor;
LM.util.rgbToHex = lmToHex;
LM.util.blendColors = lmBlendColors;
LM.util.sanitizeId = lmSanitizeId;
LM.util.pairKey = lmPairKey;
LM.util.multiKey = lmMultiKey;
LM.util.stateRank = lmStateRank;
LM.util.elementColor = lmElementColor;
LM.util.hash = lmHash;

/* ===== 19-physics-data.js ===== */
/* GENERATED from data/physics-reference.json by tools/gen-physics.mjs — do not edit. */
LM.physics.reference = {"adobe":{"s":"Adobe (sun-dried clay + sand + straw)","m":null,"b":null,"d":1600,"c":"medium","src":["https://en.wikipedia.org/wiki/Adobe","https://www.britannica.com/technology/adobe"],"note":"No melting: straw chars 200-300 C, clay dehydroxylates 500-600 C. Dry density 1500-1700 kg/m3.","sub":0},"alcohol":{"s":"Ethanol (C2H5OH)","m":-114.1,"b":78.37,"d":789,"c":"high","src":["https://en.wikipedia.org/wiki/Ethanol","https://webbook.nist.gov/cgi/cbook.cgi?ID=C64175"],"note":"Pure ethanol; 95% azeotrope boils at 78.2 C.","sub":0},"alcohol_gas":{"s":"Ethanol vapour (C2H5OH)","m":-114.1,"b":78.37,"d":2.05,"c":"high","src":["https://en.wikipedia.org/wiki/Ethanol","https://webbook.nist.gov/cgi/cbook.cgi?ID=C64175"],"note":"Density calculated as ideal gas at STP from M = 46.07 g/mol.","sub":0},"aluminum":{"s":"Aluminium (Al)","m":660.32,"b":2519,"d":2700,"c":"high","src":["https://en.wikipedia.org/wiki/Aluminium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7429905"],"note":"Also spelled aluminum; density 2700 kg/m3 at 20 C.","sub":0},"ammonia":{"s":"Ammonia (NH3)","m":-77.73,"b":-33.34,"d":0.769,"c":"high","src":["https://en.wikipedia.org/wiki/Ammonia","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7664417"],"note":"Density is the ideal-gas value at STP (0 C, 101.325 kPa).","sub":0},"baked_clay":{"s":"Fired clay / terracotta","m":1200,"b":null,"d":2000,"c":"medium","src":["https://en.wikipedia.org/wiki/Terracotta","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"No sharp melting point; vitrifies/softens ~1000-1200 C. Density 1900-2100 kg/m3.","sub":0},"basalt":{"s":"Basalt (mafic volcanic rock)","m":1000,"b":null,"d":2900,"c":"medium","src":["https://en.wikipedia.org/wiki/Basalt","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Solidus ~1000 C, liquidus ~1200-1250 C. Density 2800-3000 kg/m3.","sub":0},"beans":{"s":"Dry beans (starch/protein seed)","m":null,"b":null,"d":750,"c":"medium","src":["https://en.wikipedia.org/wiki/Bean","https://www.fao.org/3/ap815e/ap815e.pdf"],"note":"Dry kidney/white beans 0.69-0.79 g/cm3 bulk; starch gelatinises 60-70 C, chars >250 C. No melting or boiling point.","sub":0},"blue_gold":{"s":"Blue gold (AuIn2 intermetallic, 46% Au, 54% In)","m":541,"b":null,"d":10200,"c":"low","src":["https://en.wikipedia.org/wiki/Colored_gold"],"note":"AuIn2 melts at 541 C (AuGa2 variant: 492 C). Density estimated by rule of mixtures; brittle intermetallic.","sub":0},"brass":{"s":"Brass (Cu-Zn alloy)","m":900,"b":null,"d":8500,"c":"medium","src":["https://en.wikipedia.org/wiki/Brass","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Typical 65% Cu / 35% Zn; melting 900-940 C depending on composition (solidus ~900). Density 8400-8750 kg/m3.","sub":0},"bread":{"s":"Bread (baked starch/protein foam)","m":null,"b":null,"d":290,"c":"medium","src":["https://en.wikipedia.org/wiki/Bread","https://www.fao.org/3/ap815e/ap815e.pdf"],"note":"Starch gelatinises 60-70 C, crust chars ~200 C; no melting. Bulk density 180-450 kg/m3.","sub":0},"brick":{"s":"Fired clay brick","m":1200,"b":null,"d":1900,"c":"medium","src":["https://en.wikipedia.org/wiki/Brick","https://www.britannica.com/technology/brick-building-material"],"note":"No sharp melting point: Pyrometric Cone Equivalent ~1150-1250 C; true melt of the clay body is higher. Density 1800-2100 kg/m3.","sub":0},"bronze":{"s":"Bronze (Cu-Sn alloy)","m":950,"b":null,"d":8800,"c":"medium","src":["https://en.wikipedia.org/wiki/Bronze","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Typical 88% Cu / 12% Sn; melting ~950 C, range 800-1000 C depending on tin content. Density 8740-8890 kg/m3.","sub":0},"butter":{"s":"Butter (~80% milk fat, water-in-oil emulsion)","m":33,"b":null,"d":911,"c":"high","src":["https://en.wikipedia.org/wiki/Butter","https://www.fao.org/3/ap815e/ap815e.pdf"],"note":"Butterfat melts 28-35 C (33 C typical); scorches/decomposes >150 C. Density 911 kg/m3.","sub":0},"calcium":{"s":"Calcium (Ca)","m":842,"b":1484,"d":1550,"c":"high","src":["https://en.wikipedia.org/wiki/Calcium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440702"],"note":"","sub":0},"carbon_dioxide":{"s":"Carbon dioxide (CO2)","m":-56.6,"b":-78.5,"d":1.977,"c":"high","src":["https://en.wikipedia.org/wiki/Carbon_dioxide","https://webbook.nist.gov/cgi/cbook.cgi?ID=C124389"],"note":"At 1 atm CO2 sublimes at -78.5 C; melting point -56.6 C applies at the 5.1 atm triple point. Density is the ideal-gas value at STP (0 C, 101.325 kPa).","sub":1},"cement":{"s":"Portland cement powder (Ca silicates/aluminates)","m":null,"b":null,"d":1440,"c":"medium","src":["https://en.wikipedia.org/wiki/Portland_cement","https://www.britannica.com/technology/cement-building-material"],"note":"Bulk powder 1400-1500 kg/m3. No melting: kiln clinker liquid forms ~1450 C, and the powder sets by hydration.","sub":0},"charcoal":{"s":"Charcoal (amorphous carbon, ~80-90% C)","m":null,"b":null,"d":300,"c":"medium","src":["https://en.wikipedia.org/wiki/Charcoal","https://www.britannica.com/technology/charcoal"],"note":"No melting at 1 atm: carbon sublimes ~3650 C. Bulk density 200-400 kg/m3 (true carbon skeleton ~1800-2000).","sub":0},"cheese":{"s":"Cheese (casein/fat matrix with water)","m":65,"b":null,"d":1100,"c":"medium","src":["https://en.wikipedia.org/wiki/Cheese","https://www.britannica.com/topic/cheese"],"note":"Softens 40-60 C and melts 60-90 C depending on fat and moisture; burns rather than boiling. Density 1050-1150 kg/m3.","sub":0},"chlorine":{"s":"Chlorine (Cl2)","m":-101.5,"b":-34.04,"d":3.2,"c":"high","src":["https://en.wikipedia.org/wiki/Chlorine","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7782505"],"note":"Density is the ideal-gas value at STP (0 C, 101.325 kPa).","sub":0},"chocolate":{"s":"Chocolate (cocoa solids + cocoa butter + sugar)","m":33,"b":null,"d":1320,"c":"high","src":["https://en.wikipedia.org/wiki/Chocolate","https://www.britannica.com/topic/chocolate"],"note":"Cocoa butter melts 30-34 C (33 C typical); solid density ~1320, molten ~1280 kg/m3. Scorches >180 C.","sub":0},"clay":{"s":"Kaolinite clay (Al2Si2O5(OH)4)","m":1785,"b":null,"d":2600,"c":"medium","src":["https://en.wikipedia.org/wiki/Kaolinite","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Dehydroxylates at ~550-600 C; melts/forms mullite at ~1785 C. No boiling point. Density 2600 kg/m3 (particle).","sub":0},"clay_shard":{"s":"Fired clay shard (terracotta)","m":1200,"b":null,"d":2000,"c":"medium","src":["https://en.wikipedia.org/wiki/Terracotta","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Same material as baked_clay; a shard has identical properties.","sub":0},"cloth":{"s":"Woven textile (cotton cellulose)","m":null,"b":null,"d":300,"c":"medium","src":["https://en.wikipedia.org/wiki/Textile","https://www.britannica.com/technology/textile"],"note":"Cotton chars ~250-300 C, no melting point. Bulk fabric density 200-400 kg/m3 (fibre itself ~1500).","sub":0},"coffee":{"s":"Brewed coffee (dilute aqueous extract)","m":0,"b":100,"d":1000,"c":"medium","src":["https://en.wikipedia.org/wiki/Coffee","https://www.fao.org/3/ap815e/ap815e.pdf"],"note":"~98-99% water; density 1.00 g/cm3, melting/boiling essentially those of water.","sub":0},"concrete":{"s":"Concrete (cement paste + aggregate)","m":null,"b":null,"d":2400,"c":"medium","src":["https://en.wikipedia.org/wiki/Concrete","https://www.britannica.com/technology/cement-building-material"],"note":"No melting point: paste dehydrates 100-400 C and spalls, aggregate melts ~1100-1200 C. Density 2200-2500 kg/m3.","sub":0},"copper":{"s":"Copper (Cu)","m":1084.62,"b":2562,"d":8960,"c":"high","src":["https://en.wikipedia.org/wiki/Copper","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440508"],"note":"","sub":0},"copper_sulfate":{"s":"Copper(II) sulfate pentahydrate (CuSO4.5H2O)","m":null,"b":null,"d":2286,"c":"high","src":["https://en.wikipedia.org/wiki/Copper(II)_sulfate","https://pubchem.ncbi.nlm.nih.gov/compound/24462"],"note":"Loses water at 63/109/200 C and decomposes to CuO above ~560 C; never melts at 1 atm. Anhydrous density 3600 kg/m3.","sub":0},"cream":{"s":"Cream (dairy fat-in-water emulsion)","m":-0.5,"b":100.5,"d":1010,"c":"medium","src":["https://en.wikipedia.org/wiki/Cream","https://www.fao.org/3/ap815e/ap815e.pdf"],"note":"Density by fat content: 1017 (9%), 1013 (13%), 994 (heavy ~40%); freezing point ~-0.5 C, boils ~100.5 C.","sub":0},"dirt":{"s":"Soil (mineral particles + organic matter)","m":null,"b":null,"d":1300,"c":"medium","src":["https://en.wikipedia.org/wiki/Soil","https://www.britannica.com/science/soil"],"note":"Mixture with no single melting point: organics char 200-400 C, mineral fraction sinters/melts ~1100-1200 C. Bulk density 1200-1500 kg/m3.","sub":0},"dirty_water":{"s":"Suspended-solids water (muddy water)","m":-1,"b":100.5,"d":1010,"c":"low","src":["https://en.wikipedia.org/wiki/Water","https://en.wikipedia.org/wiki/Suspended_solids"],"note":"Assumes ~1-5% suspended silt/clay; colligative effect small. Melting -0.5 to -2 C, boiling 100-102 C, density 1010-1050 kg/m3.","sub":0},"dough":{"s":"Bread dough (flour/water/yeast)","m":null,"b":null,"d":1150,"c":"medium","src":["https://en.wikipedia.org/wiki/Dough","https://www.britannica.com/topic/dough"],"note":"Sets rather than melts: starch gelatinises 60-70 C, water/CO2 evolve 100-200 C. Density 1100-1200 kg/m3.","sub":0},"dry_ice":{"s":"Solid carbon dioxide (CO2)","m":-56.6,"b":-78.5,"d":1562,"c":"high","src":["https://en.wikipedia.org/wiki/Dry_ice","https://webbook.nist.gov/cgi/cbook.cgi?ID=C124389"],"note":"Sublimes at -78.5 C at 1 atm; melts at -56.6 C only above 5.1 atm. Density 1562 kg/m3.","sub":1},"epsom_salt":{"s":"Magnesium sulfate heptahydrate (MgSO4.7H2O)","m":150,"b":null,"d":1660,"c":"medium","src":["https://en.wikipedia.org/wiki/Magnesium_sulfate","https://pubchem.ncbi.nlm.nih.gov/compound/24083"],"note":"Heptahydrate loses water from ~150 C; anhydrous MgSO4 melts at 1124 C. No boiling point (decomposes). Density of the heptahydrate.","sub":0},"flour":{"s":"Wheat flour (starch + gluten powder)","m":null,"b":null,"d":550,"c":"high","src":["https://en.wikipedia.org/wiki/Flour","https://www.fao.org/3/ap815e/ap815e.pdf"],"note":"Bulk density 480-700 kg/m3 depending on packing. Starch gelatinises 60-70 C and chars ~250 C; no melting.","sub":0},"galvanized_steel":{"s":"Zinc-coated steel","m":1450,"b":null,"d":7850,"c":"medium","src":["https://en.wikipedia.org/wiki/Galvanized_steel","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Steel substrate (0.2-2.1% C) with ~50-100 um zinc coating; coating melts at 419 C, steel solidus ~1400-1500 C.","sub":0},"glass":{"s":"Soda-lime glass (SiO2-Na2O-CaO)","m":1400,"b":null,"d":2500,"c":"medium","src":["https://en.wikipedia.org/wiki/Soda%E2%80%93lime_glass","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"No sharp melting point: glass transition ~520-560 C, softening ~700-730 C, working/melting range 1400-1600 C. No boiling point (decomposes/volatilises).","sub":0},"glass_shard":{"s":"Soda-lime glass fragment","m":1400,"b":null,"d":2500,"c":"medium","src":["https://en.wikipedia.org/wiki/Soda%E2%80%93lime_glass","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Same material as glass; a shard has identical properties.","sub":0},"gold":{"s":"Gold (Au)","m":1064.18,"b":2856,"d":19300,"c":"high","src":["https://en.wikipedia.org/wiki/Gold","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440575"],"note":"","sub":0},"gravel":{"s":"Gravel (loose rock fragments)","m":null,"b":null,"d":1600,"c":"medium","src":["https://en.wikipedia.org/wiki/Gravel","https://www.britannica.com/science/gravel"],"note":"Loose dry bulk density 1500-1700 kg/m3; no single melting point, constituent silicate rock melts ~1100-1250 C.","sub":0},"gunpowder":{"s":"Black powder (75% KNO3, 15% charcoal, 10% S)","m":null,"b":null,"d":1000,"c":"medium","src":["https://en.wikipedia.org/wiki/Gunpowder","https://www.britannica.com/technology/gunpowder"],"note":"Deflagrates instead of melting; autoignition ~300 C (ignites 250-300 C). Bulk 900-1100 kg/m3, pressed grains ~1700.","sub":0},"helium":{"s":"Helium (He)","m":null,"b":-268.928,"d":0.1786,"c":"high","src":["https://en.wikipedia.org/wiki/Helium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440597"],"note":"Does not solidify at 1 atm; solid forms only above ~25 atm. Density is the ideal-gas value at STP (0 C, 101.325 kPa).","sub":0},"honey":{"s":"Honey (concentrated sucrose/fructose/glucose solution)","m":null,"b":null,"d":1420,"c":"medium","src":["https://en.wikipedia.org/wiki/Honey","https://www.britannica.com/topic/honey"],"note":"No melting point: crystallises 10-15 C and caramelises 160-190 C; water boils off ~100 C. Density 1360-1450 kg/m3 at 20 C.","sub":0},"hydrogen":{"s":"Hydrogen (H2)","m":-259.16,"b":-252.879,"d":0.08988,"c":"high","src":["https://en.wikipedia.org/wiki/Hydrogen","https://webbook.nist.gov/cgi/cbook.cgi?ID=C1333740"],"note":"Density is the ideal-gas value at STP (0 C, 101.325 kPa).","sub":0},"ice":{"s":"Water ice (H2O, Ih)","m":0,"b":100,"d":917,"c":"high","src":["https://en.wikipedia.org/wiki/Ice","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7732185"],"note":"Ordinary hexagonal ice at 0 C; density 917 kg/m3. Melts at 0 C, boils at 100 C.","sub":0},"ice_cream":{"s":"Ice cream (aerated frozen dairy emulsion)","m":-6,"b":null,"d":550,"c":"low","src":["https://en.wikipedia.org/wiki/Ice_cream"],"note":"Mixture: melts -10 to -2 C depending on sugar/fat; overrun gives 500-600 kg/m3. No boiling point (boils off water then scorches).","sub":0},"iron":{"s":"Iron (Fe)","m":1538,"b":2861,"d":7874,"c":"high","src":["https://en.wikipedia.org/wiki/Iron","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439896"],"note":"","sub":0},"juice":{"s":"Fruit juice (aqueous, ~10% sugars)","m":-2,"b":100.5,"d":1050,"c":"low","src":["https://en.wikipedia.org/wiki/Juice"],"note":"Generic fruit juice; composition varies. Density 1040-1060 kg/m3, freezing point -1 to -3 C.","sub":0},"juice_ice":{"s":"Frozen fruit juice","m":-2,"b":100.5,"d":1050,"c":"low","src":["https://en.wikipedia.org/wiki/Juice"],"note":"Frozen aqueous sugar solution; melting is a slush range starting near -2 C.","sub":0},"lead":{"s":"Lead (Pb)","m":327.46,"b":1749,"d":11340,"c":"high","src":["https://en.wikipedia.org/wiki/Lead","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439921"],"note":"","sub":0},"limestone":{"s":"Limestone (CaCO3)","m":825,"b":null,"d":2700,"c":"medium","src":["https://en.wikipedia.org/wiki/Limestone","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Decomposes (calcines) to CaO + CO2 at ~825 C at 1 atm; true melting is 1339 C under CO2 pressure. No boiling point.","sub":0},"liquid_ammonia":{"s":"Liquid ammonia (NH3)","m":-77.73,"b":-33.34,"d":682,"c":"high","src":["https://en.wikipedia.org/wiki/Ammonia","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7664417"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"liquid_chlorine":{"s":"Liquid chlorine (Cl2)","m":-101.5,"b":-34.04,"d":1468,"c":"high","src":["https://en.wikipedia.org/wiki/Chlorine","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7782505"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"liquid_helium":{"s":"Liquid helium (He)","m":null,"b":-268.928,"d":125,"c":"high","src":["https://en.wikipedia.org/wiki/Helium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440597"],"note":"Density is for the liquid state at or near its boiling/melting point. Solidifies only under ~25 atm.","sub":0},"liquid_hydrogen":{"s":"Liquid hydrogen (H2)","m":-259.16,"b":-252.879,"d":70.8,"c":"high","src":["https://en.wikipedia.org/wiki/Hydrogen","https://webbook.nist.gov/cgi/cbook.cgi?ID=C1333740"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"liquid_methane":{"s":"Liquid methane (CH4)","m":-182.5,"b":-161.5,"d":422.6,"c":"high","src":["https://en.wikipedia.org/wiki/Methane","https://webbook.nist.gov/cgi/cbook.cgi?ID=C74828"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"liquid_neon":{"s":"Liquid neon (Ne)","m":-248.59,"b":-246.08,"d":1207,"c":"high","src":["https://en.wikipedia.org/wiki/Neon","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440174"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"liquid_nitrogen":{"s":"Liquid nitrogen (N2)","m":-210,"b":-195.795,"d":808,"c":"high","src":["https://en.wikipedia.org/wiki/Nitrogen","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7727379"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"liquid_oxygen":{"s":"Liquid oxygen (O2)","m":-218.79,"b":-182.962,"d":1141,"c":"high","src":["https://en.wikipedia.org/wiki/Oxygen","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7782447"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"magnesium":{"s":"Magnesium (Mg)","m":650,"b":1090,"d":1738,"c":"high","src":["https://en.wikipedia.org/wiki/Magnesium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439954"],"note":"","sub":0},"mercury":{"s":"Mercury (Hg)","m":-38.83,"b":356.73,"d":13534,"c":"high","src":["https://en.wikipedia.org/wiki/Mercury_(element)","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439976"],"note":"Liquid at room temperature.","sub":0},"mercury_gas":{"s":"Mercury vapour (Hg(g))","m":-38.83,"b":356.73,"d":8.96,"c":"high","src":["https://en.wikipedia.org/wiki/Mercury_(element)","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439976"],"note":"Saturation vapour density is far lower; 8.96 kg/m3 is the ideal-gas value at STP.","sub":0},"methane":{"s":"Methane (CH4)","m":-182.5,"b":-161.5,"d":0.717,"c":"high","src":["https://en.wikipedia.org/wiki/Methane","https://webbook.nist.gov/cgi/cbook.cgi?ID=C74828"],"note":"Density is the ideal-gas value at STP (0 C, 101.325 kPa).","sub":0},"milk":{"s":"Whole cow milk (water/fat/protein emulsion)","m":-0.5,"b":100.5,"d":1030,"c":"high","src":["https://en.wikipedia.org/wiki/Milk","https://www.fao.org/3/ap815e/ap815e.pdf"],"note":"Freezing point -0.53 C; boils 100.2-100.5 C. Density 1030 kg/m3 at 20 C (1034 at 4 C).","sub":0},"molten_aluminum":{"s":"Molten aluminium (Al, liquid)","m":660.32,"b":2519,"d":2375,"c":"high","src":["https://en.wikipedia.org/wiki/Aluminium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7429905"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_copper":{"s":"Molten copper (Cu, liquid)","m":1084.62,"b":2562,"d":8020,"c":"high","src":["https://en.wikipedia.org/wiki/Copper","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440508"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_glass":{"s":"Molten soda-lime glass","m":1400,"b":null,"d":2350,"c":"medium","src":["https://en.wikipedia.org/wiki/Soda%E2%80%93lime_glass","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Liquid glass above the working range; density ~2350-2400 kg/m3 at 1400 C. No boiling point.","sub":0},"molten_gold":{"s":"Molten gold (Au, liquid)","m":1064.18,"b":2856,"d":17310,"c":"high","src":["https://en.wikipedia.org/wiki/Gold","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440575"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_iron":{"s":"Molten iron (Fe, liquid)","m":1538,"b":2861,"d":6980,"c":"high","src":["https://en.wikipedia.org/wiki/Iron","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439896"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_lead":{"s":"Molten lead (Pb, liquid)","m":327.46,"b":1749,"d":10660,"c":"high","src":["https://en.wikipedia.org/wiki/Lead","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439921"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_magnesium":{"s":"Molten magnesium (Mg, liquid)","m":650,"b":1090,"d":1584,"c":"high","src":["https://en.wikipedia.org/wiki/Magnesium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439954"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_nickel":{"s":"Molten nickel (Ni, liquid)","m":1455,"b":2913,"d":7810,"c":"high","src":["https://en.wikipedia.org/wiki/Nickel","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440020"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_potassium":{"s":"Molten potassium (K, liquid)","m":63.5,"b":759,"d":828,"c":"high","src":["https://en.wikipedia.org/wiki/Potassium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440097"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_silver":{"s":"Molten silver (Ag, liquid)","m":961.78,"b":2162,"d":9320,"c":"high","src":["https://en.wikipedia.org/wiki/Silver","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440224"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_sodium":{"s":"Molten sodium (Na, liquid)","m":97.794,"b":882.94,"d":927,"c":"high","src":["https://en.wikipedia.org/wiki/Sodium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440235"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_sulfur":{"s":"Molten sulfur (S, liquid)","m":115.21,"b":444.6,"d":1819,"c":"high","src":["https://en.wikipedia.org/wiki/Sulfur","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7704349"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_tin":{"s":"Molten tin (Sn, liquid)","m":231.93,"b":2602,"d":6990,"c":"high","src":["https://en.wikipedia.org/wiki/Tin","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440315"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_uranium":{"s":"Molten uranium (U, liquid)","m":1132.2,"b":4131,"d":17300,"c":"high","src":["https://en.wikipedia.org/wiki/Uranium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440611"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"molten_zinc":{"s":"Molten zinc (Zn, liquid)","m":419.53,"b":907,"d":6570,"c":"high","src":["https://en.wikipedia.org/wiki/Zinc","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440666"],"note":"Density is for the liquid state at or near its boiling/melting point.","sub":0},"mud":{"s":"Mud (water + silt/clay)","m":0,"b":100,"d":1700,"c":"low","src":["https://en.wikipedia.org/wiki/Mud","https://www.britannica.com/science/soil"],"note":"Melting/boiling are those of the pore water; clay fraction dehydroxylates ~500-600 C. Wet bulk density 1600-1900 kg/m3.","sub":0},"mudstone":{"s":"Mudstone (clay-silt sedimentary rock)","m":1200,"b":null,"d":2500,"c":"low","src":["https://en.wikipedia.org/wiki/Mudstone"],"note":"Approximate: clay-rich rock with no sharp melting point; dehydrates 400-600 C and softens/melts above ~1100-1300 C. Density 2400-2700 kg/m3.","sub":0},"neon":{"s":"Neon (Ne)","m":-248.59,"b":-246.08,"d":0.9002,"c":"high","src":["https://en.wikipedia.org/wiki/Neon","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440174"],"note":"Density is the ideal-gas value at STP (0 C, 101.325 kPa).","sub":0},"nickel":{"s":"Nickel (Ni)","m":1455,"b":2913,"d":8900,"c":"high","src":["https://en.wikipedia.org/wiki/Nickel","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440020"],"note":"","sub":0},"nitrogen":{"s":"Nitrogen (N2)","m":-210,"b":-195.795,"d":1.251,"c":"high","src":["https://en.wikipedia.org/wiki/Nitrogen","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7727379"],"note":"Density is the ideal-gas value at STP (0 C, 101.325 kPa).","sub":0},"nitrogen_ice":{"s":"Solid nitrogen (N2)","m":-210,"b":-195.795,"d":1026,"c":"high","src":["https://en.wikipedia.org/wiki/Nitrogen","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7727379"],"note":"Solid nitrogen melts at -210 C and sublimes/boils at -195.8 C at 1 atm. Density 1026 kg/m3 at 63 K.","sub":0},"nut_oil":{"s":"Nut/seed oil (triglyceride)","m":-10,"b":null,"d":915,"c":"medium","src":["https://en.wikipedia.org/wiki/Cooking_oil","https://en.wikipedia.org/wiki/Vegetable_oil"],"note":"Generic nut oil (e.g. peanut, sunflower); freezes -20 to 0 C, smoke point ~225 C, decomposes before boiling.","sub":0},"oil":{"s":"Vegetable cooking oil (triglyceride)","m":-10,"b":null,"d":915,"c":"medium","src":["https://en.wikipedia.org/wiki/Cooking_oil","https://en.wikipedia.org/wiki/Vegetable_oil"],"note":"Generic refined seed oil; composition varies. Solidifies -20 to 0 C, smoke point ~200-230 C, decomposes before boiling.","sub":0},"oxidized_copper":{"s":"Copper(II) oxide (CuO)","m":1326,"b":2000,"d":6315,"c":"medium","src":["https://en.wikipedia.org/wiki/Copper(II)_oxide","https://pubchem.ncbi.nlm.nih.gov/compound/14829"],"note":"Black tenorite; decomposes/vaporises near 2000 C. Green patina is basic copper carbonate, not CuO.","sub":0},"oxygen":{"s":"Oxygen (O2)","m":-218.79,"b":-182.962,"d":1.429,"c":"high","src":["https://en.wikipedia.org/wiki/Oxygen","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7782447"],"note":"Density is the ideal-gas value at STP (0 C, 101.325 kPa).","sub":0},"packed_sand":{"s":"Compacted quartz sand (SiO2)","m":1713,"b":2950,"d":2000,"c":"medium","src":["https://en.wikipedia.org/wiki/Silicon_dioxide","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Compacted bulk density ~2000 kg/m3 (vs 2650 for quartz grains); thermal values are those of silica.","sub":0},"paper":{"s":"Paper (cellulose fibres)","m":null,"b":null,"d":800,"c":"high","src":["https://en.wikipedia.org/wiki/Paper","https://www.britannica.com/topic/paper"],"note":"Chars and autoignites ~230 C instead of melting. Apparent density 700-1200 kg/m3.","sub":0},"permafrost":{"s":"Permafrost (ice-cemented soil/rock)","m":0,"b":100,"d":1800,"c":"medium","src":["https://en.wikipedia.org/wiki/Permafrost","https://www.britannica.com/science/permafrost"],"note":"Melting/boiling are those of the pore ice (0/100 C); frozen bulk density 1700-2000 kg/m3. Thaws to a mud-like slurry.","sub":0},"plastic":{"s":"Thermoplastic (generic, polypropylene-like)","m":160,"b":null,"d":900,"c":"low","src":["https://en.wikipedia.org/wiki/Plastic","https://www.britannica.com/technology/plastic"],"note":"Representative value: PP crystalline melting 130-171 C, HDPE 120-140 C. Softens well below melting and decomposes >300 C.","sub":0},"pool_water":{"s":"Chlorinated fresh water (pool water)","m":-0.5,"b":100,"d":1000,"c":"medium","src":["https://en.wikipedia.org/wiki/Water","https://en.wikipedia.org/wiki/Swimming_pool"],"note":"Assumes ~1-3 ppm free chlorine plus trace salts; near-pure water values.","sub":0},"porcelain":{"s":"Porcelain (vitrified kaolin/feldspar/quartz ceramic)","m":1400,"b":null,"d":2400,"c":"medium","src":["https://en.wikipedia.org/wiki/Porcelain","https://www.britannica.com/technology/porcelain"],"note":"No sharp melting point: vitrifies 1200-1400 C and softens ~1300-1450 C; reported value is the upper softening range.","sub":0},"potassium":{"s":"Potassium (K)","m":63.5,"b":759,"d":862,"c":"high","src":["https://en.wikipedia.org/wiki/Potassium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440097"],"note":"","sub":0},"potassium_gas":{"s":"Potassium vapour (K(g))","m":63.5,"b":759,"d":1.744,"c":"high","src":["https://en.wikipedia.org/wiki/Potassium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440097"],"note":"Ideal-gas density at STP from M = 39.10 g/mol.","sub":0},"potassium_salt":{"s":"Potassium chloride (KCl)","m":770,"b":1420,"d":1984,"c":"high","src":["https://en.wikipedia.org/wiki/Potassium_chloride","https://pubchem.ncbi.nlm.nih.gov/compound/4873"],"note":"Muriate of potash; melts 770 C, boils ~1420 C (sublimes ~1500 C).","sub":0},"purple_gold":{"s":"Purple gold (AuAl2 intermetallic, 79% Au)","m":1060,"b":null,"d":8400,"c":"low","src":["https://en.wikipedia.org/wiki/Colored_gold","https://en.wikipedia.org/wiki/Gold%E2%80%93aluminium_intermetallic"],"note":"Brittle intermetallic, not a malleable alloy. mp ~1060 C; density estimated by rule of mixtures (Au 19.3, Al 2.7).","sub":0},"rice":{"s":"Rice grain (starch-based)","m":null,"b":null,"d":850,"c":"low","src":["https://en.wikipedia.org/wiki/Rice"],"note":"Starch gelatinises at 60-70 C; chars/decomposes above ~250 C, no melting or boiling point. Density is bulk (grain ~1450 kg/m3).","sub":0},"rock":{"s":"Granitic rock (silicate aggregate)","m":700,"b":null,"d":2700,"c":"medium","src":["https://en.wikipedia.org/wiki/Granite","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"No sharp melting point: granite solidus ~650-900 C depending on water content, liquidus ~1200 C. Density 2600-2800 kg/m3.","sub":0},"rock_wall":{"s":"Granitic rock, wall form (silicate aggregate)","m":700,"b":null,"d":2700,"c":"medium","src":["https://en.wikipedia.org/wiki/Granite","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Same material as rock; wall variant has no distinct physical properties. Solidus ~650-900 C.","sub":0},"rose_gold":{"s":"Rose gold (18k: 75% Au, 22.25% Cu, 2.75% Ag)","m":900,"b":null,"d":15600,"c":"medium","src":["https://en.wikipedia.org/wiki/Colored_gold","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Solidus ~900 C, liquidus ~1000 C; 14k and 22k variants differ. Density 15.4-15.9 g/cm3.","sub":0},"salt":{"s":"Sodium chloride (NaCl)","m":801,"b":1413,"d":2165,"c":"high","src":["https://en.wikipedia.org/wiki/Sodium_chloride","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7647145"],"note":"Halite; melting 801 C, boiling 1413 C.","sub":0},"salt_ice":{"s":"Frozen brine (ice + NaCl)","m":-21.1,"b":100,"d":1100,"c":"low","src":["https://en.wikipedia.org/wiki/Sodium_chloride","https://en.wikipedia.org/wiki/Eutectic"],"note":"Assumes near-eutectic brine ice (23.3% NaCl); eutectic melting -21.1 C, weaker brines melt higher. Density 1000-1150 kg/m3.","sub":0},"salt_water":{"s":"Sodium chloride solution (NaCl(aq))","m":-2,"b":100.5,"d":1025,"c":"medium","src":["https://en.wikipedia.org/wiki/Sodium_chloride","https://en.wikipedia.org/wiki/Eutectic"],"note":"Assumes seawater-like 3.5% NaCl. Melting spans -2 C (3.5%) to -21.1 C (23.3% eutectic); boiling 100.5-104 C at higher salinity; density 1020-1200 kg/m3.","sub":0},"sand":{"s":"Quartz sand (SiO2)","m":1713,"b":2950,"d":2650,"c":"high","src":["https://en.wikipedia.org/wiki/Silicon_dioxide","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Quartz grain density; dry loose bulk density is only ~1600 kg/m3. Melting 1713 C (beta-quartz), boiling ~2950 C.","sub":0},"sandstone":{"s":"Sandstone (cemented quartz grains, SiO2)","m":null,"b":null,"d":2300,"c":"medium","src":["https://en.wikipedia.org/wiki/Sandstone","https://www.britannica.com/science/sandstone"],"note":"No single melting point: quartz grains melt 1713 C, bulk sandstone fuses ~1400-1600 C. Density 2200-2400 kg/m3.","sub":0},"silver":{"s":"Silver (Ag)","m":961.78,"b":2162,"d":10490,"c":"high","src":["https://en.wikipedia.org/wiki/Silver","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440224"],"note":"","sub":0},"snow":{"s":"Snow (aggregated ice crystals, H2O)","m":0,"b":100,"d":100,"c":"high","src":["https://en.wikipedia.org/wiki/Snow","https://nsidc.org/learn/parts-cryosphere/snow"],"note":"Fresh dry snow 50-100 kg/m3, settles to 200-400; melting/boiling are those of ice at 1 atm.","sub":0},"soap":{"s":"Soap (sodium stearate, C17H35COONa)","m":288,"b":null,"d":900,"c":"medium","src":["https://en.wikipedia.org/wiki/Soap","https://www.britannica.com/topic/soap"],"note":"Pure sodium stearate melts ~288 C; commercial bars with water/glycerol soften at 40-100 C. Decomposes rather than boiling.","sub":0},"sodium":{"s":"Sodium (Na)","m":97.794,"b":882.94,"d":968,"c":"high","src":["https://en.wikipedia.org/wiki/Sodium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440235"],"note":"","sub":0},"sodium_acetate":{"s":"Sodium acetate (CH3COONa)","m":324,"b":null,"d":1528,"c":"high","src":["https://en.wikipedia.org/wiki/Sodium_acetate","https://pubchem.ncbi.nlm.nih.gov/compound/517045"],"note":"Anhydrous values; trihydrate melts at 58 C. Decomposes above ~400 C, so no boiling point.","sub":0},"sodium_gas":{"s":"Sodium vapour (Na(g))","m":97.794,"b":882.94,"d":1.026,"c":"high","src":["https://en.wikipedia.org/wiki/Sodium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440235"],"note":"Ideal-gas density at STP from M = 22.99 g/mol.","sub":0},"solid_mercury":{"s":"Solid mercury (Hg)","m":-38.83,"b":356.73,"d":14184,"c":"high","src":["https://en.wikipedia.org/wiki/Mercury_(element)","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7439976"],"note":"Solid Hg below -38.8 C; density 14.184 g/cm3 at -38.8 C.","sub":0},"sponge":{"s":"Sponge (natural cellulose/poriferan or synthetic foam)","m":null,"b":null,"d":30,"c":"low","src":["https://en.wikipedia.org/wiki/Sponge","https://www.britannica.com/topic/sponge-animal"],"note":"Dry porous bulk 20-40 kg/m3. Natural sponge is keratin/cellulose-like; PU foam softens ~200 C and decomposes, no melting point.","sub":0},"stained_glass":{"s":"Metal-oxide coloured soda-lime glass","m":1400,"b":null,"d":2500,"c":"medium","src":["https://en.wikipedia.org/wiki/Soda%E2%80%93lime_glass","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Same base glass with transition-metal oxide colorants (<2%); thermal properties essentially unchanged.","sub":0},"steel":{"s":"Steel (Fe-C alloy, 0.2-2.1% C)","m":1450,"b":null,"d":7850,"c":"medium","src":["https://en.wikipedia.org/wiki/Steel","https://www.engineeringtoolbox.com/density-solids-d_1265.html"],"note":"Typical carbon steel; solidus 1400-1500 C, liquidus 1450-1530 C. Density 7750-8050 kg/m3. No boiling point in practical use.","sub":0},"straw":{"s":"Straw (dried cereal stalks, cellulose)","m":null,"b":null,"d":150,"c":"medium","src":["https://en.wikipedia.org/wiki/Straw","https://www.britannica.com/topic/straw"],"note":"Loose straw 50-100 kg/m3, baled 100-200. Cellulose ignites ~250 C; no melting point.","sub":0},"sugar":{"s":"Sucrose (C12H22O11)","m":186,"b":null,"d":1587,"c":"high","src":["https://en.wikipedia.org/wiki/Sucrose","https://pubchem.ncbi.nlm.nih.gov/compound/5988"],"note":"Melts with decomposition at ~186 C (caramelises); no boiling point.","sub":0},"sugar_ice":{"s":"Frozen sucrose solution","m":-5,"b":100.5,"d":1080,"c":"low","src":["https://en.wikipedia.org/wiki/Sucrose","https://en.wikipedia.org/wiki/Freezing-point_depression"],"note":"Assumes ~35-40% sucrose; freezing point -2 to -8 C depending on concentration.","sub":0},"sugar_water":{"s":"Sucrose solution (C12H22O11(aq))","m":-2,"b":100.5,"d":1040,"c":"medium","src":["https://en.wikipedia.org/wiki/Sucrose","https://en.wikipedia.org/wiki/Freezing-point_depression"],"note":"Assumes ~20% sucrose. Freezing point -0.6 to -5 C depending on concentration; boiling up to ~105 C; density 1040-1080 kg/m3.","sub":0},"sulfur":{"s":"Sulfur (S8)","m":115.21,"b":444.6,"d":2070,"c":"high","src":["https://en.wikipedia.org/wiki/Sulfur","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7704349"],"note":"Rhombic alpha-sulfur; melts to a mobile yellow liquid at 115 C.","sub":0},"syrup":{"s":"Sugar syrup (~65 Brix sucrose solution)","m":-12,"b":106,"d":1330,"c":"medium","src":["https://en.wikipedia.org/wiki/Syrup","https://www.fao.org/3/ap815e/ap815e.pdf"],"note":"Freezing point ~-12 C and boiling ~105-107 C at 65 Brix; maple syrup 1320, corn syrup 1380 kg/m3. No true melting point.","sub":0},"tea":{"s":"Brewed tea (dilute aqueous extract)","m":0,"b":100,"d":1000,"c":"medium","src":["https://en.wikipedia.org/wiki/Tea","https://www.fao.org/3/ap815e/ap815e.pdf"],"note":"~99.7% water; values are essentially those of water at 1 atm.","sub":0},"tin":{"s":"Tin (Sn, white/beta)","m":231.93,"b":2602,"d":7280,"c":"high","src":["https://en.wikipedia.org/wiki/Tin","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440315"],"note":"White (beta) tin; grey tin has density 5750 kg/m3.","sub":0},"tungsten":{"s":"Tungsten (W)","m":3422,"b":5555,"d":19250,"c":"high","src":["https://en.wikipedia.org/wiki/Tungsten","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440337"],"note":"Highest melting point of all metals.","sub":0},"uranium":{"s":"Uranium (U, depleted)","m":1132.2,"b":4131,"d":19100,"c":"high","src":["https://en.wikipedia.org/wiki/Uranium","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440611"],"note":"Alpha-uranium at 20 C; density 19.1 g/cm3.","sub":0},"vinegar":{"s":"Vinegar (5% acetic acid, CH3COOH, in water)","m":-2,"b":100.5,"d":1010,"c":"high","src":["https://en.wikipedia.org/wiki/Vinegar","https://webbook.nist.gov/cgi/cbook.cgi?ID=C64197"],"note":"5% acetic acid: freezes ~-2 C (pure acid 16.6 C), boils 100.1-100.5 C; density 1006-1012 kg/m3.","sub":0},"water":{"s":"Water (H2O)","m":0,"b":100,"d":997,"c":"high","src":["https://en.wikipedia.org/wiki/Water","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7732185"],"note":"Values at 1 atm; density at 25 C (997 kg/m3), 999.97 at 4 C.","sub":0},"wax":{"s":"Paraffin wax (CnH2n+2, ~C20-C40)","m":58,"b":null,"d":900,"c":"high","src":["https://en.wikipedia.org/wiki/Paraffin_wax","https://www.britannica.com/technology/wax"],"note":"Paraffin melting range 46-68 C (58 C typical). Boils/decomposes 300-400 C, so no clean boiling point.","sub":0},"wet_sand":{"s":"Water-saturated quartz sand (SiO2 + H2O)","m":0,"b":100,"d":1900,"c":"low","src":["https://en.wikipedia.org/wiki/Sand","https://en.wikipedia.org/wiki/Water"],"note":"Bulk mixture, ~20-25% water by volume; melting/boiling are those of the pore water, not of the sand (silica melts 1713 C). Bulk density 1800-2000 kg/m3.","sub":0},"wood":{"s":"Wood (cellulose/hemicellulose/lignin)","m":null,"b":null,"d":650,"c":"high","src":["https://en.wikipedia.org/wiki/Wood","https://www.engineeringtoolbox.com/wood-density-d_40.html"],"note":"No melting: lignins soften 80-120 C, pyrolysis starts 200-300 C, ignition ~300 C. Oven-dry density 350-900 kg/m3 by species.","sub":0},"zinc":{"s":"Zinc (Zn)","m":419.53,"b":907,"d":7140,"c":"high","src":["https://en.wikipedia.org/wiki/Zinc","https://webbook.nist.gov/cgi/cbook.cgi?ID=C7440666"],"note":"","sub":0}};
LM.physics.generatedAt = "2026-11-20";

/* ===== 20-physics.js ===== */
/* Physics audit.
   Compares every base-game element that maps to a real substance against
   data/physics-reference.json, records every mismatch, and corrects only the
   ones whose reference confidence is trusted. Also fills in missing viscosity,
   density and conductivity for liquids and metals ("add viscosity and more").

   Temperature mapping used by the engine (verified in index.html):
     solid  + tempHigh  -> melts into stateHigh
     liquid + tempHigh  -> boils into stateHigh
     liquid + tempLow   -> freezes into stateLow
     gas    + tempLow   -> condenses into stateLow
*/

var LM_CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/* Viscosity in cP. Only used for liquids that have none in the base game. */
var LM_VISCOSITY = {
  water: 1, salt_water: 1.2, sugar_water: 3, dirty_water: 1.4, pool_water: 1,
  seltzer: 1, soda: 1.1, juice: 3, milk: 3, cream: 12, blood: 4, slush: 40,
  oil: 65, lamp_oil: 20, nut_oil: 60, methane: 0.2, liquid_methane: 0.2,
  mercury: 0.6, alcohol: 1.1, acid: 1.4, neutral_acid: 1.4, poison: 1.3,
  lava: 10000, magma: 10000, molten_glass: 100000, molten_steel: 6000,
  molten_iron: 6000, molten_copper: 4000, molten_gold: 4000, molten_silver: 3500,
  molten_aluminum: 2500, molten_lead: 3000, molten_tin: 2000, molten_zinc: 2500,
  molten_nickel: 6000, molten_tungsten: 8000, molten_rock: 100000,
  honey: 10000, syrup: 3000, glycerol: 1400, glycerin: 1400, tar: 100000,
  gasoline: 0.6, diesel: 3, kerosene: 1.6, acetone: 0.3, benzene: 0.6,
  ethanol: 1.1, antifreeze: 16, plasma: 1.5, vaccine: 1.2, infection: 1.2
};

/* Thermal conductivity, 0-1. Only fills elements that have none. */
var LM_CONDUCTIVITY = {
  iron: 0.5, steel: 0.45, stainless_steel: 0.2, copper: 0.95, silver: 1, gold: 0.9,
  aluminum: 0.8, tungsten: 0.6, nickel: 0.4, zinc: 0.3, tin: 0.3, lead: 0.2,
  mercury: 0.1, brass: 0.3, bronze: 0.25, graphite: 0.3, carbon: 0.2,
  silicon: 0.4, water: 0.02, ice: 0.05, glass: 0.02, diamond: 0.9
};

/* Vetted corrections: the game value is demonstrably wrong, the real value is
   unambiguous, and changing it cannot break an authored reaction chain. */
var LM_PHYSICS_TRUSTED = {
  helium: ["tempLow"],
  ice: ["tempHigh"],
  magnesium: ["density"]
};

LM.physics.fills = { viscosity: 0, density: 0, conduct: 0 };

/* Derived ids (molten_x, liquid_x, x_gas, x_ice) are produced by the engine's
   autogen from their parent. Auditing them fights the engine, so they are skipped;
   correcting the parent propagates automatically. */
var LM_DERIVED_ID = /^(molten_|liquid_|solid_)|(_gas|_ice)$/;

LM.physics.stateOf = function (el, id) {
  if (el && el.state) { return el.state; }
  if (/^liquid_|^molten_/.test(id)) { return "liquid"; }
  if (/_gas$/.test(id)) { return "gas"; }
  if (el && el.tempLow !== undefined && el.tempHigh === undefined) { return "gas"; }
  return undefined;
};

LM.physics.desired = function (el, ref, id) {
  // Returns the fields the reference says the element should have.
  var want = {};
  if (!el || !ref) { return want; }
  var state = LM.physics.stateOf(el, id);
  if (state === "solid" || state === undefined) {
    if (ref.m != null) { want.tempHigh = ref.m; }
  }
  else if (state === "liquid") {
    if (ref.b != null) { want.tempHigh = ref.b; }
    if (ref.m != null) { want.tempLow = ref.m; }
  }
  else if (state === "gas") {
    if (ref.b != null) { want.tempLow = ref.b; }
  }
  if (ref.d != null && (state === "solid" || state === "liquid")) {
    want.density = ref.d;
  }
  return want;
};

/* A value is safe if it does not contradict the element's own spawn temperature. */
function lmSafeTemperature(field, value, el) {
  var t = el.temp === undefined ? 20 : el.temp;
  if (field === "tempHigh" && value <= t + 1) { return false; }
  if (field === "tempLow" && value >= t - 1) { return false; }
  return true;
}

LM.physics.apply = function (els, ref, opts) {
  els = els || elements;
  ref = ref || LM.physics.reference;
  var cfg = LM.config.audit;
  var mode = (opts && opts.mode) || cfg.mode || "trusted";
  var minRank = LM_CONFIDENCE_RANK[cfg.minConfidence] || 2;
  var report = { mode: mode, corrected: [], mismatches: [], informational: [], skipped: [], missing: [], derived: [], fills: { viscosity: 0, density: 0, conduct: 0 } };

  for (var id in ref) {
    if (!Object.prototype.hasOwnProperty.call(ref, id)) { continue; }
    var r = ref[id];
    var el = els[id];
    if (!el) { report.missing.push(id); continue; }
    if (LM_DERIVED_ID.test(id)) { report.derived.push(id); continue; }
    var rank = LM_CONFIDENCE_RANK[r.c] || 1;
    var want = LM.physics.desired(el, r, id);

    for (var field in want) {
      var current = el[field];
      var target = want[field];
      var mismatch;
      if (field === "density") {
        if (typeof current !== "number" || current <= 0) {
          mismatch = true;
        } else {
          mismatch = Math.abs(current - target) / target > cfg.densityTolerance;
        }
      } else {
        mismatch = typeof current !== "number" || Math.abs(current - target) > cfg.temperatureTolerance;
      }
      if (!mismatch) { continue; }
      var entry = { id: id, field: field, from: current === undefined ? null : current, to: target, confidence: r.c, source: (r.src && r.src[0]) || "" };
      report.mismatches.push(entry);
      if (rank < minRank) {
        report.skipped.push(Object.assign({ reason: "low confidence" }, entry));
        continue;
      }
      if (mode === "report") {
        report.informational.push(Object.assign({ reason: "report only" }, entry));
        continue;
      }
      if (mode === "trusted") {
        var allow = LM_PHYSICS_TRUSTED[id];
        if (!allow || allow.indexOf(field) === -1) {
          report.informational.push(Object.assign({ reason: "not in trusted list" }, entry));
          continue;
        }
      }
      if (field !== "density" && !lmSafeTemperature(field, target, el)) {
        report.skipped.push(Object.assign({ reason: "contradicts spawn temperature" }, entry));
        continue;
      }
      el[field] = target;
      report.corrected.push(entry);
    }
  }

  /* Fill missing viscosity / density / conductivity across the whole game. */
  for (var name in els) {
    if (!Object.prototype.hasOwnProperty.call(els, name)) { continue; }
    var e = els[name];
    if (!e || typeof e !== "object") { continue; }
    if (e.state === "liquid") {
      if (e.viscosity === undefined) {
        e.viscosity = LM_VISCOSITY[name] !== undefined ? LM_VISCOSITY[name] : 10;
        report.fills.viscosity++;
      }
      if (e.density === undefined) {
        e.density = 1000;
        report.fills.density++;
      }
    }
    if (e.conduct === undefined && LM_CONDUCTIVITY[name] !== undefined) {
      e.conduct = LM_CONDUCTIVITY[name];
      report.fills.conduct++;
    }
  }

  LM.physics.audit = report;
  LM.stats.corrected = report.corrected.length;
  LM.physics.fills = report.fills;
  return report;
};

LM.physics.applyAll = function () {
  return LM.physics.apply(elements, LM.physics.reference, { mode: "all" });
};

LM.physics.summary = function () {
  var a = LM.physics.audit;
  return {
    mode: a.mode,
    corrected: a.corrected.length,
    mismatches: a.mismatches.length,
    informational: a.informational.length,
    skipped: a.skipped.length,
    missing: a.missing.length,
    fills: a.fills
  };
};

/* ===== 25-define.js ===== */
/* Element definition helper for the new material pack.

   Specs are registered at mod top level, which the engine finalizes on window
   load (index.html:20287). Nothing here touches the DOM. */

var LM_DEFAULT_BEHAVIOR = {
  solid: "WALL",
  liquid: "LIQUID",
  gas: "GAS"
};

LM.define = function (spec) {
  if (!spec || !spec.id) { LM.warn("define() called without an id"); return null; }
  var id = String(spec.id);
  if (!/^[a-z0-9_]+$/.test(id)) { LM.warn("bad element id: " + id); return null; }
  if (elements[id]) { return null; } // never overwrite the base game or another mod

  var out = {
    name: spec.name || id.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }),
    color: spec.color || "#cccccc",
    category: spec.category || "solids",
    state: spec.state || "solid",
    density: typeof spec.density === "number" ? spec.density : 1000,
    desc: spec.desc || ""
  };
  if (spec.temp !== undefined) { out.temp = spec.temp; }
  if (spec.tempHigh !== undefined) { out.tempHigh = spec.tempHigh; }
  if (spec.tempLow !== undefined) { out.tempLow = spec.tempLow; }
  if (spec.stateHigh !== undefined) { out.stateHigh = spec.stateHigh; }
  if (spec.stateLow !== undefined) { out.stateLow = spec.stateLow; }
  if (spec.hardness !== undefined) { out.hardness = spec.hardness; }
  if (spec.conduct !== undefined) { out.conduct = spec.conduct; }
  if (spec.burn !== undefined) { out.burn = spec.burn; }
  if (spec.burnTime !== undefined) { out.burnTime = spec.burnTime; }
  if (spec.burnInto !== undefined) { out.burnInto = spec.burnInto; }
  if (spec.breakInto !== undefined) { out.breakInto = spec.breakInto; }
  if (spec.viscosity !== undefined) { out.viscosity = spec.viscosity; }
  if (spec.alpha !== undefined) { out.alpha = spec.alpha; }
  if (spec.glow !== undefined) { out.glow = spec.glow; }
  if (spec.isFood !== undefined) { out.isFood = spec.isFood; }
  if (spec.insulate !== undefined) { out.insulate = spec.insulate; }
  if (spec.ignore !== undefined) { out.ignore = spec.ignore; }
  if (spec.hidden !== undefined) { out.hidden = spec.hidden; }
  if (spec.reactions !== undefined) { out.reactions = spec.reactions; }

  // Behaviour: powder flag wins, otherwise the state default.
  if (spec.behavior !== undefined) { out.behavior = spec.behavior; }
  else if (spec.powder) { out.behavior = behaviors.POWDER; }
  else { out.behavior = behaviors[LM_DEFAULT_BEHAVIOR[out.state]] || behaviors.WALL; }

  if (out.state === "liquid" && out.viscosity === undefined) {
    out.viscosity = spec.viscosityDefault !== undefined ? spec.viscosityDefault : 10;
  }

  elements[id] = out;
  LM.materials.registered.push(id);
  LM.stats.added = LM.materials.registered.length;
  return out;
};

LM.define.bulk = function (list) {
  for (var i = 0; i < list.length; i++) { LM.define(list[i]); }
};

/* ===== 30-fusion.js ===== */
/* Fusion core.
   Turns any compatible pair into a real element:
     - a curated real alloy if the pair is known (copper + tin -> bronze),
     - otherwise a deterministic generated mixture (mix_copper__nickel).
   Pure: specFor() decides everything. ensure() is the only side-effecting entry
   point and calls the engine's addElement() exactly once per pair. */

/* Real-world pairs. When the target id already exists in the game we reuse it. */
var LM_CURATED = {
  "copper|tin": {
    id: "bronze", name: "Bronze",
    spec: { color: "#cd7f32", state: "solid", density: 8800, tempHigh: 950, conduct: 0.25, hardness: 0.6, category: "solids" }
  },
  "copper|zinc": {
    id: "brass", name: "Brass",
    spec: { color: "#c9a227", state: "solid", density: 8500, tempHigh: 900, conduct: 0.3, hardness: 0.55, category: "solids" }
  },
  "copper|gold": {
    id: "rose_gold", name: "Rose Gold",
    spec: { color: "#e6a07a", state: "solid", density: 12500, tempHigh: 1000, conduct: 0.85, hardness: 0.4, category: "solids" }
  },
  "copper|nickel": {
    id: "monel", name: "Monel",
    spec: { color: "#b8b2a0", state: "solid", density: 8800, tempHigh: 1300, conduct: 0.35, hardness: 0.6, category: "solids" }
  },
  "copper|aluminum": {
    id: "duralumin", name: "Duralumin",
    spec: { color: "#c9c6bd", state: "solid", density: 2800, tempHigh: 600, conduct: 0.55, hardness: 0.5, category: "solids" }
  },
  "lead|tin": {
    id: "solder", name: "Solder",
    spec: { color: "#a9adb2", state: "solid", density: 9000, tempHigh: 183, conduct: 0.2, hardness: 0.15, category: "solids" }
  },
  "copper|silver": {
    id: "sterling_silver", name: "Sterling Silver",
    spec: { color: "#d8dde3", state: "solid", density: 10300, tempHigh: 893, conduct: 0.95, hardness: 0.4, category: "solids" }
  },
  "gold|silver": {
    id: "electrum", name: "Electrum",
    spec: { color: "#f2e3a1", state: "solid", density: 14000, tempHigh: 1000, conduct: 0.92, hardness: 0.3, category: "solids" }
  },
  "iron|charcoal": {
    id: "steel", name: "Steel",
    spec: { color: "#8d949c", state: "solid", density: 7850, tempHigh: 1450, conduct: 0.45, hardness: 0.8, category: "solids" }
  },
  "iron|carbon": {
    id: "steel", name: "Steel",
    spec: { color: "#8d949c", state: "solid", density: 7850, tempHigh: 1450, conduct: 0.45, hardness: 0.8, category: "solids" }
  },
  "iron|chromium": {
    id: "stainless_steel", name: "Stainless Steel",
    spec: { color: "#b0b6bb", state: "solid", density: 7800, tempHigh: 1450, conduct: 0.2, hardness: 0.8, category: "solids" }
  },
  "iron|nickel": {
    id: "invar", name: "Invar",
    spec: { color: "#9ea6ad", state: "solid", density: 8050, tempHigh: 1450, conduct: 0.2, hardness: 0.7, category: "solids" }
  },
  "mercury|gold": {
    id: "gold_amalgam", name: "Gold Amalgam",
    spec: { color: "#cbb46a", state: "solid", density: 15000, tempHigh: 200, conduct: 0.4, hardness: 0.3, category: "solids" }
  },
  "tungsten|carbon": {
    id: "tungsten_carbide", name: "Tungsten Carbide",
    spec: { color: "#5c6168", state: "solid", density: 15600, tempHigh: 2870, conduct: 0.3, hardness: 0.95, category: "solids" }
  },
  "tin|brass": {
    id: "gunmetal", name: "Gunmetal",
    spec: { color: "#7f858c", state: "solid", density: 8700, tempHigh: 1000, conduct: 0.25, hardness: 0.65, category: "solids" }
  }
};

/* Elements that must never be fused: effects, energy and corrosives whose
   interactions the base game already handles through heat and reactions. */
var LM_FUSION_DENY = {
  fire: 1, smoke: 1, steam: 1, ash: 1, ember: 1, spark: 1, plasma: 1,
  lightning: 1, radiation: 1, acid: 1, acid_gas: 1, neutral_acid: 1,
  magma: 1, lava: 1, explosion: 1, sandstorm: 1, tornado: 1, void: 1,
  unknown: 1, wall: 1, cloner: 1, floating_cloner: 1
};

var LM_RANK_STATE = { 1: "solid", 2: "solid", 3: "liquid", 4: "gas" };

/* state rank pair -> result rank (see design doc) */
var LM_RESULT_RANK = {
  1: { 1: 1, 2: 2, 3: 2, 4: 1 },
  2: { 1: 2, 2: 2, 3: 2, 4: 2 },
  3: { 1: 2, 2: 2, 3: 3, 4: 3 },
  4: { 1: 1, 2: 2, 3: 3, 4: 4 }
};

function lmCap(s) {
  if (!s) { return s; }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lmDisplayName(id) {
  var el = elements[id];
  if (el && el.name) { return lmCap(el.name); }
  return lmCap(String(id).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }));
}

/* A generated mixture records the base elements it is made of, so a mixture of
   mixtures is named after its components instead of its parents' labels. */
/* Autogen creates molten_/liquid_/_gas/_ice variants of our mixtures. Those
   phases are not new materials; they are the same mixture in another state, and
   letting them fuse grows ids and names without bound. */
LM.fusion.mixBaseOf = function (id) {
  var candidates = [];
  if (id.indexOf("molten_") === 0) { candidates.push(id.slice(7)); }
  if (id.indexOf("liquid_") === 0) { candidates.push(id.slice(7)); }
  if (id.indexOf("solid_") === 0) { candidates.push(id.slice(6)); }
  if (/_gas$/.test(id)) { candidates.push(id.slice(0, -4)); }
  if (/_ice$/.test(id)) { candidates.push(id.slice(0, -4)); }
  for (var i = 0; i < candidates.length; i++) {
    var el = elements[candidates[i]];
    if (el && el._lmParts) { return candidates[i]; }
  }
  return null;
};

function lmPartsOf(id) {
  var el = elements[id];
  if (el && el._lmParts && el._lmParts.length) { return el._lmParts.slice(); }
  var base = LM.fusion.mixBaseOf(id);
  if (base) { return elements[base]._lmParts.slice(); }
  return [id];
}

function lmUniqueSorted(list) {
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) {
    var v = list[i];
    if (!seen[v]) { seen[v] = 1; out.push(v); }
  }
  out.sort();
  return out;
}

function lmNum(v) { return typeof v === "number" && isFinite(v); }
function lmPos(v) { return lmNum(v) && v > 0; }

LM.fusion.depth = function (id) {
  var el = elements[id];
  return el && lmNum(el._lmDepth) ? el._lmDepth : 0;
};

LM.fusion.isFusable = function (id) {
  var el = elements[id];
  if (!el || typeof el !== "object") { return false; }
  if (el.tool || el.category === "tools") { return false; }
  if (el.noMix === true) { return false; }
  if (id === "unknown") { return false; }
  if (LM_FUSION_DENY[id]) { return false; }
  if (LM.fusion.mixBaseOf(id)) { return false; }
  if (el.category === "special") { return false; }
  if (el.state !== "solid" && el.state !== "liquid" && el.state !== "gas") { return false; }
  if (LM.fusion.depth(id) > LM.config.maxFusionDepth) { return false; }
  return true;
};

function lmCuratedFor(a, b) {
  var key1 = a + "|" + b;
  var key2 = b + "|" + a;
  var c = LM_CURATED[key1] || LM_CURATED[key2];
  if (!c) { return null; }
  if (elements[c.id]) { return { id: c.id, spec: null }; }
  return { id: c.id, spec: c.spec, name: c.name };
}

LM.fusion.specFor = function (a, b) {
  if (!a || !b || a === b) { return null; }
  if (!LM.fusion.isFusable(a) || !LM.fusion.isFusable(b)) { return null; }

  var cur = lmCuratedFor(a, b);
  if (cur) {
    return { id: cur.id, spec: cur.spec, existing: !!elements[cur.id], curated: true, depth: 0 };
  }

  var A = elements[a], B = elements[b];
  var depth = Math.max(LM.fusion.depth(a), LM.fusion.depth(b)) + 1;
  if (depth > LM.config.maxFusionDepth) { return null; }

  var rankA = LM.util.stateRank(A), rankB = LM.util.stateRank(B);
  var rank = LM_RESULT_RANK[rankA][rankB];
  var state = LM_RANK_STATE[rank];

  var colorA = LM.util.elementColor(A, a);
  var colorB = LM.util.elementColor(B, b);
  var blend = LM.util.blendColors([colorA, colorB], [1, 1]);
  var color = LM.util.rgbToHex(blend);

  var dA = lmPos(A.density) ? A.density : null;
  var dB = lmPos(B.density) ? B.density : null;
  var density;
  if (rankA === 4 && rankB !== 4) { density = dB != null ? dB : (dA != null ? dA : 1000); }
  else if (rankB === 4 && rankA !== 4) { density = dA != null ? dA : (dB != null ? dB : 1000); }
  else if (dA != null && dB != null) { density = (dA + dB) / 2; }
  else if (dA != null) { density = dA; }
  else if (dB != null) { density = dB; }
  else { density = state === "gas" ? 1.2 : 1000; }
  if (state === "gas" && !(density >= 0.05)) { density = 1.2; }
  if (state !== "gas" && !(density >= 1)) { density = 1000; }

  var tempsHigh = [A.tempHigh, B.tempHigh].filter(lmNum);
  var tempsLow = [A.tempLow, B.tempLow].filter(lmNum);
  var visc = [A.viscosity, B.viscosity].filter(lmPos);
  var hard = [A.hardness, B.hardness].filter(lmPos);
  var cond = [A.conduct, B.conduct].filter(lmPos);
  var burn = [A.burn, B.burn].filter(lmPos);

  var isMetal = (A.state === "solid" || A.state === undefined) && (B.state === "solid" || B.state === undefined) &&
    ((lmNum(A.conduct) && A.conduct >= 0.3) || (lmNum(B.conduct) && B.conduct >= 0.3));
  var suffix = isMetal ? "Alloy" : (state === "liquid" ? "Solution" : (state === "gas" ? "Gas Mix" : "Mixture"));

  /* Name and id come from the component set, never from a parent's label. */
  var parts = lmUniqueSorted(lmPartsOf(a).concat(lmPartsOf(b)));
  var id = parts.length === 2 ? LM.util.pairKey(parts[0], parts[1]) : LM.util.multiKey(parts);
  var partNames = [];
  for (var pi = 0; pi < parts.length; pi++) { partNames.push(lmDisplayName(parts[pi])); }
  var name = partNames.slice(0, 2).join("-");
  if (parts.length > 2) { name += " +" + (parts.length - 2); }
  name += " " + suffix;
  if (name.length > 44) {
    // Too long: keep one component and count the rest instead of truncating.
    name = partNames[0] + (parts.length > 1 ? " +" + (parts.length - 1) : "") + " " + suffix;
  }

  var LM_RANK_BEHAVIOR = { 1: "WALL", 2: "POWDER", 3: "LIQUID", 4: "GAS" };
  var spec = {
    name: name,
    color: color,
    behavior: behaviors[LM_RANK_BEHAVIOR[rank]],
    category: "mixtures",
    state: state,
    density: Math.round(density * 10) / 10,
    hidden: true,
    _lmDepth: depth,
    _lmParts: parts,
    _lmParents: [a, b],
    desc: (suffix === "Alloy" ? "An " : "A ") + suffix.toLowerCase() + " of " + partNames.slice(0, 4).join(", ") +
      (partNames.length > 4 ? " and " + (partNames.length - 4) + " more" : "") + "."
  };

  if (state === "liquid") {
    var viscAvg = 0;
    for (var vi = 0; vi < visc.length; vi++) { viscAvg += visc[vi]; }
    spec.viscosity = visc.length ? Math.max(1, Math.round(viscAvg / visc.length)) : 10;
    spec.tempHigh = tempsHigh.length ? Math.min.apply(null, tempsHigh) : undefined;
    spec.tempLow = tempsLow.length ? Math.max.apply(null, tempsLow) : undefined;
  } else if (state === "gas") {
    spec.tempLow = tempsLow.length ? Math.max.apply(null, tempsLow) : undefined;
  } else {
    // A solid has no low-temperature state: autogen only builds stateLow for
    // liquids and gases, so copying tempLow here would leave a dangling phase.
    spec.tempHigh = tempsHigh.length ? Math.min.apply(null, tempsHigh) : undefined;
  }
  if (hard.length) { spec.hardness = Math.min.apply(null, hard); }
  if (cond.length) { spec.conduct = Math.max.apply(null, cond); }
  if (burn.length) { spec.burn = Math.round((burn[0] + (burn[1] || burn[0])) / 2); }

  if (spec.tempHigh === undefined) { delete spec.tempHigh; }
  if (spec.tempLow === undefined) { delete spec.tempLow; }

  /* Spawn temperature must not sit on the wrong side of a phase change. */
  if (spec.tempHigh !== undefined && spec.tempHigh <= 25) {
    spec.temp = spec.tempHigh - 5;
  } else if (spec.tempLow !== undefined && spec.tempLow >= 15) {
    spec.temp = spec.tempLow + 5;
  }

  return { id: id, spec: spec, existing: !!elements[id], curated: false, depth: depth };
};

/* Side-effecting: create the element if needed, return its id (or null). */
LM.fusion.ensure = function (a, b) {
  var plan = LM.fusion.specFor(a, b);
  if (!plan) { return null; }
  if (elements[plan.id]) { return plan.id; }
  if (!plan.spec) { return null; }
  if (LM.stats.generated >= LM.config.maxGenerated) {
    if (!LM.fusion._capWarned) {
      LM.fusion._capWarned = true;
      LM.warn("generated element cap reached (" + LM.config.maxGenerated + "); further fusion is disabled");
      LM.log("Fusion cap reached. Reset with: LimitlessMod.stats.generated = 0");
    }
    return null;
  }
  if (typeof addElement === "function") {
    addElement(plan.id, plan.spec);
  } else {
    elements[plan.id] = plan.spec;
  }
  LM.stats.generated++;
  LM.fusion.remember(a, b);
  return plan.id;
};

/* How likely a contact between these two is to fuse. */
LM.fusion.chanceFor = function (a, b) {
  var A = elements[a], B = elements[b];
  if (!A || !B) { return 0; }
  var r1 = LM.util.stateRank(A), r2 = LM.util.stateRank(B);
  var c = LM.config.chances;
  if (r1 === 4 && r2 === 4) { return c.gasGas; }
  if (r1 === 4 || r2 === 4) { return r1 === 3 || r2 === 3 ? c.gasLiquid : c.gasGas; }
  if (r1 === 3 && r2 === 3) { return c.liquidLiquid; }
  if (r1 === 3 || r2 === 3) { return r1 === 2 || r2 === 2 ? c.liquidPowder : c.liquidPowder; }
  if (r1 === 2 && r2 === 2) { return c.powderPowder; }
  if (r1 === 2 || r2 === 2) { return c.solidPowder; }
  return c.solidSolid;
};

/* Metals only alloy when hot. */
LM.fusion.needsHeat = function (a, b) {
  var A = elements[a], B = elements[b];
  if (!A || !B) { return false; }
  if (A.state !== "solid" || B.state !== "solid") { return false; }
  var aMetal = lmNum(A.conduct) && A.conduct >= 0.3;
  var bMetal = lmNum(B.conduct) && B.conduct >= 0.3;
  return aMetal || bMetal;
};

LM.fusion.heatOk = function (a, b, temp) {
  if (!LM.fusion.needsHeat(a, b)) { return true; }
  var A = elements[a], B = elements[b];
  var melts = [A.tempHigh, B.tempHigh].filter(lmNum);
  var threshold = melts.length ? Math.min.apply(null, melts) * LM.config.solidHeatRatio : LM.config.solidColdFloor;
  if (threshold < LM.config.solidColdFloor) { threshold = LM.config.solidColdFloor; }
  return temp >= threshold;
};

/* ===== 35-persistence.js ===== */
/* Durability: remember every generated mixture so a saved canvas still resolves
   its elements after a reload. Without this, a save containing mix_gold__nickel
   would come back as "unknown" because the element only exists after that pair
   fuses again. */

LM.storage = {
  key: "limitless_mixes_v1",
  max: 2000,
  pairs: [],
  seen: {},
  dirty: false
};

LM.fusion.remember = function (a, b) {
  var k = a + "|" + b;
  if (LM.storage.seen[k]) { return; }
  LM.storage.seen[k] = 1;
  LM.storage.pairs.push(k);
  if (LM.storage.pairs.length > LM.storage.max) {
    var dropped = LM.storage.pairs.shift();
    delete LM.storage.seen[dropped];
  }
  LM.storage.dirty = true;
  LM.fusion.saveSoon();
};

LM.fusion.persist = function () {
  if (!LM.storage.dirty) { return; }
  LM.storage.dirty = false;
  try {
    if (typeof localStorage === "undefined") { return; }
    localStorage.setItem(LM.storage.key, JSON.stringify(LM.storage.pairs));
  } catch (e) { /* private mode or quota: durability is best effort */ }
};

LM.fusion.saveSoon = function () {
  if (LM.fusion._saveTimer) { return; }
  if (typeof setTimeout !== "function") { LM.fusion.persist(); return; }
  LM.fusion._saveTimer = setTimeout(function () {
    LM.fusion._saveTimer = null;
    LM.fusion.persist();
  }, 2000);
  // Do not hold the page open on unload.
  if (typeof LM.fusion._saveTimer === "object" && LM.fusion._saveTimer && typeof LM.fusion._saveTimer.unref === "function") {
    LM.fusion._saveTimer.unref();
  }
};

LM.fusion.restore = function () {
  var pairs = [];
  try {
    if (typeof localStorage === "undefined") { return 0; }
    pairs = JSON.parse(localStorage.getItem(LM.storage.key) || "[]");
  } catch (e) { return 0; }
  if (!pairs || !pairs.length) { return 0; }
  var made = 0;
  LM.storage.restoreLog = [];
  for (var i = 0; i < pairs.length; i++) {
    var parts = String(pairs[i]).split("|");
    if (parts.length !== 2) { continue; }
    var a = parts[0], b = parts[1];
    if (!elements[a] || !elements[b]) {
      LM.storage.restoreLog.push([a, b, "missing parent"]);
      continue;
    }
    LM.storage.seen[pairs[i]] = 1;
    LM.storage.pairs.push(pairs[i]);
    try {
      var id = LM.fusion.ensure(a, b);
      if (id) { made++; } else { LM.storage.restoreLog.push([a, b, "ensure returned null"]); }
    } catch (err) {
      LM.storage.restoreLog.push([a, b, "threw: " + (err && err.message)]);
    }
  }
  return made;
};

/* ===== 40-triggers.js ===== */
/* Triggers: when does a contact fuse?
   1. validateMoves() sees every attempted move into an occupied cell.
   2. A small random neighbour sample each tick covers pixels that never move
      (static solids, walls), so alloying still happens in a pile of metal.

   Authored vanilla reactions always win: if either element has a reaction for
   the other, we do nothing and let the engine's own chemistry run. */

function lmHasVanillaReaction(a, b) {
  var A = elements[a], B = elements[b];
  if (A && A.reactions && A.reactions[b]) { return true; }
  if (B && B.reactions && B.reactions[a]) { return true; }
  return false;
}

function lmPixelTemp(p) {
  return (p && typeof p.temp === "number" && isFinite(p.temp)) ? p.temp : 20;
}

LM.triggers.canFuse = function (a, b, temp) {
  if (!a || !b || a === b) { return false; }
  if (!LM.fusion.isFusable(a) || !LM.fusion.isFusable(b)) { return false; }
  if (lmHasVanillaReaction(a, b)) { return false; }
  if (!LM.fusion.heatOk(a, b, temp)) { return false; }
  return LM.fusion.specFor(a, b) !== null;
};

/* Returns false to veto the move when a fusion happened. */
LM.triggers.tryFuse = function (p1, p2, chanceScale) {
  if (!p1 || !p2 || p1.del || p2.del) { return; }
  var a = p1.element, b = p2.element;
  var temp = Math.max(lmPixelTemp(p1), lmPixelTemp(p2));
  if (!LM.triggers.canFuse(a, b, temp)) { return; }
  var chance = LM.fusion.chanceFor(a, b) * (chanceScale === undefined ? 1 : chanceScale);
  if (!(Math.random() < chance)) { return; }
  var id = LM.fusion.ensure(a, b);
  if (!id) { return; }
  changePixel(p1, id);
  changePixel(p2, id);
  LM.stats.fused++;
  return false;
};

LM.triggers.validateMove = function (pixel, nx, ny) {
  if (!LM.ready) { return; }
  var row = pixelMap[nx];
  if (!row) { return; }
  var other = row[ny];
  if (!other || other === pixel) { return; }
  return LM.triggers.tryFuse(pixel, other, 1);
};

var LM_TRIGGER_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

LM.triggers.sample = function () {
  if (!LM.ready) { return; }
  if (LM.pendingRestore) {
    LM.pendingRestore = false;
    var restored = LM.fusion.restore();
    if (restored) {
      LM.stats.restored = restored;
      LM.log("Restored " + restored + " saved mixture" + (restored === 1 ? "" : "s") + ".");
    }
  }
  var n = LM.config.staticSamplesPerTick;
  if (!n) { return; }
  var list = currentPixels;
  if (!list || !list.length) { return; }
  for (var i = 0; i < n; i++) {
    var p = list[(Math.random() * list.length) | 0];
    if (!p || p.del) { continue; }
    var dirs = LM_TRIGGER_DIRS;
    for (var d = 0; d < dirs.length; d++) {
      var row = pixelMap[p.x + dirs[d][0]];
      if (!row) { continue; }
      var q = row[p.y + dirs[d][1]];
      if (!q || q === p || q.del) { continue; }
      if (LM.triggers.tryFuse(p, q, 0.5) === false) { break; }
    }
  }
};

if (typeof validateMoves === "function") { validateMoves(LM.triggers.validateMove); }
if (typeof runEveryTick === "function") { runEveryTick(LM.triggers.sample); }

/* ===== 50-materials-metals.js ===== */
/* Metals and alloys not already in the base game.
   Temperatures are Celsius, densities kg/m3. Melting points are real values;
   alloy values are solidus (where melting starts). */

LM.define.bulk([
  { id: "indium", color: "#b9bcc4", state: "solid", category: "solids", density: 7310, tempHigh: 156.6, hardness: 0.1, conduct: 0.8, desc: "Soft, silvery, and used in touchscreens." },
  { id: "bismuth", color: "#d9c8d8", state: "solid", category: "solids", density: 9780, tempHigh: 271.5, hardness: 0.2, conduct: 0.15, breakInto: "bismuth", desc: "Forms rainbow staircase crystals." },
  { id: "antimony", color: "#9aa0a6", state: "solid", category: "solids", density: 6690, tempHigh: 630.6, hardness: 0.3, conduct: 0.25, desc: "A brittle metalloid used in flame retardants." },
  { id: "arsenic", color: "#8b8f94", state: "solid", category: "solids", density: 5727, tempHigh: 616, hardness: 0.25, conduct: 0.2, desc: "A toxic metalloid that sublimes when heated." },
  { id: "cadmium", color: "#c4c8c0", state: "solid", category: "solids", density: 8650, tempHigh: 321.1, hardness: 0.2, conduct: 0.5, desc: "A soft, toxic metal used in older batteries." },
  { id: "selenium", color: "#b04a3a", state: "solid", category: "solids", density: 4810, tempHigh: 221, hardness: 0.2, conduct: 0.05, desc: "A red-black metalloid, essential in traces." },
  { id: "tellurium", color: "#b6a58c", state: "solid", category: "solids", density: 6240, tempHigh: 449.5, hardness: 0.2, conduct: 0.15, desc: "A rare metalloid that smells of garlic." },
  { id: "germanium", color: "#a9adb3", state: "solid", category: "solids", density: 5323, tempHigh: 938.3, hardness: 0.45, conduct: 0.35, desc: "The semiconductor inside the first transistors." },
  { id: "zirconium", color: "#b3b7bb", state: "solid", category: "solids", density: 6511, tempHigh: 1855, hardness: 0.5, conduct: 0.25, desc: "Corrosion-proof metal for reactor cladding." },
  { id: "vanadium", color: "#a3a7ab", state: "solid", category: "solids", density: 6110, tempHigh: 1910, hardness: 0.55, conduct: 0.3, desc: "Toughens steel in tiny amounts." },
  { id: "molybdenum", color: "#9ba0a5", state: "solid", category: "solids", density: 10280, tempHigh: 2623, hardness: 0.6, conduct: 0.4, desc: "A high-temperature metal for furnace parts." },
  { id: "niobium", color: "#9fa4a8", state: "solid", category: "solids", density: 8570, tempHigh: 2477, hardness: 0.55, conduct: 0.3, desc: "Superconducting when cold." },
  { id: "tantalum", color: "#8f9499", state: "solid", category: "solids", density: 16650, tempHigh: 3017, hardness: 0.65, conduct: 0.25, desc: "Dense and immune to almost all acids." },
  { id: "hafnium", color: "#a0a5a9", state: "solid", category: "solids", density: 13310, tempHigh: 2233, hardness: 0.6, conduct: 0.2, desc: "Absorbs neutrons; used in control rods." },
  { id: "rhenium", color: "#9ca1a5", state: "solid", category: "solids", density: 21020, tempHigh: 3186, hardness: 0.7, conduct: 0.3, desc: "One of the rarest metals on Earth." },
  { id: "osmium", color: "#8d9297", state: "solid", category: "solids", density: 22590, tempHigh: 3033, hardness: 0.8, conduct: 0.4, desc: "The densest naturally occurring element." },
  { id: "iridium", color: "#b7bcc2", state: "solid", category: "solids", density: 22560, tempHigh: 2466, hardness: 0.8, conduct: 0.35, desc: "Rare, dense, and extremely corrosion resistant." },
  { id: "rhodium", color: "#cfd4da", state: "solid", category: "solids", density: 12450, tempHigh: 1964, hardness: 0.7, conduct: 0.8, desc: "The most expensive precious metal." },
  { id: "palladium", color: "#c3c7cc", state: "solid", category: "solids", density: 12023, tempHigh: 1555, hardness: 0.5, conduct: 0.7, desc: "Soaks up hydrogen like a sponge." },
  { id: "ruthenium", color: "#adb2b7", state: "solid", category: "solids", density: 12370, tempHigh: 2334, hardness: 0.7, conduct: 0.4, desc: "Hardens platinum alloys." },
  { id: "scandium", color: "#c2c6c9", state: "solid", category: "solids", density: 2985, tempHigh: 1541, hardness: 0.4, conduct: 0.4, desc: "Makes aluminium stronger and lighter." },
  { id: "yttrium", color: "#aeb3b6", state: "solid", category: "solids", density: 4472, tempHigh: 1526, hardness: 0.4, conduct: 0.3, desc: "Glows in old television phosphors." },
  { id: "beryllium", color: "#b9bdb9", state: "solid", category: "solids", density: 1850, tempHigh: 1287, hardness: 0.6, conduct: 0.5, desc: "Light, stiff, and toxic as dust." },
  { id: "strontium", color: "#c0bfae", state: "solid", category: "solids", density: 2640, tempHigh: 777, hardness: 0.3, conduct: 0.3, desc: "Burns bright red in fireworks." },
  { id: "barium", color: "#b9b6a6", state: "solid", category: "solids", density: 3510, tempHigh: 727, hardness: 0.3, conduct: 0.3, desc: "A dense alkaline earth metal." },
  { id: "rubidium", color: "#c3c0ae", state: "solid", category: "solids", density: 1532, temp: 25, tempHigh: 39.3, hardness: 0.05, conduct: 0.4, desc: "Melts just above room temperature; ignites in air." },
  { id: "caesium", color: "#d0c58a", state: "solid", category: "solids", density: 1930, temp: 25, tempHigh: 28.5, hardness: 0.05, conduct: 0.4, desc: "The most reactive metal; defines the second." },
  { id: "thorium", color: "#9aa0a0", state: "solid", category: "solids", density: 11724, tempHigh: 1750, hardness: 0.5, conduct: 0.25, glow: true, desc: "A weakly radioactive actinide." }
]);

LM.define.bulk([
  { id: "nitinol", color: "#b1b6bb", state: "solid", category: "solids", density: 6450, tempHigh: 1310, hardness: 0.6, conduct: 0.15, desc: "Remembers its shape when warmed." },
  { id: "alnico", color: "#8f959c", state: "solid", category: "solids", density: 7300, tempHigh: 1450, hardness: 0.7, conduct: 0.2, desc: "A strong permanent magnet alloy." },
  { id: "inconel", color: "#a6abb0", state: "solid", category: "solids", density: 8440, tempHigh: 1390, hardness: 0.75, conduct: 0.15, desc: "Survives jet-engine temperatures." },
  { id: "hastelloy", color: "#9aa0a6", state: "solid", category: "solids", density: 8890, tempHigh: 1320, hardness: 0.75, conduct: 0.12, desc: "Resists boiling acids." },
  { id: "pewter", color: "#b9bec4", state: "solid", category: "solids", density: 7700, tempHigh: 170, hardness: 0.25, conduct: 0.2, desc: "Mostly tin, easily cast." },
  { id: "zamak", color: "#c2c6ca", state: "solid", category: "solids", density: 6600, tempHigh: 385, hardness: 0.5, conduct: 0.25, desc: "Die-casting zinc alloy." },
  { id: "magnalium", color: "#cfd2d6", state: "solid", category: "solids", density: 2000, tempHigh: 460, hardness: 0.45, conduct: 0.4, desc: "Light magnesium-aluminium alloy." },
  { id: "silumin", color: "#c8ccd1", state: "solid", category: "solids", density: 2650, tempHigh: 577, hardness: 0.5, conduct: 0.4, desc: "Castable aluminium-silicon alloy." },
  { id: "babbitt", color: "#b4b9bf", state: "solid", category: "solids", density: 7300, tempHigh: 240, hardness: 0.2, conduct: 0.2, desc: "Low-friction bearing metal." },
  { id: "cupronickel", color: "#c3b6a4", state: "solid", category: "solids", density: 8900, tempHigh: 1170, hardness: 0.55, conduct: 0.2, desc: "The metal inside coins." },
  { id: "constantan", color: "#b8ab98", state: "solid", category: "solids", density: 8900, tempHigh: 1220, hardness: 0.55, conduct: 0.15, desc: "Resistance stays flat when heated." },
  { id: "nichrome", color: "#9fa4a9", state: "solid", category: "solids", density: 8400, tempHigh: 1400, hardness: 0.6, conduct: 0.1, desc: "Glows orange in toasters." },
  { id: "permalloy", color: "#a9aeb3", state: "solid", category: "solids", density: 8700, tempHigh: 1450, hardness: 0.55, conduct: 0.2, desc: "Shields magnetic fields." },
  { id: "stellite", color: "#9aa0a5", state: "solid", category: "solids", density: 8600, tempHigh: 1290, hardness: 0.85, conduct: 0.1, desc: "Wear-resistant cobalt alloy." },
  { id: "galinstan", color: "#c7cbd0", state: "liquid", category: "liquids", density: 6440, tempLow: -19, tempHigh: 1300, viscosity: 2, conduct: 0.4, desc: "A non-toxic liquid metal." },
  { id: "woods_metal", color: "#aab0b6", state: "solid", category: "solids", density: 9400, tempHigh: 70, hardness: 0.15, conduct: 0.2, desc: "Melts in hot water." },
  { id: "field_metal", color: "#b7bcc2", state: "solid", category: "solids", density: 9150, tempHigh: 62, hardness: 0.15, conduct: 0.2, desc: "A bismuth alloy that melts at 62 C." },
  { id: "bismuth_crystal", color: "#e2c4e6", state: "solid", category: "solids", density: 9800, tempHigh: 271, hardness: 0.25, conduct: 0.1, breakInto: "bismuth_crystal", desc: "An iridescent hopper crystal." }
]);

/* Rare earths: chemically similar, magnetically interesting, mostly grey. */
LM.define.bulk([
  { id: "lanthanum", color: "#c9ccd0", state: "solid", category: "solids", density: 6146, tempHigh: 920, hardness: 0.35, conduct: 0.12, desc: "Soft rare earth used in camera lenses." },
  { id: "cerium", color: "#c4c7ca", state: "solid", category: "solids", density: 6689, tempHigh: 795, hardness: 0.35, conduct: 0.12, desc: "The most abundant rare earth; sparks when struck." },
  { id: "praseodymium", color: "#c7cac3", state: "solid", category: "solids", density: 6773, tempHigh: 935, hardness: 0.35, conduct: 0.12, desc: "Colours glass green." },
  { id: "neodymium", color: "#c2c5c9", state: "solid", category: "solids", density: 7010, tempHigh: 1024, hardness: 0.4, conduct: 0.12, desc: "Makes the strongest permanent magnets." },
  { id: "promethium", color: "#c9ccc0", state: "solid", category: "solids", density: 7264, tempHigh: 1042, hardness: 0.35, conduct: 0.1, glow: true, desc: "Radioactive rare earth that glows faintly." },
  { id: "samarium", color: "#c5c8cb", state: "solid", category: "solids", density: 7353, tempHigh: 1072, hardness: 0.4, conduct: 0.12, desc: "Samarium-cobalt magnets work when hot." },
  { id: "europium", color: "#c8cbcf", state: "solid", category: "solids", density: 5244, tempHigh: 822, hardness: 0.3, conduct: 0.12, desc: "Burns bright red under UV." },
  { id: "gadolinium", color: "#c3c6ca", state: "solid", category: "solids", density: 7901, tempHigh: 1312, hardness: 0.4, conduct: 0.12, desc: "Magnetic near room temperature." },
  { id: "terbium", color: "#c6c9cd", state: "solid", category: "solids", density: 8230, tempHigh: 1356, hardness: 0.4, conduct: 0.12, desc: "Green phosphor in old displays." },
  { id: "dysprosium", color: "#c1c4c8", state: "solid", category: "solids", density: 8551, tempHigh: 1407, hardness: 0.4, conduct: 0.12, desc: "Keeps magnets working in heat." },
  { id: "holmium", color: "#c8cbc8", state: "solid", category: "solids", density: 8795, tempHigh: 1461, hardness: 0.4, conduct: 0.12, desc: "Has the strongest magnetic moment of any element." },
  { id: "erbium", color: "#cbd0d0", state: "solid", category: "solids", density: 9066, tempHigh: 1529, hardness: 0.4, conduct: 0.12, desc: "Pink colour in glass and fibre optics." },
  { id: "thulium", color: "#c7cac6", state: "solid", category: "solids", density: 9321, tempHigh: 1545, hardness: 0.4, conduct: 0.12, desc: "The rarest stable rare earth." },
  { id: "ytterbium", color: "#c9ccc6", state: "solid", category: "solids", density: 6900, tempHigh: 819, hardness: 0.3, conduct: 0.12, desc: "Used in ultra-precise atomic clocks." },
  { id: "lutetium", color: "#c4c7cb", state: "solid", category: "solids", density: 9841, tempHigh: 1652, hardness: 0.45, conduct: 0.12, desc: "The densest and hardest rare earth." }
]);

/* ===== 51-materials-minerals.js ===== */
/* Minerals, rocks and ores. Melting values are real where a clean melting point
   exists; otherwise they are the decomposition or softening temperature and the
   description says so. */

LM.define.bulk([
  { id: "quartz", color: "#e8e4de", state: "solid", category: "land", density: 2650, tempHigh: 1713, hardness: 0.7, conduct: 0.02, breakInto: "quartz", desc: "Pure crystalline silicon dioxide." },
  { id: "feldspar", color: "#d9cfc0", state: "solid", category: "land", density: 2560, tempHigh: 1200, hardness: 0.6, conduct: 0.02, breakInto: "feldspar", desc: "The most common mineral in the crust." },
  { id: "mica", color: "#c9c3a5", state: "solid", category: "land", density: 2800, tempHigh: 1000, hardness: 0.3, conduct: 0.02, breakInto: "mica", desc: "Peels into transparent sheets." },
  { id: "calcite", color: "#efeae0", state: "solid", category: "land", density: 2710, tempHigh: 825, hardness: 0.3, conduct: 0.02, breakInto: "calcite", desc: "Fizzes in acid; decomposes at 825 C." },
  { id: "dolomite", color: "#ded6c8", state: "solid", category: "land", density: 2840, tempHigh: 800, hardness: 0.35, conduct: 0.02, breakInto: "dolomite", desc: "Calcium magnesium carbonate." },
  { id: "gypsum", color: "#e9e3d6", state: "solid", category: "land", density: 2320, tempHigh: 150, hardness: 0.2, conduct: 0.02, breakInto: "gypsum", desc: "Loses its water at 150 C to become plaster." },
  { id: "fluorite", color: "#9ee6c8", state: "solid", category: "land", density: 3180, tempHigh: 1418, hardness: 0.4, conduct: 0.02, breakInto: "fluorite", glow: true, desc: "Fluorescent under UV." },
  { id: "hematite", color: "#7a3b32", state: "solid", category: "land", density: 5250, tempHigh: 1538, hardness: 0.6, conduct: 0.1, breakInto: "hematite", desc: "The main ore of iron." },
  { id: "magnetite", color: "#3d3d44", state: "solid", category: "land", density: 5170, tempHigh: 1597, hardness: 0.65, conduct: 0.15, breakInto: "magnetite", desc: "A naturally magnetic iron ore." },
  { id: "galena", color: "#8b8f96", state: "solid", category: "land", density: 7600, tempHigh: 1113, hardness: 0.25, conduct: 0.1, breakInto: "galena", desc: "The main ore of lead." },
  { id: "sphalerite", color: "#8a6b3a", state: "solid", category: "land", density: 4090, tempHigh: 1700, hardness: 0.4, conduct: 0.05, breakInto: "sphalerite", desc: "The main ore of zinc." },
  { id: "bauxite", color: "#b8683f", state: "solid", category: "land", density: 2500, tempHigh: 2050, hardness: 0.3, conduct: 0.02, breakInto: "bauxite", desc: "Aluminium ore, refined into alumina." },
  { id: "cassiterite", color: "#5b4a3c", state: "solid", category: "land", density: 6950, tempHigh: 1630, hardness: 0.6, conduct: 0.05, breakInto: "cassiterite", desc: "The main ore of tin." },
  { id: "wolframite", color: "#4a4440", state: "solid", category: "land", density: 7300, tempHigh: 1700, hardness: 0.55, conduct: 0.05, breakInto: "wolframite", desc: "Tungsten ore." },
  { id: "chromite", color: "#3f3a38", state: "solid", category: "land", density: 4790, tempHigh: 2180, hardness: 0.6, conduct: 0.05, breakInto: "chromite", desc: "Chromium ore." },
  { id: "ilmenite", color: "#4b4642", state: "solid", category: "land", density: 4790, tempHigh: 1470, hardness: 0.55, conduct: 0.05, breakInto: "ilmenite", desc: "Titanium ore." },
  { id: "rutile", color: "#a4543a", state: "solid", category: "land", density: 4230, tempHigh: 1843, hardness: 0.6, conduct: 0.02, breakInto: "rutile", desc: "Pure titanium dioxide." },
  { id: "apatite", color: "#b6c9a8", state: "solid", category: "land", density: 3190, tempHigh: 1670, hardness: 0.5, conduct: 0.02, breakInto: "apatite", desc: "The mineral in bones and teeth." },
  { id: "graphite", color: "#3b3b40", state: "solid", category: "land", density: 2260, tempHigh: 3600, hardness: 0.1, conduct: 0.3, breakInto: "graphite", desc: "Soft carbon layers, a conductor." },
  { id: "obsidian", color: "#1d1b24", state: "solid", category: "land", density: 2400, tempHigh: 1200, hardness: 0.55, conduct: 0.02, breakInto: "obsidian", desc: "Volcanic glass, sharp as a blade." },
  { id: "pumice", color: "#cfc9bd", state: "solid", category: "land", density: 900, tempHigh: 1100, hardness: 0.3, conduct: 0.02, breakInto: "pumice", desc: "Frothy volcanic rock that floats." },
  { id: "shale", color: "#5c5b57", state: "solid", category: "land", density: 2400, tempHigh: 900, hardness: 0.3, conduct: 0.05, breakInto: "shale", desc: "Layered mudstone that splits." },
  { id: "slate", color: "#4d5057", state: "solid", category: "land", density: 2750, tempHigh: 1000, hardness: 0.45, conduct: 0.05, breakInto: "slate", desc: "Metamorphosed shale for roofing." },
  { id: "marble", color: "#e6e2da", state: "solid", category: "land", density: 2700, tempHigh: 1339, hardness: 0.4, conduct: 0.02, breakInto: "marble", desc: "Metamorphosed limestone." },
  { id: "granite", color: "#a8988c", state: "solid", category: "land", density: 2700, tempHigh: 1215, hardness: 0.6, conduct: 0.05, breakInto: "granite", desc: "Speckled igneous rock." },
  { id: "sandstone", color: "#c9a56f", state: "solid", category: "land", density: 2300, tempHigh: 1500, hardness: 0.45, conduct: 0.05, breakInto: "sandstone", desc: "Cemented sand grains." },
  { id: "chert", color: "#8d8577", state: "solid", category: "land", density: 2600, tempHigh: 1670, hardness: 0.65, conduct: 0.02, breakInto: "chert", desc: "Microcrystalline quartz." },
  { id: "chalk", color: "#f2efe6", state: "solid", category: "land", density: 2000, tempHigh: 1339, hardness: 0.15, conduct: 0.02, breakInto: "chalk", desc: "Soft limestone from shells." },
  { id: "kaolinite", color: "#e3ddd0", state: "solid", category: "land", density: 2600, tempHigh: 1750, hardness: 0.15, conduct: 0.02, breakInto: "kaolinite", powder: true, desc: "Clay mineral used for porcelain." },
  { id: "saltpeter", color: "#eeeae0", state: "solid", category: "powders", density: 2110, tempHigh: 334, hardness: 0.15, conduct: 0.02, breakInto: "saltpeter", powder: true, desc: "Potassium nitrate, an oxidiser." },
  { id: "sylvite", color: "#e5e0d4", state: "solid", category: "land", density: 1990, tempHigh: 770, hardness: 0.15, conduct: 0.02, breakInto: "sylvite", desc: "Potassium chloride ore." },
  { id: "olivine", color: "#7f9a5c", state: "solid", category: "land", density: 3270, tempHigh: 1700, hardness: 0.6, conduct: 0.05, breakInto: "olivine", desc: "Green mantle mineral." },
  { id: "talc", color: "#dfe6d8", state: "solid", category: "land", density: 2750, tempHigh: 1500, hardness: 0.05, conduct: 0.02, breakInto: "talc", powder: true, desc: "The softest mineral." }
]);

/* Gemstones and ore minerals. */
LM.define.bulk([
  { id: "sodalite", color: "#4a6fc9", state: "solid", category: "land", density: 2300, tempHigh: 1100, hardness: 0.55, conduct: 0.02, breakInto: "sodalite", desc: "Blue feldspathoid mineral." },
  { id: "labradorite", color: "#5c7a8c", state: "solid", category: "land", density: 2700, tempHigh: 1200, hardness: 0.6, conduct: 0.02, breakInto: "labradorite", desc: "Flashes blue and gold when turned." },
  { id: "rhodonite", color: "#d4707f", state: "solid", category: "land", density: 3600, tempHigh: 1290, hardness: 0.55, conduct: 0.02, breakInto: "rhodonite", desc: "Pink manganese silicate." },
  { id: "azurite", color: "#2a5fc9", state: "solid", category: "land", density: 3770, tempHigh: 200, hardness: 0.35, conduct: 0.02, breakInto: "azurite", desc: "Deep blue copper carbonate; decomposes when heated." },
  { id: "cinnabar", color: "#a32a2a", state: "solid", category: "land", density: 8100, tempHigh: 580, hardness: 0.25, conduct: 0.02, breakInto: "cinnabar", desc: "Mercury sulfide, bright vermilion." },
  { id: "realgar", color: "#d4552a", state: "solid", category: "land", density: 3560, tempHigh: 320, hardness: 0.2, conduct: 0.02, breakInto: "realgar", desc: "Orange arsenic sulfide." },
  { id: "orpiment", color: "#e0c23a", state: "solid", category: "land", density: 3490, tempHigh: 310, hardness: 0.2, conduct: 0.02, breakInto: "orpiment", desc: "Golden arsenic sulfide." },
  { id: "spodumene", color: "#c8c2b0", state: "solid", category: "land", density: 3200, tempHigh: 1420, hardness: 0.6, conduct: 0.02, breakInto: "spodumene", desc: "The main lithium ore." },
  { id: "lepidolite", color: "#c07a9a", state: "solid", category: "land", density: 2800, tempHigh: 1100, hardness: 0.3, conduct: 0.02, breakInto: "lepidolite", desc: "Purple lithium mica." },
  { id: "tourmaline", color: "#3a4a44", state: "solid", category: "land", density: 3100, tempHigh: 1300, hardness: 0.65, conduct: 0.02, breakInto: "tourmaline", desc: "Becomes electric when heated." },
  { id: "topaz", color: "#e8c98a", state: "solid", category: "land", density: 3500, tempHigh: 1400, hardness: 0.8, conduct: 0.02, breakInto: "topaz", desc: "Hard aluminium fluorosilicate gem." },
  { id: "zircon", color: "#d8c8a8", state: "solid", category: "land", density: 4650, tempHigh: 2550, hardness: 0.75, conduct: 0.02, breakInto: "zircon", desc: "Zirconium silicate gem." },
  { id: "kyanite", color: "#4a6a9a", state: "solid", category: "land", density: 3600, tempHigh: 1400, hardness: 0.6, conduct: 0.02, breakInto: "kyanite", desc: "Blue aluminium silicate." },
  { id: "andalusite", color: "#b08a6a", state: "solid", category: "land", density: 3100, tempHigh: 1380, hardness: 0.65, conduct: 0.02, breakInto: "andalusite", desc: "Heat-resistant refractory mineral." }
]);

/* ===== 52-materials-liquids.js ===== */
/* Liquids. tempLow is the freezing point, tempHigh the boiling point, viscosity cP. */

LM.define.bulk([
  { id: "gasoline", color: "#e0c46a", category: "liquids", state: "liquid", density: 750, tempLow: -60, tempHigh: 125, viscosity: 0.6, burn: 90, burnTime: 30, burnInto: "fire", desc: "Light, volatile fuel." },
  { id: "diesel", color: "#c9a85c", category: "liquids", state: "liquid", density: 830, tempLow: -20, tempHigh: 300, viscosity: 3, burn: 40, burnTime: 120, burnInto: "fire", desc: "Heavy fuel oil for engines." },
  { id: "kerosene", color: "#dcc37a", category: "liquids", state: "liquid", density: 810, tempLow: -48, tempHigh: 250, viscosity: 1.6, burn: 60, burnTime: 80, burnInto: "fire", desc: "Lamp and jet fuel." },
  { id: "tar", color: "#26211d", category: "liquids", state: "liquid", density: 1150, temp: 60, tempLow: 30, tempHigh: 400, viscosity: 100000, burn: 15, burnTime: 400, desc: "Thick black residue of distillation." },
  { id: "glycerin", color: "#e8e4c9", category: "liquids", state: "liquid", density: 1260, temp: 20, tempLow: 17.8, tempHigh: 290, viscosity: 1400, desc: "Sweet, syrupy alcohol." },
  { id: "acetone", color: "#dfe8e8", category: "liquids", state: "liquid", density: 784, tempLow: -95, tempHigh: 56, viscosity: 0.32, burn: 70, burnTime: 20, desc: "A fast-evaporating solvent." },
  { id: "benzene", color: "#ded6bf", category: "liquids", state: "liquid", density: 876, tempLow: 5.5, tempHigh: 80.1, viscosity: 0.6, burn: 80, burnTime: 40, desc: "Aromatic hydrocarbon ring." },
  { id: "toluene", color: "#ddd4bb", category: "liquids", state: "liquid", density: 867, tempLow: -95, tempHigh: 110.6, viscosity: 0.59, burn: 80, burnTime: 45, desc: "A benzene with one methyl group." },
  { id: "xylene", color: "#d9d0b6", category: "liquids", state: "liquid", density: 864, tempLow: -47.4, tempHigh: 138.4, viscosity: 0.8, burn: 70, burnTime: 50, desc: "Dimethylbenzene solvent." },
  { id: "hydrogen_peroxide", color: "#d7eef7", category: "liquids", state: "liquid", density: 1450, tempLow: -0.4, tempHigh: 150.2, viscosity: 1.2, desc: "A powerful oxidiser that fizzes on cuts." },
  { id: "nitric_acid", color: "#e6dfa8", category: "liquids", state: "liquid", density: 1510, tempLow: -42, tempHigh: 83, viscosity: 0.9, burn: 0, desc: "Dissolves most metals." },
  { id: "sulfuric_acid", color: "#e4e6c9", category: "liquids", state: "liquid", density: 1830, tempLow: 10.3, tempHigh: 337, viscosity: 26, desc: "The workhorse industrial acid." },
  { id: "hydrochloric_acid", color: "#dfe9d5", category: "liquids", state: "liquid", density: 1180, tempLow: -27, tempHigh: 110, viscosity: 1.9, desc: "Stomach acid, in a bottle." },
  { id: "phosphoric_acid", color: "#e8e6d3", category: "liquids", state: "liquid", density: 1880, temp: 45, tempLow: 42.35, tempHigh: 158, viscosity: 150, desc: "The acid in cola." },
  { id: "potassium_lye", color: "#e7eee4", category: "liquids", state: "liquid", density: 1240, tempLow: -20, tempHigh: 1327, viscosity: 15, desc: "Potassium hydroxide solution." },
  { id: "brine", color: "#9fc6d8", category: "liquids", state: "liquid", density: 1150, tempLow: -18, tempHigh: 103, viscosity: 1.2, desc: "Saturated salt water." },
  { id: "syrup", color: "#c98a2e", category: "liquids", state: "liquid", density: 1330, tempLow: -10, tempHigh: 105, viscosity: 3000, isFood: true, desc: "Sugar dissolved in water." },
  { id: "latex", color: "#eeeade", category: "liquids", state: "liquid", density: 980, tempLow: -5, tempHigh: 100, viscosity: 200, desc: "Rubber tree sap." },
  { id: "linseed_oil", color: "#c9a54a", category: "liquids", state: "liquid", density: 930, tempLow: -20, tempHigh: 316, viscosity: 50, burn: 25, burnTime: 200, desc: "Drying oil for wood." },
  { id: "turpentine", color: "#d8d2b0", category: "liquids", state: "liquid", density: 870, tempLow: -55, tempHigh: 154, viscosity: 1.5, burn: 70, burnTime: 30, desc: "Pine resin solvent." },
  { id: "chloroform", color: "#dfe8e8", category: "liquids", state: "liquid", density: 1490, tempLow: -63.5, tempHigh: 61.2, viscosity: 0.6, desc: "A dense, sweet-smelling solvent." },
  { id: "ether", color: "#e6e9e0", category: "liquids", state: "liquid", density: 713, tempLow: -116, tempHigh: 34.6, viscosity: 0.23, burn: 90, burnTime: 15, desc: "Extremely volatile and flammable." },
  { id: "methanol", color: "#e2ecec", category: "liquids", state: "liquid", density: 792, tempLow: -97.6, tempHigh: 64.7, viscosity: 0.6, burn: 80, burnTime: 25, desc: "Wood alcohol; toxic." },
  { id: "propanol", color: "#e4ece8", category: "liquids", state: "liquid", density: 803, tempLow: -126, tempHigh: 97, viscosity: 2, burn: 70, burnTime: 30, desc: "Rubbing alcohol, three carbons." },
  { id: "butanol", color: "#e6ebe4", category: "liquids", state: "liquid", density: 810, tempLow: -90, tempHigh: 117.7, viscosity: 3, burn: 60, burnTime: 40, desc: "A four-carbon alcohol." },
  { id: "pentane", color: "#e6ece6", category: "liquids", state: "liquid", density: 626, tempLow: -130, tempHigh: 36.1, viscosity: 0.24, burn: 95, burnTime: 12, desc: "A very light alkane." },
  { id: "hexane", color: "#e4eae0", category: "liquids", state: "liquid", density: 659, tempLow: -95, tempHigh: 68.7, viscosity: 0.3, burn: 90, burnTime: 20, desc: "Non-polar extraction solvent." },
  { id: "heptane", color: "#e2e8dc", category: "liquids", state: "liquid", density: 684, tempLow: -90, tempHigh: 98.4, viscosity: 0.4, burn: 85, burnTime: 25, desc: "The zero point of the octane scale." },
  { id: "octane", color: "#e0e6d8", category: "liquids", state: "liquid", density: 703, tempLow: -57, tempHigh: 125.6, viscosity: 0.5, burn: 80, burnTime: 30, desc: "The reference fuel for petrol ratings." },
  { id: "cyclohexane", color: "#e3e9dd", category: "liquids", state: "liquid", density: 779, tempLow: 6.5, tempHigh: 80.7, viscosity: 1, burn: 80, burnTime: 25, desc: "A ring of six carbons." },
  { id: "carbon_tetrachloride", color: "#e8eaea", category: "liquids", state: "liquid", density: 1590, tempLow: -22.9, tempHigh: 76.7, viscosity: 0.9, desc: "A dense, non-flammable solvent." }
]);

/* Solvents and acids. */
LM.define.bulk([
  { id: "aniline", color: "#d8c8a8", category: "liquids", state: "liquid", density: 1020, tempLow: -6, tempHigh: 184, viscosity: 3.7, burn: 30, burnTime: 60, desc: "Oily amine used to make dyes." },
  { id: "nitrobenzene", color: "#e0d0a0", category: "liquids", state: "liquid", density: 1200, tempLow: 5.7, tempHigh: 210, viscosity: 2, burn: 30, burnTime: 80, desc: "Smells of almonds, and toxic." },
  { id: "phenol", color: "#e8ded0", category: "liquids", state: "liquid", density: 1070, temp: 45, tempLow: 40.5, tempHigh: 181, viscosity: 3, burn: 20, burnTime: 70, desc: "Carbolic acid, a crystalline liquid." },
  { id: "acetic_acid", color: "#e9e9d9", category: "liquids", state: "liquid", density: 1049, tempLow: 16.6, tempHigh: 118, viscosity: 1.2, desc: "The acid of vinegar, concentrated." },
  { id: "formic_acid", color: "#e6e9d6", category: "liquids", state: "liquid", density: 1220, tempLow: 8.4, tempHigh: 100.8, viscosity: 1.6, desc: "The acid of ant stings." },
  { id: "lactic_acid", color: "#e8e6cf", category: "liquids", state: "liquid", density: 1206, tempLow: 16.8, tempHigh: 122, viscosity: 25, isFood: true, desc: "The acid that makes yoghurt sour." },
  { id: "ethylene_glycol", color: "#e5ece5", category: "liquids", state: "liquid", density: 1113, tempLow: -12.9, tempHigh: 197, viscosity: 16, desc: "Antifreeze, sweet and poisonous." },
  { id: "propylene_glycol", color: "#e7eee6", category: "liquids", state: "liquid", density: 1036, tempLow: -59, tempHigh: 188, viscosity: 42, isFood: true, desc: "The safe cousin of antifreeze." },
  { id: "dimethyl_sulfoxide", color: "#e4e8e0", category: "liquids", state: "liquid", density: 1100, tempLow: 18.5, tempHigh: 189, viscosity: 2, desc: "Soaks through skin and carries solutes." },
  { id: "pyridine", color: "#e0dcc4", category: "liquids", state: "liquid", density: 982, tempLow: -42, tempHigh: 115, viscosity: 0.9, burn: 60, burnTime: 40, desc: "Foul-smelling nitrogen ring." },
  { id: "styrene", color: "#e2dcc0", category: "liquids", state: "liquid", density: 909, tempLow: -30, tempHigh: 145, viscosity: 0.8, burn: 60, burnTime: 45, desc: "The monomer of polystyrene." }
]);

/* ===== 53-materials-gases.js ===== */
/* Gases. tempLow is the condensation point, density is kg/m3 at STP. */

LM.define.bulk([
  { id: "hydrogen_sulfide", color: "#d8dca8", category: "gases", state: "gas", density: 1.54, tempLow: -60, desc: "Rotten-egg gas." },
  { id: "sulfur_dioxide", color: "#d9d2a0", category: "gases", state: "gas", density: 2.63, tempLow: -10, desc: "Sharp, choking volcanic gas." },
  { id: "nitrogen_dioxide", color: "#b4653f", category: "gases", state: "gas", density: 2.05, temp: 25, tempLow: 21, desc: "Red-brown smog gas." },
  { id: "nitrous_oxide", color: "#cfd8e2", category: "gases", state: "gas", density: 1.98, tempLow: -88.5, desc: "Laughing gas." },
  { id: "carbon_monoxide", color: "#c8ccd2", category: "gases", state: "gas", density: 1.25, tempLow: -191.5, desc: "Colourless, odourless, deadly." },
  { id: "butane", color: "#d4d8c4", category: "gases", state: "gas", density: 2.48, tempLow: -0.5, burn: 95, burnTime: 25, desc: "Lighter fuel." },
  { id: "acetylene", color: "#d8dcc8", category: "gases", state: "gas", density: 1.1, tempLow: -84, burn: 100, burnTime: 10, desc: "Burns hot enough to weld steel." },
  { id: "ethylene", color: "#d2d8c0", category: "gases", state: "gas", density: 1.18, tempLow: -103.7, burn: 90, burnTime: 15, desc: "Ripening gas from fruit." },
  { id: "propylene", color: "#d0d6c2", category: "gases", state: "gas", density: 1.81, tempLow: -47.6, burn: 90, burnTime: 18, desc: "Feedstock for plastics." },
  { id: "fluorine", color: "#d7e8b0", category: "gases", state: "gas", density: 1.7, tempLow: -188, desc: "The most reactive element." },
  { id: "krypton", color: "#cfd8e8", category: "gases", state: "gas", density: 3.75, tempLow: -153.4, desc: "A heavy noble gas." },
  { id: "xenon", color: "#c8d4e6", category: "gases", state: "gas", density: 5.89, tempLow: -108.1, glow: true, desc: "Noble gas used in bright lamps." },
  { id: "radon", color: "#b8c6d8", category: "gases", state: "gas", density: 9.73, tempLow: -61.7, glow: true, glowColor: "#8fffb0", desc: "Radioactive noble gas from rock." },
  { id: "phosphine", color: "#d6dcb8", category: "gases", state: "gas", density: 1.53, tempLow: -87.7, desc: "Toxic gas that glows in air." },
  { id: "silane", color: "#d4dcc4", category: "gases", state: "gas", density: 1.34, tempLow: -112, burn: 100, burnTime: 8, desc: "Spontaneously flammable silicon hydride." },
  { id: "diborane", color: "#d2dac0", category: "gases", state: "gas", density: 1.21, tempLow: -92.5, burn: 95, burnTime: 12, desc: "A boron hydride rocket fuel." },
  { id: "formaldehyde", color: "#d8dcd0", category: "gases", state: "gas", density: 1.03, tempLow: -19, desc: "Pungent preservative gas." }
]);

/* Industrial and reactive gases. */
LM.define.bulk([
  { id: "chlorine_dioxide", color: "#d4dca0", category: "gases", state: "gas", density: 2.4, tempLow: 11, desc: "Yellow-green disinfectant gas." },
  { id: "hydrogen_bromide", color: "#d8d8c4", category: "gases", state: "gas", density: 2.8, tempLow: -67, desc: "Sharp, corrosive gas." },
  { id: "hydrogen_iodide", color: "#dcd8c8", category: "gases", state: "gas", density: 5.2, tempLow: -35, desc: "Fumes in moist air." },
  { id: "sulfur_hexafluoride", color: "#d2dce0", category: "gases", state: "gas", density: 6.2, tempLow: -64, desc: "Six times heavier than air." },
  { id: "nitrogen_trifluoride", color: "#d6e0c8", category: "gases", state: "gas", density: 2.9, tempLow: -129, desc: "A potent greenhouse gas." },
  { id: "germane", color: "#d4dcc4", category: "gases", state: "gas", density: 3.1, tempLow: -88, burn: 95, burnTime: 10, desc: "Silane's heavier cousin." },
  { id: "stibine", color: "#d6d8c4", category: "gases", state: "gas", density: 5.3, tempLow: -17, desc: "Antimony hydride, very toxic." },
  { id: "carbonyl_sulfide", color: "#d8dcc8", category: "gases", state: "gas", density: 2.5, tempLow: -50, desc: "Trace gas with a sulfur smell." }
]);

/* ===== 54-materials-organics.js ===== */
/* Organic materials: fibres, waxes, resins and soils. Most decompose rather
   than melt, so tempHigh is the scorch point. */

LM.define.bulk([
  { id: "starch", color: "#f0ece0", category: "powders", state: "solid", density: 1500, tempHigh: 250, hardness: 0.05, burn: 40, burnTime: 60, powder: true, isFood: true, desc: "Energy storage of plants." },
  { id: "gluten", color: "#e8d8b0", category: "powders", state: "solid", density: 1300, tempHigh: 200, hardness: 0.05, burn: 30, burnTime: 50, powder: true, isFood: true, desc: "The elastic protein of wheat." },
  { id: "casein", color: "#f2ead8", category: "powders", state: "solid", density: 1300, tempHigh: 280, hardness: 0.05, burn: 25, burnTime: 50, powder: true, isFood: true, desc: "Milk protein, used in old plastics." },
  { id: "keratin", color: "#d8c8a8", category: "solids", state: "solid", density: 1300, tempHigh: 240, hardness: 0.3, burn: 30, burnTime: 60, desc: "Hair, horn and feather protein." },
  { id: "chitin", color: "#c9b48c", category: "solids", state: "solid", density: 1400, tempHigh: 300, hardness: 0.5, burn: 20, burnTime: 70, desc: "The shell of insects and crabs." },
  { id: "collagen", color: "#e6d8c8", category: "solids", state: "solid", density: 1300, tempHigh: 200, hardness: 0.2, burn: 25, burnTime: 60, desc: "The protein rope in skin and tendon." },
  { id: "beeswax", color: "#e8c86a", category: "solids", state: "solid", density: 960, tempHigh: 62, hardness: 0.1, burn: 35, burnTime: 120, desc: "Melts just above a hot day." },
  { id: "paraffin", color: "#efeade", category: "solids", state: "solid", density: 900, tempHigh: 58, hardness: 0.1, burn: 60, burnTime: 150, desc: "Candle wax from petroleum." },
  { id: "rosin", color: "#c98a3a", category: "solids", state: "solid", density: 1070, tempHigh: 100, hardness: 0.15, burn: 50, burnTime: 100, desc: "Pine resin, used as flux." },
  { id: "natural_rubber", color: "#d8d0bc", category: "solids", state: "solid", density: 920, tempHigh: 180, hardness: 0.2, burn: 35, burnTime: 200, desc: "Elastic latex that has set." },
  { id: "gutta_percha", color: "#c9bea0", category: "solids", state: "solid", density: 980, tempHigh: 60, hardness: 0.2, burn: 30, burnTime: 180, desc: "Hard, leathery natural plastic." },
  { id: "bitumen", color: "#221f1c", category: "solids", state: "solid", density: 1100, tempHigh: 150, hardness: 0.2, burn: 20, burnTime: 300, desc: "Heavy tar that binds asphalt." },
  { id: "peat", color: "#4a3a26", category: "land", state: "solid", density: 400, tempHigh: 200, hardness: 0.05, burn: 30, burnTime: 250, powder: true, desc: "Partly decayed moss." },
  { id: "biochar", color: "#2a2622", category: "powders", state: "solid", density: 300, tempHigh: 400, hardness: 0.1, burn: 15, burnTime: 200, powder: true, desc: "Charred biomass for soil." },
  { id: "humus", color: "#3d2e1e", category: "land", state: "solid", density: 1300, tempHigh: 200, hardness: 0.05, burn: 10, burnTime: 120, powder: true, desc: "The dark organic part of soil." },
  { id: "compost", color: "#463525", category: "land", state: "solid", density: 600, tempHigh: 150, hardness: 0.05, burn: 8, burnTime: 100, powder: true, desc: "Decomposing kitchen scraps." }
]);

/* Structural and resinous organics. */
LM.define.bulk([
  { id: "lignin", color: "#4a3520", category: "powders", state: "solid", density: 1300, tempHigh: 300, hardness: 0.1, burn: 30, burnTime: 120, powder: true, desc: "The woody polymer that makes trees stiff." },
  { id: "suberin", color: "#7a5a35", category: "solids", state: "solid", density: 1200, tempHigh: 250, hardness: 0.15, burn: 20, burnTime: 150, desc: "The waxy polymer in cork." },
  { id: "cutin", color: "#8a6a3a", category: "solids", state: "solid", density: 1200, tempHigh: 250, hardness: 0.15, burn: 20, burnTime: 120, desc: "The waxy skin of leaves." },
  { id: "fibrin", color: "#d8b8a8", category: "solids", state: "solid", density: 1300, tempHigh: 200, hardness: 0.15, burn: 15, burnTime: 80, desc: "The protein that forms clots." },
  { id: "elastin", color: "#e0c8a8", category: "solids", state: "solid", density: 1300, tempHigh: 220, hardness: 0.1, burn: 20, burnTime: 90, desc: "The rubbery protein in arteries." },
  { id: "shellac", color: "#c98a3a", category: "solids", state: "solid", density: 1100, tempHigh: 80, hardness: 0.2, burn: 30, burnTime: 100, desc: "Resin secreted by lac insects." },
  { id: "copal", color: "#d8a84a", category: "solids", state: "solid", density: 1100, tempHigh: 120, hardness: 0.2, burn: 25, burnTime: 120, desc: "Hard tree resin used in varnish." },
  { id: "guano", color: "#c8b48a", category: "land", state: "solid", density: 900, tempHigh: 200, hardness: 0.05, burn: 10, burnTime: 100, powder: true, desc: "Nitrogen-rich bird droppings." }
]);

/* ===== 55-materials-powders.js ===== */
/* Industrial and mineral powders. All use the POWDER behaviour so they pile,
   flow and mix like the base game's powders. */

LM.define.bulk([
  { id: "titanium_dioxide", color: "#f4f2ec", category: "powders", state: "solid", density: 4230, tempHigh: 1843, hardness: 0.5, conduct: 0.02, powder: true, desc: "The white pigment in paint and sunscreen." },
  { id: "alumina", color: "#eae7e0", category: "powders", state: "solid", density: 3950, tempHigh: 2072, hardness: 0.7, conduct: 0.02, powder: true, desc: "Aluminium oxide, abrasive and refractory." },
  { id: "iron_oxide", color: "#8a3a2a", category: "powders", state: "solid", density: 5242, tempHigh: 1566, hardness: 0.5, conduct: 0.05, powder: true, desc: "Rust, in bulk." },
  { id: "silica_fume", color: "#dcdad2", category: "powders", state: "solid", density: 2200, tempHigh: 1713, hardness: 0.4, conduct: 0.02, powder: true, desc: "Ultra-fine silica from smelting." },
  { id: "fly_ash", color: "#9a968c", category: "powders", state: "solid", density: 2300, tempHigh: 1200, hardness: 0.4, conduct: 0.03, powder: true, desc: "Coal ash used to strengthen concrete." },
  { id: "cement_powder", color: "#b8b4a8", category: "powders", state: "solid", density: 3100, tempHigh: 1450, hardness: 0.3, conduct: 0.03, powder: true, desc: "Portland cement before water." },
  { id: "plaster_of_paris", color: "#efece2", category: "powders", state: "solid", density: 2320, tempHigh: 150, hardness: 0.2, conduct: 0.02, powder: true, desc: "Gypsum with the water driven off." },
  { id: "chalk_powder", color: "#f6f3ea", category: "powders", state: "solid", density: 2700, tempHigh: 1339, hardness: 0.1, conduct: 0.02, powder: true, desc: "Ground limestone, soft and dusty." },
  { id: "graphite_powder", color: "#3a3a40", category: "powders", state: "solid", density: 2260, tempHigh: 3600, hardness: 0.05, conduct: 0.35, powder: true, desc: "Conductive carbon powder." },
  { id: "sulfur_powder", color: "#e2d35a", category: "powders", state: "solid", density: 2070, tempHigh: 115.2, hardness: 0.1, conduct: 0.02, powder: true, burn: 30, burnTime: 80, desc: "Bright yellow brimstone." },
  { id: "zinc_oxide", color: "#f0eee6", category: "powders", state: "solid", density: 5606, tempHigh: 1975, hardness: 0.4, conduct: 0.02, powder: true, desc: "White powder in sunscreen and rubber." },
  { id: "lead_oxide", color: "#c9b45a", category: "powders", state: "solid", density: 9500, tempHigh: 888, hardness: 0.2, conduct: 0.02, powder: true, desc: "Used in lead crystal and old glazes." },
  { id: "copper_powder", color: "#b56a3a", category: "powders", state: "solid", density: 8960, tempHigh: 1085, hardness: 0.2, conduct: 0.7, powder: true, desc: "Fine copper, used in metal paints." },
  { id: "aluminum_powder", color: "#c6c9cc", category: "powders", state: "solid", density: 2700, tempHigh: 660, hardness: 0.2, conduct: 0.6, powder: true, burn: 60, burnTime: 40, desc: "Finely divided aluminium; burns bright." },
  { id: "magnesium_powder", color: "#cfd2d4", category: "powders", state: "solid", density: 1740, tempHigh: 650, hardness: 0.2, conduct: 0.4, powder: true, burn: 90, burnTime: 30, fireColor: "#ffffff", desc: "Flash powder that burns white." },
  { id: "ammonium_nitrate", color: "#eeeadc", category: "powders", state: "solid", density: 1720, tempHigh: 169, hardness: 0.1, conduct: 0.02, powder: true, desc: "Fertiliser and oxidiser." },
  { id: "potassium_permanganate", color: "#6a3a6a", category: "powders", state: "solid", density: 2703, tempHigh: 240, hardness: 0.15, conduct: 0.02, powder: true, desc: "Deep purple oxidising crystals." },
  { id: "activated_carbon", color: "#1e1e22", category: "powders", state: "solid", density: 2000, tempHigh: 3600, hardness: 0.05, conduct: 0.2, powder: true, desc: "Porous carbon that adsorbs almost anything." },
  { id: "carbon_black", color: "#141416", category: "powders", state: "solid", density: 1800, tempHigh: 3600, hardness: 0.05, conduct: 0.15, powder: true, desc: "Soot used as a black pigment." },
  { id: "silica_gel", color: "#e6e8e4", category: "powders", state: "solid", density: 2100, tempHigh: 1713, hardness: 0.2, conduct: 0.02, powder: true, desc: "Beads that drink moisture." },
  { id: "bentonite", color: "#c9c2ac", category: "powders", state: "solid", density: 900, tempHigh: 1200, hardness: 0.1, conduct: 0.02, powder: true, desc: "Swelling clay for drilling mud." },
  { id: "vermiculite", color: "#a8946a", category: "powders", state: "solid", density: 300, tempHigh: 1300, hardness: 0.1, conduct: 0.03, powder: true, desc: "Expanded mica that holds water." },
  { id: "perlite", color: "#dcd8cc", category: "powders", state: "solid", density: 300, tempHigh: 1260, hardness: 0.1, conduct: 0.03, powder: true, desc: "Popped volcanic glass for soil." },
  { id: "zeolite", color: "#d8d6c8", category: "powders", state: "solid", density: 2200, tempHigh: 1000, hardness: 0.3, conduct: 0.02, powder: true, desc: "Microporous mineral sieve." },
  { id: "cork_dust", color: "#b08a5a", category: "powders", state: "solid", density: 200, tempHigh: 250, hardness: 0.05, conduct: 0.02, powder: true, burn: 40, burnTime: 60, desc: "Ground cork, light and springy." },
  { id: "wood_flour", color: "#c9a878", category: "powders", state: "solid", density: 300, tempHigh: 300, hardness: 0.05, conduct: 0.03, powder: true, burn: 60, burnTime: 70, desc: "Fine sawdust used as filler." },
  { id: "titanium", color: "#b8bcc0", category: "solids", state: "solid", density: 4506, tempHigh: 1668, hardness: 0.7, conduct: 0.15, desc: "Light, strong and corrosion proof." },
  { id: "cobalt", color: "#5a6a8c", category: "solids", state: "solid", density: 8900, tempHigh: 1495, hardness: 0.6, conduct: 0.25, desc: "Blue pigment metal and magnet ingredient." },
  { id: "manganese", color: "#8c8f96", category: "solids", state: "solid", density: 7210, tempHigh: 1246, hardness: 0.65, conduct: 0.2, desc: "Hardens steel; essential in tiny amounts." }
]);

/* ===== 70-limits.js ===== */
/* "Limitless" feel without touching the UI: a much higher pixel ceiling and no
   brush-size ceiling. Both are engine settings, not DOM changes. */

LM.applyLimits = function () {
  var cfg = LM.config;

  if (cfg.maxPixelCount && typeof settings === "object" && settings) {
    settings.maxpixels = cfg.maxPixelCount;
    if (typeof refreshMaxPixels === "function") { refreshMaxPixels(); }
    else if (typeof maxPixelCount !== "undefined") { maxPixelCount = cfg.maxPixelCount; }
    else { /* nothing to raise in this environment */ }
  }

  if (cfg.brushCeiling) {
    for (var id in elements) {
      if (!Object.prototype.hasOwnProperty.call(elements, id)) { continue; }
      var el = elements[id];
      if (!el || typeof el !== "object" || el.tool) { continue; }
      if (typeof el.maxSize !== "number" || el.maxSize < cfg.brushCeiling) {
        el.maxSize = cfg.brushCeiling;
      }
    }
  }

  LM.limits = { maxPixelCount: cfg.maxPixelCount, brushCeiling: cfg.brushCeiling };
  return LM.limits;
};

/* ===== 99-footer.js ===== */
/* Finish: register everything that needs the engine, then report once. */

LM.loaded = true;

if (typeof runAfterLoad === "function") {
  runAfterLoad(function () {
    LM.ready = true;
    if (LM.config.audit.enabled) { LM.physics.apply(); }
    if (typeof LM.applyLimits === "function") { LM.applyLimits(); }
    if (LM.config.logSummary) {
      LM.log("Limitless Elements v" + LM.version + " ready — " +
        LM.stats.added + " new elements, " +
        LM.stats.corrected + " physics corrections, " +
        (LM.stats.restored ? LM.stats.restored + " saved mixtures restored, " : "") +
        "fusion depth " + LM.config.maxFusionDepth + ".");
    }
  });
  // Restore on the first game tick: element finalization (which fills in
  // `state` for elements that omit it) happens after every load hook.
  LM.pendingRestore = true;
} else {
  LM.ready = true;
  if (LM.config.audit.enabled && typeof LM.physics.apply === "function") { LM.physics.apply(); }
  if (typeof LM.applyLimits === "function") { LM.applyLimits(); }
}

})();
