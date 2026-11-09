/* KIKO's live facts: answers "who is the president of France?", "capital of Japan?",
   "भारत के प्रधानमंत्री कौन हैं?", "ಕರ್ನಾಟಕದ ಮುಖ್ಯಮಂತ್ರಿ ಯಾರು?" by looking them up in Wikidata,
   the free encyclopedia data behind Wikipedia that volunteers keep up to date.

   Why: a tiny offline brain only knows the world as it was when it was trained, and often guesses.
   Facts that change (leaders, population) need a live lookup, so this needs the internet.
   Without internet KIKO says so, and never guesses.

   KikoFacts.answer(text, lang) -> Promise<string | null>
     null = not a facts question (or "who is X" not found): let KIKO's brain answer instead. */
(function () {
  "use strict";
  const API = "https://www.wikidata.org/w/api.php";
  const TIMEOUT = 9000;

  /* ---------- what is the child asking? ---------- */
  // role -> Wikidata properties to try (P35 head of state, P6 head of government), and words to look for in the office name
  const ROLES = {
    president: {props: ["P35", "P6"], word: /president/i},
    pm:        {props: ["P6", "P35"], word: /prime minister|premier|chancellor/i},
    cm:        {props: ["P6"], word: /chief minister/i},
    governor:  {props: ["P35", "P6"], word: /governor/i},
    mayor:     {props: ["P6"], word: /mayor/i},
    king:      {props: ["P35"], word: /king|queen|monarch|emperor|sultan|emir/i},
    leader:    {props: ["P6", "P35"], word: null},
    capital:   {props: ["P36"]},
    currency:  {props: ["P38"]},
    population:{props: ["P1082"]},
  };
  const EN_ROLE = [
    [/\b(president)\b/, "president"], [/\b(prime minister|pm|premier|chancellor)\b/, "pm"], [/\b(chief minister|cm)\b/, "cm"],
    [/\b(governor)\b/, "governor"], [/\b(mayor)\b/, "mayor"], [/\b(king|queen|monarch|emperor|ruler)\b/, "king"],
    [/\b(leader|head)\b/, "leader"],
  ];
  const HI_ROLE = [["राष्ट्रपति", "president"], ["प्रधानमंत्री", "pm"], ["प्रधान मंत्री", "pm"], ["मुख्यमंत्री", "cm"], ["मुख्य मंत्री", "cm"],
    ["राज्यपाल", "governor"], ["महापौर", "mayor"], ["राजा", "king"], ["रानी", "king"], ["नेता", "leader"],
    ["राजधानी", "capital"], ["मुद्रा", "currency"], ["करेंसी", "currency"], ["जनसंख्या", "population"], ["आबादी", "population"]];
  const KN_ROLE = [["ಅಧ್ಯಕ್ಷ", "president"], ["ರಾಷ್ಟ್ರಪತಿ", "president"], ["ಪ್ರಧಾನ ಮಂತ್ರಿ", "pm"], ["ಪ್ರಧಾನಮಂತ್ರಿ", "pm"], ["ಪ್ರಧಾನಿ", "pm"],
    ["ಮುಖ್ಯಮಂತ್ರಿ", "cm"], ["ಮುಖ್ಯ ಮಂತ್ರಿ", "cm"], ["ರಾಜ್ಯಪಾಲ", "governor"], ["ಮೇಯರ್", "mayor"], ["ರಾಜ", "king"], ["ರಾಣಿ", "king"],
    ["ನಾಯಕ", "leader"], ["ರಾಜಧಾನಿ", "capital"], ["ಕರೆನ್ಸಿ", "currency"], ["ಹಣ", "currency"], ["ಜನಸಂಖ್ಯೆ", "population"]];
  const HINGLISH_ROLE = [[/\b(rashtrapati|president)\b/, "president"], [/\b(pradhan ?mantri|pm|prime minister)\b/, "pm"],
    [/\b(mukhya ?mantri|cm|chief minister)\b/, "cm"], [/\b(rajdhani|capital)\b/, "capital"], [/\b(mudra|currency)\b/, "currency"],
    [/\b(jansankhya|aabadi|population)\b/, "population"]];

  // longest words first, so ರಾಜಧಾನಿ (capital) is not read as ರಾಜ (king)
  [HI_ROLE, KN_ROLE].forEach(l => l.sort((a, b) => b[0].length - a[0].length));
  const NEWS = /\b(news|headlines?|who won|winner of|won the|score|scores|match today|election results?|breaking)\b|समाचार|ख़बर|खबर|ಸುದ್ದಿ/i;
  const FILLER = /\b(now|today|currently|right now|at present|these days|nowadays|please|pls|plz|kiko|tell me|in \d{4})\b/gi;
  const tidy = s => s.replace(FILLER, " ").replace(/[?!.,"“”'’]+/g, " ").replace(/^\s*(the|of|in)\s+/i, "").replace(/\s+/g, " ").trim();

  function parse(text, lang) {
    const t = " " + text.toLowerCase().replace(/[?!।.]+/g, " ").replace(/\s+/g, " ") + " ";
    if (/\b(story|stories|tale|sing|song|rhyme)\b|कहानी|कथा|किस्सा|गाना|ಕಥೆ|ಕತೆ|ಹಾಡು/.test(t)) return null;   // stories and songs are not facts
    // English (works in every language: "who is the president of France")
    let m;
    for (const [rx, role] of EN_ROLE) {
      const r = new RegExp(rx.source + "\\s+(?:of|in|for)\\s+(?:the\\s+)?(.+)$");
      if ((m = t.match(r))) return {role, places: [tidy(m[m.length - 1])]};
      const r2 = new RegExp("(?:^|\\s)([a-z .]+?)(?:'s|’s)\\s+(?:current\\s+|present\\s+)?" + rx.source);
      if ((m = t.match(r2))) return {role, places: [tidy(m[1].replace(/^.*\b(is|who|what|name)\b/, ""))]};
    }
    if ((m = t.match(/\bcapital(?:\s+city)?\s+(?:of|in)\s+(?:the\s+)?(.+)$/))) return {role: "capital", places: [tidy(m[1])]};
    if ((m = t.match(/\bcurrency\s+(?:of|in|used in)\s+(?:the\s+)?(.+)$/)) || (m = t.match(/\bwhat money (?:do|does) (?:they|people)? ?use in\s+(.+)$/)))
      return {role: "currency", places: [tidy(m[1])]};
    if ((m = t.match(/\bpopulation\s+(?:of|in)\s+(?:the\s+)?(.+)$/)) || (m = t.match(/\bhow many people (?:live|are there) in\s+(?:the\s+)?(.+)$/)))
      return {role: "population", places: [tidy(m[1])]};
    // Hinglish: "india ke pm kaun hai", "japan ki rajdhani kya hai"
    if ((m = t.match(/(?:^|\s)([a-z]+(?: [a-z]+)?)\s+(?:ke|ka|ki)\s+(.+)$/))) {
      for (const [rx, role] of HINGLISH_ROLE) if (rx.test(m[2])) return {role, places: lastWords(m[1])};
    }
    // Hindi: "भारत के प्रधानमंत्री कौन हैं", "जापान की राजधानी क्या है"
    for (const [w, role] of HI_ROLE) {
      const i = t.indexOf(w);
      if (i < 0) continue;
      const before = t.slice(0, i).replace(/\s(के|का|की|में)\s*$/, " ").trim();
      if (before) return {role, places: lastWords(before)};
    }
    // Kannada: "ಭಾರತದ ಪ್ರಧಾನಿ ಯಾರು", "ಜಪಾನಿನ ರಾಜಧಾನಿ ಯಾವುದು"
    for (const [w, role] of KN_ROLE) {
      const i = t.indexOf(w);
      if (i < 0) continue;
      const before = t.slice(0, i).trim();
      if (before) return {role, places: lastWords(before).flatMap(knStems)};
    }
    // "who is Virat Kohli?" -> a short description of a real person
    if ((m = t.match(/^\s*(?:who is|who's|whos|who was)\s+(.+)$/))) {
      const name = tidy(m[1]);
      if (name && !/^(you|your|my|me|i|we|he|she|it|they|this|that|there|the best|better|kiko)\b/.test(name) && name.length < 50)
        return {role: "person", places: [name]};
    }
    if (NEWS.test(t)) return {role: "news"};
    return null;
  }
  function lastWords(s) {
    const w = s.trim().split(/\s+/).filter(x => !/^(बताओ|बताइए|बता|क्या|कौन|हैं|है|ತಿಳಿಸು|ಹೇಳು|ಯಾರು|batao|bata|kaun|kya)$/.test(x));
    const out = [];
    if (w.length >= 2) out.push(w.slice(-2).join(" "));
    if (w.length) out.push(w[w.length - 1]);
    return out;
  }
  // Kannada adds endings for "of": ಭಾರತದ -> ಭಾರತ, ಜಪಾನಿನ -> ಜಪಾನ್, ಕರ್ನಾಟಕದ -> ಕರ್ನಾಟಕ
  function knStems(w) {
    w = w.replace(/‌/g, "");
    const out = [];
    if (/ದ$/.test(w)) out.push(w.slice(0, -1));
    if (/ಿನ$/.test(w)) out.push(w.slice(0, -2) + "್");
    if (/ನ$/.test(w)) out.push(w.slice(0, -1));
    if (/ರ$/.test(w)) out.push(w.slice(0, -1));
    if (/ಯ$/.test(w)) out.push(w.slice(0, -1));
    out.push(w);                       // the word as typed, last
    return [...new Set(out)];
  }

  /* ---------- talking to Wikidata ---------- */
  async function api(params) {
    const q = new URLSearchParams(Object.assign({format: "json", origin: "*"}, params));
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(API + "?" + q, {signal: ctl.signal});
      if (!r.ok) throw new Error("wikidata " + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  async function search(name, lang) {
    for (const lg of [...new Set([lang, "en"])]) {
      const j = await api({action: "wbsearchentities", search: name, language: lg, uselang: lg, type: "item", limit: "6"});
      if (j.search && j.search.length) return j.search;
    }
    return [];
  }
  const entities = (ids, props, langs) => api({action: "wbgetentities", ids: ids.join("|"), props, languages: langs}).then(j => j.entities || {});
  // The statement that is true now: "preferred" first; skip ones with an end date (P582) in the past.
  function current(claims) {
    const now = new Date().toISOString();
    const ok = (claims || []).filter(c => c.rank !== "deprecated" && c.mainsnak && c.mainsnak.datavalue).filter(c => {
      const end = c.qualifiers && c.qualifiers.P582 && c.qualifiers.P582[0].datavalue;
      return !end || end.value.time.replace(/^\+/, "") > now;
    });
    const pref = ok.filter(c => c.rank === "preferred");
    const list = pref.length ? pref : ok;
    const when = c => { const q = c.qualifiers && (c.qualifiers.P585 || c.qualifiers.P580); return q && q[0].datavalue ? q[0].datavalue.value.time : ""; };
    return list.sort((a, b) => when(b).localeCompare(when(a)))[0] || null;
  }
  const label = (e, lang) => e && e.labels && ((e.labels[lang] || e.labels.en || {}).value || "");
  const desc = (e, lang) => e && e.descriptions && ((e.descriptions[lang] || e.descriptions.en || {}).value || "");

  /* ---------- what KIKO says ---------- */
  const SAY = {
    en: {pre: "I just checked: ", office: "the {office} is {x}.", leader: "the leader of {place} is {x}.", capital: "the capital of {place} is {x}.",
         currency: "{place} uses the {x}.", population: "about {x} people live in {place}.", person: "{x} is {d}.",
         offline: "I need the internet to check new facts, and I can't reach it right now. Ask a grown-up, or try again later!",
         none: "I looked, but I couldn't find that. Can you say the name of the country or state again?",
         news: "I can't read the news yet. A grown-up can tell you today's news! You can ask me who leads a country, or a country's capital.",
         grownup: "That's a grown-up topic. You can ask a grown-up you trust about it."},
    hi: {pre: "मैंने अभी देखा: ", office: "{office} {x} हैं।", leader: "{place} के नेता {x} हैं।", capital: "{place} की राजधानी {x} है।",
         currency: "{place} की मुद्रा {x} है।", population: "{place} में लगभग {x} लोग रहते हैं।", person: "{x}: {d}।",
         offline: "नई बातें देखने के लिए मुझे इंटरनेट चाहिए, और अभी इंटरनेट नहीं मिल रहा। किसी बड़े से पूछो, या थोड़ी देर बाद फिर पूछो!",
         none: "मैंने देखा, पर मुझे यह नहीं मिला। देश या राज्य का नाम फिर से बोलोगे?",
         news: "मैं अभी समाचार नहीं पढ़ सकता। आज की ख़बरें कोई बड़ा बता सकता है! तुम मुझसे किसी देश के नेता या राजधानी के बारे में पूछ सकते हो।",
         grownup: "यह बड़ों वाली बात है। किसी भरोसेमंद बड़े से इसके बारे में पूछो।"},
    kn: {pre: "ನಾನು ಈಗ ನೋಡಿದೆ: ", office: "{office}: {x}.", leader: "{place} ನಾಯಕರು: {x}.", capital: "{place} ರಾಜಧಾನಿ: {x}.",
         currency: "{place} ಹಣ: {x}.", population: "{place}: ಸುಮಾರು {x} ಜನ ಇದ್ದಾರೆ.", person: "{x}: {d}.",
         offline: "ಹೊಸ ವಿಷಯ ನೋಡಲು ನನಗೆ ಇಂಟರ್ನೆಟ್ ಬೇಕು, ಈಗ ಸಿಗುತ್ತಿಲ್ಲ. ದೊಡ್ಡವರನ್ನು ಕೇಳು, ಅಥವಾ ಸ್ವಲ್ಪ ಹೊತ್ತಿನ ನಂತರ ಮತ್ತೆ ಕೇಳು!",
         none: "ನಾನು ನೋಡಿದೆ, ಆದರೆ ಸಿಗಲಿಲ್ಲ. ದೇಶ ಅಥವಾ ರಾಜ್ಯದ ಹೆಸರನ್ನು ಮತ್ತೆ ಹೇಳುತ್ತೀಯಾ?",
         news: "ನಾನು ಇನ್ನೂ ಸುದ್ದಿ ಓದಲಾರೆ. ಇಂದಿನ ಸುದ್ದಿಯನ್ನು ದೊಡ್ಡವರು ಹೇಳಬಹುದು! ನೀನು ನನ್ನನ್ನು ಒಂದು ದೇಶದ ನಾಯಕರು ಅಥವಾ ರಾಜಧಾನಿ ಬಗ್ಗೆ ಕೇಳಬಹುದು.",
         grownup: "ಇದು ದೊಡ್ಡವರ ವಿಷಯ. ನಿನ್ನ ನಂಬಿಕೆಯ ದೊಡ್ಡವರನ್ನು ಕೇಳು."},
  };
  // Descriptions of people can mention things children shouldn't get from KIKO.
  const GROWNUP = /\b(porn\w*|sex\w*|erotic|adult (film|actress|actor|model)|murder\w*|killer|criminal|terroris\w*|gangster|drug\w*|rapist|convicted|nazi|dictator|mass shooter|cartel)\b/i;
  const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] == null ? "" : v[k]);
  function bigNumber(n, lang) {
    if (lang === "en") return n >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, "") + " billion" : n >= 1e6 ? Math.round(n / 1e6) + " million" : Math.round(n).toLocaleString("en");
    const [crore, lakh] = lang === "hi" ? ["करोड़", "लाख"] : ["ಕೋಟಿ", "ಲಕ್ಷ"];
    return n >= 1e7 ? Math.round(n / 1e7) + " " + crore : n >= 1e5 ? Math.round(n / 1e5) + " " + lakh : Math.round(n).toLocaleString("en-IN");
  }
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

  async function lookup(q, lang) {
    const L = SAY[lang] || SAY.en, langs = [...new Set([lang, "en"])].join("|");
    if (q.role === "news") return L.news;
    if (q.role === "person") {
      const hits = await search(q.places[0], lang);
      if (!hits.length) return null;
      const ents = await entities(hits.slice(0, 3).map(h => h.id), "claims|labels|descriptions", langs);
      for (const h of hits.slice(0, 3)) {
        const e = ents[h.id];
        const human = e && e.claims && (e.claims.P31 || []).some(c => c.mainsnak.datavalue && c.mainsnak.datavalue.value.id === "Q5");
        if (!human) continue;
        const d = desc(e, lang);
        if (!d) return null;
        if (GROWNUP.test(desc(e, "en"))) return L.grownup;
        return L.pre + fill(L.person, {x: label(e, lang), d: lang === "en" && !/^(a|an|the)\s/i.test(d) ? (/^[aeiou]/i.test(d) ? "an " : "a ") + d : d});
      }
      return null;
    }
    // find the place: try each spelling the child might mean, keep the first that has what we need
    const role = ROLES[q.role];
    let place = null, cands = [];
    for (const p of q.places.filter(Boolean)) {
      cands = await search(p, lang);
      if (!cands.length) continue;
      const ents = await entities(cands.slice(0, 5).map(c => c.id), "claims|labels", langs);
      place = cands.slice(0, 5).map(c => ents[c.id]).find(e => e && e.claims && role.props.some(pr => e.claims[pr]));
      if (place) break;
    }
    if (!place) return null;          // "king of the jungle" is not a country: let KIKO's brain answer
    let prop = role.props.find(pr => place.claims[pr]), officeId = null;
    if (q.role !== "capital" && q.role !== "currency" && q.role !== "population") {
      // which office is it? (P1906 = office of the head of state, P1313 = of the head of government)
      const officeOf = {P35: "P1906", P6: "P1313"};
      const offices = {};
      for (const pr of role.props) { const c = current(place.claims[officeOf[pr]]); if (c) offices[pr] = c.mainsnak.datavalue.value.id; }
      const oEnts = Object.keys(offices).length ? await entities(Object.values(offices), "labels", langs) : {};
      if (role.word) { const better = role.props.find(pr => place.claims[pr] && offices[pr] && role.word.test(label(oEnts[offices[pr]], "en"))); if (better) prop = better; }
      officeId = offices[prop];
      place._offices = oEnts;
    }
    const st = current(place.claims[prop]);
    if (!st) return L.none;
    const placeName = label(place, lang);
    if (q.role === "population") return L.pre + fill(L.population, {x: bigNumber(parseFloat(st.mainsnak.datavalue.value.amount), lang), place: placeName});
    const valId = st.mainsnak.datavalue.value.id;
    const vEnts = await entities([valId], "labels", langs);
    const x = label(vEnts[valId], lang);
    if (!x) return L.none;
    if (q.role === "capital") return L.pre + fill(L.capital, {place: placeName, x});
    if (q.role === "currency") return L.pre + fill(L.currency, {place: placeName, x});
    const office = officeId && label(place._offices[officeId], lang);
    const line = office ? fill(L.office, {office, x}) : fill(L.leader, {place: placeName, x});
    return L.pre + (lang === "en" ? line : cap(line));
  }

  async function answer(text, lang) {
    const q = parse(text || "", lang || "en");
    if (!q) return null;
    const L = SAY[lang] || SAY.en;
    if (q.role === "news") return L.news;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return q.role === "person" ? null : L.offline;
    try { return await lookup(q, lang || "en"); }
    catch (e) { console.log("facts lookup failed", e); return q.role === "person" ? null : L.offline; }
  }

  window.KikoFacts = {answer, _t: {parse, knStems, current, bigNumber}};
})();
