#!/usr/bin/env python3
"""Generate the Northern Colorado Relocation Guide PDF.

WHY THIS EXISTS (2026-08-17). /guides/northern-colorado-relocation-guide.html is
the site's single named lead magnet -- linked from all 37 town pages, the
homepage and /relocation.html -- and until now there was no document behind it.
The form captured the lead and /thank-you.html promised Christine would reply.
That is how the Buyer's and Seller's Guide landers have always worked, but this
is the page the whole relocation funnel points at, so the promise needed
something real on the other end of it.

WHY IT IS GENERATED, NOT WRITTEN. The lander makes six specific promises: how
the towns differ, real drive times, which school district serves which town, the
out-of-state buying process, the Colorado-specific line items, and a read on the
market. Four of those are facts that already live in build/data/city_content.json
and change over time. A hand-written PDF would be accurate the day it was
exported and quietly wrong six months later -- which is exactly the failure mode
this repo keeps designing against (see build/tools/town-market-stats.js and the
staleness guard on market_report.json). So the town content is read from the same
source the website reads, and the PDF is regenerated rather than edited.

DELIBERATELY NO MARKET FIGURES. The one promise not baked in is the numbers. A
median price inside a PDF cannot be refreshed once someone has downloaded it, and
this guide will sit in inboxes for months. It points at the live pages instead,
which is both honest and the site's actual advantage over every competing
relocation guide in this market.

USAGE
    pip install reportlab          # NOT in requirements.txt on purpose --
    python3 build/tools/relocation_guide_pdf.py

reportlab is kept out of requirements.txt and out of build.py so the Netlify
deploy never depends on it. The PDF is a committed artifact; regenerate it when
city_content.json changes.
"""

import os
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, NextPageTemplate, PageBreak,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(BUILD_DIR)

# Import the generator as a module to reuse its real data and constants rather
# than re-declaring the town->county mapping here. build.py is guarded by
# `if __name__ == "__main__"`, so importing it loads the data without building
# the site.
sys.path.insert(0, BUILD_DIR)
import build as b  # noqa: E402

# Written into build/assets, NOT site/assets. copy_static_assets() in build.py
# does `shutil.rmtree(site/assets)` then copies build/assets over the top -- it
# preserves only the generated qr/ directory. A PDF written straight into
# site/assets would therefore survive exactly until the next build and then
# vanish, and the lander would 404 with nothing in the diff to explain it.
# Living in the source tree means the ordinary asset copy carries it across.
OUT_DIR = os.path.join(BUILD_DIR, "assets", "guides")
OUT_PATH = os.path.join(OUT_DIR, "northern-colorado-relocation-guide.pdf")

# Brand tokens, read off site/assets/css/style.css so the document matches the
# site rather than approximating it.
CHARCOAL = colors.HexColor("#141415")
ROSE = colors.HexColor("#B86F7A")
MAUVE = colors.HexColor("#BA8C84")
CREAM = colors.HexColor("#F8F6F4")
SLATE = colors.HexColor("#33414F")
SLATE_MIST = colors.HexColor("#63707D")
RULE = colors.HexColor("#E2DAD5")

PAGE_W, PAGE_H = letter
MARGIN = 0.85 * inch


