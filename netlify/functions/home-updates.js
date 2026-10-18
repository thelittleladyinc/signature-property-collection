// "What have you updated?" -- the form a value review email links to (Build E,
// 2026-10-17). Off unless VALUE_REVIEW_UPDATES_FORM=on. Everything is in
// lib/_home-updates.js, shared byte for byte with the Signature site; this file
// only names the site and its brand.
"use strict";
const { handleHomeUpdates } = require("./lib/_home-updates");

const SITE = "signature";
const BRAND = "Signature Property Collection";

exports.handler = (event) => handleHomeUpdates(event, { site: SITE, brand: BRAND });
