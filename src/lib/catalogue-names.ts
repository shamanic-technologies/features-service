/**
 * THE NAME FAMILIES OF THE CATALOGUE (owner 2026-10-10, "chat first"). Every named catalogue object takes a
 * name of its OWN family, shared by every client and stable forever (`lib/sales-path-names.ts` stores and
 * assigns them):
 *
 *   SALES FUNNEL (a sales path with one pipe per leg; the "combination" of `/offers/:id/sales-paths`): an
 *     uplifting word (Victory, Jubilation...). The pool is the original `SALES_PATH_NAME_POOL` (every word of
 *     it given or not) followed by `FUNNEL_EXTRA_WORDS`, ~1000 words in all.
 *   PIPE (one channel x one leg; the "campaign" name of `/public/channels` `stepTransitions[].campaignName`):
 *     a bird (Sparrow, Plover...). The ~20 pipes named before 2026-10-10 keep their uplifting word until the
 *     owner's go to rename them (relayed by session porto-v3); every NEW pipe takes a bird.
 *   SALES PATH (a chain of legs to paid client, no channel): a river (Danube, Mekong...), never one that is
 *     also a country or a brand name (Amazon, Congo, Jordan...).
 *
 * Rules (owner, verbatim intent): English, ONE word, ONE family per concept, no word shared between two
 * families nor with workflow-service's dynasty words (`lib/workflow-dynasty-words.ts`; this is why the
 * birds workflow-service already uses, Heron, Swift, Kestrel, Wren..., are NOT in the bird pool). Once a
 * family's single words are all given, the family continues with TWO words: one of the family's own
 * positive adjectives + a family word ("Speckled Sparrow"); each family has its own adjectives, so even a
 * two-word name shares no word with another family. A name is never given twice (UNIQUE in the table) and
 * an exhausted family fails loud (`SalesPathNamePoolExhaustedError`), never a reused or invented name.
 *
 * Append-only in spirit: add words at the END of a list. Reordering or removing only changes which word
 * the NEXT new object receives; a name already given stays given.
 */
import { WORKFLOW_DYNASTY_WORDS } from "./workflow-dynasty-words.js";

export type NameFamily = "sales_funnel" | "pipe" | "sales_path";

