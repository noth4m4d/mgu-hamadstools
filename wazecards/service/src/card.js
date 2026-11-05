'use strict';
/**
 * card.js - find Waze's turn and arrival cards in a CarPlay frame and lay them out for the cluster.
 *
 * Pure functions on a raw winston-grabber frame (1920x720, 4 bytes per pixel, BGRA). Node 8.
 * The geometry was measured on Waze's full-screen CarPlay map (night theme) on a G20 MGU.
 */

const SCREEN = { w: 1920, h: 720 };

const DEFAULTS = {
    turn: { x: 1111, y: 14, w: 654, h: 221, radius: 48 },
    arrival: { x: 1111, y: 545, w: 652, h: 163, radius: 48 },
};

/* luminance of the pixel at x, y (BGRA) */
function lum(buf, x, y) {
    const i = (y * SCREEN.w + x) * 4;
    return (buf[i + 2] * 77 + buf[i + 1] * 150 + buf[i] * 29) >> 8;
}

function channels(buf, x, y) {
    const i = (y * SCREEN.w + x) * 4;
    return [buf[i + 2], buf[i + 1], buf[i]];
}

/* share of sampled pixels inside r (inset away from the rounded corners) that pass test */
function share(buf, r, inset, step, test) {
    let hit = 0, all = 0;
    for (let y = r.y + inset; y < r.y + r.h - inset; y += step) {
        for (let x = r.x + inset; x < r.x + r.w - inset; x += step) {
            all++;
            if (test(buf, x, y)) hit++;
        }
    }
    return all ? hit / all : 0;
}

const isBlack = (buf, x, y) => Math.max.apply(null, channels(buf, x, y)) < 24;
const isWhite = (buf, x, y) => Math.min.apply(null, channels(buf, x, y)) > 190;

/* the longest run of black pixels down column x: { at, len } */
function blackRun(buf, x) {
    let len = 0, at = -1, run = 0;
    for (let y = 0; y < SCREEN.h; y++) {
        if (isBlack(buf, x, y)) {
            if (++run > len) { len = run; at = y - run + 1; }
        } else {
            run = 0;
        }
    }
    return { at, len };
}

const MIN_CARD_H = 100;     // "Proceed to route": one line, no arrow
const MAX_CARD_H = 330;     // a turn with a "then ..." line under it
const MIN_CARD_W = 380;

/* how far a rounded corner of radius rad cuts in, at off px from the side */
function cornerCut(rad, off) {
    return off >= rad ? 0 : rad - Math.sqrt(rad * rad - (rad - off) * (rad - off));
}

/**
 * Where the turn card is now, and its size. Waze moves it down when its top button bar (Stop, search,
 * ...) shows, and its height and width change with what it says. The card's left edge stays put:
 *   1. its height, from the column just inside the left edge (left of the arrow and the text),
 *      which is black from top to bottom but for the rounded corners;
 *   2. its width, from a row near the bottom (below the text) where the black ends;
 *   3. checks: all four inner corners black, and a column inside the right end black for the same
 *      height. A card in the middle of Waze's slide fails them and is skipped.
 * Returns the card's rect, or null.
 */
function locateTurn(buf, g) {
    const t = (g || DEFAULTS).turn;
    const rad = t.radius;

    const leftCut = cornerCut(rad, 14);
    const left = blackRun(buf, t.x + 14);
    const h = Math.round(left.len + 2 * leftCut);
    if (left.at < 0 || h < MIN_CARD_H || h > MAX_CARD_H) return null;
    const y = Math.max(0, Math.round(left.at - leftCut));
    if (isBlack(buf, t.x - 6, y + (h >> 1))) return null;            // the black must start at its left edge

    const row = y + h - 20;
    let end = t.x + 14;
    while (end < SCREEN.w - 1 && isBlack(buf, end + 1, row)) end++;
    const w = Math.round(end - t.x + 1 + cornerCut(rad, 20));
    if (w < MIN_CARD_W || w > t.w + 12) return null;

    const corners = [[t.x + 60, y + 10], [t.x + w - 60, y + 10], [t.x + 60, y + h - 10], [t.x + w - 60, y + h - 10]];
    for (let i = 0; i < corners.length; i++) if (!isBlack(buf, corners[i][0], corners[i][1])) return null;
    // a long street name can reach one of these columns, not both. The one 65 px in is clear of the
    // corner, so where it agrees it gives the exact top and height.
    const fits = (off) => {
        const cut = cornerCut(rad, off), r = blackRun(buf, t.x + w - off);
        const ry = Math.round(r.at - cut), rh = Math.round(r.len + 2 * cut);
        return Math.abs(rh - h) <= 12 && Math.abs(ry - y) <= 12 ? { y: ry, h: rh } : null;
    };
    const exact = fits(65) || fits(30);
    if (!exact) return null;

    return { x: t.x, y: Math.max(0, Math.min(exact.y, SCREEN.h - exact.h)), w: Math.min(w, t.w), h: exact.h, radius: rad };
}

