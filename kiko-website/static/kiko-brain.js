/*
 * KIKO brain for the website: runs entirely inside the visitor's browser.
 *
 * Same pipeline as kiko/engine.py on the laptop:
 *   1. input guard (English / Hindi / Kannada / Hinglish)  -> fixed, pre-written reply
 *   2. curated story library                                -> checked story, no model needed
 *   3. tiny LLM (llama.cpp in WebAssembly, via wllama)      -> example chats + age rules
 *   4. clean + hard limits (sentences, one question, no emojis, word swaps)
 *   5. output guard -> one strict retry -> safe fallback
 *   6. (English) too hard to read? -> one "say it simpler" retry
 *
 * The rules themselves come from static/brain-data.json, which build_web.py exports from the
 * Python code, so the website and the laptop version share one source of truth.
 */
(function () {
  "use strict";

  // Two brains to choose from. Both are GGUF files on Hugging Face (downloaded once, then cached).
  const MODELS = {
    small: {
      label: "Small brain", size: "~290 MB",
      url: "https://huggingface.co/unsloth/gemma-3-270m-it-GGUF/resolve/main/gemma-3-270m-it-Q8_0.gguf",
      note: "Fast. Best for phones. English is good; Hindi and Kannada are basic.",
    },
    better: {
      label: "Better brain", size: "~530 MB",
      url: "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf",
      note: "Smarter and better at Hindi and Kannada. For laptops and newer phones.",
    },
  };

  let D = null;            // brain-data.json
  let R = null;            // compiled regexes
  let wllama = null;       // the in-browser llama.cpp
  let loadedKey = null;
  let history = [];
  const HISTORY_TURNS = 3;          // shorter memory = less to read before each reply = faster
  const store = {
    get(k, d) { try { const v = localStorage.getItem("kiko_" + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("kiko_" + k, JSON.stringify(v)); } catch (e) {} },
  };

  /* ---------------- rules ---------------- */
  async function init(base) {
    if (D) return;
    D = await (await fetch(new URL((base || "") + "static/brain-data.json", document.baseURI))).json();
    const rx = (p, f) => new RegExp(p, f || "i");
    R = {
      input: D.input_rules.map(([cat, p]) => [cat, rx(p), D.indic_rules[cat] ? rx(D.indic_rules[cat]) : null]),
      outBlock: rx(D.output_block), outGroom: rx(D.output_grooming), outIndic: rx(D.output_block_indic),
      filler: rx(D.filler), vague: rx(D.vague_q), lesson: rx(D.lesson),
      swap: new RegExp("\\b(" + Object.keys(D.word_swaps).join("|") + ")\\b", "gi"),
      repeat: new RegExp(D.repeat, "s"),
    };
  }

  function checkInput(text) {
    for (const [cat, en, indic] of R.input) if (en.test(text) || (indic && indic.test(text))) return {safe: false, category: cat};
    return {safe: true};
  }
  function checkOutput(text) {
    if (R.outBlock.test(text) || R.outIndic.test(text)) return {safe: false, category: "unsafe_words"};
    if (R.outGroom.test(text)) return {safe: false, category: "boundary"};
    return {safe: true};
  }
  const fixedReply = (cat, lang) => (D.fixed[lang] && D.fixed[lang][cat]) || D.fixed.en[cat];
  const fallback = lang => D.fallback[lang] || D.fallback.en;

  function cleanOutput(text) {
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "");
    text = text.replace(/(https?:\/\/\S+|www\.\S+|\S+\.(com|in|org|net)\b)/gi, "");
    text = text.replace(/[*_#`>]+/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const lines = text.split("\n"), last = (lines[lines.length - 1] || "").trim();
    if (text && !".!?।\"')".includes(text[text.length - 1]) && /[.!?।]/.test(text) && !/^[AB][).:]/.test(last)) {
      text = text.slice(0, Math.max(text.lastIndexOf("."), text.lastIndexOf("!"), text.lastIndexOf("?"), text.lastIndexOf("।")) + 1);
    }
    return text.trim();
  }

  const SENT = /[^.!?।]+[.!?।]+["'”’]?/g;
  function sentences(text) {
    const parts = (text.match(SENT) || []).map(s => s.trim()).filter(Boolean);
    const rest = text.replace(SENT, "").trim();
    if (rest && rest.split(/\s+/).length > 2) parts.push(rest);
    return parts;
  }
  const squash = t => t.split(/\s+/).filter(Boolean).join(" ");
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️‍⭐⬆↔-↪]+/gu;

  function simplify(text, maxS, mode) {
    text = text.replace(EMOJI, "");
    text = text.replace(R.swap, w => { const n = D.word_swaps[w.toLowerCase()]; return w[0] === w[0].toUpperCase() ? n[0].toUpperCase() + n.slice(1) : n; });
    if (mode === "interactive_story") {
      let story = text, a = "", b = "";
      const ma = text.match(/\bA[).:]\s*([\s\S]+?)(?=\s*\bB[).:]|$)/), mb = text.match(/\bB[).:]\s*([\s\S]+?)(?=\n|$)/);
      if (ma) { story = text.slice(0, ma.index); a = "A) " + ma[1].trim().split("\n")[0]; }
      if (mb) b = "B) " + mb[1].trim();
      story = sentences(squash(story)).slice(0, maxS).join(" ");
      return [story, a, b].filter(Boolean).join("\n").trim();
    }
    const sents = sentences(squash(text));
    if (D.story_modes.includes(mode)) {
      const lesson = sents.find(s => R.lesson.test(s));
      let keep = sents.slice(0, maxS);
      if (lesson && !keep.includes(lesson)) keep = keep.slice(0, maxS - 1).concat([lesson]);
      return keep.join(" ");
    }
    const real = sents.filter(s => !R.filler.test(s));
    const use = real.length ? real : sents.slice(0, 1);
    const statements = use.filter(s => !s.endsWith("?")), questions = use.filter(s => s.endsWith("?"));
    const question = questions.find(q => !R.vague.test(q)) || questions[0] || null;
    const keep = statements.slice(0, Math.max(maxS - (question ? 1 : 0), 1));
    if (question) keep.push(question);
    return keep.join(" ");
  }

  function looksBroken(text, lang) {
    if (!text) return false;
    if (R.repeat.test(text)) return true;
    const letters = [...text].filter(c => /\p{L}/u.test(c));      // same as Python's str.isalpha()
    if (letters.length < 8) return false;
    const allowed = new RegExp("[A-Za-z" + (D.scripts[lang] || "") + "]");
    return letters.filter(c => !allowed.test(c)).length / letters.length > 0.15;
  }
  function capLength(text, mode) {
    const limit = D.max_chars[["story", "culture", "interactive_story"].includes(mode) ? "story" : "chat"];
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit);
    const end = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"), cut.lastIndexOf("।"));
    return (end > Math.floor(limit / 3) ? cut.slice(0, end + 1) : cut).trim();
  }

  function readability(text) {
    const sents = text.split(/[.!?]+/).filter(s => s.trim());
    const words = text.match(/[A-Za-z']+/g) || [];
    if (!words.length) return {words: 0, grade: 0};
    const syl = w => { w = w.toLowerCase(); const g = w.match(/[aeiouy]+/g) || []; return Math.max(1, g.length - (w.endsWith("e") && g.length > 1 ? 1 : 0)); };
    const nSyl = words.reduce((a, w) => a + syl(w), 0);
    const asl = words.length / Math.max(1, sents.length);
    return {words: words.length, grade: Math.round((0.39 * asl + 11.8 * (nSyl / words.length) - 15.59) * 10) / 10};
  }

  /* ---------------- prompts ---------------- */
  const band = age => D.age_bands[age] || D.age_bands["6-8"];
  const fill = (tpl, b) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in b ? b[k] : m));
  function systemPrompt(mode, age, lang) {
    const b = band(age);
    const parts = [fill(D.core_rules, b), "NOW: " + fill(D.mode_rules[mode] || D.mode_rules.chat, b)];
    if (D.language_hint[lang]) parts.push(D.language_hint[lang]);
    return parts.join("\n\n");
  }
  function fewShot(mode, lang) {
    let shots;
    if (D.few_shot_lang[lang]) shots = D.few_shot_lang[lang][mode] || D.few_shot_lang[lang][mode === "culture" ? "story" : "chat"];
    else shots = D.few_shot[mode] || D.few_shot.chat;
    return shots.flatMap(([u, k]) => [{role: "user", content: u}, {role: "assistant", content: k}]);
  }
  function maxTokens(age, mode) {
    const b = band(age);
    return D.story_modes.includes(mode) ? b.story_tokens : Math.round(b.tokens * (["interactive_story", "play"].includes(mode) ? 1.6 : 1));
  }
  function maxSentences(age, mode) {
    const b = band(age);
    if (D.story_modes.includes(mode)) return b.story;
    return b.sentences + ({learn: 2, play: 3, feelings: 2, interactive_story: 1}[mode] || 1);
  }
  const temperature = mode => (D.story_modes.concat(["interactive_story"]).includes(mode) ? 0.8 : 0.5);
  const strictNote = lang => (D.strict_note + " " + (D.language_hint[lang] || "")).trim();
  const simplerNote = age => { const b = band(age); return `Too hard! Say it again for a ${b.age}-year-old. Use tiny words. Only ${b.sentences} short sentences.`; };

  /* ---------------- story library ---------------- */
  const STORY_ASK = /\b(story|stories|tale|tell me about|read|bedtime)\b|कहानी|कथा|किस्सा|ಕಥೆ|ಕತೆ/i;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (t, kw) => /^[\x00-\x7F]*$/.test(kw) ? new RegExp("\\b" + esc(kw.toLowerCase()) + "\\b").test(t) : t.includes(kw.toLowerCase());
  function matchStory(text, mode, C, Cen) {
    const t = text.toLowerCase();
    if (!D.story_modes.includes(mode) && !STORY_ASK.test(t)) return null;
    let bestId = null, bestLen = 0;
    for (const src of [C, Cen]) for (const s of (src && src.stories) || []) for (const kw of s.keywords || []) {
      if (has(t, kw) && kw.length > bestLen) { bestId = s.id; bestLen = kw.length; }
    }
    return bestId ? (C.stories || []).find(s => s.id === bestId) || null : null;
  }
  const storyText = (s, C) => s.lines.join(" ") + " " + (C.lesson_prefix || "And the lesson is:") + " " + s.lesson;

  /* ---------------- the model ---------------- */
  // Absolute address of the website folder (works on GitHub Pages sub-folders like /kiko/).
  const siteRoot = base => new URL(base || "./", document.baseURI).href;
  const hasGPU = () => typeof navigator !== "undefined" && !!navigator.gpu;
  const useGPU = () => hasGPU() && store.get("use_gpu", false) === true;
  function recommended() {
    const mem = navigator.deviceMemory || 4;
    const phone = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    return phone || mem < 6 ? "small" : "better";
  }
  async function load(key, onProgress, base) {
    const m = MODELS[key]; if (!m) throw new Error("unknown model");
    if (loadedKey === key && wllama && wllama.isModelLoaded()) return;
    const root = siteRoot(base);
    const mod = await import(root + "static/wllama/index.js");
    if (wllama) { try { await wllama.exit(); } catch (e) {} }
    wllama = new mod.Wllama({default: root + "static/wllama/wasm/wllama.wasm"}, {suppressNativeLog: true, allowOffline: true});
    const url = store.get("model_url_override", null) || m.url;      // (testing hook)
    const opts = {n_ctx: 2048, useCache: true, reasoning: false, default_template_kwargs: {enable_thinking: false},
                  progressCallback: ({loaded, total}) => onProgress && total && onProgress(Math.round(loaded / total * 100))};
    try {
      // The graphics-chip path (WebGPU) is experimental in browsers and can produce nonsense on some
      // computers, so KIKO uses the processor unless a grown-up switches the graphics chip on.
      await wllama.loadModelFromUrl(url, Object.assign({n_gpu_layers: useGPU() ? 99 : 0}, opts));
    } catch (e) {
      if (!useGPU()) throw e;
      wllama = new mod.Wllama({default: root + "static/wllama/wasm/wllama.wasm"}, {suppressNativeLog: true, allowOffline: true});
      await wllama.loadModelFromUrl(url, Object.assign({n_gpu_layers: 0}, opts));    // graphics chip failed: use the CPU
    }
    loadedKey = key; store.set("brain", key);
    // ask the browser to keep the brain even when the device is low on space
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }
  async function generate(messages, maxTok, temp, lang) {
    let text = "", pieces = 0;
    const stop = new AbortController();
    try {
      await wllama.createChatCompletion({
        messages, max_tokens: maxTok, temperature: temp, temp, top_p: 0.9, top_k: 40, min_p: 0.05,
        penalty_repeat: 1.15, penalty_last_n: 64, cache_prompt: true,
        chat_template_kwargs: {enable_thinking: false}, abortSignal: stop.signal, stream: true,
        onData: chunk => {
          const d = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (d && d.content){ text += d.content; pieces++; }
          // stop as soon as it loops / changes alphabet, or once it has said enough
          if ((pieces % 8 === 0 && looksBroken(text, lang)) || pieces > maxTok + 8 || text.length > 1600) stop.abort();
        },
      });
    } catch (e) {
      if (!(e && (e.name === "AbortError" || /abort/i.test(String(e))))) throw e;
    }
    return text;
  }
  async function forget() {
    try {
      const root = siteRoot();
      const mod = await import(root + "static/wllama/index.js");
      const w = wllama || new mod.Wllama({default: root + "static/wllama/wasm/wllama.wasm"});
      await w.cacheManager.clear();
    } catch (e) {}
    store.set("brain", null); loadedKey = null;
  }

  /* ---------------- one chat turn ---------------- */
  function greet(lang) {
    const g = D.greetings[lang] || D.greetings.en;
    history = [{role: "user", content: "Hi KIKO!"}, {role: "assistant", content: g}];
    return g;
  }
  function messagesFor(text, mode, age, lang, note) {
    return [{role: "system", content: systemPrompt(mode, age, lang)}, ...fewShot(mode, lang), ...history.slice(-HISTORY_TURNS * 2),
            {role: "user", content: note ? `${text}\n\n(${note})` : text}];
  }
  async function ask(text, o, note) {
    const raw = await generate(messagesFor(text, o.mode, o.age, o.lang, note), maxTokens(o.age, o.mode), temperature(o.mode), o.lang);
    const cleaned = cleanOutput(raw);
    if (looksBroken(cleaned, o.lang)) return "";                    // stuck / nonsense: treat as no answer
    return capLength(simplify(cleaned, maxSentences(o.age, o.mode), o.mode), o.mode);
  }
  // o = {mode, age, lang, content, contentEn}
  async function reply(text, o) {
    if (!history.length) greet(o.lang);
    const chk = checkInput(text);
    if (!chk.safe) return {text: fixedReply(chk.category, o.lang), source: "fixed_reply"};
    const story = matchStory(text, o.mode, o.content, o.contentEn);
    if (story) { const s = storyText(story, o.content); remember(text, s); return {text: s, source: "library"}; }
    if (!wllama || !wllama.isModelLoaded()) return {text: null, source: "need_brain"};

    let out = await ask(text, o);
    if (!checkOutput(out).safe || !out) {
      out = await ask(text, o, strictNote(o.lang));
      if (!checkOutput(out).safe || !out) return {text: fallback(o.lang), source: "fallback"};
    } else if (o.lang === "en" && !D.story_modes.concat(["interactive_story"]).includes(o.mode)) {
      const r = readability(out);
      if (r.words >= 12 && r.grade > band(o.age).grade + 2) {
        const out2 = await ask(text, o, simplerNote(o.age));
        if (out2 && checkOutput(out2).safe && readability(out2).grade < r.grade) out = out2;
      }
    }
    remember(text, out);
    return {text: out, source: "model"};
  }
  function remember(u, k) { history.push({role: "user", content: u}, {role: "assistant", content: k}); }

  window.KikoBrain = {
    MODELS, init, load, forget, reply, greet, recommended,
    reset: () => { history = []; },
    isReady: () => !!(wllama && wllama.isModelLoaded()),
    savedBrain: () => store.get("brain", null),
    fallbackText: lang => (D ? fallback(lang) : "Hmm, let me think of something better!"),
    // exposed for tests
    hasGPU, useGPU, setGPU: on => store.set("use_gpu", !!on),
    multiThread: () => typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
    _t: {checkInput, checkOutput, cleanOutput, simplify, sentences, matchStory, storyText, systemPrompt, fewShot, maxTokens, maxSentences, readability, looksBroken, capLength},
  };
})();