/** Uplifting words appended to the original sales-funnel pool (`SALES_PATH_NAME_POOL`). */
export const FUNNEL_EXTRA_WORDS: readonly string[] = [
  "Accord", "Achieve", "Adore", "Adventure", "Affluence", "Agility", "Alacrity", "Allure", "Altitude", "Amaze",
  "Ambition", "Amity", "Amplify", "Applause", "Arise", "Artistry", "Assurance", "Astound", "Attain",
  "Audacity", "Avid", "Awaken", "Awe", "Balance", "Banner", "Benefit", "Benevolence", "Blessing", "Blithe",
  "Bloom", "Bold", "Bountiful", "Brave", "Breakthrough", "Breeze", "Bright", "Brisk", "Buoyant", "Calm",
  "Candor", "Capable", "Carefree", "Caring", "Carnival", "Celebrate", "Certainty", "Charisma", "Charm",
  "Cherish", "Chorus", "Clarity", "Climb", "Comfort", "Commend", "Compassion", "Confidence", "Content",
  "Courage", "Cozy", "Craft", "Create", "Credo", "Crest", "Crowning", "Daring", "Dazzling", "Dedication",
  "Delightful", "Devotion", "Dignity", "Discovery", "Dream", "Drive", "Dynamic", "Eager", "Earnest", "Ease",
  "Ecstasy", "Effort", "Elegance", "Eloquence", "Embrace", "Empower", "Enchant", "Endeavor", "Endure",
  "Energy", "Enjoy", "Enrich", "Enthrall", "Enthusiasm", "Epic", "Esteem", "Ethos", "Exuberance", "Excellence",
  "Excite", "Exquisite", "Faith", "Fascinate", "Favor", "Fearless", "Feast", "Felicity", "Fidelity", "Finesse",
  "Flawless", "Flight", "Flow", "Focus", "Fond", "Forge", "Forward", "Freedom", "Fulfill", "Generous",
  "Genial", "Gift", "Giving", "Glad", "Gladden", "Glamour", "Glisten", "Glitter", "Goodness", "Goodwill",
  "Gorgeous", "Grand", "Grateful", "Gratitude", "Greatness", "Grit", "Growth", "Happy", "Hearty", "Heart",
  "Helpful", "Heroic", "Highlight", "Honest", "Hope", "Hopeful", "Hospitality", "Humble", "Hustle", "Ideal",
  "Illuminate", "Imagine", "Impact", "Impress", "Incredible", "Infinite", "Influence", "Inspire", "Integrity",
  "Intrepid", "Invent", "Invincible", "Jaunty", "Jolly", "Journey", "Jovial", "Joyful", "Jubilant", "Justice",
  "Keen", "Kind", "Kindness", "Kinship", "Largesse", "Launch", "Leap", "Liberty", "Lively", "Lofty", "Loyal",
  "Lucky", "Magic", "Magnify", "Masterpiece", "Mastery", "Mellow", "Mighty", "Mindful", "Modest", "Motive",
  "Natural", "Nimble", "Nourish", "Nurture", "Optimism", "Opus", "Outshine", "Overcome", "Passion", "Patience",
  "Peace", "Persist", "Playful", "Pleasure", "Plucky", "Plume", "Poise", "Polish", "Positive", "Potent",
  "Power", "Praise", "Precious", "Prize", "Progress", "Prosper", "Prosperity", "Proud", "Purpose", "Quest",
  "Quintessence", "Radiate", "Realize", "Rebirth", "Refresh", "Rejoice", "Relish", "Remarkable", "Renew",
  "Resolve", "Respect", "Revive", "Reward", "Ripple", "Robust", "Romance", "Rousing", "Salute", "Savor",
  "Serene", "Serenity", "Shimmer", "Shining", "Sincere", "Smile", "Solace", "Soul", "Sparkling", "Spirit",
  "Splendid", "Spring", "Sprout", "Stamina", "Steady", "Stride", "Strive", "Strong", "Sturdy", "Style",
  "Sunny", "Support", "Talent", "Tenacity", "Thrill", "Thriving", "Timeless", "Together", "Tranquil", "Trust",
  "Truth", "Unique", "Upbeat", "Uprise", "Upward", "Valiant", "Value", "Venture", "Vibrant", "Victorious",
  "Vigor", "Virtue", "Vision", "Vital", "Vitality", "Vivacious", "Voice", "Warmth", "Welcome", "Wholesome",
  "Willing", "Wisdom", "Worth", "Worthy", "Wow", "Youthful", "Zippy", "Zestful", "Acme", "Adept", "Advance",
  "Agile", "Aglow", "Alive", "Amazing", "Ample", "Angelic", "Apt", "Ardent", "Arrival", "Ascend", "Ascension",
  "Aspiration", "Assured", "Astonish", "Athletic", "Attune", "Auspicious", "Authentic", "Avail", "Award",
  "Awesome", "Beaming", "Beloved", "Best", "Better", "Blissful", "Blooming", "Blossoming", "Bonny", "Bravery",
  "Brightness", "Brilliant", "Bubbly", "Capstone", "Captivate", "Celebrated", "Centered", "Charming",
  "Cheerful", "Cherished", "Classic", "Coherent", "Colossal", "Commitment", "Competent", "Composure",
  "Conquer", "Considerate", "Constant", "Cordial", "Courteous", "Credible", "Crisp", "Cultivate", "Curious",
  "Dapper", "Darling", "Decisive", "Deft", "Delighted", "Dependable", "Determined", "Devoted", "Diligent",
  "Distinct", "Dominion", "Dreamy", "Durable", "Earnestness", "Ebullient", "Effective", "Efficient",
  "Effortless", "Elated", "Embolden", "Eminent", "Enamor", "Enchanting", "Endless", "Energize", "Engaging",
  "Enlighten", "Enormous", "Entice", "Equity", "Ethical", "Evolve", "Exceptional", "Exciting", "Exemplar",
  "Exultant", "Fabulous", "Faithful", "Fantastic", "Fastidious", "Festive", "Fetching", "Fine", "Fizz",
  "Flourishing", "Fluent", "Fortitude", "Fortunate", "Frank", "Friendly", "Fruitful", "Gallantry", "Gentle",
  "Genuine", "Gifted", "Gleeful", "Glorious", "Glowing", "Good", "Graceful", "Gracious", "Great", "Greet",
  "Gutsy", "Hale", "Handy", "Happiness", "Hardy", "Heartfelt", "Heavenly", "Helping", "Honorable", "Honored",
  "Immense", "Impeccable", "Incandescent", "Indomitable", "Ingenious", "Innovate", "Insight", "Inspired",
  "Intense", "Inventive", "Invigorate", "Irresistible", "Jocund", "Jubilance", "Kinetic", "Laudable",
  "Legendary", "Leisure", "Liberate", "Limitless", "Lionhearted", "Lovely", "Loving", "Lucid", "Luminous",
  "Luxurious", "Magical", "Magnetic", "Magnificent", "Majestic", "Marvelous", "Masterful", "Matchless",
  "Meaningful", "Merry", "Mesmerize", "Meteoric", "Miraculous", "Motivate", "Moving", "Neighborly", "Nifty",
  "Notable", "Novel", "Nurturing", "Openness", "Opportune", "Optimistic", "Orderly", "Original", "Outgoing",
  "Outstanding", "Paramount", "Peaceful", "Peerless", "Perfect", "Perky", "Persevere", "Philanthropy",
  "Phenomenal", "Pioneering", "Pleasant", "Plentiful", "Poised", "Polished", "Popular", "Powerful", "Pristine",
  "Prodigious", "Productive", "Proficient", "Profound", "Prolific", "Prominent", "Propel", "Prosperous",
  "Punchy", "Quality", "Rapid", "Rational", "Ravishing", "Reassure", "Recognize", "Refined", "Reliable",
  "Remedy", "Renewed", "Resilient", "Resolute", "Resourceful", "Resplendent", "Restore", "Revered",
  "Revolution", "Righteous", "Rising", "Rosy", "Royal", "Satisfy", "Secure", "Selfless", "Sensational",
  "Sensible", "Skillful", "Smiling", "Soaring", "Sociable", "Soothe", "Sparky", "Spectacular", "Speedy",
  "Spirited", "Splendiferous", "Spontaneous", "Sprightly", "Stalwart", "Stately", "Steadfast", "Stunning",
  "Stupendous", "Succeed", "Sunshine", "Surpass", "Sustain", "Sympathy", "Tactful", "Terrific", "Thankful",
  "Thorough", "Thoughtful", "Tidy", "Tireless", "Topnotch", "Treasured", "Tremendous", "Triumphal", "True",
  "Trusty", "Truthful", "Unbeatable", "Unbounded", "Uncommon", "Unfading", "Unrivaled", "Unstoppable",
  "Unwavering", "Uplifting", "Upright", "Upstanding", "Valued", "Venerable", "Verity", "Versatile", "Vibrance",
  "Vigilant", "Vigorous", "Vindicate", "Virtuous", "Vivify", "Welcoming", "Winning", "Wondrous", "Wonderful",
  "Worldly", "Xenial", "Yearn", "Zealous", "Zenful", "Acclaimed", "Adoration", "Advent", "Affection",
  "Allegiance", "Alliance", "Anew", "Appeal", "Ardency", "Arrive", "Ascendant", "Aspiring", "Avidity", "Bask",
  "Bedazzle", "Belong", "Betterment", "Brightside", "Brio", "Calmness", "Candle", "Caress", "Cascading",
  "Catalyze", "Certain", "Charity", "Chivalry", "Concord", "Conquest", "Cornerstone", "Covenant", "Daylight",
  "Debonair", "Decorum", "Delectable", "Deliver", "Deserve", "Discern", "Dulcet", "Dynamism", "Easygoing",
  "Effulgent", "Elan", "Elevation", "Embark", "Eminence", "Empathy", "Enable", "Encourage", "Endear",
  "Energetic", "Enliven", "Ensure", "Entrust", "Epoch", "Equanimity", "Esprit", "Ethereal", "Evergreen",
  "Evolution", "Exhilarate", "Expanse", "Exultation", "Fairness", "Fanciful", "Fete", "Flagship", "Fledge",
  "Fleur", "Flock", "Flutter", "Fondness", "Foremost", "Foresight", "Fortify", "Fountain", "Fragrance",
  "Friendship", "Gaiety", "Gather", "Gemstone", "Glorify", "Glint", "Goldmine", "Grail", "Gratify",
  "Greenlight", "Guiding", "Handsome", "Harmonize", "Haven", "Headway", "Heal", "Healthy", "Hearten",
  "Heirloom", "Homage", "Illustrious", "Impetus", "Improve", "Inception", "Incentive", "Indulge", "Inkling",
  "Innocence", "Intuition", "Inviting", "Irradiate", "Jamboree", "Jingle", "Joviality", "Jubilate", "Keepsake",
  "Landmark", "Largess", "Lasting", "Lavish", "Levity", "Lifelong", "Lighthearted", "Likeable", "Lionheart",
  "Lucidity", "Lullaby", "Mainstay", "Medallion", "Melody", "Merrily", "Milestone", "Munificence", "Nestle",
  "Newness", "Nobility", "Nonpareil", "Nourishment", "Orchestrate", "Outlook", "Overflow", "Pageant", "Pearly",
  "Pinwheel", "Placid", "Pleasing", "Poetic", "Poppy", "Potential", "Precise", "Preeminent", "Prestigious",
  "Prevail", "Prized", "Prowess", "Purity", "Readiness", "Reborn", "Recital", "Regale", "Rejuvenate", "Relax",
  "Relief", "Renaissance", "Repose", "Resonate", "Revelry", "Reverie", "Rhythmic", "Ribbon", "Rosette",
  "Sanctuary", "Sapience", "Satisfaction", "Scintilla", "Serendipity", "Shelter", "Showcase", "Silken",
  "Simplicity", "Sincerity", "Skylight", "Sonorous", "Soothing", "Sovereignty", "Sparklet", "Sportive",
  "Steadiness", "Strength", "Stronghold", "Sumptuous", "Sundance", "Sunflower", "Sunray", "Synergy",
  "Teamwork", "Tenderness", "Thrilling", "Tidings", "Tiptop", "Tranquility", "Trek", "Truce", "Tune",
  "Twinkle", "Unfold", "Unite", "Uptick", "Useful", "Vaunt", "Venerate", "Verily", "Viable", "Vigil", "Vim",
  "Vintage", "Vitalize", "Vivacity", "Volition", "Vow", "Wanderlust", "Wellbeing", "Wellness", "Wellspring",
  "Whimsical", "Wildflower", "Willpower", "Winsome", "Wonderland", "Workmanship",
];

