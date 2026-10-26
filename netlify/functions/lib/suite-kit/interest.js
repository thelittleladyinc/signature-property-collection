"use strict";
// What a lead wants, as ONE tag vocabulary for every app (Christine, Oct 26, 2026: "every single possible lead form or
// entry into my platform to be sourced and as detailed as possible so plans/funnels can expand to downsizers etc").
//
// Every app adds `Interest – <kind>` (EN DASH) next to the tags it already writes, on a new lead and on a returning
// one. An Interest tag starts no Smart Plan (her Lofty had only hobby tags such as `Interest – Golf` on Oct 26, none of
// these), so adding one never sets off a drip; a plan can later be set to start on one. "First Time" and "Move Up"
// have no hyphen, like her plan tags `TOF – First Time Buyer` and `TOF – Move Up Buyer`.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUYER_SIDE_INTERESTS = exports.SELLER_SIDE_INTERESTS = exports.LEAD_TYPES = exports.INTEREST_TAGS = void 0;
exports.isInterestTag = isInterestTag;
exports.leadTypesForInterests = leadTypesForInterests;
exports.interestTagsForIntent = interestTagsForIntent;
exports.INTEREST_TAGS = {
    buyer: 'Interest – Buyer',
    firstTimeBuyer: 'Interest – First Time Buyer',
    rentToOwn: 'Interest – Rent to Own',
    moveUpBuyer: 'Interest – Move Up Buyer',
    vaBuyer: 'Interest – VA Buyer',
    luxuryBuyer: 'Interest – Luxury Buyer',
    relocation: 'Interest – Relocation',
    land: 'Interest – Land',
    multigenerational: 'Interest – Multigenerational',
    investor: 'Interest – Investor',
    seller: 'Interest – Seller',
    homeValue: 'Interest – Home Value',
    cashOffer: 'Interest – Cash Offer',
    luxurySeller: 'Interest – Luxury Seller',
    downsizing: 'Interest – Downsizing',
    expired: 'Interest – Expired',
    fsbo: 'Interest – FSBO',
    preForeclosure: 'Interest – Pre-Foreclosure',
    taxDefault: 'Interest – Tax Default',
    inherited: 'Interest – Inherited',
    agentRecruit: 'Interest – Agent Recruit',
    newsletter: 'Interest – Newsletter',
};
const ALL_INTEREST_TAGS = new Set(Object.values(exports.INTEREST_TAGS));
/** Is this exactly one of the Interest tags above (same case, EN DASH)? */
function isInterestTag(tag) {
    return ALL_INTEREST_TAGS.has(tag);
}
// ── Lofty lead types from the Interest tags (0.5.12; Christine, Oct 26, 2026: "we need it to be buyer and seller too not
// just one or the other") ──
//
// Lofty's `leadTypes` is a list: 1 = Seller, 2 = Buyer. A Smart Plan enrolls only the lead types in its scope, so a
// person who said both must be both. The types come ONLY from what the person told us, as the Interest tags say it:
// a seller-side tag gives Seller, a buyer-side tag gives Buyer, both kinds give [1, 2]. Nothing is inferred. These
// readings wait for Christine and are NOT made here: Move Up Buyer as Seller too (they own now), Downsizing as Buyer
// too (they buy the next home), Relocation as anything but Buyer. Investor, Land, Multigenerational, Agent Recruit and
// Newsletter say neither (the same sides as Listing Engine's own copy of this rule; a form that files Land or
// Multigenerational as Buyer today does it through its plan's type, which the apps keep).
/** Lofty's numeric lead types (`leadTypes` on POST /v1.0/leads). */
exports.LEAD_TYPES = { seller: 1, buyer: 2 };
/** The Interest tags that say the person is selling (or weighing it): each gives the Seller lead type. */
exports.SELLER_SIDE_INTERESTS = Object.freeze([
    exports.INTEREST_TAGS.seller, exports.INTEREST_TAGS.homeValue, exports.INTEREST_TAGS.cashOffer, exports.INTEREST_TAGS.luxurySeller, exports.INTEREST_TAGS.expired,
    exports.INTEREST_TAGS.fsbo, exports.INTEREST_TAGS.preForeclosure, exports.INTEREST_TAGS.taxDefault, exports.INTEREST_TAGS.inherited, exports.INTEREST_TAGS.downsizing,
]);
/** The Interest tags that say the person is buying: each gives the Buyer lead type. */
exports.BUYER_SIDE_INTERESTS = Object.freeze([
    exports.INTEREST_TAGS.buyer, exports.INTEREST_TAGS.firstTimeBuyer, exports.INTEREST_TAGS.rentToOwn, exports.INTEREST_TAGS.moveUpBuyer, exports.INTEREST_TAGS.vaBuyer,
    exports.INTEREST_TAGS.luxuryBuyer, exports.INTEREST_TAGS.relocation,
]);
// Exactly her tags, as isInterestTag reads them (spaces around the tag trimmed): "Interest - Buyer" with a hyphen is not
// her tag, and a plan tag ("TOF – Seller") is not an Interest tag.
const SELLER_KEYS = new Set(exports.SELLER_SIDE_INTERESTS);
const BUYER_KEYS = new Set(exports.BUYER_SIDE_INTERESTS);
/**
 * The Lofty lead types a lead's Interest tags say: [1] seller-side only, [2] buyer-side only, [1, 2] both, [] none (no
 * Interest tag, or only Investor / Land / Multigenerational / Agent Recruit / Newsletter). Other tags in the list are
 * ignored, so a lead's whole tag list can be passed. Always in the order [1, 2].
 */
function leadTypesForInterests(tags) {
    let seller = false, buyer = false;
    for (const t of tags ?? []) {
        const k = typeof t === 'string' ? t.trim() : '';
        if (SELLER_KEYS.has(k))
            seller = true;
        else if (BUYER_KEYS.has(k))
            buyer = true;
    }
    return [...(seller ? [exports.LEAD_TYPES.seller] : []), ...(buyer ? [exports.LEAD_TYPES.buyer] : [])];
}
/**
 * The Interest tag(s) for a hub router intent (supabase/functions/hub-api/router.ts). `sell_and_buy` is both; an
 * intent that says nothing about what the person wants (referral, resource, an unknown word) is none.
 */
function interestTagsForIntent(intent) {
    switch (intent) {
        case 'urgent_buyer':
        case 'buyer_next_steps':
        case 'buyer':
        case 'open_house':
        case 'listing_inquiry':
            return [exports.INTEREST_TAGS.buyer];
        case 'buyer_preparing': return [exports.INTEREST_TAGS.firstTimeBuyer];
        case 'rent_to_own': return [exports.INTEREST_TAGS.rentToOwn];
        case 'luxury_buyer': return [exports.INTEREST_TAGS.luxuryBuyer];
        case 'relocation': return [exports.INTEREST_TAGS.relocation];
        case 'investor': return [exports.INTEREST_TAGS.investor];
        case 'seller': return [exports.INTEREST_TAGS.seller];
        case 'home_value': return [exports.INTEREST_TAGS.homeValue];
        case 'seller_cash': return [exports.INTEREST_TAGS.cashOffer];
        case 'seller_luxury': return [exports.INTEREST_TAGS.luxurySeller];
        case 'seller_fsbo': return [exports.INTEREST_TAGS.fsbo];
        case 'downsizing': return [exports.INTEREST_TAGS.downsizing];
        case 'sell_and_buy': return [exports.INTEREST_TAGS.seller, exports.INTEREST_TAGS.buyer];
        default: return [];
    }
}
