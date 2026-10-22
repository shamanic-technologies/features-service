/**
 * THE MARK OF A WORKFLOW OR A TEMPLATE (owner 2026-10-22, MARKS-1022: « Je veux que chaque template ait son icône »).
 *
 * Every workflow dynasty and every template dynasty has its OWN icon + colour, the same pair everywhere it is named
 * (leg workflow ranking, leg writer ranking, Research catalogue, agent catalogue). Same rule as a catalogue name
 * (`lib/sales-path-names.ts`): assigned ON FIRST SIGHT, written once to `catalogue_marks` (`lib/catalogue-marks-store.ts`)
 * and never moved, so a mark never changes object nor gets given twice inside its family. Nothing is derived from a
 * slug at read time: growing the pool changes only what the NEXT new object receives.
 *
 * A mark = a Phosphor icon name from `MARK_ICONS` (every name checked against `@phosphor-icons/react` 2.1.10; the
 * dashboard draws icons by Phosphor name, like every other catalogue icon) + a colour from `GLYPH_COLORS` (the
 * catalogue's family-glyph colours). The first `MARK_ICONS.length` objects of a family each get a DIFFERENT icon;
 * after that an icon comes back in another colour, so the (icon, colour) pair stays unique per family up to
 * icons × colours. Past that the family is exhausted: loud, never a reused pair.
 */

/** The catalogue's glyph colours (also the family glyphs', `lib/agent-catalogue.ts` `glyphColorOf`). */
export const GLYPH_COLORS = ["#E0784B", "#8E6CD8", "#3FA27E", "#D6A21E", "#3D7FD0", "#D9577A", "#9C6B3E", "#5E9E3A", "#2F9DB3", "#C2563A"] as const;

/** Append-only in spirit: add icons at the END (a mark already given stays given whatever happens here). */
export const MARK_ICONS: readonly string[] = [
  "acorn",
  "airplane-tilt",
  "alien",
  "anchor",
  "aperture",
  "apple-logo",
  "atom",
  "avocado",
  "axe",
  "baby-carriage",
  "balloon",
  "barbell",
  "barn",
  "baseball",
  "basket",
  "basketball",
  "bathtub",
  "beach-ball",
  "beer-stein",
  "bell-simple",
  "bicycle",
  "binoculars",
  "boat",
  "bone",
  "book-open",
  "boot",
  "bowl-food",
  "bowling-ball",
  "brain",
  "bread",
  "bridge",
  "briefcase",
  "broom",
  "bug-beetle",
  "butterfly",
  "cactus",
  "cake",
  "calculator",
  "camera",
  "campfire",
  "car-profile",
  "carrot",
  "castle-turret",
  "cat",
  "cherries",
  "church",
  "cloud-sun",
  "clover",
  "coat-hanger",
  "coffee",
  "coin-vertical",
  "compass",
  "cookie",
  "cow",
  "crown",
  "cube",
  "dog",
  "diamond",
  "dice-five",
  "disc",
  "dna",
  "door-open",
  "dress",
  "drop",
  "ear",
  "egg",
  "eye",
  "factory",
  "feather",
  "fire",
  "fish",
  "flag-pennant",
  "flame",
  "flashlight",
  "flower",
  "flower-lotus",
  "flower-tulip",
  "football",
  "footprints",
  "fork-knife",
  "game-controller",
  "garage",
  "gear-six",
  "ghost",
  "gift",
  "globe-hemisphere-west",
  "graduation-cap",
  "guitar",
  "hammer",
  "hand-fist",
  "hand-peace",
  "hard-hat",
  "headphones",
  "heart",
  "hexagon",
  "horse",
  "hourglass",
  "ice-cream",
  "island",
  "jeep",
  "key",
  "keyboard",
  "knife",
  "lamp",
  "leaf",
  "lighthouse",
  "lightbulb",
  "lock-key",
  "magic-wand",
  "magnet",
  "mask-happy",
  "medal-military",
  "microscope",
  "moon-stars",
  "mountains",
  "mouse-simple",
  "music-notes",
  "needle",
  "nut",
  "orange-slice",
  "package",
  "paint-brush",
  "palette",
  "paper-plane-tilt",
  "parachute",
  "paw-print",
  "pen-nib",
  "pencil-simple",
  "pepper",
  "person-simple-bike",
  "piano-keys",
  "picnic-table",
  "pinwheel",
  "pizza",
  "planet",
  "plant",
  "popcorn",
  "potted-plant",
  "puzzle-piece",
  "rabbit",
  "radio",
  "rainbow",
  "rocket-launch",
  "rows",
  "ruler",
  "sailboat",
  "scissors",
  "screwdriver",
  "shield-star",
  "shovel",
  "shrimp",
  "skull",
  "snowflake",
  "soccer-ball",
  "spade",
  "spiral",
  "star-four",
  "stool",
  "student",
  "sun-horizon",
  "sunglasses",
  "sword",
  "t-shirt",
  "taxi",
  "tennis-ball",
  "tent",
  "test-tube",
  "tipi",
  "tooth",
  "tote",
  "tractor",
  "train",
  "tree",
  "tree-evergreen",
  "tree-palm",
  "trophy",
  "truck",
  "umbrella",
  "volleyball",
  "watch",
  "wind",
  "wine",
  "wrench",
  "yin-yang",
  "lego",
  "cheese",
  "sneaker",
  "goggles",
  "hamburger",
  "lifebuoy",
  "windmill",
  "disco-ball",
  "martini",
  "champagne",
  "popsicle",
  "cards",
  "armchair",
  "flask",
  "ladder",
  "piggy-bank",
];

/** The objects that carry a mark of their own. A key is the object's dynasty slug (a template on its own: its id). */
export type MarkFamily = "workflow" | "template";
export const MARK_FAMILIES: readonly MarkFamily[] = ["workflow", "template"];

export interface CatalogueMark {
  icon: string;
  color: string;
}

export class MarkPoolExhaustedError extends Error {
  constructor(public readonly family: MarkFamily, public readonly missing: number) {
    super(`mark pool exhausted (${family}): ${missing} new object(s) need a mark and every icon x colour of the family is given — add icons at the end of MARK_ICONS (lib/catalogue-marks.ts)`);
    this.name = "MarkPoolExhaustedError";
  }
}

export const markId = (m: CatalogueMark): string => `${m.icon}|${m.color}`;

/** PURE: every mark of a family in the order they are given (round r gives icon i the colour (i + r) mod colours). */
export function* markCandidates(): Generator<CatalogueMark> {
  for (let round = 0; round < GLYPH_COLORS.length; round++) {
    for (let i = 0; i < MARK_ICONS.length; i++) yield { icon: MARK_ICONS[i], color: GLYPH_COLORS[(i + round) % GLYPH_COLORS.length] };
  }
}

/** PURE: the next `count` marks the family has not given (`used` = `markId`s), in candidate order. Throws when short. */
export function nextMarks(family: MarkFamily, used: ReadonlySet<string>, count: number): CatalogueMark[] {
  const out: CatalogueMark[] = [];
  if (count <= 0) return out;
  for (const m of markCandidates()) {
    if (used.has(markId(m))) continue;
    out.push(m);
    if (out.length === count) return out;
  }
  throw new MarkPoolExhaustedError(family, count - out.length);
}
