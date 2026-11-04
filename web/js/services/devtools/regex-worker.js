// Runs a regex off the main thread so a catastrophic pattern can be killed by a timeout (see devtools.js).
const MAX_MATCHES = 2000;

self.onmessage = ({ data: { pattern, flags, text, replacement } }) => {
  try {
    const re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
    const matches = [];
    let m;
    while ((m = re.exec(text)) && matches.length < MAX_MATCHES) {
      matches.push({ index: m.index, end: m.index + m[0].length, text: m[0], groups: m.slice(1), named: m.groups || null });
      if (m[0] === '') re.lastIndex += 1;  // zero-length match: step past it
      if (!flags.includes('g')) break;
    }
    const replaced = replacement === null ? null : text.replace(new RegExp(pattern, flags), replacement);
    self.postMessage({ matches, truncated: matches.length >= MAX_MATCHES, replaced });
  } catch (e) {
    self.postMessage({ error: e.message });
  }
};