/** Birds, none of them in workflow-service's dynasty words. */
export const PIPE_BIRD_WORDS: readonly string[] = [
  "Sparrow", "Robin", "Finch", "Thrush", "Warbler", "Plover", "Sandpiper", "Egret", "Ibis", "Stork", "Puffin",
  "Gannet", "Tern", "Gull", "Petrel", "Shearwater", "Fulmar", "Auk", "Grebe", "Loon", "Coot", "Bittern",
  "Avocet", "Curlew", "Godwit", "Dunlin", "Turnstone", "Oystercatcher", "Lapwing", "Dotterel", "Killdeer",
  "Bobolink", "Oriole", "Tanager", "Grosbeak", "Bunting", "Junco", "Towhee", "Siskin", "Linnet", "Redpoll",
  "Crossbill", "Waxwing", "Shrike", "Vireo", "Flycatcher", "Phoebe", "Kingbird", "Swallow", "Nuthatch",
  "Treecreeper", "Titmouse", "Chickadee", "Bushtit", "Dipper", "Kinglet", "Gnatcatcher", "Bluebird",
  "Starling", "Mockingbird", "Catbird", "Thrasher", "Pipit", "Wagtail", "Accentor", "Dunnock", "Chaffinch",
  "Goldfinch", "Greenfinch", "Bullfinch", "Hawfinch", "Serin", "Canary", "Parrot", "Macaw", "Cockatoo",
  "Lorikeet", "Parakeet", "Toucan", "Hornbill", "Hoopoe", "Motmot", "Trogon", "Quetzal", "Jacamar", "Puffbird",
  "Barbet", "Honeyguide", "Woodpecker", "Flicker", "Sapsucker", "Wryneck", "Cuckoo", "Roadrunner", "Coucal",
  "Turaco", "Owl", "Owlet", "Nightjar", "Potoo", "Frogmouth", "Hummingbird", "Sunbird", "Spinebill",
  "Honeyeater", "Pardalote", "Fairywren", "Lyrebird", "Bowerbird", "Drongo", "Fantail", "Magpie", "Jay",
  "Jackdaw", "Rook", "Chough", "Nutcracker", "Treepie", "Bulbul", "Babbler", "Whistler", "Wheatear",
  "Stonechat", "Whinchat", "Redstart", "Bluethroat", "Eagle", "Hawk", "Buzzard", "Kite", "Goshawk",
  "Sparrowhawk", "Gyrfalcon", "Caracara", "Vulture", "Secretarybird", "Goose", "Mallard", "Wigeon", "Pintail",
  "Gadwall", "Shoveler", "Eider", "Scoter", "Merganser", "Smew", "Goldeneye", "Bufflehead", "Canvasback",
  "Scaup", "Pochard", "Pheasant", "Grouse", "Ptarmigan", "Quail", "Partridge", "Peacock", "Guineafowl",
  "Francolin", "Capercaillie", "Frigatebird", "Anhinga", "Skua", "Kittiwake", "Noddy", "Murre", "Guillemot",
  "Razorbill", "Auklet", "Murrelet", "Prion", "Flamingo", "Spoonbill", "Hammerkop", "Shoebill", "Bustard",
  "Kiwi", "Emu", "Ostrich", "Rhea", "Cassowary", "Tinamou", "Kakapo", "Kea", "Kaka", "Weka", "Takahe", "Tui",
  "Bellbird", "Pukeko", "Hoatzin", "Sunbittern", "Kagu", "Seriema", "Trumpeter", "Limpkin", "Sungrebe",
  "Jacana", "Pratincole", "Courser", "Sheathbill", "Stilt", "Phalarope", "Snipe", "Woodcock", "Whimbrel",
  "Sanderling", "Stint", "Ruff", "Redshank", "Greenshank", "Yellowlegs", "Willet", "Tattler", "Dowitcher",
  "Pigeon", "Dove", "Turtledove", "Toucanet", "Aracari", "Cotinga", "Manakin", "Antbird", "Ovenbird",
  "Woodcreeper", "Becard", "Tityra", "Euphonia", "Saltator", "Seedeater", "Grassquit", "Dickcissel",
  "Meadowlark", "Grackle", "Blackbird", "Bobwhite", "Chachalaca", "Guan", "Curassow", "Megapode", "Malleefowl",
  "Brolga", "Jabiru", "Marabou", "Openbill", "Coquette", "Sylph", "Woodstar", "Sabrewing", "Starthroat",
  "Hillstar", "Puffleg", "Firecrown", "Sunangel", "Lark", "Cardinal", "Martin", "Rosella", "Galah", "Corella",
  "Budgerigar", "Kookaburra", "Lovebird", "Conure", "Waxbill", "Mannikin", "Munia", "Whydah", "Indigobird",
  "Firefinch", "Twinspot", "Silverbill", "Minivet", "Iora", "Leafbird", "Fulvetta", "Yuhina", "Minla",
  "Barwing", "Sibia", "Liocichla", "Laughingthrush", "Shortwing", "Forktail", "Cochoa", "Niltava", "Akalat",
  "Alethe", "Palmchat", "Phainopepla", "Verdin", "Wrentit", "Gnatwren", "Sicklebill", "Riflebird", "Manucode",
  "Astrapia", "Logrunner", "Chowchilla", "Berrypecker", "Longbill", "Satinbird", "Sittella", "Treerunner",
  "Pitohui", "Boatbill", "Elepaio", "Apapane", "Iiwi", "Akepa", "Akiapolaau", "Palila", "Omao", "Puaiohi",
  "Alala", "Nene", "Koloa",
];