def _styles():
    ss = getSampleStyleSheet()
    s = {}
    s["cover_kicker"] = ParagraphStyle(
        "cover_kicker", parent=ss["Normal"], fontName="Helvetica-Bold",
        fontSize=10.5, leading=16, textColor=ROSE, alignment=TA_CENTER,
        spaceAfter=18,
    )
    s["cover_title"] = ParagraphStyle(
        "cover_title", parent=ss["Title"], fontName="Times-Roman",
        fontSize=38, leading=44, textColor=CHARCOAL, alignment=TA_CENTER,
        spaceAfter=20,
    )
    s["cover_sub"] = ParagraphStyle(
        "cover_sub", parent=ss["Normal"], fontName="Helvetica",
        fontSize=12.5, leading=19, textColor=SLATE, alignment=TA_CENTER,
    )
    s["cover_by"] = ParagraphStyle(
        "cover_by", parent=ss["Normal"], fontName="Helvetica-Bold",
        fontSize=11, leading=17, textColor=CHARCOAL, alignment=TA_CENTER,
    )
    s["h1"] = ParagraphStyle(
        "h1", parent=ss["Heading1"], fontName="Times-Roman", fontSize=23,
        leading=28, textColor=CHARCOAL, spaceBefore=4, spaceAfter=6,
    )
    s["kicker"] = ParagraphStyle(
        "kicker", parent=ss["Normal"], fontName="Helvetica-Bold", fontSize=9,
        leading=13, textColor=ROSE, spaceAfter=4,
    )
    s["h2"] = ParagraphStyle(
        "h2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=12.5,
        leading=17, textColor=CHARCOAL, spaceBefore=14, spaceAfter=5,
    )
    s["body"] = ParagraphStyle(
        "body", parent=ss["Normal"], fontName="Helvetica", fontSize=10.2,
        leading=15.6, textColor=CHARCOAL, spaceAfter=9, alignment=TA_LEFT,
    )
    s["lede"] = ParagraphStyle(
        "lede", parent=s["body"], fontSize=11.4, leading=17.5, textColor=SLATE,
        spaceAfter=12,
    )
    s["small"] = ParagraphStyle(
        "small", parent=s["body"], fontSize=9, leading=13.4,
        textColor=SLATE_MIST,
    )
    s["town_name"] = ParagraphStyle(
        "town_name", parent=ss["Heading3"], fontName="Helvetica-Bold",
        fontSize=11.5, leading=15, textColor=CHARCOAL, spaceBefore=11,
        spaceAfter=2,
    )
    s["town_meta"] = ParagraphStyle(
        "town_meta", parent=s["body"], fontSize=9.2, leading=13.4,
        textColor=SLATE_MIST, spaceAfter=3,
    )
    s["cell"] = ParagraphStyle(
        "cell", parent=s["body"], fontSize=8.6, leading=11.6, spaceAfter=0,
    )
    s["cell_head"] = ParagraphStyle(
        "cell_head", parent=s["cell"], fontName="Helvetica-Bold",
        textColor=colors.white,
    )
    return s


S = _styles()


