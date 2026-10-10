/**
 * THE FACE OF A SALES FUNNEL NAME (owner 2026-10-10): a customer-facing funnel name ("Victory") comes with a
 * face the dashboard can show WITHOUT anybody drawing it. Before this, ~76 faces were drawn by hand and lived
 * in the dashboard; a funnel created by the agent at run time had none.
 *
 * A face is a cute manga-style animal head, built procedurally from the NAME alone: the same name always
 * draws the same face (a pure function of the string, no stored state, no randomness), and two names land
 * on different faces in practice (animal x palette x eyes x mouth x accessory = 8 x 10 x 3 x 3 x 5 = 3,600
 * combinations). Served as an SVG at `GET /public/catalogue/faces/:name.svg` and described on the funnel row
 * (`faceOf`), so a reader can show the image or render the same traits itself.
 *
 * Pure: no IO.
 */

export const FACE_ANIMALS = ["cat", "bear", "bunny", "fox", "panda", "mouse", "koala", "tiger"] as const;
export type FaceAnimal = (typeof FACE_ANIMALS)[number];

/** Fur, inner-ear and accent colours (soft, high-key, readable on light and dark backgrounds). */
const PALETTES: ReadonlyArray<{ fur: string; inner: string; accent: string }> = [
  { fur: "#F6C28B", inner: "#F9A8A8", accent: "#E0784B" },
  { fur: "#C9B6F2", inner: "#F5B8D8", accent: "#8E6CD8" },
  { fur: "#A8DCC8", inner: "#F7C0C0", accent: "#3FA27E" },
  { fur: "#F4E1A6", inner: "#F7B2A2", accent: "#D6A21E" },
  { fur: "#B9D7F5", inner: "#F6BCCB", accent: "#3D7FD0" },
  { fur: "#F2B5C4", inner: "#FFE1E8", accent: "#D9577A" },
  { fur: "#D8C3A5", inner: "#F3B8A7", accent: "#9C6B3E" },
  { fur: "#E7E7EC", inner: "#F6C1CF", accent: "#6B6F80" },
  { fur: "#FFD3A5", inner: "#FFB3B3", accent: "#F28C38" },
  { fur: "#BFE6A8", inner: "#F7C6B8", accent: "#5E9E3A" },
];

export const FACE_EYES = ["sparkle", "happy", "wink"] as const;
export const FACE_MOUTHS = ["smile", "cat", "open"] as const;
export const FACE_ACCESSORIES = ["none", "star", "flower", "bow", "crown"] as const;

export interface FaceTraits {
  animal: FaceAnimal;
  /** Main fur colour, `#RRGGBB`. */
  color: string;
  eyes: (typeof FACE_EYES)[number];
  mouth: (typeof FACE_MOUTHS)[number];
  accessory: (typeof FACE_ACCESSORIES)[number];
}

export interface Face extends FaceTraits {
  /** Path of the SVG on this service (`GET /public/catalogue/faces/:name.svg`), the name URL-encoded. */
  svgPath: string;
}

/** FNV-1a 32-bit: stable across processes and releases (never `Math.random`, never a per-boot seed). */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** PURE: the traits a name draws. Each trait reads its own slice of the hash, so they vary independently. */
export function faceTraitsOf(name: string): FaceTraits {
  const h = stableHash(name.trim().toLowerCase());
  const h2 = stableHash(`${name.trim().toLowerCase()}#face`);
  return {
    animal: FACE_ANIMALS[h % FACE_ANIMALS.length],
    color: PALETTES[Math.floor(h / FACE_ANIMALS.length) % PALETTES.length].fur,
    eyes: FACE_EYES[h2 % FACE_EYES.length],
    mouth: FACE_MOUTHS[Math.floor(h2 / 3) % FACE_MOUTHS.length],
    accessory: FACE_ACCESSORIES[Math.floor(h2 / 9) % FACE_ACCESSORIES.length],
  };
}

/** PURE: the face served beside a funnel name. */
export function faceOf(name: string): Face {
  return { ...faceTraitsOf(name), svgPath: `/public/catalogue/faces/${encodeURIComponent(name)}.svg` };
}

const paletteOf = (color: string) => PALETTES.find((p) => p.fur === color) ?? PALETTES[0];

function ears(animal: FaceAnimal, fur: string, inner: string, accent: string): string {
  switch (animal) {
    case "cat":
    case "tiger":
      return `<path d="M22 52 L30 14 L54 36 Z" fill="${fur}"/><path d="M106 52 L98 14 L74 36 Z" fill="${fur}"/><path d="M29 44 L33 24 L46 37 Z" fill="${inner}"/><path d="M99 44 L95 24 L82 37 Z" fill="${inner}"/>`;
    case "fox":
      return `<path d="M18 56 L26 8 L56 34 Z" fill="${accent}"/><path d="M110 56 L102 8 L72 34 Z" fill="${accent}"/><path d="M27 46 L30 20 L47 35 Z" fill="${inner}"/><path d="M101 46 L98 20 L81 35 Z" fill="${inner}"/>`;
    case "bunny":
      return `<ellipse cx="44" cy="22" rx="11" ry="28" fill="${fur}"/><ellipse cx="84" cy="22" rx="11" ry="28" fill="${fur}"/><ellipse cx="44" cy="24" rx="5" ry="19" fill="${inner}"/><ellipse cx="84" cy="24" rx="5" ry="19" fill="${inner}"/>`;
    case "mouse":
      return `<circle cx="26" cy="36" r="22" fill="${fur}"/><circle cx="102" cy="36" r="22" fill="${fur}"/><circle cx="26" cy="36" r="13" fill="${inner}"/><circle cx="102" cy="36" r="13" fill="${inner}"/>`;
    case "koala":
      return `<circle cx="22" cy="46" r="20" fill="${fur}"/><circle cx="106" cy="46" r="20" fill="${fur}"/><circle cx="22" cy="46" r="11" fill="#FFFFFF" opacity="0.8"/><circle cx="106" cy="46" r="11" fill="#FFFFFF" opacity="0.8"/>`;
    case "panda":
      return `<circle cx="32" cy="32" r="15" fill="#2B2B33"/><circle cx="96" cy="32" r="15" fill="#2B2B33"/>`;
    case "bear":
    default:
      return `<circle cx="32" cy="32" r="15" fill="${fur}"/><circle cx="96" cy="32" r="15" fill="${fur}"/><circle cx="32" cy="32" r="8" fill="${inner}"/><circle cx="96" cy="32" r="8" fill="${inner}"/>`;
  }
}

