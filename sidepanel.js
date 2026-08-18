/* Flight Deck — natural-language flight lookup.
   Query -> Claude (parse to structured params) -> SerpApi Google Flights -> render + Claude summary. */

"use strict";

// White-label: booking links go to the live Google Flights page for the search.
function bookingUrl() {
  return state.gfUrl || "https://www.google.com/travel/flights";
}

// ---------- Settings ----------

const DEFAULTS = {
  anthropicKey: "",
  serpapiKey: "",
  model: "claude-opus-5",
  openaiKey: "",
  ttsVoice: "alloy",
  speakResults: true,
};
let settings = { ...DEFAULTS };

const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  settings = { ...DEFAULTS, ...stored };
  $("anthropicKey").value = settings.anthropicKey;
  $("serpapiKey").value = settings.serpapiKey;
  $("modelSelect").value = settings.model;
  $("openaiKey").value = settings.openaiKey;
  $("voiceSelect").value = settings.ttsVoice;
  $("speakResults").checked = settings.speakResults;
}

async function saveSettings() {
  settings = {
    anthropicKey: $("anthropicKey").value.trim(),
    serpapiKey: $("serpapiKey").value.trim(),
    model: $("modelSelect").value,
    openaiKey: $("openaiKey").value.trim(),
    ttsVoice: $("voiceSelect").value,
    speakResults: $("speakResults").checked,
  };
  await chrome.storage.local.set(settings);
  const status = $("settingsStatus");
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 2000);
}

// ---------- UI helpers ----------

function setStatus(text) {
  const bar = $("statusBar");
  if (!text) {
    bar.classList.add("hidden");
    return;
  }
  $("statusText").textContent = text;
  bar.classList.remove("hidden");
}

function showError(msg) {
  const box = $("errorBox");
  box.textContent = msg;
  box.classList.remove("hidden");
}

