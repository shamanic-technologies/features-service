/**
 * SNAPSHOT of workflow-service's dynasty word list (`src/lib/workflow-dynasty-signature-name.ts` `WORDS`,
 * origin/main 534eb726). Owner rule 2026-10-10: no catalogue name (sales funnel, pipe, sales path) may share a
 * word with a workflow's dynasty name, so every family pool is filtered against this list
 * (`lib/catalogue-names.ts`) and the guard test fails on any overlap. workflow-service only APPENDS words;
 * re-copy this list when it does (a word added there after a name was given here stays given here).
 */
/** The mixed pool every dynasty was named from before 2026-10-10 (534eb726). */
const WORKFLOW_DYNASTY_LEGACY_WORDS: readonly string[] = [
  "andromeda", "orion", "cassiopeia", "lyra", "vega", "sirius", "polaris", "altair", "rigel", "deneb",
  "antares", "arcturus", "betelgeuse", "capella", "canopus", "procyon", "aldebaran", "spica", "regulus",
  "fomalhaut", "achernar", "bellatrix", "mintaka", "alnilam", "alnitak", "mizar", "alcor", "dubhe", "merak",
  "alioth", "sequoia", "baobab", "cypress", "juniper", "cedar", "maple", "willow", "birch", "aspen",
  "magnolia", "acacia", "banyan", "redwood", "hemlock", "linden", "sycamore", "alder", "hazel", "laurel",
  "myrtle", "oleander", "wisteria", "jasmine", "orchid", "dahlia", "peony", "lotus", "iris", "azalea",
  "camellia", "obsidian", "quartz", "onyx", "jade", "topaz", "opal", "garnet", "zircon", "beryl", "pyrite",
  "agate", "jasper", "basalt", "granite", "marble", "slate", "feldspar", "mica", "cobalt", "titanium",
  "chromium", "rhodium", "iridium", "osmium", "bismuth", "galena", "calcite", "dolomite", "gypsum", "flint",
  "avalon", "olympus", "elysium", "arcadia", "valhalla", "asgard", "atlantis", "eldorado", "utopia",
  "shangri-la", "camelot", "hyperion", "lemuria", "midgard", "nirvana", "zion", "eden", "thule", "lyonesse",
  "ithaca", "colchis", "delphi", "knossos", "mycenae", "thebes", "carthage", "persepolis", "palmyra",
  "petra", "angkor", "phoenix", "griffin", "falcon", "osprey", "condor", "albatross", "peregrine", "kestrel",
  "merlin", "harrier", "heron", "crane", "pelican", "cormorant", "kingfisher", "nightingale", "skylark",
  "wren", "swift", "raven", "panther", "jaguar", "leopard", "lynx", "ocelot", "cheetah", "gazelle", "impala",
  "oryx", "ibex", "nautilus", "triton", "nereid", "coral", "tempest", "tsunami", "monsoon", "maelstrom",
  "cascade", "torrent", "fjord", "lagoon", "atoll", "reef", "delta", "estuary", "rapids", "geyser",
  "glacier", "iceberg", "tundra", "permafrost", "aurora", "boreal", "solstice", "equinox", "zenith", "nadir",
  "meridian", "horizon", "summit", "pinnacle", "ridge", "plateau", "mesa", "canyon", "ravine", "caldera",
  "crater", "volcano", "fumarole", "tectonic", "moraine", "cirque", "escarpment", "butte", "bluff",
  "promontory", "archipelago", "isthmus", "peninsula", "strait", "channel", "basin", "watershed",
  "tributary", "confluence", "headwater", "nebula", "pulsar", "quasar", "nova", "cosmos", "stellar", "lunar",
  "solar", "astral", "celestial", "twilight", "dusk", "dawn", "daybreak", "nightfall", "starlight",
  "moonbeam", "sunburst", "rainbow", "prism", "spectrum", "halo", "corona", "nimbus", "cirrus", "stratus",
  "cumulus", "zephyr", "mistral", "sirocco", "carbon", "silicon", "argon", "neon", "helium", "lithium",
  "sodium", "cesium", "strontium", "barium", "radium", "thorium", "uranium", "neptunium", "plutonium",
  "curium", "fermium", "einsteinium", "mendelevium", "nobelium", "lawrencium", "rutherford", "seaborg",
  "bohrium", "hassium", "meitnerium", "darmstadt", "roentgen", "copernicium", "flerovium", "crimson",
  "scarlet", "vermilion", "amber", "saffron", "ochre", "sienna", "umber", "cerulean", "azure", "indigo",
  "violet", "magenta", "cerise", "carmine", "burgundy", "maroon", "teal", "turquoise", "emerald", "viridian",
  "chartreuse", "olive", "khaki", "ivory", "pearl", "silver", "platinum", "bronze", "allegro", "adagio",
  "andante", "crescendo", "fortissimo", "pianissimo", "staccato", "legato", "vibrato", "tremolo", "cadenza",
  "fugue", "sonata", "prelude", "nocturne", "requiem", "serenade", "overture", "symphony", "concerto",
  "aria", "ballad", "etude", "rondo", "scherzo", "minuet", "bolero", "tango", "waltz", "mazurka", "spartan",
  "athenian", "roman", "viking", "samurai", "centurion", "gladiator", "pharaoh", "sultan", "emperor",
  "monarch", "sentinel", "guardian", "herald", "vanguard", "pioneer", "voyager", "navigator", "explorer",
  "pathfinder", "trailblazer", "frontier", "outpost", "citadel", "fortress", "bastion", "rampart", "parapet",
  "battlement", "watchtower", "apex", "vertex", "nexus", "cipher", "axiom", "theorem", "paradox", "enigma",
  "quantum", "vector", "matrix", "tensor", "scalar", "fractal", "helix", "spiral", "vortex", "flux", "pulse",
  "surge", "catalyst", "echo", "resonance", "harmony", "cadence", "rhythm", "tempo", "momentum", "velocity",
  "blossom", "harvest", "frost", "ember", "kindle", "spark", "blaze", "flame", "inferno", "pyre", "beacon",
  "lantern", "lighthouse", "compass", "anchor", "rudder", "helm", "keel", "mast", "bowsprit", "starboard",
  "portside", "leeward", "windward", "current", "drift", "voyage", "odyssey",
];