function markings(animal: FaceAnimal, accent: string): string {
  if (animal === "panda") return `<ellipse cx="45" cy="70" rx="13" ry="15" fill="#2B2B33" transform="rotate(-20 45 70)"/><ellipse cx="83" cy="70" rx="13" ry="15" fill="#2B2B33" transform="rotate(20 83 70)"/>`;
  if (animal === "tiger") return `<path d="M64 30 L58 44 L70 44 Z" fill="${accent}"/><path d="M24 70 L38 72 L24 78 Z" fill="${accent}"/><path d="M104 70 L90 72 L104 78 Z" fill="${accent}"/>`;
  if (animal === "fox") return `<path d="M30 84 Q64 120 98 84 Q64 98 30 84 Z" fill="#FFFFFF" opacity="0.85"/>`;
  return "";
}

function eyesSvg(kind: FaceTraits["eyes"]): string {
  const sparkle = (cx: number) =>
    `<ellipse cx="${cx}" cy="70" rx="8" ry="10" fill="#2B2B33"/><circle cx="${cx + 3}" cy="66" r="3.2" fill="#FFFFFF"/><circle cx="${cx - 3}" cy="74" r="1.6" fill="#FFFFFF"/>`;
  const happy = (cx: number) => `<path d="M${cx - 8} 72 Q${cx} 62 ${cx + 8} 72" stroke="#2B2B33" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  if (kind === "happy") return happy(45) + happy(83);
  if (kind === "wink") return sparkle(45) + happy(83);
  return sparkle(45) + sparkle(83);
}

function mouthSvg(kind: FaceTraits["mouth"]): string {
  const nose = `<ellipse cx="64" cy="84" rx="4.5" ry="3.2" fill="#2B2B33"/>`;
  if (kind === "cat") return `${nose}<path d="M56 90 Q60 96 64 90 Q68 96 72 90" stroke="#2B2B33" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  if (kind === "open") return `${nose}<path d="M56 91 Q64 104 72 91 Z" fill="#E2566F" stroke="#2B2B33" stroke-width="2.5" stroke-linejoin="round"/>`;
  return `${nose}<path d="M57 91 Q64 98 71 91" stroke="#2B2B33" stroke-width="3" fill="none" stroke-linecap="round"/>`;
}

function accessorySvg(kind: FaceTraits["accessory"], accent: string): string {
  switch (kind) {
    case "star":
      return `<path d="M98 16 L101.5 25 L111 25.5 L103.5 31.5 L106 41 L98 35.5 L90 41 L92.5 31.5 L85 25.5 L94.5 25 Z" fill="#FFD54A" stroke="#E0A800" stroke-width="1.5"/>`;
    case "flower":
      return `<g transform="translate(96 28)"><circle cx="0" cy="-8" r="6" fill="#FF9EC4"/><circle cx="8" cy="0" r="6" fill="#FF9EC4"/><circle cx="0" cy="8" r="6" fill="#FF9EC4"/><circle cx="-8" cy="0" r="6" fill="#FF9EC4"/><circle r="5" fill="#FFD54A"/></g>`;
    case "bow":
      return `<g transform="translate(64 24)"><path d="M0 0 L-16 -9 L-16 9 Z" fill="${accent}"/><path d="M0 0 L16 -9 L16 9 Z" fill="${accent}"/><circle r="4.5" fill="${accent}" stroke="#FFFFFF" stroke-width="1.5"/></g>`;
    case "crown":
      return `<path d="M46 30 L50 12 L58 24 L64 8 L70 24 L78 12 L82 30 Z" fill="#FFD54A" stroke="#E0A800" stroke-width="2" stroke-linejoin="round"/>`;
    case "none":
    default:
      return "";
  }
}

/** PURE: the SVG of a name's face (128 x 128, transparent background). */
export function faceSvg(name: string): string {
  const t = faceTraitsOf(name);
  const { fur, inner, accent } = paletteOf(t.color);
  const title = name.replace(/[<>&"]/g, "");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    ears(t.animal, fur, inner, accent),
    `<ellipse cx="64" cy="74" rx="46" ry="42" fill="${fur}"/>`,
    markings(t.animal, accent),
    `<ellipse cx="34" cy="86" rx="8" ry="5" fill="${inner}" opacity="0.75"/><ellipse cx="94" cy="86" rx="8" ry="5" fill="${inner}" opacity="0.75"/>`,
    eyesSvg(t.eyes),
    mouthSvg(t.mouth),
    accessorySvg(t.accessory, accent),
    `</svg>`,
  ].join("");
}