/** Rivers, none of them also a country or a brand name. */
export const PATH_RIVER_WORDS: readonly string[] = [
  "Danube", "Rhine", "Loire", "Seine", "Thames", "Mekong", "Yangtze", "Ganges", "Indus", "Tigris", "Euphrates",
  "Orinoco", "Zambezi", "Limpopo", "Rhone", "Elbe", "Oder", "Vistula", "Dnieper", "Tagus", "Douro", "Ebro",
  "Arno", "Tiber", "Severn", "Tyne", "Tweed", "Missouri", "Yellowstone", "Platte", "Arkansas", "Brazos",
  "Pecos", "Willamette", "Fraser", "Mackenzie", "Athabasca", "Saskatchewan", "Rideau", "Richelieu", "Saguenay",
  "Mississippi", "Tennessee", "Cumberland", "Wabash", "Allegheny", "Susquehanna", "Delaware", "Potomac",
  "Shenandoah", "Rappahannock", "Suwannee", "Apalachicola", "Chattahoochee", "Tombigbee", "Sabine",
  "Guadalupe", "Gila", "Salinas", "Klamath", "Rogue", "Umpqua", "Deschutes", "Kootenai", "Flathead", "Bighorn",
  "Niobrara", "Cimarron", "Neosho", "Osage", "Gasconade", "Meramec", "Illinois", "Kankakee", "Wisconsin",
  "Chippewa", "Minnesota", "Iowa", "Wapsipinicon", "Maumee", "Muskingum", "Scioto", "Kanawha", "Monongahela",
  "Genesee", "Mohawk", "Housatonic", "Connecticut", "Merrimack", "Kennebec", "Penobscot", "Androscoggin",
  "Moselle", "Meuse", "Scheldt", "Garonne", "Dordogne", "Charente", "Vienne", "Marne", "Oise", "Saone",
  "Durance", "Isere", "Adige", "Piave", "Brenta", "Ticino", "Isar", "Lech", "Neckar", "Weser", "Ems", "Havel",
  "Spree", "Saale", "Mulde", "Drava", "Sava", "Tisza", "Mures", "Olt", "Prut", "Dniester", "Narew", "Warta",
  "Neman", "Daugava", "Neva", "Volkhov", "Svir", "Onega", "Pechora", "Irtysh", "Yenisei", "Amur", "Ussuri",
  "Kolyma", "Indigirka", "Anadyr", "Kama", "Oka", "Kuban", "Terek", "Kura", "Aras", "Helmand", "Sutlej",
  "Chenab", "Jhelum", "Ravi", "Beas", "Yamuna", "Gomti", "Ghaghara", "Gandak", "Kosi", "Brahmaputra", "Teesta",
  "Padma", "Meghna", "Mahanadi", "Godavari", "Kaveri", "Narmada", "Tapti", "Irrawaddy", "Salween", "Chindwin",
  "Sittaung", "Huai", "Liao", "Songhua", "Tumen", "Yalu", "Taedong", "Nakdong", "Shinano", "Kiso",
  "Murrumbidgee", "Lachlan", "Burdekin", "Fitzroy", "Gascoyne", "Waikato", "Whanganui", "Clutha", "Rakaia",
  "Waitaki", "Ucayali", "Maranon", "Huallaga", "Madeira", "Tapajos", "Xingu", "Araguaia", "Tocantins",
  "Parnaiba", "Parana", "Pilcomayo", "Bermejo", "Chubut", "Magdalena", "Cauca", "Atrato", "Essequibo",
  "Demerara", "Berbice", "Corantijn", "Maroni", "Oyapock", "Nile", "Atbara", "Sobat", "Ubangi", "Sangha",
  "Kasai", "Lualaba", "Okavango", "Kunene", "Kwanza", "Vaal", "Tugela", "Rufiji", "Shebelle", "Awash", "Omo",
  "Benue", "Casamance", "Sassandra", "Bandama", "Komoe", "Ogooue", "Sanaga", "Cuanza", "Pungwe", "Luangwa",
  "Kafue", "Ruvuma", "Galana", "Litani", "Orontes", "Karun", "Zayandeh", "Atrek", "Murghab", "Tarim",
  "Selenga", "Orkhon", "Kerulen", "Onon",
];