function clearOutput() {
  for (const id of ["askBar", "parsedBar", "summaryBox", "insightsBar", "noticeBar", "resultsPanel", "errorBox"]) {
    $(id).classList.add("hidden");
  }
  $("resultsList").innerHTML = "";
  $("gfLink").classList.add("hidden");
  $("backBtn").classList.add("hidden");
  $("tripSummary").classList.add("hidden");
  $("tripLines").innerHTML = "";
  $("bookTripBtn").classList.add("hidden");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

// ---------- Claude API ----------

async function callClaude({ system, messages, schema, maxTokens }) {
  const body = {
    model: settings.model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system }],
    messages,
  };
  const outputConfig = {};
  // Haiku 4.5 doesn't support the effort parameter; Opus/Sonnet 5 do.
  if (!settings.model.includes("haiku")) outputConfig.effort = "low";
  if (schema) outputConfig.format = { type: "json_schema", schema };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API error: ${data?.error?.message || res.status}`);
  }
  if (data.stop_reason === "refusal") {
    throw new Error("The model declined this request.");
  }
  const text = (data.content || []).find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Empty response from Claude.");
  return text;
}

const PARSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: ["book", "explore"],
      description: "book = a concrete trip search with dates. explore = a general question about a route (availability, nonstop service, schedules) with open/flexible dates.",
    },
    origin: { type: ["string", "null"], description: "IATA airport code of origin, or comma-separated codes for multi-airport cities (e.g. JFK,EWR,LGA). Never metro codes like NYC or LON." },
    destination: { type: ["string", "null"], description: "IATA airport code of destination, or comma-separated codes for multi-airport cities (e.g. LHR,LGW). Never metro codes." },
    outbound_date: { type: ["string", "null"], description: "book intent: departure date, YYYY-MM-DD. explore intent: null" },
    return_date: { type: ["string", "null"], description: "Return date YYYY-MM-DD, or null" },
    trip_type: { type: "string", enum: ["round_trip", "one_way"] },
    nonstop_only: { type: "boolean" },
    travel_class: { type: "integer", enum: [1, 2, 3, 4], description: "1 economy, 2 premium economy, 3 business, 4 first" },
    adults: { type: "integer", enum: [1, 2, 3, 4, 5, 6] },
    airlines: {
      type: ["array", "null"],
      items: { type: "string", enum: ["DL", "UA", "AA"] },
      description: "Only if the user explicitly named airlines; otherwise null",
    },
    explore_window_start: { type: ["string", "null"], description: "explore intent: start of the implied date window, YYYY-MM-DD ('next couple of weeks' -> today through +14 days; 'end of September' -> the last ~10 days of September). Null if no window implied." },
    explore_window_end: { type: ["string", "null"], description: "explore intent: end of the implied date window, YYYY-MM-DD. Null if none." },
    explore_question: { type: ["string", "null"], description: "explore intent: the user's actual question in one sentence, e.g. 'Are there daily nonstop flights in both directions between PHL and ATH?'. Null for book intent." },
    check_both_directions: { type: "boolean", description: "explore intent: true if the user asked about (or would clearly benefit from) return-direction service too" },
    clarification_needed: {
      type: ["string", "null"],
      description: "A short question for the user ONLY if truly required info is missing. book: origin, destination, or departure date. explore: origin or destination only — NEVER ask for dates on explore. Otherwise null.",
    },
  },
  required: [
    "intent", "origin", "destination", "outbound_date", "return_date", "trip_type",
    "nonstop_only", "travel_class", "adults", "airlines",
    "explore_window_start", "explore_window_end", "explore_question", "check_both_directions",
    "clarification_needed",
  ],
};

function parseSystemPrompt() {
  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
  const dateStr = now.toLocaleDateString("en-CA"); // YYYY-MM-DD local
  return [
    "You convert a natural-language flight request into structured search parameters.",
    `Today is ${dayName}, ${dateStr}.`,
    "Rules:",
    "- intent: 'explore' when the user asks a general question about a route — whether nonstop service exists, how often it runs, what's available — with open, flexible, or unstated dates ('at some point', 'dates are still open', 'just looking', 'general information'). 'book' when they describe a concrete trip to search.",
    "- Convert cities/airports to IATA AIRPORT codes. The search API does NOT accept metro/city codes (NYC, LON, WAS, CHI, TYO). For multi-airport cities, list the major airports comma-separated: New York -> JFK,EWR,LGA; London -> LHR,LGW; Paris -> CDG,ORY; Chicago -> ORD,MDW; Washington DC -> IAD,DCA; Tokyo -> HND,NRT; Milan -> MXP,LIN; Houston -> IAH,HOU. Otherwise use the single main airport code.",
    "- Resolve relative dates ('next Friday', 'tomorrow') to actual future dates. Never return a date in the past.",
    "- book intent: if a return trip is implied (a return day, 'back', 'round trip'), set trip_type to round_trip and fill return_date. If only one direction is mentioned, use one_way and return_date null.",
    "- explore intent: leave outbound_date/return_date null; instead fill explore_window_start/end from any implied timeframe ('next couple of weeks' -> today through +14 days; 'end of September' -> ~Sep 20-30), or null if none. Fill explore_question with the user's actual question. Set check_both_directions true when they ask about flights back too, or asked generally about 'flights between' the cities.",
    "- nonstop_only: true when the question is specifically about nonstop/direct flights, or the user requires nonstop. 'Nonstop if possible' on a book search is a preference, not a requirement: false.",
    "- Default: 1 adult, economy (travel_class 1).",
    "- Set airlines only when the user explicitly names carriers (Delta -> DL, United -> UA, American -> AA). Otherwise null.",
    "- clarification_needed: for book intent, ask only if origin, destination, or departure date is missing. For explore intent, ask only if origin or destination is missing — NEVER ask for dates on an explore question; open dates are the point.",
    "- This is an ongoing conversation: earlier turns may contain prior requests, your parses (as JSON), and clarifying questions. Interpret the latest message in that context — it may answer a question, refine the previous trip ('make it business class', 'what about the following week'), or follow up on an exploration ('okay, book the Sept 28 one'). Merge accordingly. If it is instead an unrelated new request, parse it fresh.",
  ].join("\n");
}

async function parseQuery(messages) {
  const text = await callClaude({
    system: parseSystemPrompt(),
    messages,
    schema: PARSE_SCHEMA,
    maxTokens: 2000,
  });
  return JSON.parse(text);
}

async function summarizeResults(parsed, flights, priceInsights, context) {
  const condensed = flights.slice(0, 8).map((f) => ({
    best: !!f._best,
    airlines: [...new Set((f.flights || []).map((l) => l.airline))],
    depart: f.flights?.[0]?.departure_airport?.time,
    arrive: f.flights?.at(-1)?.arrival_airport?.time,
    duration_min: f.total_duration,
    stops: (f.flights || []).length - 1,
    layovers: (f.layovers || []).map((l) => l.id),
    price_usd: f.price,
  }));
  const user = JSON.stringify({
    route: `${parsed.origin} -> ${parsed.destination}`,
    dates: { out: parsed.outbound_date, back: parsed.return_date },
    leg: context,
    price_insights: priceInsights || null,
    options: condensed,
  });
  return callClaude({
    system:
      "You are a concise travel assistant. Given flight search results (JSON), reply with 2-3 plain sentences: the best pick and why, one notable alternative if relevant, and price context if price_insights is present. No preamble, no markdown, no lists.",
    messages: [{ role: "user", content: user }],
    schema: null,
    maxTokens: 1000,
  });
}

// ---------- Voice (OpenAI chained pipeline: STT -> search -> TTS) ----------

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let isRecording = false;
let discardRecording = false;
let currentAudio = null;

function setRecordingUI(on) {
  isRecording = on;
  $("micBtn").classList.toggle("recording", on);
  $("micBtn").title = on ? "Stop and search" : "Speak your search";
  if (on) setStatus("Listening… click the mic again when done.");
}

function openMicPermissionTab() {
  // Chrome can't show the mic prompt inside a side panel; the grant has to
  // happen once from a full extension tab (same origin, so it carries over).
  chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
  showError(
    "Chrome needs mic access granted from a full tab first (a side-panel limitation). " +
    "I opened one — click Allow there, then come back and tap the mic again."
  );
}

async function micPermissionGranted() {
  try {
    const st = await navigator.permissions.query({ name: "microphone" });
    return st.state === "granted";
  } catch (e) {
    return true; // permissions API unavailable — let getUserMedia decide
  }
}

async function toggleRecording() {
  if (isRecording) {
    mediaRecorder?.stop();
    return;
  }
  if (!settings.openaiKey) {
    $("settingsPanel").classList.remove("hidden");
    showError("Add your OpenAI API key in Settings to use voice search.");
    return;
  }
  stopAudio();
  $("errorBox").classList.add("hidden");
  if (!(await micPermissionGranted())) {
    openMicPermissionTab();
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    openMicPermissionTab();
    return;
  }
  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    mediaStream?.getTracks().forEach((t) => t.stop());
    setRecordingUI(false);
    if (discardRecording) {
      discardRecording = false;
      return;
    }
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    try {
      setStatus("Transcribing…");
      const text = await transcribeAudio(blob);
      setStatus("");
      if (text.trim()) {
        $("queryInput").value = text.trim();
        runSearch();
      }
    } catch (err) {
      setStatus("");
      showError(err.message || String(err));
    }
  };
  mediaRecorder.start();
  setRecordingUI(true);
}

async function transcribeAudio(blob) {
  const fd = new FormData();
  fd.append("file", new File([blob], "query.webm", { type: blob.type || "audio/webm" }));
  fd.append("model", "gpt-4o-mini-transcribe");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.openaiKey}` },
    body: fd,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI transcription error: ${data?.error?.message || res.status}`);
  return data.text || "";
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

async function speak(text) {
  if (!settings.openaiKey || !settings.speakResults || !text) return;
  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.openaiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: settings.ttsVoice,
        input: text,
        response_format: "mp3",
      }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      console.warn("TTS failed:", d?.error?.message || res.status);
      return;
    }
    const blob = await res.blob();
    stopAudio();
    currentAudio = new Audio(URL.createObjectURL(blob));
    currentAudio.play().catch((e) => console.warn("Audio playback blocked:", e));
  } catch (e) {
    console.warn("TTS failed:", e);
  }
}

// ---------- Explore mode (probe searches over a flexible window) ----------

function parseISOLocal(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const toISO = (d) => d.toLocaleDateString("en-CA");
const dayLabel = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function exploreSampleDates(parsed) {
  const today = new Date();
  let start = parsed.explore_window_start ? parseISOLocal(parsed.explore_window_start) : addDays(today, 14);
  let end = parsed.explore_window_end ? parseISOLocal(parsed.explore_window_end) : addDays(start, 10);
  if (start <= today) start = addDays(today, 2);
  if (end <= start) end = addDays(start, 7);
  const span = Math.round((end - start) / 864e5);
  const d1 = addDays(start, Math.floor(span * 0.3));
  const d2 = addDays(start, Math.floor(span * 0.8));
  return { start, end, dates: toISO(d1) === toISO(d2) ? [d1] : [d1, d2] };
}

async function runExplore(parsed, airlines) {
  const { start, end, dates } = exploreSampleDates(parsed);
  const filter = airlines.length > 0 && airlines.length < 3 ? airlines.join(",") : "DL,UA,AA";
  const isNoResults = (e) => /hasn't returned any results|no results/i.test(e?.message || "");

  const bar = $("parsedBar");
  bar.innerHTML = [
    `${esc(parsed.origin)} &rarr; ${esc(parsed.destination)}`,
    `exploring ${esc(dayLabel(start))} &ndash; ${esc(dayLabel(end))}`,
    parsed.nonstop_only ? "nonstop focus" : null,
    parsed.check_both_directions ? "both directions" : null,
  ].filter(Boolean).join(" &middot; ");
  bar.classList.remove("hidden");

  // Build the probe list: sampled outbound days, plus one return-direction day.
  const probes = dates.map((d) => ({
    dir: "out", from: parsed.origin, to: parsed.destination, date: d,
  }));
  if (parsed.check_both_directions) {
    probes.push({ dir: "ret", from: parsed.destination, to: parsed.origin, date: dates.at(-1) });
  }

  const probeParams = (p, withFilter) => {
    const params = {
      engine: "google_flights",
      departure_id: p.from,
      arrival_id: p.to,
      outbound_date: toISO(p.date),
      currency: "USD", hl: "en", gl: "us",
      adults: 1,
      travel_class: parsed.travel_class || 1,
      type: 2, // one-way samples — schedule/frequency is what we're after
      stops: parsed.nonstop_only ? 1 : 0,
    };
    if (withFilter) params.include_airlines = withFilter;
    return params;
  };

  for (const p of probes) {
    const label = `${p.from} → ${p.to} on ${dayLabel(p.date)}`;
    setStatus(`Checking ${label}…`);
    try {
      p.data = await serpApiSearch(probeParams(p, filter));
      p.flights = combinedFlights(p.data);
    } catch (e) {
      if (!isNoResults(e)) throw e;
      p.data = null;
      p.flights = [];
    }
  }

  // If the carrier filter found nothing anywhere, sample once across all airlines
  // so the assessment can say who actually flies the route.
  let allAirlinesProbe = null;
  if (probes.every((p) => !p.flights.length)) {
    setStatus("No matches on selected carriers — checking all airlines…");
    try {
      const data = await serpApiSearch(probeParams(probes[0], null));
      allAirlinesProbe = { ...probes[0], data, flights: combinedFlights(data) };
    } catch (e) {
      if (!isNoResults(e)) throw e;
    }
  }

  state.mode = "explore";
  renderExplore(probes, allAirlinesProbe);
  showGfLink(probes.find((p) => p.data)?.data || allAirlinesProbe?.data);

  setStatus("Putting together an assessment…");
  try {
    const assessment = await summarizeExplore(parsed, probes, allAirlinesProbe, start, end);
    showSummary(assessment);
    speak(assessment);
  } catch (e) {
    console.warn("Assessment failed:", e);
  }
  setStatus("");
}

function condenseProbe(p) {
  return {
    direction: p.dir === "ret" ? "return" : "outbound",
    route: `${p.from} -> ${p.to}`,
    date: toISO(p.date),
    flights: (p.flights || []).slice(0, 6).map((f) => ({
      airlines: [...new Set((f.flights || []).map((l) => l.airline))],
      depart: f.flights?.[0]?.departure_airport?.time,
      arrive: f.flights?.at(-1)?.arrival_airport?.time,
      duration_min: f.total_duration,
      stops: (f.flights || []).length - 1,
      price_usd_one_way: f.price,
    })),
  };
}

async function summarizeExplore(parsed, probes, allAirlinesProbe, start, end) {
  const payload = {
    question: parsed.explore_question || "What does service look like on this route?",
    route: `${parsed.origin} <-> ${parsed.destination}`,
    window: { start: toISO(start), end: toISO(end) },
    carrier_filter: "results were filtered to Delta/United/American unless noted",
    sampled_days: probes.map(condenseProbe),
    all_airlines_sample: allAirlinesProbe ? condenseProbe(allAirlinesProbe) : null,
  };
  return callClaude({
    system: [
      "You are a concise travel assistant answering a general route question from live Google Flights samples (prices are one-way).",
      "Reply in 2-4 short, conversational sentences, leading with the direct answer to their question.",
      "Describe patterns, not schedules: 'flights leave in the evening', 'returns leave at several times through the day' — never list individual flight times or enumerate flights.",
      "Use at most two numbers: a round-trip price ballpark (roughly double the one-way samples when both directions were sampled) and, only if helpful, the flight duration. Skip airline-alliance or joint-venture trivia.",
      "Close with a brief clause (not a full sentence of methodology) noting fares vary with exact dates. If no nonstops were found on their carriers, say so plainly and note what the all-airlines sample shows.",
      "No preamble, no markdown, no lists.",
      "Example of the desired style: \"You've got good nonstop options between Philadelphia and London, with multiple flights each day on American and British Airways. Flights to London leave in the evening and arrive the next morning, while return flights leave London at several times throughout the day. Based on the dates checked, expect around $2,100–$2,200 round trip, though fares may vary depending on your exact travel dates.\"",
    ].join(" "),
    messages: [{ role: "user", content: JSON.stringify(payload) }],
    schema: null,
    maxTokens: 1000,
  });
}

function renderExplore(probes, allAirlinesProbe) {
  const panel = $("resultsPanel");
  panel.classList.remove("hidden");
  $("backBtn").classList.add("hidden");
  $("sortSelect").classList.add("hidden");
  const list = $("resultsList");
  list.innerHTML = "";

  // The assessment is the answer — sampled days stay tucked behind a toggle.
  const title = $("resultsTitle");
  list.classList.add("hidden");
  title.classList.add("results-title-toggle");
  const setTitle = () => {
    const open = !list.classList.contains("hidden");
    title.textContent = `${open ? "▾" : "▸"} Days checked (${probes.length}${allAirlinesProbe ? "+1" : ""})`;
  };
  title.onclick = () => {
    list.classList.toggle("hidden");
    setTitle();
  };
  setTitle();

  const addGroup = (p, note) => {
    const h = document.createElement("div");
    h.className = "probe-heading";
    h.textContent = `${p.from} → ${p.to} · ${dayLabel(p.date)}${note ? ` · ${note}` : ""}`;
    list.appendChild(h);
    if (!p.flights.length) {
      const none = document.createElement("div");
      none.className = "probe-empty";
      none.textContent = "No matching flights this day.";
      list.appendChild(none);
      return;
    }
    for (const f of p.flights.slice(0, 3)) {
      const card = buildFlightCard(f, {
        onSelect: (ff, c) => selectExploreSample(ff, c, p),
        priceLabel: "one way",
      });
      card.dataset.dir = p.dir === "ret" ? "ret" : "out";
      list.appendChild(card);
    }
  };

  for (const p of probes) addGroup(p, p.dir === "ret" ? "return direction" : null);
  if (allAirlinesProbe) addGroup(allAirlinesProbe, "all airlines");
}

// ---------- SerpApi ----------

async function serpApiSearch(params) {
  const url = new URL("https://serpapi.com/search.json");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  url.searchParams.set("api_key", settings.serpapiKey);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`SerpApi: ${data.error}`);
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
  return data;
}

function buildSearchParams(parsed, airlines) {
  const p = {
    engine: "google_flights",
    departure_id: parsed.origin,
    arrival_id: parsed.destination,
    outbound_date: parsed.outbound_date,
    currency: "USD",
    hl: "en",
    gl: "us",
    adults: parsed.adults || 1,
    travel_class: parsed.travel_class || 1,
    type: parsed.trip_type === "one_way" ? 2 : 1,
    stops: parsed.nonstop_only ? 1 : 0,
    deep_search: "true",
  };
  if (parsed.trip_type !== "one_way") p.return_date = parsed.return_date;
  if (airlines.length > 0 && airlines.length < 3) p.include_airlines = airlines.join(",");
  else p.include_airlines = "DL,UA,AA";
  return p;
}

// ---------- Rendering ----------

function fmtTime(serpTime) {
  // SerpApi time format: "2026-08-14 08:15"
  if (!serpTime) return "—";
  const d = new Date(serpTime.replace(" ", "T"));
  if (isNaN(d)) return serpTime;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtDuration(min) {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function stopsText(f) {
  const n = (f.flights || []).length - 1;
  if (n <= 0) return "Nonstop";
  const lay = (f.layovers || [])
    .map((l) => `${l.id} ${fmtDuration(l.duration)}`)
    .join(", ");
  return `${n} stop${n > 1 ? "s" : ""}${lay ? ` (${lay})` : ""}`;
}

function openBooking() {
  if (typeof chrome !== "undefined" && chrome.tabs?.create) {
    chrome.tabs.create({ url: bookingUrl() });
  } else {
    window.open(bookingUrl(), "_blank");
  }
}

function buildFlightCard(f, { onSelect, priceLabel }) {
  const legs = f.flights || [];
  const first = legs[0];
  const last = legs.at(-1);
  const airlines = [...new Set(legs.map((l) => l.airline))].join(" + ");
  const card = document.createElement("div");
  card.className = "flight-card";
  card.innerHTML = `
    ${f._best ? '<span class="best-badge">Best</span>' : ""}
    <div class="fc-top">
      <img class="fc-logo" src="${esc(f.airline_logo || first?.airline_logo || "")}" alt="" />
      <div class="fc-times">
        <div class="fc-time-line">${esc(fmtTime(first?.departure_airport?.time))} &ndash; ${esc(fmtTime(last?.arrival_airport?.time))}</div>
        <div class="fc-route">${esc(first?.departure_airport?.id || "")} &rarr; ${esc(last?.arrival_airport?.id || "")}</div>
      </div>
      <div class="fc-price">${f.price != null ? "$" + Number(f.price).toLocaleString() : "—"}<div style="font-size:9px;color:#9aa3a9;font-weight:normal">${esc(priceLabel)}</div></div>
    </div>
    <div class="fc-bottom">
      <span class="fc-stops ${legs.length === 1 ? "nonstop" : ""}">${esc(stopsText(f))}</span>
      <span>${esc(fmtDuration(f.total_duration))}</span>
      <span class="fc-airline">${esc(airlines)}</span>
      ${onSelect ? "" : '<span class="fc-book" title="Book on Google Flights">Book &#9889;</span>'}
    </div>`;
  // Book mode: clicks select (drill into returns, or pin the trip selection).
  // Explore mode passes no onSelect — sample cards link straight to Google Flights.
  card.addEventListener("click", () => (onSelect ? onSelect(f, card) : openBooking()));
  return card;
}

function renderFlights(flights, opts) {
  const list = $("resultsList");
  list.innerHTML = "";
  for (const f of flights) list.appendChild(buildFlightCard(f, opts));
}

function sortFlights(flights, mode) {
  const arr = [...flights];
  if (mode === "price") arr.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
  else if (mode === "duration") arr.sort((a, b) => (a.total_duration ?? 1e9) - (b.total_duration ?? 1e9));
  return arr; // "best": SerpApi order, best_flights first
}

function showParsedBar(parsed) {
  const bits = [
    `${parsed.origin} &rarr; ${parsed.destination}`,
    parsed.trip_type === "one_way"
      ? `${parsed.outbound_date} (one-way)`
      : `${parsed.outbound_date} &ndash; ${parsed.return_date}`,
    `${parsed.adults} adult${parsed.adults > 1 ? "s" : ""}`,
    ["Economy", "Premium economy", "Business", "First"][(parsed.travel_class || 1) - 1],
  ];
  if (parsed.nonstop_only) bits.push("Nonstop only");
  const bar = $("parsedBar");
  bar.innerHTML = bits.join(" &middot; ");
  bar.classList.remove("hidden");
}

function showInsights(pi) {
  if (!pi) return;
  const bar = $("insightsBar");
  const bits = [];
  if (pi.lowest_price != null) bits.push(`Lowest price seen: $${pi.lowest_price}`);
  if (pi.price_level) bits.push(`prices are currently ${pi.price_level}`);
  if (Array.isArray(pi.typical_price_range)) bits.push(`typical range $${pi.typical_price_range[0]}–$${pi.typical_price_range[1]}`);
  if (!bits.length) return;
  bar.textContent = bits.join(" · ");
  bar.classList.remove("hidden");
}

function showNotice(text) {
  const bar = $("noticeBar");
  bar.textContent = text;
  bar.classList.remove("hidden");
}

function showSummary(text) {
  const box = $("summaryBox");
  box.innerHTML = `<span class="summary-label">Quick take</span>${esc(text)}`;
  box.classList.remove("hidden");
}

function showGfLink(data) {
  const url = data?.search_metadata?.google_flights_url;
  if (url) state.gfUrl = url;
  const a = $("gfLink");
  a.href = state.gfUrl || bookingUrl();
  a.classList.remove("hidden");
}

// ---------- App state & flow ----------

const state = {
  parsed: null,
  parseHistory: null, // ongoing conversation context: [{role, content}, ...]
  mode: "book", // or "explore"
  searchParams: null,
  outboundData: null,
  outboundFlights: [],
  returnData: null,
  returnFlights: [],
  view: "outbound", // or "return"
  selectedOutbound: null,
  selectedReturn: null,
  exploreSel: { out: null, ret: null },
  gfUrl: null,
};

const DEFAULT_PLACEHOLDER = "e.g. SLC to Austin next Friday, back Sunday evening, nonstop";

function resetConversation() {
  if (isRecording) {
    discardRecording = true;
    mediaRecorder?.stop();
  }
  stopAudio();
  state.parsed = null;
  state.parseHistory = null;
  state.mode = "book";
  state.searchParams = null;
  state.outboundData = null;
  state.outboundFlights = [];
  state.returnData = null;
  state.returnFlights = [];
  state.view = "outbound";
  state.selectedOutbound = null;
  state.selectedReturn = null;
  state.exploreSel = { out: null, ret: null };
  state.gfUrl = null;
  clearOutput();
  setStatus("");
  const input = $("queryInput");
  input.value = "";
  input.placeholder = DEFAULT_PLACEHOLDER;
  input.focus();
}

function showQuestion(question) {
  const bar = $("askBar");
  bar.textContent = question;
  bar.classList.remove("hidden");
  const input = $("queryInput");
  input.value = "";
  input.placeholder = "Your answer — type it or tap the mic";
  input.focus();
}

function activeAirlines() {
  return [...document.querySelectorAll("#airlineChips .chip.active")].map((c) => c.dataset.code);
}

function combinedFlights(data) {
  return [
    ...(data.best_flights || []).map((f) => ({ ...f, _best: true })),
    ...(data.other_flights || []),
  ];
}

async function runSearch() {
  const query = $("queryInput").value.trim();
  if (!query) return;

  if (!settings.anthropicKey || !settings.serpapiKey) {
    $("settingsPanel").classList.remove("hidden");
    showError("Enter your Anthropic and SerpApi keys in Settings first.");
    return;
  }

  stopAudio();
  clearOutput();
  state.selectedOutbound = null;
  state.selectedReturn = null;
  state.exploreSel = { out: null, ret: null };
  state.gfUrl = null;
  $("searchBtn").disabled = true;

  try {
    setStatus("Understanding your request…");
    // If we previously asked a clarifying question, continue that conversation
    // so the answer merges with the original request.
    const messages = state.parseHistory
      ? [...state.parseHistory, { role: "user", content: query }]
      : [{ role: "user", content: query }];
    const parsed = await parseQuery(messages);

    // The conversation persists across turns (capped) so follow-ups can refine
    // or build on earlier searches. The ↺ button clears it.
    state.parseHistory = [
      ...messages,
      { role: "assistant", content: JSON.stringify(parsed) },
    ].slice(-16);

    if (parsed.clarification_needed) {
      setStatus("");
      showQuestion(parsed.clarification_needed);
      speak(parsed.clarification_needed);
      return;
    }
    $("queryInput").placeholder = DEFAULT_PLACEHOLDER;

    // If the query named airlines, sync the chips to match.
    if (parsed.airlines && parsed.airlines.length) {
      document.querySelectorAll("#airlineChips .chip").forEach((c) => {
        c.classList.toggle("active", parsed.airlines.includes(c.dataset.code));
      });
    }
    const airlines = activeAirlines();
    if (!airlines.length) {
      setStatus("");
      showError("Select at least one airline (DL / UA / AA).");
      return;
    }

    state.parsed = parsed;

    if (parsed.intent === "explore") {
      await runExplore(parsed, airlines);
      return;
    }

    state.mode = "book";
    state.searchParams = buildSearchParams(parsed, airlines);
    showParsedBar(parsed);

    setStatus("Searching flights…");
    const isNoResults = (e) => /hasn't returned any results|no results/i.test(e?.message || "");
    let data = null;
    let usedAllAirlines = false;
    try {
      data = await serpApiSearch(state.searchParams);
    } catch (e) {
      if (!isNoResults(e)) throw e;
    }
    if (!data || !combinedFlights(data).length) {
      // Nothing on DL/UA/AA — retry once without the carrier filter.
      const p2 = { ...state.searchParams };
      delete p2.include_airlines;
      setStatus("No DL/UA/AA itineraries — checking all airlines…");
      try {
        data = await serpApiSearch(p2);
        usedAllAirlines = true;
        state.searchParams = p2;
      } catch (e2) {
        if (!isNoResults(e2)) throw e2;
        data = null;
      }
    }
    if (!data || !combinedFlights(data).length) {
      setStatus("");
      showError("Google Flights returned no results for this search. Try different dates, nearby airports, or a simpler route.");
      return;
    }

    state.outboundData = data;
    state.outboundFlights = combinedFlights(data);
    state.view = "outbound";

    if (usedAllAirlines) {
      showNotice("No Delta/United/American itineraries matched this search — showing all airlines instead.");
    }

    showInsights(data.price_insights);
    showResultsView();
    setStatus("Asking Claude for a recommendation…");

    const isRT = parsed.trip_type !== "one_way";
    try {
      const summary = await summarizeResults(
        parsed,
        state.outboundFlights,
        data.price_insights,
        isRT ? "outbound leg of a round trip (prices shown are round-trip totals)" : "one-way"
      );
      showSummary(summary);
      speak(summary);
    } catch (e) {
      console.warn("Summary failed:", e);
    }
    setStatus("");
  } catch (err) {
    setStatus("");
    showError(err.message || String(err));
  } finally {
    $("searchBtn").disabled = false;
  }
}

function tripLineText(f) {
  const legs = f.flights || [];
  const airlines = [...new Set(legs.map((l) => l.airline))].join(" + ");
  return `${fmtTime(legs[0]?.departure_airport?.time)} ${legs[0]?.departure_airport?.id || ""} → ${legs.at(-1)?.arrival_airport?.id || ""} · ${stopsText(f)} · ${airlines}`;
}

function selectExploreSample(f, card, probe) {
  const slot = probe.dir === "ret" ? "ret" : "out";
  state.exploreSel[slot] = { flight: f, probe };
  document
    .querySelectorAll(`.flight-card[data-dir="${slot}"].selected`)
    .forEach((c) => c.classList.remove("selected"));
  card.classList.add("selected");
  renderTripSummary();
}

function renderTripSummary() {
  const box = $("tripSummary");

  if (state.mode === "explore") {
    const { out, ret } = state.exploreSel;
    if (!out && !ret) {
      box.classList.add("hidden");
      return;
    }
    const lines = [];
    if (out) lines.push(["Outbound", out]);
    if (ret) lines.push(["Return", ret]);
    const total = (out?.flight.price || 0) + (ret?.flight.price || 0);
    $("tripLines").innerHTML =
      lines
        .map(
          ([label, sel]) =>
            `<div class="trip-line"><b>${label}:</b> ${esc(dayLabel(sel.probe.date))} · ${esc(tripLineText(sel.flight))}</div>`
        )
        .join("") +
      (total
        ? `<div class="trip-total">Total: $${Number(total).toLocaleString()}${out && ret ? " (one-way fares combined)" : " one way"}</div>`
        : "");
    $("bookTripBtn").classList.remove("hidden");
    box.classList.remove("hidden");
    return;
  }

  if (state.mode !== "book" || !state.selectedOutbound) {
    box.classList.add("hidden");
    return;
  }
  const isRT = state.parsed?.trip_type !== "one_way";
  const lines = [];
  if (isRT) {
    lines.push(["Outbound", state.selectedOutbound]);
    if (state.selectedReturn) lines.push(["Return", state.selectedReturn]);
  } else {
    lines.push(["Flight", state.selectedOutbound]);
  }
  const finalPick = isRT ? state.selectedReturn : state.selectedOutbound;
  const total = finalPick?.price;
  $("tripLines").innerHTML =
    lines.map(([label, f]) => `<div class="trip-line"><b>${label}:</b> ${esc(tripLineText(f))}</div>`).join("") +
    (finalPick && total != null
      ? `<div class="trip-total">Total: $${Number(total).toLocaleString()}${isRT ? " round trip" : ""}</div>`
      : "");
  $("bookTripBtn").classList.toggle("hidden", !finalPick);
  box.classList.remove("hidden");
}

function highlightSelected(flights, selected) {
  if (!selected) return;
  const cards = [...$("resultsList").children];
  const idx = flights.indexOf(selected);
  if (idx >= 0 && cards[idx]) cards[idx].classList.add("selected");
}

function selectTrip(f, card) {
  if (state.view === "return") state.selectedReturn = f;
  else state.selectedOutbound = f; // one-way
  document.querySelectorAll(".flight-card.selected").forEach((c) => c.classList.remove("selected"));
  card.classList.add("selected");
  renderTripSummary();
}

function showResultsView() {
  const panel = $("resultsPanel");
  panel.classList.remove("hidden");
  $("sortSelect").classList.remove("hidden");
  // Undo explore-mode's collapsed sample toggle.
  const title = $("resultsTitle");
  title.classList.remove("results-title-toggle");
  title.onclick = null;
  $("resultsList").classList.remove("hidden");
  const isRT = state.parsed.trip_type !== "one_way";

  if (state.view === "outbound") {
    $("resultsTitle").textContent = isRT ? "Outbound — pick a flight" : "Flights — pick one";
    $("backBtn").classList.add("hidden");
    const flights = sortFlights(state.outboundFlights, $("sortSelect").value);
    renderFlights(flights, {
      priceLabel: isRT ? "round trip" : "one way",
      onSelect: isRT ? (f) => loadReturnFlights(f) : selectTrip,
    });
    if (!isRT) highlightSelected(flights, state.selectedOutbound);
    showGfLink(state.outboundData);
  } else {
    $("resultsTitle").textContent = "Return — pick a flight";
    $("backBtn").classList.remove("hidden");
    const flights = sortFlights(state.returnFlights, $("sortSelect").value);
    renderFlights(flights, { priceLabel: "total", onSelect: selectTrip });
    highlightSelected(flights, state.selectedReturn);
    showGfLink(state.returnData || state.outboundData);
  }
  renderTripSummary();
}

async function loadReturnFlights(outboundFlight) {
  if (!outboundFlight.departure_token) return;
  $("errorBox").classList.add("hidden");
  setStatus("Loading return flights…");
  try {
    const data = await serpApiSearch({
      ...state.searchParams,
      departure_token: outboundFlight.departure_token,
    });
    state.returnData = data;
    state.returnFlights = combinedFlights(data);
    state.selectedOutbound = outboundFlight;
    state.selectedReturn = null;
    state.view = "return";
    showResultsView();
    setStatus("");
  } catch (err) {
    setStatus("");
    showError(err.message || String(err));
  }
}

// ---------- Events ----------

function init() {
  loadSettings().then(() => {
    if (!settings.anthropicKey || !settings.serpapiKey) {
      $("settingsPanel").classList.remove("hidden");
    }
  });

  $("settingsBtn").addEventListener("click", () => $("settingsPanel").classList.toggle("hidden"));
  $("saveSettings").addEventListener("click", saveSettings);
  $("searchBtn").addEventListener("click", runSearch);
  $("micBtn").addEventListener("click", toggleRecording);
  $("resetBtn").addEventListener("click", resetConversation);
  $("bookTripBtn").addEventListener("click", openBooking);
  $("queryInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runSearch();
    }
  });
  document.querySelectorAll("#airlineChips .chip").forEach((c) =>
    c.addEventListener("click", () => c.classList.toggle("active"))
  );
  $("sortSelect").addEventListener("change", () => {
    if (state.parsed && state.mode === "book") showResultsView();
  });
  $("backBtn").addEventListener("click", () => {
    state.view = "outbound";
    showResultsView();
  });
}

init();
