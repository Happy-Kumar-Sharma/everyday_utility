// Password generator logic (no DOM). All randomness comes from crypto.getRandomValues through `randomInt`,
// which uses rejection sampling, so every index is equally likely (no modulo bias).
// Entropy is computed from the generator settings (alphabet / list size), never guessed from the output.

/** Fills a Uint32Array with secure random values. Injectable for tests. */
export const cryptoSource = (arr) => globalThis.crypto.getRandomValues(arr);

const RANGE = 2 ** 32;

/** Uniform integer in [0, n) by rejection sampling: draws ≥ the largest multiple of n below 2^32 are discarded. */
export function randomInt(n, source = cryptoSource) {
  if (!Number.isInteger(n) || n < 1 || n > RANGE) throw new RangeError('randomInt: n must be an integer in 1..2^32');
  if (n === 1) return 0;
  const limit = RANGE - (RANGE % n);  // multiple of n; values ≥ limit would favour small results
  const buf = new Uint32Array(1);
  for (;;) {
    source(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export const pick = (list, source) => list[randomInt(list.length, source)];

export function randomBytes(n, source = cryptoSource) {
  const out = new Uint8Array(n);
  // getRandomValues on a byte array is uniform per byte; route through the same source for testability
  const words = new Uint32Array(Math.ceil(n / 4));
  source(words);
  for (let i = 0; i < n; i++) out[i] = (words[i >> 2] >>> ((i & 3) * 8)) & 0xff;
  return out;
}

/* ------------------------------------------------------------------ random passwords */

export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGITS = '0123456789';
export const DEFAULT_SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/~';
export const AMBIGUOUS = 'Il1O0';
export const LIMITS = { length: [8, 128], words: [3, 12], pin: [4, 32], bytes: [8, 128], count: [1, 50] };

export const clampInt = (v, [lo, hi], fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/**
 * Character pools for the chosen sets: [{name, chars: [...]}]. Duplicates are removed (a symbol set that
 * repeats a letter does not double its weight) and every character appears in exactly one pool.
 */
export function buildPools({ lower = true, upper = true, digits = true, symbols = true, symbolSet = DEFAULT_SYMBOLS, excludeAmbiguous = false } = {}) {
  const seen = new Set();
  const pools = [];
  const add = (name, chars) => {
    const list = [];
    for (const c of Array.from(chars)) {
      if (/\s/.test(c) || seen.has(c) || (excludeAmbiguous && AMBIGUOUS.includes(c))) continue;
      seen.add(c); list.push(c);
    }
    if (list.length) pools.push({ name, chars: list });
  };
  if (lower) add('lowercase', LOWER);
  if (upper) add('uppercase', UPPER);
  if (digits) add('digits', DIGITS);
  if (symbols) add('symbols', symbolSet);
  return pools;
}

/** log2 of a positive BigInt, accurate to ~1e-12 relative. */
export function log2Big(n) {
  if (n <= 0n) return -Infinity;
  const bits = n.toString(2).length;
  if (bits <= 52) return Math.log2(Number(n));
  const shift = BigInt(bits - 52);
  return Math.log2(Number(n >> shift)) + Number(shift);
}

/** Number of length-L strings over the pools that contain at least one char of every pool (inclusion–exclusion). */
export function countValid(sizes, length) {
  const k = sizes.length;
  let total = 0n;
  for (let mask = 0; mask < 1 << k; mask++) {
    let excluded = 0, bitsSet = 0;
    for (let i = 0; i < k; i++) if (mask & (1 << i)) { excluded += sizes[i]; bitsSet++; }
    const term = BigInt(sizes.reduce((a, b) => a + b, 0) - excluded) ** BigInt(length);
    total += bitsSet % 2 ? -term : term;
  }
  return total;
}

export function randomEntropy(opts) {
  const pools = buildPools(opts);
  const length = clampInt(opts.length, LIMITS.length, 20);
  if (!pools.length) return 0;
  const sizes = pools.map((p) => p.chars.length);
  return opts.requireEach === false ? length * Math.log2(sizes.reduce((a, b) => a + b, 0)) : log2Big(countValid(sizes, length));
}

/**
 * Random password. With requireEach, a uniformly random string over the whole alphabet is redrawn until it
 * contains every chosen set — this keeps all valid passwords equally likely (unlike "insert one of each").
 */
export function randomPassword(opts = {}, source = cryptoSource) {
  const pools = buildPools(opts);
  if (!pools.length) throw new Error('Choose at least one character set.');
  const length = clampInt(opts.length, LIMITS.length, 20);
  if (opts.requireEach !== false && pools.length > length) throw new Error('Length is shorter than the number of required sets.');
  const all = pools.flatMap((p) => p.chars);
  for (;;) {
    const chars = Array.from({ length }, () => pick(all, source));
    if (opts.requireEach === false || pools.every((p) => p.chars.some((c) => chars.includes(c)))) return chars.join('');
  }
}

/* ------------------------------------------------------------------ passphrases */

// A diceware-style list of common, short English words (deduplicated below; entropy uses the final size).
const WORD_TEXT = `
able about above acid acorn act actor add adult afraid after again age agent agree ahead aim air airport
aisle alarm album alert alien alive alley allow alpha amber amount anchor angel anger angle angry animal
ankle answer ant apart apple apron arch arena argue arm armor army arrow art artist ash aside ask asleep
atom attic audio aunt autumn avoid awake award away awful axe baby back bacon badge bag bake baker balance
ball bamboo banana band bank bar barn barrel base basil basket bat bath beach beam bean bear beard beat
become bed bee beef beer begin behind bell belly belt bench berry best better bike bill bird birth biscuit
bit bite bitter black blade blank blanket blast blaze blend bless blind blink block blond blood bloom blouse
blue blunt blur board boat body boil bold bolt bone bonus book boot border boss both bottle bottom bounce
bow bowl box boy brain brake branch brand brass brave bread break breeze brick bride bridge brief bright
bring brisk broad broken bronze brook broom brother brown brush bubble bucket buddy budget buffalo build
bulb bulk bull bunch bundle bunny burden burger burst bus bush busy butter button buyer buzz cabin cable
cactus cage cake call calm camel camera camp canal candle candy cane canoe canvas canyon cap captain car
carbon card cargo carpet carrot cart case cash castle cat catch cattle cause cave cedar ceiling celery
cell cement cereal chain chair chalk champ chance change chaos chapter charm chart chase cheap check cheek
cheese chef cherry chess chest chicken chief child chili chill chimney chin chip choice choir chop chorus
chunk church cider cigar cinema circle citizen city civil claim clam clap clay clean clerk clever click
client cliff climb clinic clip clock close cloth cloud clown club clue coach coal coast coat cobra cocoa
coconut code coffee coil coin cold collar color column comb comet comic common cook cookie cool copper copy
coral cord core corn corner cost cotton couch cough count county couple course court cousin cover cow
cowboy crab crack cradle craft crane crash crate crawl crayon crazy cream credit creek crew cricket crisp
crop cross crow crowd crown crude cruise crumb crush crust cry crystal cube cup cupboard curb cure curious
curl curry curtain curve cushion custom cute cycle dad daily dairy daisy dance danger dare dark dash data
date dawn day deal dear debate debt decade deck deer delay deliver denim dense dent depth desert design
desk detail dial diary dice diesel diet dig digit dinner dirt dish ditch dive dizzy doctor dog doll dolphin
dome donkey door dose dot double dough dove down dozen draft dragon drama draw dream dress drift drill drink
drip drive drop drum dry duck dune dust duty eager eagle early earn earth easel east easy echo edge eel
effort egg eight elbow elder elect elephant elk elm email ember empty end enemy energy engine enjoy enter
entry envy equal era erase error escape essay even event exact exam exit expert extra eye fabric face fact
fade fail faint fair fairy faith fall false fame family fan fancy farm fashion fast fat fault feast feather
fee feed fence fern ferry fever few fiber field fig file film final find fine finger finish fire firm first
fish fist fit five fix flag flame flash flat flavor flea fleet flight flip float flock flood floor flour
flower fluid flute fly foam focus fog foil fold folk food fool foot force forest fork form fort fossil
found fox frame free fresh friend frog front frost frozen fruit fuel full fun funny fur future gadget gain
galaxy game gap garage garden garlic gas gate gather gauge gear gem genius gentle ghost giant gift ginger
giraffe girl give glad glass globe glory glove glow glue goal goat gold golf good goose gorilla gospel
gown grab grace grade grain grand grant grape graph grass gravel gravy great green grid grill grin grip
group grow guard guess guest guide guitar gulf gum gym habit hair half hall ham hammer hand happy harbor
hard harp hat hawk hay hazel head health heart heat heavy hedge heel height hello helmet help hen herb hero
hidden high hill hint hip hire hobby hockey hold hole holiday hollow home honey hood hook hope horn horse
host hot hotel hour house hover hub huge human humble humor hunt hurry husband hut ice icon idea idle igloo
image inch index ink inn input insect inside iron island item ivory ivy jacket jaguar jam jar jazz jeans
jelly jet jewel job jog join joke journey joy judge juice jump jungle junior jury just kale keen kettle key
kick kid kidney kind king kiss kit kitchen kite kitten kiwi knee knife knock knot koala lab label lace
ladder lady lake lamb lamp land lane laptop large laser later laugh lava law lawn layer lazy lead leaf
learn leash leather leave lecture left leg legal lemon lend length lens leopard lesson letter level liar
library lid life lift light like lily limb lime limit line lion lip liquid list little live lizard load
loaf loan lobby lobster local lock lodge logic lonely long loop lose lot loud lounge love lucky lumber
lunar lunch lung lyrics machine mad magic magnet maid mail main major make mammal man mango manor map
maple marble march margin marine market mask mass master match math matter maze meadow meal meat medal
media melody melon member memory menu mercy merge merit mesh metal meter method middle midnight milk mill
mimic mind mint minute mirror misty mix mobile model modem moment money monkey month mood moon moose
moral morning mosaic moss motel moth mother motor mouse mouth move movie much mud muffin mule multiply
muscle museum music mustard myth nail name napkin narrow nasty nation nature navy near neck need needle
nephew nerve nest net never news next nice niece night ninja noble nod noise noodle normal north nose
note novel number nurse nut oak oasis object ocean odd offer office often oil okay old olive omega onion
online open opera opinion orange orbit orchid order organ other otter ounce outer oval oven owl owner
oxygen oyster pace pack paddle page pair palace palm pan panda panel panic paper parade parent park parrot
party pass pasta paste patch path patrol pause paw peace peach peanut pear pearl pebble pecan pedal pen
pencil penguin people pepper perfect permit person pet phone photo piano picnic piece pig pigeon pill
pilot pine pink pint pioneer pipe pirate pitch pizza place plain planet plant plastic plate play
plaza plenty plot plow plug plum plunge pocket poem poet point polar pole police pond pony pool popcorn
poppy porch port pose post pot potato pouch powder power praise prawn prefer press price pride prince
print prison prize problem profit proof proud prune public pudding pulse pump punch pupil puppy purple
purse push puzzle pyramid quack quail quarter queen quest quick quiet quilt quiz quote rabbit raccoon race
rack radar radio raft rage rail rain raise rake ramp ranch random range rapid rare rate raven raw razor
ready real rebel recipe record red reef region relax relief remote rent repair report rescue resort rest
retire return reward rhythm rib ribbon rice rich ride ridge right rigid ring rinse ripe rise risk
rival river road roast robin robot rock rocket rodeo roll roof room root rope rose rotate rough round route
royal rubber rug rule rumor run rural rush rust saddle safe sail salad salmon salon salt same sand satin
sauce sausage save scale scarf scene school science scoop scout scrap screen script scrub sea seal season
seat second secret seed select sense series serve set seven shadow shaft shake shallow shape share shark
sharp shed sheep shelf shell shield shift shine ship shirt shock shoe shoot shop shore short shoulder shout
shovel show shrimp shrug shy sick side siege sight sign silent silk silly silver simple since sing siren
sister sit six size skate sketch ski skill skin skirt skull sky slab slam sled sleep sleeve slice slide
slim slogan slope slot slow small smart smile smoke smooth snack snake snap sniff snow soap soccer social
sock soda sofa soft solar soldier solid solve song soon sorry sort soul sound soup south space spare spark
speak spear speed spell spend sphere spice spider spike spin spirit split spoon sport spot spray spring
spy square squid stable stadium staff stage stairs stamp stand star start state steak steam steel stem
step stereo stick still sting stock stomach stone stool story stove strap straw stream street strike
strong student studio stuff style sugar suit summer sun sunny super supper supply sure surf surface swamp
swan sweet swift swim swing switch sword symbol syrup system table tackle tail talent talk tall tank tape
target task taste taxi tea teach team tell temple ten tenant tennis tent term test text thank theme theory
thick thing thirsty thorn thread three thrive thumb thunder ticket tide tiger tilt timber time tiny tip
tired tissue title toast today toe token tomato tone tongue tool tooth top topic torch tornado tortoise
total tour towel tower town toy track trade traffic trail train tray treat tree trend trial tribe trick
trip trophy truck true trumpet trust truth tube tulip tuna tunnel turkey turn turtle twelve twenty twin
twist type uncle under unfair uniform union unit until update upper upset urban usage use usual vacuum
valley value van vapor vault velvet vendor venue verb verse very vessel vest video view village vintage
violin virus visa visit visual vital vivid vocal voice volume vote voyage wage wagon waist wait walk wall
walnut want war warm wash wasp waste watch water wave wax way wealth weapon wear weasel weather web wedding
week weird welcome west wet whale wheat wheel whip whisper wide width wife wild will win window wine wing
wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth
wrap wreck wrist write yard year yellow yogurt young youth zebra zero zone zoo
acre aged aim alto angle apex aqua atlas avid axis badger bagel ballet banjo barge basin beacon beaver
beetle bingo bison blimp blossom bobcat bongo bonsai boulder bracket bridle bugle burrow cable cadet
camper candor caper carbon cargo carton cashew cello chapel chord cinder citrus clamp cobalt condor
cosmic cougar crater crimson cruiser cumin dagger dahlia decoy delta denim dingo disco domino dragon
drizzle eclipse elixir emerald ember falcon fennel fiddle fjord flannel flint fondue fresco gadget gazebo
gecko geyser glacier goblet gopher granite gravel griddle hammock harvest hazel helium heron hickory
hornet husky iguana indigo jasmine jigsaw jolly juggle kayak kernel ketchup lagoon lantern lasso lemur
lilac llama locket lotus lynx macaw magpie mallet mantle marlin marsh meteor mitten mocha monsoon
mortar muffin mural nectar nickel nimble noodle nugget nutmeg oatmeal octave onyx opal orchard osprey
outlet paddle pagoda panther papaya parcel parsley pastel pelican pepper petal pewter pickle pinball
plaza polka poncho pretzel puffin pumpkin quartz quiver radish raisin rattle relish ripple rocket rooster
saffron salsa sapphire sardine satchel savvy scallop scarlet sequin sherbet sierra sonnet sparrow spinach
sprout squash stencil stork summit sundae sunset tango tapir tavern teapot thistle thyme timber toffee
topaz toucan trellis trolley tundra turnip tuxedo umbrella unicorn utopia vanilla vortex waffle
walrus willow wizard wombat yacht yodel zephyr zigzag zinc zipper
`;
export const WORDS = Object.freeze([...new Set(WORD_TEXT.trim().split(/\s+/))]);
const WORD_SET = new Set(WORDS);

export function passphraseEntropy({ words = 5, addNumber = false } = {}) {
  const k = clampInt(words, LIMITS.words, 5);
  return k * Math.log2(WORDS.length) + (addNumber ? Math.log2(100 * k) : 0);  // number 0–99 after one of k words
}

export function passphrase({ words = 5, separator = '-', capitalize = false, addNumber = false } = {}, source = cryptoSource) {
  const k = clampInt(words, LIMITS.words, 5);
  const list = Array.from({ length: k }, () => {
    const w = pick(WORDS, source);
    return capitalize ? w[0].toUpperCase() + w.slice(1) : w;
  });
  if (addNumber) list[randomInt(k, source)] += String(randomInt(100, source));
  return list.join(separator);
}

/* ------------------------------------------------------------------ PINs and tokens */

export const pinEntropy = ({ length = 6 } = {}) => clampInt(length, LIMITS.pin, 6) * Math.log2(10);
export const pin = ({ length = 6 } = {}, source = cryptoSource) =>
  Array.from({ length: clampInt(length, LIMITS.pin, 6) }, () => randomInt(10, source)).join('');

export const tokenEntropy = ({ bytes = 32 } = {}) => clampInt(bytes, LIMITS.bytes, 32) * 8;

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function token({ bytes = 32, format = 'hex' } = {}, source = cryptoSource) {
  const raw = randomBytes(clampInt(bytes, LIMITS.bytes, 32), source);
  return format === 'base64url' ? toBase64Url(raw) : toHex(raw);
}

/* ------------------------------------------------------------------ dispatch */

export function entropyFor(mode, o) {
  if (mode === 'passphrase') return passphraseEntropy(o);
  if (mode === 'pin') return pinEntropy(o);
  if (mode === 'token') return tokenEntropy(o);
  return randomEntropy(o);
}

export function generate(mode, o, source = cryptoSource) {
  if (mode === 'passphrase') return passphrase(o, source);
  if (mode === 'pin') return pin(o, source);
  if (mode === 'token') return token(o, source);
  return randomPassword(o, source);
}

/** Label for an entropy in bits; `kind` maps to pill classes. */
export function strength(bits) {
  if (bits < 28) return { label: 'Very weak', kind: 'err', level: 0 };
  if (bits < 40) return { label: 'Weak', kind: 'err', level: 1 };
  if (bits < 60) return { label: 'Fair', kind: 'warn', level: 2 };
  if (bits < 80) return { label: 'Strong', kind: 'ok', level: 3 };
  return { label: 'Very strong', kind: 'ok', level: 4 };
}

/* ------------------------------------------------------------------ checking a typed password (local only) */

// Top common passwords from public breach-frequency lists (lowercase); matching is case-insensitive and leet-aware.
export const COMMON = new Set(`
123456 password 123456789 12345678 12345 qwerty 1234567 111111 1234567890 123123 abc123 1234 password1
iloveyou 1q2w3e4r 000000 qwerty123 zaq12wsx dragon sunshine princess letmein 654321 monkey 27653 1qaz2wsx
123321 qwertyuiop superman asdfghjkl 666666 football baseball welcome admin login master hello freedom
whatever shadow michael jennifer trustno1 batman passw0rd starwars charlie donald 121212 qazwsx 7777777
888888 555555 112233 987654321 159753 access flower hottie loveme zxcvbnm ninja mustang solo azerty
654321 passpass secret test test123 changeme default root toor guest user pass 11111111 abcdef abcd1234
qwe123 1qazxsw2 asdf1234 asdfgh hunter2 killer jordan23 cheese summer winter autumn spring computer
internet google samsung apple pokemon minecraft liverpool chelsea arsenal soccer hockey ranger buster
tigger harley thomas jessica ashley daniel andrew joshua matthew hannah love123 iloveu princess1 qwerty1
p@ssw0rd password123 admin123 welcome1 letmein1 monkey1 dragon1 abc12345 a123456 aa123456 1password
`.trim().split(/\s+/));

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };
const deLeet = (s) => s.toLowerCase().replace(/[0134578@$!|]/g, (c) => LEET[c]);
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'qazwsxedcrfvtgbyhnujmikolp'];

/** Length of the input after removing runs (aaa), sequences (abcd, 4321) and keyboard walks (qwer). */
function effectiveChars(pw) {
  const chars = Array.from(pw);
  let effective = 0, i = 0;
  const notes = new Set();
  while (i < chars.length) {
    let j = i + 1;
    // run of the same character
    while (j < chars.length && chars[j] === chars[i]) j++;
    if (j - i >= 3) { effective += 1; notes.add('repeated characters'); i = j; continue; }
    // ascending / descending code-point sequence
    for (const step of [1, -1]) {
      let k = i + 1;
      while (k < chars.length && chars[k].codePointAt(0) - chars[k - 1].codePointAt(0) === step && /[a-z0-9]/i.test(chars[k])) k++;
      if (k - i >= 3) { j = k; notes.add('sequences like abc or 123'); break; }
    }
    if (j - i >= 3) { effective += 1.5; i = j; continue; }
    // keyboard walk
    let walk = 0;
    for (const row of KEYBOARD_ROWS) {
      let k = i;
      while (k < chars.length && row.includes(chars.slice(i, k + 1).join('').toLowerCase())) k++;
      walk = Math.max(walk, k - i);
    }
    if (walk >= 4) { effective += 1.5; notes.add('keyboard patterns like qwer'); i += walk; continue; }
    effective += 1; i++;
  }
  return { effective, notes };
}

/** Local strength estimate for a typed password. Never sent anywhere; the caller must not store it. */
export function checkPassword(pw) {
  const chars = Array.from(pw || '');
  if (!chars.length) return null;
  const classes = {
    lowercase: /[a-z]/.test(pw), uppercase: /[A-Z]/.test(pw), digits: /[0-9]/.test(pw),
    symbols: /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e ]/.test(pw), other: /[^\x20-\x7e]/.test(pw),
  };
  const pool = (classes.lowercase ? 26 : 0) + (classes.uppercase ? 26 : 0) + (classes.digits ? 10 : 0) + (classes.symbols ? 33 : 0) + (classes.other ? 100 : 0);
  const warnings = [];
  const lower = pw.toLowerCase();
  const stripped = deLeet(lower.replace(/[^a-z]+$/, ''));
  if (COMMON.has(lower) || COMMON.has(deLeet(lower))) {
    return { bits: 4, classes, length: chars.length, warnings: ['This is one of the most common passwords — it would be guessed instantly.'], ...strength(0) };
  }
  let { effective, notes } = effectiveChars(pw);
  if (stripped.length >= 4 && (COMMON.has(stripped) || COMMON.has(lower.replace(/[^a-z]+$/, '')))) {
    warnings.push('Based on a very common password with a few characters added.');
    effective = Math.min(effective, 2 + (chars.length - stripped.length) / 2);
  }
  if (/(19|20)\d\d/.test(pw)) { warnings.push('Contains a year — years are among the first things tried.'); effective -= 2; }
  const unique = new Set(chars).size;
  if (unique <= 2 && chars.length > 3) { notes.add('only one or two distinct characters'); effective = Math.min(effective, 2); }
  for (const n of notes) warnings.push(`Uses ${n}, which add little strength.`);
  if (chars.length < 12) warnings.push('Shorter than 12 characters.');
  if (Object.values(classes).filter(Boolean).length === 1 && chars.length < 20) warnings.push('Uses only one kind of character.');
  const perChar = Math.log2(Math.max(pool, 2));
  let bits = Math.max(1, effective) * perChar;
  // words from the passphrase list are worth ~log2(list size) each, not their length in characters
  const parts = pw.split(/([A-Za-z]+)/);
  const words = parts.filter((p, i) => i % 2 && p.length >= 3 && WORD_SET.has(p.toLowerCase()));
  if (words.length) {
    const rest = parts.filter((p, i) => !(i % 2 && p.length >= 3 && WORD_SET.has(p.toLowerCase()))).join('');
    const wordBits = words.length * Math.log2(WORDS.length) + (/[A-Z]/.test(words.join('')) ? words.length : 0)
      + (rest ? effectiveChars(rest).effective * perChar : 0);
    if (wordBits < bits) { bits = wordBits; warnings.push(`Contains ${words.length} common English word${words.length > 1 ? 's' : ''}; counted as words, not letters.`); }
  }
  return { bits, classes, length: chars.length, warnings, ...strength(bits) };
}

/** Rough time to guess 2^(bits-1) at the given rate (guesses / second). */
export function crackTime(bits, rate = 1e10) {
  const s = 2 ** Math.max(0, bits - 1) / rate;
  if (s < 1) return 'instantly';
  const units = [['century', 3155695200], ['year', 31556952], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  if (s > 3155695200 * 1e6) return 'longer than the age of the universe';
  for (const [name, size] of units) {
    if (s >= size) {
      const n = s / size;
      const shown = n >= 1e6 ? n.toExponential(1).replace('e+', '×10^') : String(Math.round(n));
      return `${shown} ${name === 'century' ? (n >= 2 ? 'centuries' : 'century') : name + (n >= 2 ? 's' : '')}`;
    }
  }
  return 'instantly';
}