/** The turn card: a solid black box with white text (arrow, distance, street), wherever Waze put it. */
function hasTurn(buf, g) {
    const r = locateTurn(buf, g);
    if (!r) return { found: false, black: 0, white: 0, rect: null };
    const black = share(buf, r, 30, 6, isBlack);
    const white = share(buf, r, 30, 6, isWhite);
    return { found: black >= 0.75 && white >= 0.01 && white <= 0.3, black, white, rect: r };
}

/** The arrival card: an even dark-grey panel with a 1-px dark edge at each side and white text. */
function hasArrival(buf, g) {
    const r = (g || DEFAULTS).arrival;
    const panel = share(buf, r, 30, 6, (b, x, y) => { const l = lum(b, x, y); return l >= 48 && l <= 90; });
    const white = share(buf, r, 30, 6, isWhite);
    // the edge is 1 px wide and its column shifts by a pixel along the card: take the darkest of 4
    const darkest = (x, y) => Math.min(lum(buf, x - 2, y), lum(buf, x - 1, y), lum(buf, x, y), lum(buf, x + 1, y));
    let edge = 0, n = 0;
    for (let y = r.y + 25; y < r.y + r.h - 25; y += 6) {
        n += 2;
        if (darkest(r.x - 1, y) < 35) edge++;
        if (darkest(r.x + r.w, y) < 35) edge++;
    }
    const edges = n ? edge / n : 0;
    return { found: panel >= 0.6 && white >= 0.005 && white <= 0.3 && edges >= 0.5, panel, white, edges };
}

/** Size of each card's layer on the cluster at these scales: { turn: {w, h}, arrival: {w, h} }. */
function sizes(turnScale, arrivalScale, g) {
    g = g || DEFAULTS;
    return {
        turn: { w: Math.round(g.turn.w * turnScale), h: Math.round(g.turn.h * turnScale) },
        arrival: { w: Math.round(g.arrival.w * arrivalScale), h: Math.round(g.arrival.h * arrivalScale) },
    };
}

/* alpha (0..1) of a rounded rectangle w x h with corner radius rad at pixel x, y; 1 px anti-aliased edge */
function cornerAlpha(x, y, w, h, rad) {
    const cx = x < rad ? rad : (x > w - 1 - rad ? w - 1 - rad : x);
    const cy = y < rad ? rad : (y > h - 1 - rad ? h - 1 - rad : y);
    const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
    return d <= rad - 1 ? 1 : (d >= rad ? 0 : rad - d);
}

/* draw src rect r (BGRA frame) scaled into dst (RGBA, dw wide) at box b, bilinear, with rounded corners */
function blit(buf, r, dst, dw, b) {
    const sx = r.w / b.w, sy = r.h / b.h;
    for (let y = 0; y < b.h; y++) {
        const fy = Math.min(r.h - 1.001, (y + 0.5) * sy - 0.5);
        const y0 = Math.max(0, Math.floor(fy)), ty = Math.max(0, fy - y0);
        for (let x = 0; x < b.w; x++) {
            const fx = Math.min(r.w - 1.001, (x + 0.5) * sx - 0.5);
            const x0 = Math.max(0, Math.floor(fx)), tx = Math.max(0, fx - x0);
            const i00 = ((r.y + y0) * SCREEN.w + r.x + x0) * 4, i10 = i00 + 4;
            const i01 = i00 + SCREEN.w * 4, i11 = i01 + 4;
            const o = ((b.y + y) * dw + b.x + x) * 4;
            for (let c = 0; c < 3; c++) {
                // BGRA source channel 2-c is RGBA channel c
                const s0 = buf[i00 + 2 - c] * (1 - tx) + buf[i10 + 2 - c] * tx;
                const s1 = buf[i01 + 2 - c] * (1 - tx) + buf[i11 + 2 - c] * tx;
                dst[o + c] = Math.round(s0 * (1 - ty) + s1 * ty);
            }
            dst[o + 3] = Math.round(255 * cornerAlpha(x, y, b.w, b.h, b.radius));
        }
    }
}

/**
 * The turn card's layer image (RGBA, transparent around the card). rect comes from hasTurn(). The
 * layer is sized for the usual card at this scale; the card keeps its proportions, top-aligned: a
 * shorter card ("Proceed to route") leaves a gap below it, a taller one is drawn smaller to fit.
 */