/** Each family's own positive adjectives, for the two-word form once its single words run out. */
export const FAMILY_ADJECTIVES: Readonly<Record<NameFamily, readonly string[]>> = {
  sales_funnel: [
    "Truehearted", "Wholehearted", "Highborn", "Starbright", "Gladsome", "Heartsome", "Lightsome",
    "Openhearted", "Highspirited", "Kindhearted", "Brighteyed", "Greathearted", "Stouthearted", "Warmhearted",
    "Bravehearted", "Goodhearted", "Bonnie", "Gleaming", "Shimmering", "Twinkling", "Glistening", "Lustrous",
    "Starlit", "Chipper", "Peppy", "Sparkly", "Zesty", "Breezy", "Sunshiny", "Merrymaking",
  ],
  pipe: [
    "Highflying", "Skyborne", "Featherlight", "Spry", "Alert", "Wild", "Free", "Clever", "Quick", "Hushed",
    "Copper", "Russet", "Tawny", "Dusky", "Speckled", "Spotted", "Barred", "Crested", "Banded", "Ruddy",
    "Rufous", "Ashy", "Sooty", "Snowy", "Misty", "Mossy",
  ],
  sales_path: [
    "Long", "Winding", "Broad", "Deep", "Still", "Clear", "Rolling", "Rushing", "Meandering", "Wide", "Quiet",
    "Blue", "Green", "Silent", "Ancient", "Old", "Upper", "Lower", "Northern", "Southern", "Eastern",
    "Western", "Little", "Lazy", "Sleepy", "Babbling", "Murmuring", "Glassy", "Silvery", "Foggy", "Stony",
    "Sandy", "Rocky", "Reedy", "Willowy", "Clearwater",
  ],
};

