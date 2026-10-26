export declare const INTEREST_TAGS: {
    readonly buyer: "Interest – Buyer";
    readonly firstTimeBuyer: "Interest – First Time Buyer";
    readonly rentToOwn: "Interest – Rent to Own";
    readonly moveUpBuyer: "Interest – Move Up Buyer";
    readonly vaBuyer: "Interest – VA Buyer";
    readonly luxuryBuyer: "Interest – Luxury Buyer";
    readonly relocation: "Interest – Relocation";
    readonly land: "Interest – Land";
    readonly multigenerational: "Interest – Multigenerational";
    readonly investor: "Interest – Investor";
    readonly seller: "Interest – Seller";
    readonly homeValue: "Interest – Home Value";
    readonly cashOffer: "Interest – Cash Offer";
    readonly luxurySeller: "Interest – Luxury Seller";
    readonly downsizing: "Interest – Downsizing";
    readonly expired: "Interest – Expired";
    readonly fsbo: "Interest – FSBO";
    readonly preForeclosure: "Interest – Pre-Foreclosure";
    readonly taxDefault: "Interest – Tax Default";
    readonly inherited: "Interest – Inherited";
    readonly agentRecruit: "Interest – Agent Recruit";
    readonly newsletter: "Interest – Newsletter";
};
export type InterestTag = (typeof INTEREST_TAGS)[keyof typeof INTEREST_TAGS];
/** Is this exactly one of the Interest tags above (same case, EN DASH)? */
export declare function isInterestTag(tag: string): tag is InterestTag;
/** Lofty's numeric lead types (`leadTypes` on POST /v1.0/leads). */
export declare const LEAD_TYPES: {
    readonly seller: 1;
    readonly buyer: 2;
};
/** The Interest tags that say the person is selling (or weighing it): each gives the Seller lead type. */
export declare const SELLER_SIDE_INTERESTS: readonly InterestTag[];
/** The Interest tags that say the person is buying: each gives the Buyer lead type. */
export declare const BUYER_SIDE_INTERESTS: readonly InterestTag[];
/**
 * The Lofty lead types a lead's Interest tags say: [1] seller-side only, [2] buyer-side only, [1, 2] both, [] none (no
 * Interest tag, or only Investor / Land / Multigenerational / Agent Recruit / Newsletter). Other tags in the list are
 * ignored, so a lead's whole tag list can be passed. Always in the order [1, 2].
 */
export declare function leadTypesForInterests(tags: Iterable<unknown> | null | undefined): number[];
/**
 * The Interest tag(s) for a hub router intent (supabase/functions/hub-api/router.ts). `sell_and_buy` is both; an
 * intent that says nothing about what the person wants (referral, resource, an unknown word) is none.
 */
export declare function interestTagsForIntent(intent: string | null | undefined): InterestTag[];