function composeTurn(buf, rect, scale, g) {
    const L = sizes(scale, scale, g).turn;
    const out = Buffer.alloc(L.w * L.h * 4);
    const s = Math.min(scale, L.h / rect.h);
    const w = Math.round(rect.w * s), h = Math.round(rect.h * s);
    blit(buf, rect, out, L.w, { x: Math.round((L.w - w) / 2), y: 0, w, h, radius: rect.radius * s });
    return { w: L.w, h: L.h, rgba: out };
}

/* panel colours of the see-through cards (RGB), measured on the car */
const PANEL = {
    arrival: [55, 67, 81],          // Waze's arrival card
    dashCard: [45, 46, 64],         // the Dashboard guidance card
    dashThen: [71, 72, 90],         // its "then" strip
    dashEta: [53, 66, 80],          // the Dashboard ETA pill
};

/**
 * Redraw a see-through card solid, in place: its white text and icons on a plain panel colour.
 * The map moving behind a see-through card changes every pixel of it all the time, so its picture
 * would be sent to the cluster on every frame and the map would show through on the cluster too.
 * bgAt(y) is the panel colour for row y. A pixel's brightness above the panel's says how much
 * text is in it (anti-aliased edges included).
 */
function solidify(img, bgAt) {
    for (let y = 0; y < img.h; y++) {
        const bg = bgAt(y);
        const bl = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
        const lo = bl + 25, hi = 235;
        for (let x = 0; x < img.w; x++) {
            const o = (y * img.w + x) * 4;
            if (!img.rgba[o + 3]) continue;
            const l = 0.299 * img.rgba[o] + 0.587 * img.rgba[o + 1] + 0.114 * img.rgba[o + 2];
            const t = l <= lo ? 0 : (l >= hi ? 1 : (l - lo) / (hi - lo));
            for (let c = 0; c < 3; c++) img.rgba[o + c] = Math.round(bg[c] + (255 - bg[c]) * t);
        }
    }
    return img;
}

/** The arrival card's layer image (RGBA), redrawn solid. */
function composeArrival(buf, scale, g) {
    g = g || DEFAULTS;
    const L = sizes(scale, scale, g).arrival;
    const out = Buffer.alloc(L.w * L.h * 4);
    blit(buf, g.arrival, out, L.w, { x: 0, y: 0, w: L.w, h: L.h, radius: g.arrival.radius * scale });
    return solidify({ w: L.w, h: L.h, rgba: out }, () => PANEL.arrival);
}

/** The Dashboard guidance card's layer image (with its "then" strip when shown), redrawn solid. */
function composeDashCard(buf, d, scale) {
    const img = composeRect(buf, d.card, scale, d.card.radius);
    const split = Math.round(DASH.card.mainH * scale);
    return solidify(img, (y) => (y < split ? PANEL.dashCard : PANEL.dashThen));
}

/** The Dashboard ETA pill's layer image, redrawn solid. */
function composeDashEta(buf, d, scale) {
    return solidify(composeRect(buf, d.eta, scale, d.eta.radius), () => PANEL.dashEta);
}

/* ---------- CarPlay's Dashboard view ----------
 * In Dashboard view iOS draws the guidance card itself (top-left tile, grey-blue, with a lighter
 * "then" strip for the turn after) and Waze's map tile shows a one-line ETA pill at its bottom.
 * Measured on a G20 MGU, 1920x720. */
const DASH = {
    gapX: 729,                                          // the dark gap between the left tiles and the map tile
    card: { x: 12, y: 12, w: 712, mainH: 246, thenH: 97, radius: 44 },
    eta: { x: 950, y: 606, w: 610, h: 89, radius: 44 },  // the pill, trimmed to its text
};

const inRange = (lo, hi) => (b, x, y) => { const l = lum(b, x, y); return l >= lo && l <= hi; };

/**
 * The Dashboard view's guidance card and ETA pill, while navigating. All of: the Dashboard's dark gap,
 * a grey-blue card with white text in the top-left tile, and the ETA pill (shown only while guiding).
 * Returns { found, then, card (rect, with the "then" strip when shown), eta (rect), and the shares }.
 */