/**
 * The STAR pool new dynasties draw from since 2026-10-10 (workflow-service #514, origin/main 8d255fe: IAU single-word
 * star names minus its own `EXCLUDED_STAR_NAMES`), and the adjectives of its two-word form ("Bright Vega"). Added
 * 2026-10-10: the first snapshot held the legacy words only, so 16 catalogue words (Bold, Brave, Bright, Twinkling,
 * Clear...) were shared with a workflow name.
 */
export const WORKFLOW_STAR_NAMES: readonly string[] = [
  "Absolutno", "Acamar", "Achernar", "Achird", "Acrab", "Acrux", "Acubens", "Adhafera", "Adhara", "Adhil",
  "Ain", "Ainalrami", "Aladfar", "Alasia", "Albaldah", "Albali", "Albireo", "Alchiba", "Alcor", "Alcyone",
  "Aldebaran", "Alderamin", "Aldhanab", "Aldhibah", "Aldulfin", "Alfirk", "Algedi", "Algenib", "Algieba",
  "Algol", "Algorab", "Alhena", "Alioth", "Aljanah", "Alkaid", "Alkalurops", "Alkaphrah", "Alkarab", "Alkes",
  "Almaaz", "Almach", "Alnair", "Alnasl", "Alnilam", "Alnitak", "Alniyat", "Alphard", "Alphecca",
  "Alpheratz", "Alpherg", "Alrakis", "Alrescha", "Alruba", "Alsafi", "Alsciaukat", "Alsephina", "Alshain",
  "Alshat", "Altair", "Altais", "Alterf", "Aludra", "Alya", "Alzirr", "Amadioha", "Amansinaya", "Ancha",
  "Angetenar", "Aniara", "Ankaa", "Antares", "Arcalis", "Arcturus", "Arneb", "Ascella", "Ashlesha",
  "Aspidiske", "Asterope", "Atakoraka", "Athebyne", "Atik", "Atria", "Avior", "Azelfafage", "Azha", "Azmidi",
  "Baekdu", "Beemim", "Beid", "Belel", "Belenos", "Bellatrix", "Berehynia", "Betelgeuse", "Bharani", "Bibha",
  "Biham", "Botein", "Bubup", "Bunda", "Canopus", "Capella", "Caph", "Castula", "Cebalrai", "Celaeno",
  "Chalawan", "Chamukuy", "Chara", "Chason", "Chechia", "Chertan", "Citadelle", "Citala", "Cujam", "Cursa",
  "Dabih", "Dalim", "Deneb", "Denebola", "Dingolay", "Diphda", "Diwo", "Diya", "Dofida", "Dombay",
  "Dschubba", "Dubhe", "Dziban", "Edasich", "Electra", "Elgafar", "Elkurud", "Elnath", "Eltanin", "Emiw",
  "Enif", "Errai", "Fafnir", "Fawaris", "Fomalhaut", "Fulu", "Fumalsamakah", "Funi", "Furud", "Fuyue",
  "Gacrux", "Gakyid", "Geminga", "Giausar", "Gienah", "Ginan", "Gloas", "Gomeisa", "Grumium", "Gudja",
  "Gumala", "Guniibuu", "Hadar", "Haedus", "Hamal", "Hassaleh", "Hatysa", "Heze", "Hoggar", "Homam", "Horna",
  "Hunahpu", "Hunor", "Iklil", "Imai", "Inquill", "Intan", "Intercrus", "Itonda", "Izar", "Jabbah", "Jishui",
  "Kaffaljidhma", "Kalausi", "Kamuy", "Karaka", "Kaveh", "Keid", "Khambalia", "Kitalpha", "Kochab", "Koeia",
  "Koit", "Kornephoros", "Kraz", "Kurhah", "Larawag", "Lerna", "Lesath", "Libertas", "Liesma", "Lionrock",
  "Maasym", "Mago", "Mahasim", "Mahsati", "Maia", "Malmok", "Marfik", "Markab", "Markeb", "Marohu", "Marsic",
  "Matar", "Mebsuta", "Megrez", "Meissa", "Mekbuda", "Meleph", "Menkalinan", "Menkar", "Menkent", "Menkib",
  "Merak", "Merga", "Meridiana", "Merope", "Mesarthim", "Miaplacidus", "Minchir", "Minelauva", "Mintaka",
  "Mira", "Mirach", "Miram", "Mirfak", "Mirzam", "Misam", "Mizar", "Moldoveanu", "Monch", "Montuno",
  "Mothallah", "Muliphein", "Muphrid", "Muscida", "Muspelheim", "Nahn", "Naledi", "Naos", "Nashira", "Nasti",
  "Nekkar", "Nembus", "Nenque", "Nganurganity", "Nihal", "Nikawiy", "Nosaxa", "Nunki", "Nusakan", "Nyamien",
  "Ogma", "Okab", "Paikauhale", "Parumleo", "Phact", "Phecda", "Pherkad", "Piautos", "Pincoya", "Pipirima",
  "Pipoltr", "Pleione", "Poerava", "Pollux", "Porrima", "Praecipua", "Procyon", "Propus", "Rapeto",
  "Rasalas", "Rasalgethi", "Rasalhague", "Rastaban", "Regulus", "Revati", "Rigel", "Rotanev", "Ruchbah",
  "Rukbat", "Sabik", "Saclateni", "Sadachbia", "Sadalbari", "Sadalmelik", "Sadalsuud", "Sadr", "Saiph",
  "Salm", "Samaya", "Sansuna", "Sargas", "Sceptrum", "Scheat", "Schedar", "Segin", "Seginus", "Shaula",
  "Sheliak", "Sheratan", "Sirius", "Solaris", "Spica", "Sterrennacht", "Stribor", "Sualocin", "Subra",
  "Suhail", "Sulafat", "Syrma", "Tabit", "Taika", "Taiyangshou", "Taiyi", "Talitha", "Tangra", "Tapecue",
  "Tarazed", "Tarf", "Taygeta", "Tegmine", "Tejat", "Terebellum", "Tevel", "Theemin", "Thuban", "Tiaki",
  "Tianguan", "Tianyi", "Timir", "Titawin", "Tojil", "Toliman", "Tonatiuh", "Torcular", "Tuiren", "Tupa",
  "Tupi", "Tureis", "Ukdah", "Uklun", "Unukalhai", "Vega", "Veritate", "Vindemiatrix", "Wasat", "Wazn",
  "Wezen", "Wurren", "Xamidimura", "Xihe", "Xuange", "Yildun", "Zaniah", "Zaurak", "Zavijava", "Zhang",
  "Zibal", "Zosma", "Zubenelgenubi", "Zubenelhakrabi", "Zubeneschamali",
];

export const WORKFLOW_STAR_ADJECTIVES: readonly string[] = [
  "Bright", "Bold", "Brave", "Calm", "Clear", "Fair", "Keen", "Kind", "Glad", "Warm", "True", "Wise",
  "Steady", "Gentle", "Lucky", "Merry", "Grand", "Pure", "Proud", "Twinkling",
];

/** Every word workflow-service names (or named) a dynasty with. No catalogue name may be given one. */
export const WORKFLOW_DYNASTY_WORDS: readonly string[] = [...WORKFLOW_DYNASTY_LEGACY_WORDS, ...WORKFLOW_STAR_NAMES, ...WORKFLOW_STAR_ADJECTIVES];
