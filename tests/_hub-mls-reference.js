// The hub's own reference for "an MLS Grid record -> the row the hub sends", copied
// VERBATIM from the hub MLS read contract (Seller Intelligence wave 2a,
// hubRowFromMlsGrid; 2026-10-17 revision, where dec() rounds like Postgres
// numeric). Seller Intelligence's hub tests check that the hub's SQL gives exactly
// this, so building the fake hub's rows with it tests this site against what the
// hub really sends. Do not "improve" it here: change it only by re-copying the
// contract. Not a suite (tests/run-all.sh runs tests/test-*.js only).
"use strict";

function hubRowFromMlsGrid(rec, opts = {}) {
  const text = (v, max = 4000) => { const s = typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''); return s === '' ? null : s.slice(0, max); };
  const num = (v) => { const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN); return Number.isFinite(n) ? n : null; };
  // Rounds like Postgres numeric (half away from zero, on the decimal digits as written): 495000.555 -> 495000.56.
  const dec = (v, places) => { const n = num(v); if (n === null) return null; const s = String(Math.abs(n)); if (/e/i.test(s)) return Number(n.toFixed(places)); const [i, f = ''] = s.split('.'); if (f.length <= places) return n; const r = (BigInt(i + f.slice(0, places)) + (f[places] >= '5' ? 1n : 0n)).toString().padStart(places + 1, '0'); const out = Number(`${r.slice(0, r.length - places)}.${r.slice(r.length - places)}`); return n < 0 ? -out : out; };
  const int = (v) => { const n = num(v); return n === null ? null : Math.round(n); };
  const day = (v) => { const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim()) : null; return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
  const stamp = (v) => { if (typeof v !== 'string' || !v.trim()) return null; const t = Date.parse(v.trim()); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
  const use = Array.isArray(rec.MlgCanUse) ? rec.MlgCanUse.filter((x) => typeof x === 'string') : [];
  const hidden = rec.MlgCanView === false;
  const idx = !hidden && use.some((u) => u.toUpperCase() === 'IDX');
  const bo = !hidden && use.some((u) => u.toUpperCase() === 'BO');
  const status = text(rec.StandardStatus, 60) ?? text(rec.MlsStatus, 60);
  const sk = String(status ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const prev = opts.previousStatus ?? null;
  const row = {
    ListingKey: text(rec.ListingKey, 200), ListingId: text(rec.ListingId, 60), OriginatingSystemName: text(rec.OriginatingSystemName, 40),
    StandardStatus: status, MlsStatus: text(rec.MlsStatus, 60), StatusChangeTimestamp: stamp(rec.StatusChangeTimestamp),
    PropertyType: text(rec.PropertyType, 60), PropertySubType: text(rec.PropertySubType, 60),
    ListPrice: dec(rec.ListPrice, 2), OriginalListPrice: dec(rec.OriginalListPrice, 2), ClosePrice: dec(rec.ClosePrice, 2), CloseDate: day(rec.CloseDate),
    ListingContractDate: day(rec.ListingContractDate), PurchaseContractDate: day(rec.PurchaseContractDate),
    ExpirationDate: day(rec.ExpirationDate), OffMarketDate: day(rec.OffMarketDate),
    DaysOnMarket: int(rec.DaysOnMarket), CumulativeDaysOnMarket: int(rec.CumulativeDaysOnMarket),
    StreetNumber: text(rec.StreetNumber, 40), StreetDirPrefix: text(rec.StreetDirPrefix, 20), StreetName: text(rec.StreetName, 120),
    StreetSuffix: text(rec.StreetSuffix, 40), StreetDirSuffix: text(rec.StreetDirSuffix, 20), UnitNumber: text(rec.UnitNumber, 40),
    UnparsedAddress: text(rec.UnparsedAddress, 300), City: text(rec.City, 80), CountyOrParish: text(rec.CountyOrParish, 80),
    StateOrProvince: text(rec.StateOrProvince, 40), PostalCode: text(rec.PostalCode, 20),
    Latitude: dec(rec.Latitude, 6), Longitude: dec(rec.Longitude, 6),
    BedroomsTotal: int(rec.BedroomsTotal), BathroomsTotalInteger: int(rec.BathroomsTotalInteger), BathroomsFull: int(rec.BathroomsFull), BathroomsHalf: int(rec.BathroomsHalf),
    LivingArea: dec(rec.LivingArea, 2), LotSizeSquareFeet: dec(rec.LotSizeSquareFeet, 2), LotSizeAcres: dec(rec.LotSizeAcres, 4), YearBuilt: int(rec.YearBuilt),
    SubdivisionName: text(rec.SubdivisionName, 160),
    PublicRemarks: (idx || (bo && opts.bo) || (hidden && opts.offmarket)) ? text(rec.PublicRemarks, 8000) : null,
    WaterfrontYN: typeof rec.WaterfrontYN === 'boolean' ? rec.WaterfrontYN : null, PhotosCount: int(rec.PhotosCount),
    PhotosChangeTimestamp: stamp(rec.PhotosChangeTimestamp),
    ListOfficeMlsId: text(rec.ListOfficeMlsId, 60), ListOfficeKey: text(rec.ListOfficeKey, 60), ListOfficeName: opts.officeName ?? null,
    MlgCanView: !hidden, MlgCanUse: hidden ? [] : use.slice(0, 20), ModificationTimestamp: stamp(rec.ModificationTimestamp),
  };
  if (opts.agents) Object.assign(row, {
    ListAgentMlsId: text(rec.ListAgentMlsId, 60), ListAgentKey: text(rec.ListAgentKey, 60), ListAgentFullName: text(rec.ListAgentFullName, 120),
    CoListAgentFullName: text(rec.CoListAgentFullName, 120), BuyerAgentMlsId: text(rec.BuyerAgentMlsId, 60), BuyerOfficeMlsId: text(rec.BuyerOfficeMlsId, 60),
  });
  row._hub = {
    idx, public_display: idx && ['active', 'activeundercontract', 'comingsoon', 'pending', 'closed'].includes(sk), not_for_display: hidden,
    mine: !!opts.mine, my_office: !!opts.myOffice, previous_status: prev,
    status_changed_at: opts.statusChangedAt ?? stamp(rec.StatusChangeTimestamp),
    back_on_market: sk === 'active' && ['Pending', 'Active Under Contract', 'Expired', 'Canceled', 'Withdrawn', 'Hold'].includes(prev),
  };
  return row;
}

module.exports = { hubRowFromMlsGrid };