const WORKFLOW_WORDS: ReadonlySet<string> = new Set(WORKFLOW_DYNASTY_WORDS.map((w) => w.toLowerCase()));

/** True when a word may still be GIVEN (not a workflow dynasty word). Words already given stay given. */
export const isGivableWord = (word: string): boolean => !WORKFLOW_WORDS.has(word.toLowerCase());

/** The key prefix of a pipe name (`campaignNameKeyOf`) and of a sales path name (`salesPathNameKeyOf`). */
export const PIPE_NAME_KEY_PREFIX = "campaign:";
export const SALES_PATH_NAME_KEY_PREFIX = "path:";

/** Which family a stored name key belongs to (every other key is a sales funnel's combination key). */
export function nameFamilyOfKey(key: string): NameFamily {
  if (key.startsWith(PIPE_NAME_KEY_PREFIX)) return "pipe";
  if (key.startsWith(SALES_PATH_NAME_KEY_PREFIX)) return "sales_path";
  return "sales_funnel";
}

/**
 * Every name a family can give, in order: its single words (givable ones only), then adjective x word.
 * Lazy: a caller takes what it needs. `singleWords` is the family's word list (the funnel family passes the
 * original pool followed by `FUNNEL_EXTRA_WORDS`).
 */
export function* familyNameCandidates(family: NameFamily, singleWords: readonly string[]): Generator<string> {
  const words = singleWords.filter(isGivableWord);
  yield* words;
  for (const adjective of FAMILY_ADJECTIVES[family]) for (const word of words) yield `${adjective} ${word}`;
}