function hasDashboard(buf) {
    // the gap is a few px wide and widens at the tiles' rounded corners: the darkest of x 724-734
    let gap = 0, n = 0;
    for (let y = 30; y < 690; y += 6) {
        n++;
        let dark = 255;
        for (let x = DASH.gapX - 5; x <= DASH.gapX + 5; x++) dark = Math.min(dark, lum(buf, x, y));
        if (dark < 30) gap++;
    }
    const gapShare = gap / n;
    const c = DASH.card;
    const main = { x: c.x, y: c.y, w: c.w, h: c.mainH };
    const panel = share(buf, main, 30, 6, (b, x, y) => {
        const ch = channels(b, x, y), l = lum(b, x, y);
        return l >= 36 && l <= 62 && ch[2] - ch[0] >= 8;          // grey with a blue cast
    });
    const white = share(buf, main, 30, 6, isWhite);
    const e = DASH.eta;
    const pill = share(buf, { x: 760, y: e.y + 10, w: 190, h: e.h - 20 }, 0, 4, inRange(52, 72));
    const etaText = share(buf, e, 10, 4, isWhite);
    const found = gapShare >= 0.85 && panel >= 0.6 && white >= 0.01 && white <= 0.3 && pill >= 0.8 && etaText >= 0.01 && etaText <= 0.4;
    // the "then" strip: lighter than the card, below its main part (left of its arrow, right of "then")
    const thenShare = share(buf, { x: 140, y: c.y + c.mainH + 8, w: 460, h: c.thenH - 16 }, 0, 6, inRange(64, 88));
    const then = thenShare >= 0.6;
    return {
        found, then, gap: gapShare, panel, white, pill, etaText,
        card: { x: c.x, y: c.y, w: c.w, h: c.mainH + (then ? c.thenH : 0), radius: c.radius },
        eta: { x: e.x, y: e.y, w: e.w, h: e.h, radius: e.radius },
    };
}

/** Any rect of the frame scaled by scale, with rounded corners of radius rad (RGBA layer image). */
function composeRect(buf, rect, scale, rad) {
    const w = Math.round(rect.w * scale), h = Math.round(rect.h * scale);
    const out = Buffer.alloc(w * h * 4);
    blit(buf, rect, out, w, { x: 0, y: 0, w, h, radius: (rad || 0) * scale });
    return { w, h, rgba: out };
}

/* ---------- Waze's map, for the cluster's map area ----------
 * The map area (cluster-render's `map` target) is 1088x480. The crops keep the map's proportions,
 * centre the car, and leave out Waze's own buttons and cards (full screen: the buttons on the left,
 * the cards from x 1111; Dashboard: the map tile only, above its ETA pill). */
const MAP = {
    w: 1088, h: 480,
    // centred left-right on Waze's car arrow (x ~615) at about 1:1. The right edge takes in a sliver
    // of Waze's cards, which sits under the cluster's right gauge
    full: { x: 65, y: 235, w: 1100, h: 485 },
    dash: { x: 745, y: 160, w: 1000, h: 441 },
};

const mapTables = {};
/* for each output column and row, the frame column and row it is sampled from (worked out once a crop) */
function tablesFor(rect) {
    const k = `${rect.x},${rect.y},${rect.w},${rect.h}`;
    if (mapTables[k]) return mapTables[k];
    const xs = new Int32Array(MAP.w), ys = new Int32Array(MAP.h);
    for (let x = 0; x < MAP.w; x++) xs[x] = (rect.x + Math.min(rect.w - 1, Math.floor((x + 0.5) * rect.w / MAP.w))) * 4;
    for (let y = 0; y < MAP.h; y++) ys[y] = (rect.y + Math.min(rect.h - 1, Math.floor((y + 0.5) * rect.h / MAP.h))) * SCREEN.w * 4;
    mapTables[k] = { xs, ys };
    return mapTables[k];
}

/** Bytes of one map frame for cluster-render's video layer: a 4:2:0 atlas of 1088x480. */
const MAP_ATLAS_BYTES = MAP.w * MAP.h * 3 / 2;

/**
 * The map crop rect of the frame (BGRA) into atlas, cluster-render's 4:2:0 video frame: Y (w x h),
 * then U and V side by side (w/2 each) in h/2 rows. BT.601, full range. Nearest sampling: the crop
 * is only about 1.1x enlarged.
 */
function composeMap(buf, rect, atlas) {
    const W = MAP.w, H = MAP.h, t = tablesFor(rect);
    for (let y = 0; y < H; y++) {
        const row = t.ys[y], o = y * W;
        for (let x = 0; x < W; x++) {
            const i = row + t.xs[x];
            atlas[o + x] = (buf[i + 2] * 77 + buf[i + 1] * 150 + buf[i] * 29) >> 8;
        }
    }
    const C = W * H, half = W >> 1;
    for (let y = 0; y < (H >> 1); y++) {
        const row = t.ys[y * 2], o = C + y * W;
        for (let x = 0; x < half; x++) {
            const i = row + t.xs[x * 2];
            const r = buf[i + 2], g = buf[i + 1], b = buf[i];
            atlas[o + x] = ((-43 * r - 85 * g + 128 * b) >> 8) + 128;
            atlas[o + half + x] = ((128 * r - 107 * g - 21 * b) >> 8) + 128;
        }
    }
    return atlas;
}

module.exports = {
    SCREEN, DEFAULTS, DASH, MAP, MAP_ATLAS_BYTES, locateTurn, hasTurn, hasArrival, hasDashboard, sizes,
    composeTurn, composeArrival, composeDashCard, composeDashEta, composeRect, composeMap,
};
