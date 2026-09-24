// The property address on a home-value lead, in the shape Lofty stores and
// Seller Intelligence reads.
//
// 2026-09-24. Home-value forms put the address ONLY in the lead note
// ("Requested valuation for: ..."). Seller Intelligence has no inbound webhook
// for a new homeowner -- its only public intake needs a signed link for a
// contact it already knows -- so it learns about homeowners from its Lofty sync
// (src/sync/lofty-contacts.ts), which reads the lead's streetAddress / city /
// state / zipCode fields and never parses notes. A home-value lead therefore
// reached Lofty and stayed invisible to Seller Intelligence.
//
// Lofty's Open API takes the address on create as a NESTED `property` object;
// flat address fields are silently discarded (it still answers 200). That shape
// is the one sellerintelligence's loftyClient.ts writes (toLoftyBody), learned
// the hard way there.
//
// Parsing is deliberately conservative: the visitor typed one free-text line.
// Street is always the first comma part; city/state/ZIP are only filled when
// they are unambiguous, and nothing is guessed.

// Forms where the address is the visitor's OWN home (a seller asking what it is
// worth). Land/listing forms carry addresses of homes they want to BUY -- those
// must not be recorded as the lead's property.
const HOME_VALUE_FORMS = new Set([
  "free-home-valuation",
  "sellers-page-inquiry",
  "seller-local-proof",
  "cash-offer",
  "loveland-market-seller",
]);

function propertyFromAddress(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!text) return null;
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  const out = { streetAddress: parts[0] };
  let rest = parts.slice(1);
  if (rest.length) {
    const last = rest[rest.length - 1];
    const stateZip = /^(?:(CO|Colorado)\s*)?(\d{5})?(?:-\d{4})?$/i.exec(last);
    if (stateZip && (stateZip[1] || stateZip[2])) {
      if (stateZip[1]) out.state = "CO";
      if (stateZip[2]) out.zipCode = stateZip[2];
      rest = rest.slice(0, -1);
    }
  }
  if (rest.length === 1 && /^[A-Za-z .'-]{2,40}$/.test(rest[0])) out.city = rest[0];
  return out;
}

// The address field a home-value form uses, or null for every other form.
function homeValueProperty(formName, data) {
  if (!HOME_VALUE_FORMS.has(formName) || !data) return null;
  return propertyFromAddress(data.address || data.property_address);
}

module.exports = { HOME_VALUE_FORMS, propertyFromAddress, homeValueProperty };