def esc(t):
    return (str(t or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def _footer(canvas, doc):
    """Brand rule + page number + contact on every page but the cover."""
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.6)
    canvas.line(MARGIN, 0.72 * inch, PAGE_W - MARGIN, 0.72 * inch)
    canvas.setFont("Helvetica", 7.6)
    canvas.setFillColor(SLATE_MIST)
    canvas.drawString(MARGIN, 0.53 * inch,
                      f"{b.SITE['name']}  ·  {b.SITE['agent']}  ·  "
                      f"{b.SITE['phone']}")
    canvas.drawRightString(PAGE_W - MARGIN, 0.53 * inch,
                           f"{doc.page - 1}")
    canvas.restoreState()


def _cover_bg(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(CREAM)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    canvas.setFillColor(ROSE)
    canvas.rect(0, PAGE_H - 0.32 * inch, PAGE_W, 0.32 * inch, stroke=0, fill=1)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SLATE_MIST)
    canvas.drawCentredString(PAGE_W / 2, 0.7 * inch,
                             f"{b.SITE['domain'].replace('https://', '')}")
    canvas.restoreState()


def _towns_by_county():
    """[(county_name, [(town, info), ...]), ...] in the site's own order.

    Uses build.py's COUNTIES / CITY_DATA_SLUG so the guide covers exactly the
    towns the website covers -- no separate list to drift out of sync. A town
    that spans two counties is listed once, under the first county that claims
    it, because a reader does not care which county page it came from.
    """
    seen = set()
    out = []
    for c in b.COUNTIES:
        rows = []
        for town in c["cities"]:
            slug = b.CITY_DATA_SLUG.get(town)
            if not slug or slug not in b.CITY_CONTENT or town in seen:
                continue
            seen.add(town)
            rows.append((town, b.CITY_CONTENT[slug]))
        if rows:
            out.append((c["name"], rows))
    return out


def _first_sentence(text):
    if not text:
        return ""
        # A town with no welcome copy simply gets no description line.
    return text.split(". ")[0].strip().rstrip(".") + "."


def build():
    os.makedirs(OUT_DIR, exist_ok=True)
    counties = _towns_by_county()
    town_total = sum(len(r) for _, r in counties)

    doc = BaseDocTemplate(
        OUT_PATH, pagesize=letter,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=0.9 * inch, bottomMargin=1.0 * inch,
        title="The Northern Colorado Relocation Guide",
        author=b.SITE["agent"],
        subject=("How the towns of Northern Colorado actually differ — schools, "
                 "commute, growth, and what to know before you move here."),
        creator=b.SITE["name"],
    )
    frame = Frame(MARGIN, 1.0 * inch, PAGE_W - 2 * MARGIN,
                  PAGE_H - 1.9 * inch, id="body")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[frame], onPage=_cover_bg),
        PageTemplate(id="body", frames=[frame], onPage=_footer),
    ])

    st = []
    P = lambda t, k="body": Paragraph(t, S[k])  # noqa: E731

    # ---------------------------------------------------------------- cover --
    st.append(Spacer(1, 1.5 * inch))
    st.append(P("MOVING TO NORTHERN COLORADO", "cover_kicker"))
    st.append(P("The Northern<br/>Colorado<br/>Relocation Guide", "cover_title"))
    st.append(Spacer(1, 0.18 * inch))
    st.append(P(
        "Most relocation guides are a brochure for the state. This one is about "
        "the twenty minutes between one town and the next — which is where the "
        "decision actually gets made.", "cover_sub"))
    st.append(Spacer(1, 0.5 * inch))
    st.append(P(f"{esc(b.SITE['agent'])}", "cover_by"))
    st.append(P(f"{esc(b.SITE['name'])} · {esc(b.SITE['brokerage'])}", "cover_sub"))
    st.append(Spacer(1, 0.22 * inch))
    st.append(P(f"{town_total} towns, {len(counties)} counties, "
                f"Denver north to the Wyoming line", "cover_sub"))
    st.append(NextPageTemplate("body"))
    st.append(PageBreak())

    # ------------------------------------------------------------ who it's for --
    st.append(P("START HERE", "kicker"))
    st.append(P("The only question that actually matters", "h1"))
    st.append(P(
        "If you are moving to Northern Colorado from somewhere else, the hard part "
        "is not finding a house. There are houses. The hard part is deciding which "
        "of roughly thirty towns you want to wake up in — from a thousand miles "
        "away, on the strength of one weekend visit, using a map that makes them "
        "all look about the same.", "lede"))
    st.append(P(
        "They are not the same. Fifteen minutes apart, two towns here can differ by "
        "a school district, a twenty-minute commute, a hundred thousand dollars of "
        "median price, whether your water comes from a tap or a well, and whether "
        "your property tax includes a metropolitan district on top of everything "
        "else. Those are the differences that decide whether you like living here. "
        "Almost none of them show up in listing photos."))
    st.append(P(
        "So this guide is organised the way the decision actually gets made: town "
        "by town, on the four things people ask me about before they ask about "
        "houses — the schools, the drive, what is being built, and what it costs."))

    st.append(P("Why I am the one writing this", "h2"))
    st.append(P(
        "I left Loveland, and then I chose to come back. That is a more useful "
        "credential for this particular document than any sales figure, because it "
        "means I have actually made the decision you are making, in both "
        "directions. I will tell you when a different town is the better fit — "
        "including the ones I do not personally love."))
    st.append(P(
        f"For the record: {esc(b.SITE['agent'])}, {esc(b.SITE['name'])}, "
        f"{esc(b.SITE['brokerage'])}. RealTrends Verified in the top 0.5% of "
        f"Realtors nationwide, 250+ homes sold as a duo with Kendra Bajcar, and "
        f"$200M+ in combined volume across Northern Colorado."))

    st.append(P("How to use it", "h2"))
    st.append(P(
        "Read the region overview, then skip straight to the counties you are "
        "considering. The comparison table near the back is the fastest way to "
        "narrow thirty towns to four. Once you have four, the town profiles tell "
        "you what living in each one is actually like."))
    st.append(PageBreak())

    # ---------------------------------------------------------- the region --
    st.append(P("THE LAY OF THE LAND", "kicker"))
    st.append(P("How Northern Colorado is laid out", "h1"))
    st.append(P(
        "Everything here hangs off one line: Interstate 25, running north–south "
        "along the Front Range. Denver sits at the south end, the Wyoming line at "
        "the north. Almost every town in this guide is defined by how far it is "
        "from that highway and which direction it sits from it.", "lede"))
    st.append(P(
        "<b>West of I-25</b> is the foothills side — Loveland, Fort Collins, "
        "Berthoud, and behind them the canyon and mountain communities like "
        "Masonville, Red Feather Lakes, Estes Park and Lyons. Closer to the "
        "mountains means views, acreage, cooler summers, and a real conversation "
        "about wildfire insurance, wells and septic."))
    st.append(P(
        "<b>East of I-25</b> is the plains side — Windsor, Timnath, Severance, "
        "Wellington, Eaton, Greeley and out toward Morgan County. This is where "
        "most of the new construction is, which means newer homes, more land per "
        "dollar, master-planned neighbourhoods, and metropolitan districts."))
    st.append(P(
        "<b>South along I-25</b> the region blends into the Denver metro — Erie, "
        "Frederick, Firestone, Dacono, Mead, Longmont, and Boulder County. People "
        "who work in Denver or Boulder but want Northern Colorado prices tend to "
        "land in this band."))
    st.append(P(
        "Two practical consequences. First, \"Northern Colorado\" is not one "
        "market — a Boulder County buyer and a Weld County buyer are shopping in "
        "different worlds. Second, your commute is decided less by miles than by "
        "which side of I-25 you are on and which highway you feed onto."))

    st.append(P("The counties, briefly", "h2"))
    county_blurbs = [
        ("Larimer County", "Fort Collins and Loveland anchor it. Foothills access, "
         "Colorado State University, the most established in-town neighbourhoods, "
         "and the mountain communities behind them."),
        ("Weld County", "The growth engine. Windsor, Timnath, Severance, Eaton, "
         "Greeley. Most of the region's new construction, the most land per dollar, "
         "and the highest likelihood of a metro district."),
        ("Boulder County", "Boulder, Longmont, Louisville, Lafayette, Lyons, "
         "Nederland. The most expensive tier in this guide and the strongest "
         "Denver/Boulder job access."),
        ("Broomfield, Denver, Adams, Arapahoe, Jefferson",
         "The southern end, where Northern Colorado becomes the Denver metro. "
         "Included because the commute question runs both ways."),
        ("Morgan County", "Fort Morgan, Brush, Wiggins, Log Lane Village. Further "
         "east and genuinely rural, at prices nothing on the Front Range matches."),
    ]
    rows = [[Paragraph("County", S["cell_head"]),
             Paragraph("What defines it", S["cell_head"])]]
    for n, d in county_blurbs:
        rows.append([Paragraph(f"<b>{esc(n)}</b>", S["cell"]),
                     Paragraph(esc(d), S["cell"])])
    t = Table(rows, colWidths=[1.75 * inch, 4.85 * inch], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), CHARCOAL),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, CREAM]),
        ("LINEBELOW", (0, 1), (-1, -2), 0.4, RULE),
    ]))
    st.append(t)
    st.append(PageBreak())

    # ------------------------------------------------------- town profiles --
    st.append(P("TOWN BY TOWN", "kicker"))
    st.append(P("What living in each town is like", "h1"))
    st.append(P(
        f"All {town_total} towns, grouped by county. Every school district and "
        f"commute figure below is the same data the town pages on my website "
        f"carry, which means it is maintained rather than typed once into a PDF. "
        f"Where a town is growing fast or something specific is being built, that "
        f"is noted — those are the facts that change what a place feels like in "
        f"five years.", "lede"))
    st.append(P(
        "<b>One caution on schools.</b> The district serves the town; attendance "
        "boundaries decide which school a specific address feeds into, and they do "
        "not follow town lines. If a particular school is driving your move, send "
        "me the shortlist and I will check the boundary on each address before you "
        "tour it.", "small"))

    for county_name, towns in counties:
        st.append(Spacer(1, 0.16 * inch))
        st.append(P(esc(county_name).upper(), "kicker"))
        st.append(Table(
            [[""]], colWidths=[6.6 * inch], rowHeights=[1.4],
            style=TableStyle([("BACKGROUND", (0, 0), (-1, -1), ROSE)])))
        for town, info in towns:
            block = [Paragraph(esc(town), S["town_name"])]
            desc = _first_sentence(info.get("welcome"))
            if desc:
                block.append(Paragraph(esc(desc), S["body"]))
            if info.get("school_district"):
                block.append(Paragraph(
                    f"<b>Schools:</b> {esc(info['school_district'])}",
                    S["town_meta"]))
            if info.get("commute"):
                block.append(Paragraph(
                    f"<b>Commute:</b> {esc(info['commute'])}", S["town_meta"]))
            if info.get("relocate_extra"):
                block.append(Paragraph(
                    f"<b>Worth knowing:</b> {esc(info['relocate_extra'])}",
                    S["town_meta"]))
            st.append(KeepTogether(block))

    st.append(PageBreak())

    # ------------------------------------------------- at-a-glance table --
    st.append(P("NARROW IT DOWN", "kicker"))
    st.append(P("Schools and commute, at a glance", "h1"))
    st.append(P(
        "The fastest way to get from thirty towns to four. Find the school "
        "districts you would accept, then read the commute column.", "lede"))
    rows = [[Paragraph("Town", S["cell_head"]),
             Paragraph("County", S["cell_head"]),
             Paragraph("School district", S["cell_head"]),
             Paragraph("Commute", S["cell_head"])]]
    for county_name, towns in counties:
        short_county = county_name.replace(" County", "")
        for town, info in towns:
            rows.append([
                Paragraph(f"<b>{esc(town)}</b>", S["cell"]),
                Paragraph(esc(short_county), S["cell"]),
                Paragraph(esc(info.get("school_district") or "—"), S["cell"]),
                Paragraph(esc(info.get("commute") or "—"), S["cell"]),
            ])
    t = Table(rows, colWidths=[1.0 * inch, 0.72 * inch, 1.7 * inch, 3.18 * inch],
              repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), CHARCOAL),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, CREAM]),
        ("LINEBELOW", (0, 1), (-1, -2), 0.35, RULE),
    ]))
    st.append(t)
    st.append(PageBreak())

    # ------------------------------------------------ buying out of state --
    st.append(P("THE PROCESS", "kicker"))
    st.append(P("Buying from a thousand miles away", "h1"))
    st.append(P(
        "Roughly half my business is people who do not live here yet. The process "
        "works, but it works differently from buying across town, and the "
        "difference is mostly about sequencing.", "lede"))

    st.append(P("Make the first trip a scouting trip, not a shopping trip", "h2"))
    st.append(P(
        "The instinct is to fly in and look at houses. That wastes the trip. On a "
        "first visit we drive towns, not listings — you spend a day feeling the "
        "difference between the foothills side and the plains side, sitting in the "
        "actual commute at the actual hour, walking two or three downtowns. People "
        "who do this eliminate half the map in one day and stop second-guessing "
        "later."))

    st.append(P("Then tour on one focused trip", "h2"))
    st.append(P(
        "Once you know the town, we line up showings in a tight block, with video "
        "walkthroughs on anything that comes up between visits. I film honestly — "
        "including the road noise and the neighbour's RV — because a video that "
        "flatters a house wastes a flight."))

    st.append(P("Writing an offer on a house you have not stood in", "h2"))
    st.append(P(
        "It happens constantly here and it is survivable, with two protections: a "
        "real inspection period, and a walkthrough clause that lets you out if the "
        "house is materially not what the video showed. What you should not do is "
        "waive inspection to win a bidding war on a home you have only seen on a "
        "screen. In this market that is rarely what wins anyway — pricing and "
        "terms usually matter more than speed."))

    st.append(P("Lending, before anything else", "h2"))
    st.append(P(
        "Get fully underwritten with a lender who has actually closed Colorado "
        "loans, not just pre-qualified. Out-of-state buyers get beaten by local "
        "buyers on identical offers when the lender is an unknown quantity to the "
        "listing agent. I am happy to hand you two or three names; I do not take a "
        "referral fee on any of them."))

    st.append(P("Timing the two ends", "h2"))
    st.append(P(
        "Selling there and buying here rarely lines up cleanly. Bridge financing, "
        "a rent-back to the seller, or a short-term rental on this end are all "
        "normal. Decide which one you are willing to live with before you are "
        "under contract, not during."))
    st.append(PageBreak())

    # -------------------------------------------- Colorado-specific items --
    st.append(P("WHAT SURPRISES PEOPLE", "kicker"))
    st.append(P("The Colorado-specific line items", "h1"))
    st.append(P(
        "These are the things that catch people moving in from other states — not "
        "because anyone hides them, but because they do not exist where you are "
        "coming from.", "lede"))

    st.append(P("Water is its own subject", "h2"))
    st.append(P(
        "In much of this region, especially on acreage, water is not simply "
        "\"connected.\" A property may be on a municipal tap, a rural water "
        "district, or a private well — and well permits carry real limits on what "
        "you may use the water for. A household-use-only permit does not let you "
        "irrigate pasture or water livestock. If your plan involves horses, a "
        "garden of any ambition, or anything green in August, the permit type "
        "matters as much as the acreage. Irrigation shares and ditch rights are a "
        "separate matter again, and they do not automatically travel with the land."))

    st.append(P("Septic, and the inspection at transfer", "h2"))
    st.append(P(
        "Plenty of homes out here are on a septic system rather than sewer. "
        "Counties in this region generally require an inspection of the system "
        "when a property changes hands, and a failed system can be a five-figure "
        "repair. The rules are set county by county and do change, so I confirm "
        "the current requirement for the specific county before we are under "
        "contract rather than relying on what was true last year."))

    st.append(P("Metropolitan districts — the tax nobody mentions", "h2"))
    st.append(P(
        "This is the single most common unpleasant surprise in new construction "
        "here. Many master-planned neighbourhoods, particularly in Weld County, "
        "sit inside a metropolitan district that levies an additional mill levy on "
        "your property tax to pay off the infrastructure bonds — on top of any HOA "
        "dues. Two identical houses in two neighbourhoods can carry materially "
        "different annual costs for this reason alone. It is disclosed, it is "
        "legal, and it is easy to miss. Ask for the mill levy and the district's "
        "debt service on anything new, and read it next to the HOA budget."))

    st.append(P("Radon", "h2"))
    st.append(P(
        "Much of the Front Range sits in a high-radon area. This is normal here "
        "and mitigation is routine and not expensive relative to the house. Test "
        "during your inspection period; do not skip it because the seller says the "
        "basement is dry. Those are unrelated facts."))

    st.append(P("Wildfire, and what it does to insurance", "h2"))
    st.append(P(
        "If you are looking at the foothills or canyon communities — Masonville, "
        "Red Feather Lakes, Estes Park, Lyons, Nederland — get an insurance quote "
        "before you fall in love, not after. Availability and pricing in higher-risk "
        "areas have tightened considerably, and it is far better to learn that "
        "while you still have options than during your contract."))

    st.append(P("Altitude, and the things it quietly affects", "h2"))
    st.append(P(
        "Swamp coolers instead of air conditioning in older homes. Sun exposure "
        "that ages roofs, decks and exterior paint faster than you expect. Hail — "
        "this is one of the more active hail corridors in the country, so roof age "
        "and material belong on your diligence list, and so does the difference "
        "between replacement cost and actual cash value on the policy."))
    st.append(PageBreak())

    # -------------------------------------------------------- the numbers --
    st.append(P("WHAT IT COSTS", "kicker"))
    st.append(P("Why there is no price table in this guide", "h1"))
    st.append(P(
        "You will find other relocation guides for this area with a median price "
        "printed in them. Check the date on those numbers. A median typed into a "
        "PDF is accurate for about a month and then it is just decoration — and "
        "you would be making a six-figure decision on it.", "lede"))
    st.append(P(
        "My website solves this differently. It reads the IRES MLS feed directly, "
        "so every town page carries that town's live active inventory and its "
        "current median asking price, recomputed as listings change rather than "
        "typed in once. That is the number worth having, and it cannot live in a "
        "document you downloaded in August."))
    st.append(P("Where to look instead", "h2"))
    for label, url, why in [
        ("Any town page",
         f"{b.SITE['domain']}/communities/index.html",
         "Live active listing count and median asking price for that specific "
         "town, plus schools, commute and what is being built."),
        ("The monthly market report",
         f"{b.SITE['domain']}/northern-colorado-market-report.html",
         "Regional medians, days on market and sale-to-list, updated monthly — "
         "and the page tells you how old the figures are instead of pretending "
         "to be current."),
        ("Search homes",
         f"{b.SITE['domain']}/search-homes.html",
         "Every active listing in the region, filterable, straight from the MLS."),
    ]:
        st.append(P(f"<b>{esc(label)}</b> — {esc(why)}<br/>"
                    f"<font color='#B86F7A'>{esc(url)}</font>"))
    st.append(P(
        "Asking prices are not sale prices. What homes actually close for is in "
        "the monthly report, and the gap between the two is one of the more useful "
        "things to understand about a market before you write an offer.", "small"))

    st.append(P("The honest summary on affordability", "h2"))
    st.append(P(
        "Broadly, and this does not change month to month: Boulder County is the "
        "most expensive tier in this guide. Fort Collins, Timnath and Windsor sit "
        "above Loveland and Greeley. Wellington, Severance, Eaton and the smaller "
        "Weld County towns are where new construction meets accessible pricing. "
        "Morgan County is a genuinely different price world. Foothills acreage is "
        "priced on land and views rather than square footage, which is why it does "
        "not compare cleanly to anything in town."))
    st.append(PageBreak())

    # ----------------------------------------------------------- next step --
    st.append(P("NEXT", "kicker"))
    st.append(P("What to do with this", "h1"))
    st.append(P(
        "Pick four towns from the table. Then send them to me and tell me what you "
        "are optimising for — a school, a commute, land, a budget, a feeling. I "
        "will tell you which of the four actually fits, and I will tell you if the "
        "answer is a fifth town you have not considered.", "lede"))
    st.append(P(
        "There is no obligation attached to that conversation and no drip campaign "
        "waiting on the other side of it. You are making a decision that is hard "
        "to reverse, months before you need an agent. Getting it right is worth a "
        "phone call either way."))

    st.append(Spacer(1, 0.14 * inch))
    rows = [
        [Paragraph("<b>Call or text</b>", S["cell"]),
         Paragraph(esc(b.SITE["phone"]), S["cell"])],
        [Paragraph("<b>Email</b>", S["cell"]),
         Paragraph(esc(b.SITE["email"]), S["cell"])],
        [Paragraph("<b>Website</b>", S["cell"]),
         Paragraph(esc(b.SITE["domain"].replace("https://", "")), S["cell"])],
        [Paragraph("<b>Brokerage</b>", S["cell"]),
         Paragraph(esc(b.SITE["brokerage"]), S["cell"])],
    ]
    t = Table(rows, colWidths=[1.3 * inch, 5.3 * inch])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, 0), (-1, -1), CREAM),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, colors.white),
    ]))
    st.append(t)

    st.append(Spacer(1, 0.2 * inch))
    st.append(P(
        "Also on the website: an interactive map of all nine counties, drive times "
        "measured between real addresses, a walkability score for every town, video "
        "tours of the towns and of local restaurants and trails, a neighbourhood "
        "quiz that matches you against real towns, and a mortgage calculator.",
        "small"))
    st.append(Spacer(1, 0.12 * inch))
    st.append(P(
        f"Town data in this guide is generated from the same source that powers "
        f"the {esc(b.SITE['domain'].replace('https://', ''))} town pages, so it is "
        f"maintained rather than written once. Nothing in here is a substitute for "
        f"advice from a licensed inspector, lender, insurer, surveyor or attorney "
        f"on a specific property. Equal Housing Opportunity.", "small"))

    doc.build(st)
    size = os.path.getsize(OUT_PATH)
    # doc.page is the final page number reportlab actually laid out -- reported
    # because it is the one number that catches a layout regression (a table
    # that stopped fitting, a style change that doubled the leading) without
    # anyone opening the file.
    print(f"wrote {os.path.relpath(OUT_PATH, ROOT)}  "
          f"({size / 1024:.0f}KB, {doc.page} pages, {town_total} towns, "
          f"{len(counties)} counties)")


if __name__ == "__main__":
    build()
