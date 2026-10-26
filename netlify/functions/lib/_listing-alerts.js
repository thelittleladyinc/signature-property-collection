"use strict";
const PROPERTY_TYPES = ["Single Family Home", "Multi-Family", "Condo", "Townhouse", "Manufactured Home", "Vacant Land", "Commercial"];
function requestedAlert(data) {
  const d = data || {};
  if (d.listing_alert_consent !== "yes") return null;
  const city = String(d.alert_city || "").trim();
  if (!/^[A-Za-z .'-]{1,60}$/.test(city)) return null;
  const criteria = { locations: { cities: [city + ", CO"] } };
  for (const [field,key,max] of [["alert_min_price","priceMin",1e9],["alert_max_price","priceMax",1e9],["alert_beds","bedsMin",50],["alert_baths","bathsMin",50],["alert_sqft","sqftMin",1e7]]) {
    const raw = String(d[field] || "").trim();
    if (!raw) continue;
    if (!/^\d+(\.\d+)?$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > max || (key !== "bathsMin" && !Number.isInteger(n))) return null;
    criteria[key] = n;
  }
  if (criteria.priceMin && criteria.priceMax && criteria.priceMin > criteria.priceMax) return null;
  const type = String(d.alert_property_type || "").trim();
  if (type) { if (!PROPERTY_TYPES.includes(type)) return null; criteria.propertyTypes = [type]; }
  return criteria;
}
async function activatePropertyAlert({formName,data,leadId,submissionId},opts = {}) {
  if (formName !== "listing-alert-request" || (data || {}).listing_alert_consent !== "yes") return {attempted:false};
  const criteria = requestedAlert(data);
  const email = String((data || {}).email || "").trim().toLowerCase();
  const id = typeof leadId === "number" && !Number.isSafeInteger(leadId) ? "" : String(leadId || "");
  const requestId = String(submissionId || "");
  if (!criteria || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[1-9]\d{0,19}$/.test(id) || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) return {attempted:false,status:"held",reason:"search_needs_review"};
  try {
    const env = opts.env || process.env;
    const {createHubClient} = require("./suite-kit/hub");
    const left = (opts.deadline || Infinity)-Date.now();
    if (left < 1500) return {attempted:false,status:"held",reason:"no_time",retryable:true};
    const client = createHubClient({baseUrl:env.HUB_API_URL,key:env.HUB_API_KEY,fetch:opts.fetch,timeoutMs:Math.max(1,Math.min(8000,left))});
    const answer = await client.call("POST","/v1/lofty/property-alert",{lead_id:id,email,criteria,requested:true,request_id:requestId});
    const body = answer.body || {};
    if (!answer.ok || !["active","already_active","held","failed"].includes(body.status)) return {attempted:true,status:"failed",reason:"hub_unavailable",retryable:true};
    return {attempted:true,status:body.status,reason:body.reason || null,retryable:body.status === "failed" && body.reason === "service_unavailable",copyToAgent:body.copy_to_agent === true,searchId:body.search_id || null};
  } catch { return {attempted:true,status:"failed",reason:"service_unavailable",retryable:true}; }
}
module.exports = {PROPERTY_TYPES,requestedAlert,activatePropertyAlert};
