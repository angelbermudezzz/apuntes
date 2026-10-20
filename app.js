"use strict";
const APP_VERSION = "2026-10-20";

// ---------- Almacenamiento (IndexedDB, con memoria como respaldo) ----------
const mem = { subjects: [], notes: [] };
let db = null;
function openDB() {
  return new Promise((res) => {
    setTimeout(res, 4000); // Safari a veces no responde nunca: mejor arrancar que quedarse en blanco
    try {
      const r = indexedDB.open("apuntes-erika", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("subjects")) d.createObjectStore("subjects", { keyPath: "id" });
        if (!d.objectStoreNames.contains("notes")) d.createObjectStore("notes", { keyPath: "id" });
      };
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => res();
    } catch (e) { res(); }
  });
}
function all(store) {
  if (!db) return Promise.resolve(mem[store].slice());
  return new Promise((res) => {
    try { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }
    catch (e) { res([]); }
  });
}
function put(store, obj) {
  if (!db) { mem[store] = mem[store].filter(x => x.id !== obj.id).concat(obj); return Promise.resolve(); }
  return new Promise((res, rej) => {
    try { const t = db.transaction(store, "readwrite"); t.objectStore(store).put(obj); t.oncomplete = res; t.onerror = () => rej(t.error); }
    catch (e) { rej(e); }
  });
}
function del(store, id) {
  if (!db) { mem[store] = mem[store].filter(x => x.id !== id); return Promise.resolve(); }
  return new Promise((res) => {
    try { const t = db.transaction(store, "readwrite"); t.objectStore(store).delete(id); t.oncomplete = res; t.onerror = res; }
    catch (e) { res(); }
  });
}
const saveNote = (n) => { if (!notes.includes(n)) return Promise.resolve(); n.updated = Date.now(); return put("notes", n).catch(() => toast("No se pudo guardar. Puede que el móvil no tenga espacio.")); };
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return ls.m[k] || null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { ls.m[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { delete ls.m[k]; } },
  m: {}
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Las librerías pesadas (PDF y Word) se cargan solo cuando hacen falta.
const scriptCache = {};
function loadScript(src) {
  return scriptCache[src] ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => { delete scriptCache[src]; rej(new Error("No se pudo cargar " + src)); };
    document.head.appendChild(s);
  });
}
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
async function getPdfjs() {
  await loadScript(PDFJS + "pdf.min.js");
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
  return pdfjsLib;
}
async function getMammoth() {
  await loadScript("https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js");
  return window.mammoth;
}

// ---------- Gemini ----------
const API = "https://generativelanguage.googleapis.com/v1beta";
const FALLBACK_MODEL = "gemini-2.5-flash";
class AIError extends Error { constructor(msg, status) { super(msg); this.status = status || 0; } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function gfetch(path, opts = {}) { return (await gresponse(path, opts)).json(); }
async function gresponse(path, opts = {}) {
  const key = ls.get("gemini-key");
  if (!key) throw new AIError("Falta conectar con Gemini. Ve a «Ajustes» y pega la clave.");
  let r;
  try {
    r = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", "x-goog-api-key": key, ...(opts.headers || {}) } });
  } catch (e) {
    throw new AIError(navigator.onLine === false ? "No tienes conexión a internet. Puedes seguir viendo tus apuntes y lo que ya has generado; para crear cosas nuevas hace falta internet." : "No se pudo conectar con Gemini. Revisa la conexión y vuelve a probar.");
  }
  if (!r.ok) {
    let msg = ""; try { msg = (await r.json()).error?.message || ""; } catch (e) {}
    if (r.status === 429) throw new AIError("Se ha gastado el uso gratuito de Gemini por ahora. Espera un minuto y vuelve a probar; si sigue igual, se renueva mañana.", 429);
    if (r.status >= 500) throw new AIError("Gemini está saturado ahora mismo (no es un fallo de la app). Espera un par de minutos y vuelve a pulsar el botón.", r.status);
    if (r.status === 404) throw new AIError("Ese modelo de Gemini ya no está disponible. Vuelve a pulsar el botón.", 404);
    if (r.status === 400 && /API key/i.test(msg)) throw new AIError("La clave de Gemini no es válida. Vuelve a copiarla desde aistudio.google.com/apikey.", 400);
    if (r.status === 403) throw new AIError("Gemini ha rechazado la clave. Comprueba que está bien copiada o crea una nueva.", 403);
    if (r.status === 413 || /too large|exceeds/i.test(msg)) throw new AIError("El apunte es demasiado grande para Gemini. Prueba a dividirlo en partes más pequeñas.", r.status);
    throw new AIError("Gemini ha devuelto un error (" + r.status + "). " + msg, r.status);
  }
  return r;
}

// Modelos Flash de la cuenta gratuita, del mejor al de reserva.
// Si uno está saturado o sin cupo, se prueba el siguiente.
async function pickModels() {
  try {
    const c = JSON.parse(ls.get("gemini-models") || "null");
    if (c && Array.isArray(c.list) && c.list.length && Date.now() - c.at < 7 * 864e5) return c.list;
  } catch (e) {}
  let models = [FALLBACK_MODEL];
  try {
    const d = await gfetch("/models?pageSize=200");
    const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
    const names = (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace("models/", ""))
      .filter(n => /^gemini-[\d.]+-flash/.test(n) && !/image|tts|live|audio|thinking|exp|preview/.test(n) && !/-\d{3}$/.test(n));
    const byVer = (a, b) => ver(b) - ver(a) || a.length - b.length;
    const full = names.filter(n => !/lite/.test(n)).sort(byVer);
    const lite = names.filter(n => /lite/.test(n)).sort(byVer);
    const pool = [...full.slice(0, 3), ...lite.slice(0, 1)];
    if (pool.length) models = pool;
  } catch (e) { if (e instanceof AIError && e.status < 500) throw e; }
  ls.set("gemini-models", JSON.stringify({ list: models, at: Date.now() }));
  return models;
}

function toB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}
// Lo que se manda a Gemini, lo más ligero posible: texto siempre que se pueda
// (Word, texto y PDF con texto) y las fotos reducidas. Se guarda para no repetirlo.
async function noteParts(n) {
  if (n.kind !== "img" && n.kind !== "pdf") return [{ text: "APUNTES:\n\n" + await noteText(n) }];
  if (n.kind === "pdf") {
    if (n.pdfText === undefined) {
      const t = await pdfToText(n).catch(() => undefined); // si falla la librería se vuelve a intentar otro día
      if (t !== undefined) { n.pdfText = t; saveNote(n); }
    }
    if (n.pdfText) return [{ text: "APUNTES (texto sacado de un PDF):\n\n" + n.pdfText }];
  }
  let blob = n.blob, mime = n.kind === "pdf" ? "application/pdf" : (n.blob.type || "image/jpeg");
  if (n.kind === "img") { const small = await shrinkImage(n.blob).catch(() => null); if (small) { blob = small; mime = "image/jpeg"; } }
  if (blob.size > 14 * 1048576) throw new AIError("Este archivo pesa más de 14 MB y Gemini no lo acepta así. Divídelo en partes más pequeñas.");
  return [{ inline_data: { mime_type: mime, data: await toB64(blob) } }];
}
// Devuelve el texto del PDF, o null si es un escaneo (entonces se manda el PDF entero).
async function pdfToText(n) {
  const lib = await getPdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await n.blob.arrayBuffer()) }).promise;
  const pages = Math.min(pdf.numPages, 150), out = [];
  for (let i = 1; i <= pages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    out.push(tc.items.map(it => it.str + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " ").trim());
  }
  const text = out.join("\n\n");
  return text.replace(/\s/g, "").length >= pages * 120 ? text : null;
}
async function shrinkImage(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  if (scale === 1 && blob.size < 1.5 * 1048576) return null;
  const cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  return new Promise(res => cv.toBlob(b => res(b), "image/jpeg", 0.85));
}
async function noteText(n) {
  if (n.kind === "txt" && n.docText !== undefined) return n.docText;
  if (n.kind === "docx") {
    if (n.docText === undefined) { n.docText = (await (await getMammoth()).extractRawText({ arrayBuffer: await n.blob.arrayBuffer() })).value; saveNote(n); }
    return n.docText;
  }
  return n.blob.text();
}
// Sin "pensar" largo: para resumir y hacer tests no hace falta y responde mucho antes.
function thinkingFor(model) {
  if (ls.get("nothink-" + model)) return null;
  return /gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "low" };
}
// opts: { prompt, schema, onText (texto por partes), history (conversación previa), system }
async function generate(n, opts) {
  const { prompt, schema, onText, history, system } = opts;
  const models = await pickModels();
  const noteP = await noteParts(n);
  const contents = history
    ? [{ role: "user", parts: [...noteP, { text: "Estos son mis apuntes. Voy a hacerte preguntas sobre ellos." }] },
       { role: "model", parts: [{ text: "Perfecto, pregúntame lo que quieras." }] },
       ...history.map(m => ({ role: m.role, parts: [{ text: m.text }] })),
       { role: "user", parts: [{ text: prompt }] }]
    : [{ role: "user", parts: [...noteP, { text: prompt }] }];
  const bodyFor = (model) => {
    const cfg = schema ? { responseMimeType: "application/json", responseSchema: schema, temperature: 0.7 } : { temperature: 0.4 };
    const th = thinkingFor(model); if (th) cfg.thinkingConfig = th;
    const body = { contents, generationConfig: cfg };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return JSON.stringify(body);
  };
  let text = null, lastErr, blocked = false;
  outer: for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (onText) {
          const r = await gresponse(`/models/${model}:streamGenerateContent?alt=sse`, { method: "POST", body: bodyFor(model) });
          const reader = r.body.getReader(), dec = new TextDecoder();
          let buf = "", acc = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
              if (!line.startsWith("data:")) continue;
              let d; try { d = JSON.parse(line.slice(5)); } catch (e) { continue; }
              if (d.promptFeedback?.blockReason) blocked = true;
              const piece = (d.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
              if (piece) { acc += piece; onText(acc); }
            }
          }
          text = acc.trim();
        } else {
          const d = await gfetch(`/models/${model}:generateContent`, { method: "POST", body: bodyFor(model) });
          if (d.promptFeedback?.blockReason) blocked = true;
          text = (d.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
        }
        break outer;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof AIError)) throw e;
        if (e.status === 400 && /thinking/i.test(e.message) && !ls.get("nothink-" + model)) { ls.set("nothink-" + model, "1"); continue; }
        if (e.status === 404) { ls.del("gemini-models"); break; }
        if (e.status === 429) break; // cada modelo tiene su propio cupo: se prueba el siguiente
        if (e.status >= 500) {
          if (busy && !busy.retry) { busy.retry = true; refreshIfOpen(n.id); }
          if (attempt >= 1) break; // tras dos intentos, se prueba otro modelo
          await sleep(2500); continue;
        }
        throw e;
      }
    }
  }
  if (text === null) throw lastErr || new AIError("No se pudo conectar con Gemini.");
  if (!text) throw new AIError(blocked ? "Gemini no ha querido procesar este apunte." : "Gemini no ha devuelto nada. Vuelve a intentarlo.");
  return text;
}
function parseJSON(raw, what) {
  try { return JSON.parse(raw); }
  catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
    throw new AIError(`Gemini devolvió ${what} con un formato raro. Vuelve a intentarlo.`);
  }
}

// ---------- Instrucciones para Gemini ----------
const TEACHER = "Eres un profesor cercano que ayuda a Erika, una estudiante, a estudiar sus apuntes. Escribe en el mismo idioma que los apuntes (normalmente español de España). Usa solo información de los apuntes salvo que se pida otra cosa.";
const SUMMARY_PROMPTS = {
  corto: "Haz un RESUMEN CORTO de estos apuntes. Máximo 150 palabras. Empieza con una frase que diga de qué trata el tema y luego 4 a 7 viñetas con las ideas clave. Pon en **negrita** los términos más importantes. Usa Markdown. No inventes nada. Si es una foto difícil de leer, resume lo que se entienda y avisa de lo que no.",
  detallado: "Haz un RESUMEN DETALLADO para estudiar estos apuntes. Organízalo con títulos (##) por apartados, viñetas con las ideas, definiciones y datos clave, y pon en **negrita** los términos importantes. Termina con un apartado «## Lo que no puedes olvidar» con 3 a 5 puntos. Usa Markdown. No inventes nada. Si es una foto difícil de leer, resume lo que se entienda y avisa de lo que no."
};
const QUIZ_SCHEMA = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { question: { type: "STRING" }, options: { type: "ARRAY", items: { type: "STRING" } }, answer: { type: "INTEGER" }, explanation: { type: "STRING" } },
        required: ["question", "options", "answer", "explanation"]
      }
    }
  },
  required: ["questions"]
};
const quizPrompt = (count) => `Crea un test de ${count} preguntas de opción múltiple sobre estos apuntes para preparar un examen. Cada pregunta tiene exactamente 4 opciones y solo una correcta; "answer" es la posición de la correcta empezando en 0. Reparte la posición de la respuesta correcta entre 0, 1, 2 y 3. Mezcla preguntas de memoria con preguntas de comprensión. Las opciones incorrectas deben ser creíbles. "explanation" explica en 1 o 2 frases por qué la correcta es la correcta, basándote en los apuntes.`;
const CARDS_SCHEMA = {
  type: "OBJECT",
  properties: { cards: { type: "ARRAY", items: { type: "OBJECT", properties: { front: { type: "STRING" }, back: { type: "STRING" } }, required: ["front", "back"] } } },
  required: ["cards"]
};
const cardsPrompt = (count, existing) => `Crea ${count} TARJETAS DE MEMORIA (flashcards) con lo más importante de estos apuntes, para repasar con repetición espaciada. "front" es una pregunta corta y concreta (un concepto, definición, dato, fecha, diferencia o causa) y "back" es la respuesta en una o dos frases cortas. Cada tarjeta pregunta UNA sola cosa. Cubre todo el tema, no solo el principio.${existing.length ? ` No repitas estas tarjetas que ya existen: ${existing.slice(0, 60).map(c => "«" + c.front + "»").join("; ")}.` : ""}`;
const MAP_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    branches: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          children: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, details: { type: "ARRAY", items: { type: "STRING" } } }, required: ["title"] } }
        },
        required: ["title", "children"]
      }
    }
  },
  required: ["title", "branches"]
};
const MAP_PROMPT = "Convierte estos apuntes en un MAPA MENTAL jerárquico. \"title\" es el tema central en pocas palabras. Crea de 3 a 6 \"branches\" con las ideas principales; cada una con 2 a 5 \"children\" (subideas) y, si ayuda, 1 a 3 \"details\" muy cortos (definiciones, ejemplos, datos). Cada texto debe tener como mucho 8 palabras: son etiquetas, no frases largas.";
const VIDEO_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    scenes: { type: "ARRAY", items: { type: "OBJECT", properties: { heading: { type: "STRING" }, points: { type: "ARRAY", items: { type: "STRING" } }, narration: { type: "STRING" } }, required: ["heading", "points", "narration"] } }
  },
  required: ["title", "scenes"]
};
const VIDEO_PROMPT = "Escribe el guion de una VIDEO-LECCIÓN corta para repasar estos apuntes, en 5 a 8 escenas. La primera presenta el tema y la última repasa las 3 ideas clave. En cada escena: \"heading\" es un título de pocas palabras, \"points\" son 1 a 3 frases muy cortas que se verán en pantalla (máximo 10 palabras cada una), y \"narration\" es lo que dice el profesor en voz alta: 2 o 3 frases naturales y cercanas, como si se lo explicaras a una amiga, con un ejemplo cuando ayude. No uses símbolos, emojis ni Markdown.";
const CHAT_SYSTEM = TEACHER + " Responde a las dudas de Erika sobre sus apuntes de forma clara y breve (normalmente menos de 150 palabras), con ejemplos cuando ayuden y **negrita** en los términos clave. Usa Markdown sencillo. Si la respuesta no está en los apuntes, dilo y luego responde con conocimiento general, avisando de que no viene en sus apuntes.";
const CHAT_SUGGESTIONS = ["¿Qué es lo más importante para el examen?", "Explícamelo como si tuviera 10 años", "Ponme un ejemplo", "¿Qué me pueden preguntar de esto?"];

// ---------- Estado ----------
let subjects = [], notes = [], current = "all", openId = null;
let mode = "note"; // note | review | exam
let view = "apunte"; // pestaña del apunte abierto
let busy = null; // { id, what, partial, retry }
let lastError = null; // { id, what, msg }
let sumMode = "corto", quizCount = 10, cardCount = 15, mapMode = "mapa";
let confirming = false, editing = false, subjMode = null, query = "";
let speaking = null;
const answers = {}; // noteId -> respuestas del quiz
const recorded = {}; // noteId -> si ya se guardó la nota del intento actual
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (s) => window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(s || "")) : `<div class="text">${esc(s)}</div>`;
const isPhone = () => window.matchMedia("(max-width: 859px)").matches;

function kindOf(file) {
  const n = file.name.toLowerCase();
  if (file.type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".docx")) return "docx";
  if (file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif)$/.test(n)) return "img";
  return "txt";
}
const KIND_LABEL = { pdf: "PDF", docx: "WORD", img: "FOTO", txt: "TEXTO" };
const fmtDate = (t) => new Date(t).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const sname = (id) => (subjects.find(s => s.id === id) || {}).name || "Sin asignatura";
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const baseName = (s) => s.replace(/\.[a-z0-9]{2,5}$/i, "");

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2800);
}

// ---------- Repetición espaciada (SM-2 simplificado) ----------
const DAY = 864e5;
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };
const newCard = (front, back) => ({ id: uid(), front, back, due: Date.now(), interval: 0, ease: 2.5, reps: 0 });
function dueCards(scopeNotes) {
  const lim = endOfToday(), out = [];
  for (const n of scopeNotes) for (const c of n.cards || []) if (c.due <= lim) out.push({ noteId: n.id, cardId: c.id });
  return out;
}
function nextIntervals(c) {
  const good = c.reps === 0 ? 1 : c.reps === 1 ? 3 : Math.round(Math.max(1, c.interval) * c.ease);
  return {
    0: 0,
    1: Math.max(1, Math.round(Math.max(1, c.interval) * 1.2)),
    2: good,
    3: c.reps === 0 ? 4 : Math.round(good * 1.3) + 1
  };
}
function gradeCard(c, g) {
  const iv = nextIntervals(c);
  if (g === 0) { c.reps = 0; c.interval = 0; c.ease = Math.max(1.3, c.ease - 0.2); c.due = Date.now(); return; }
  if (g === 1) c.ease = Math.max(1.3, c.ease - 0.15);
  if (g === 3) c.ease += 0.15;
  c.interval = iv[g]; c.reps++; c.due = Date.now() + c.interval * DAY;
}
const ivLabel = (d) => d === 0 ? "ahora" : d === 1 ? "mañana" : d < 30 ? `${d} días` : d < 365 ? `${Math.round(d / 30)} mes${Math.round(d / 30) > 1 ? "es" : ""}` : "1 año+";

// ---------- Ejemplo inicial ----------
const EXAMPLE_TEXT = "Tema 3. La célula\n\nLa célula es la unidad básica de la vida. Todos los seres vivos están formados por una o más células.\n\nTipos de célula:\n• Procariota: sin núcleo definido. Ejemplo: bacterias.\n• Eucariota: con núcleo rodeado de membrana. Ejemplo: células animales y vegetales.\n\nOrgánulos importantes:\n• Mitocondria: produce energía (ATP) mediante la respiración celular.\n• Cloroplasto: realiza la fotosíntesis (solo en células vegetales).\n• Ribosoma: fabrica proteínas.\n• Núcleo: guarda el ADN y controla la actividad de la célula.";
const EXAMPLE_SUMMARY = "La **célula** es la unidad básica de la vida: todo ser vivo está formado por una o más células.\n\n- Hay dos tipos: **procariotas** (sin núcleo, como las bacterias) y **eucariotas** (con núcleo, como las animales y vegetales).\n- La **mitocondria** produce energía (**ATP**) con la respiración celular.\n- El **cloroplasto** hace la fotosíntesis y solo está en células vegetales.\n- Los **ribosomas** fabrican proteínas.\n- El **núcleo** guarda el ADN y dirige la célula.";
const EXAMPLE_QUIZ = [
  { question: "¿Qué diferencia a una célula procariota de una eucariota?", options: ["La procariota no tiene núcleo definido", "La procariota tiene cloroplastos", "La eucariota no tiene ADN", "La eucariota es siempre una bacteria"], answer: 0, explanation: "Según los apuntes, las procariotas no tienen núcleo definido y las eucariotas tienen un núcleo rodeado de membrana." },
  { question: "¿Qué orgánulo produce la energía (ATP) de la célula?", options: ["Ribosoma", "Núcleo", "Mitocondria", "Cloroplasto"], answer: 2, explanation: "La mitocondria produce ATP mediante la respiración celular." },
  { question: "¿Dónde se encuentran los cloroplastos?", options: ["En todas las células", "Solo en células vegetales", "Solo en bacterias", "Solo en células animales"], answer: 1, explanation: "Los apuntes indican que el cloroplasto realiza la fotosíntesis solo en células vegetales." }
];
const EXAMPLE_CARDS = [
  ["¿Cuál es la unidad básica de la vida?", "La célula."],
  ["¿Qué le falta a una célula procariota?", "Un núcleo definido."],
  ["Pon un ejemplo de célula procariota.", "Las bacterias."],
  ["¿Qué orgánulo produce ATP?", "La mitocondria, mediante la respiración celular."],
  ["¿Dónde se hace la fotosíntesis?", "En el cloroplasto, solo en células vegetales."],
  ["¿Qué fabrican los ribosomas?", "Proteínas."],
  ["¿Qué función tiene el núcleo?", "Guarda el ADN y controla la actividad de la célula."]
];
const EXAMPLE_MAP = {
  title: "La célula",
  branches: [
    { title: "Qué es", children: [{ title: "Unidad básica de la vida" }, { title: "Todo ser vivo tiene células", details: ["Una o más células"] }] },
    { title: "Tipos", children: [{ title: "Procariota", details: ["Sin núcleo definido", "Ej.: bacterias"] }, { title: "Eucariota", details: ["Núcleo con membrana", "Ej.: animales y vegetales"] }] },
    { title: "Orgánulos", children: [{ title: "Mitocondria", details: ["Produce ATP"] }, { title: "Cloroplasto", details: ["Fotosíntesis", "Solo vegetales"] }, { title: "Ribosoma", details: ["Fabrica proteínas"] }, { title: "Núcleo", details: ["Guarda el ADN"] }] }
  ]
};
const EXAMPLE_VIDEO = {
  title: "La célula en dos minutos",
  scenes: [
    { heading: "La célula", points: ["La unidad básica de la vida"], narration: "Hoy repasamos la célula. Es la pieza más pequeña de la que está hecho cualquier ser vivo, desde una bacteria hasta tú." },
    { heading: "Dos tipos de célula", points: ["Procariota: sin núcleo", "Eucariota: con núcleo"], narration: "Hay dos grandes tipos. Las procariotas no tienen núcleo definido, como las bacterias. Las eucariotas sí lo tienen, como las de animales y plantas." },
    { heading: "La central de energía", points: ["Mitocondria", "Produce ATP"], narration: "La mitocondria es como la central eléctrica de la célula. Fabrica ATP, que es la energía que la célula usa para todo." },
    { heading: "Solo en las plantas", points: ["Cloroplasto", "Hace la fotosíntesis"], narration: "El cloroplasto solo aparece en células vegetales. Es donde se hace la fotosíntesis." },
    { heading: "Fábrica y cerebro", points: ["Ribosoma: fabrica proteínas", "Núcleo: guarda el ADN"], narration: "Los ribosomas fabrican proteínas. Y el núcleo guarda el ADN y dirige todo lo que hace la célula." },
    { heading: "Lo que no puedes olvidar", points: ["Procariota sin núcleo, eucariota con núcleo", "Mitocondria igual a energía", "Cloroplasto solo en vegetales"], narration: "Para el examen: procariota sin núcleo y eucariota con núcleo, la mitocondria da energía, y el cloroplasto solo está en las plantas." }
  ]
};
async function seed() {
  await put("subjects", { id: "ejemplo", name: "Biología", created: Date.now() });
  await put("notes", { id: "ejemplo-nota", subject: "ejemplo", name: "Tema 3 - La célula", kind: "txt", size: EXAMPLE_TEXT.length, added: Date.now(), blob: new Blob([EXAMPLE_TEXT], { type: "text/plain" }), example: true });
}
async function upgradeExample() {
  const n = notes.find(x => x.id === "ejemplo-nota");
  if (!n) return;
  let changed = false;
  if (!n.summary) { n.summary = { mode: "corto", text: EXAMPLE_SUMMARY, at: Date.now() }; changed = true; }
  if (!n.quiz) { n.quiz = { questions: EXAMPLE_QUIZ, at: Date.now() }; changed = true; }
  if (!n.map) { n.map = { tree: EXAMPLE_MAP, at: Date.now() }; changed = true; }
  if (!n.video) { n.video = { script: EXAMPLE_VIDEO, at: Date.now() }; changed = true; }
  if (!n.cards) { n.cards = EXAMPLE_CARDS.map(([f, b]) => newCard(f, b)); changed = true; }
  if (/\.txt$/.test(n.name)) { n.name = baseName(n.name); changed = true; }
  if (changed) await put("notes", n);
}

// ---------- Cabecera, bienvenida y ajustes ----------
function renderTop() {
  const has = !!ls.get("gemini-key");
  $("keydot").classList.toggle("on", has);
  const due = dueCards(notes).length;
  $("duecount").textContent = due;
  $("reviewbtn").setAttribute("aria-label", `Repasar: ${due} tarjeta${due === 1 ? "" : "s"} para hoy`);
  $("keystatus").textContent = has ? "Conectada: hay una clave guardada en este móvil." : "Todavía no hay ninguna clave guardada. Sin ella se pueden ver los apuntes, pero no crear resúmenes ni tests nuevos.";
  $("keylink").disabled = !has; $("keyforget").disabled = !has;
  $("keysteps").hidden = has;
  $("welcome").hidden = !!ls.get("bienvenida-vista");
  $("welcomekey").textContent = has ? "Ya está todo conectado. ¡A estudiar!" : "Antes de nada, abre «Ajustes» y conecta Gemini (o abre el enlace que te hayan mandado para conectarlo solo).";
  const last = +ls.get("ultima-copia") || 0;
  $("backupstatus").textContent = last ? `Última copia: ${new Date(last).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" })}.` : "Todavía no has guardado ninguna copia.";
  const own = notes.filter(n => !n.example).length;
  const snooze = +ls.get("aviso-copia-luego") || 0;
  const show = own >= 3 && Date.now() - last > 14 * DAY && Date.now() > snooze;
  $("backupbanner").hidden = !show;
  if (show) $("backuptext").textContent = last ? `Hace ${Math.floor((Date.now() - last) / DAY)} días que no guardas una copia de tus apuntes.` : "Ya tienes varios apuntes: guarda una copia por si cambias de móvil.";
}
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = () => navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
function renderNotice() {
  const box = $("notice");
  let msg = "";
  if (!db) msg = "Este navegador no deja guardar datos (¿modo incógnito?). Lo que subas se perderá al cerrar. Ábrela en una ventana normal.";
  else if (isIOS && !installed() && !ls.get("aviso-ios-luego")) msg = "Consejo para iPhone: añádela a la pantalla de inicio (botón Compartir → «Añadir a pantalla de inicio») y úsala siempre desde ese icono. Si la usas en Safari sin abrirla durante una semana, el iPhone puede borrar los apuntes.";
  box.hidden = !msg;
  box.innerHTML = msg ? `<span>${msg}</span>${db ? `<span class="actions"><button class="small ghost" id="noticeok">Entendido</button></span>` : ""}` : "";
}
async function renderStorage() {
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (!est) { $("storagestatus").textContent = "Este navegador no informa del espacio usado."; return; }
    const mb = (est.usage || 0) / 1048576;
    $("storagestatus").textContent = `Tus apuntes ocupan unos ${mb < 1 ? "menos de 1" : Math.round(mb)} MB. ` +
      (persisted ? "El navegador los tiene marcados para no borrarlos solo." : "Aun así, guarda una copia de vez en cuando.") + ` Versión ${APP_VERSION}.`;
  } catch (e) { $("storagestatus").textContent = `Versión ${APP_VERSION}.`; }
}

// ---------- Asignaturas y lista ----------
function renderTabs() {
  const counts = {}; notes.forEach(n => counts[n.subject] = (counts[n.subject] || 0) + 1);
  const tab = (id, label, n) => `<button class="tab" data-s="${esc(id)}" aria-pressed="${current === id}">${esc(label)}<span class="n">${n}</span></button>`;
  $("tabs").innerHTML = tab("all", "Todas", notes.length) +
    subjects.map(s => tab(s.id, s.name, counts[s.id] || 0)).join("") +
    `<button class="tab ghost" id="addsubj">+ Asignatura</button>`;
  const opts = subjects.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  $("target").innerHTML = opts || `<option value="">General (se creará)</option>`;
  if (current !== "all") $("target").value = current;
  renderSubjTools();
}
function renderSubjTools() {
  const box = $("subjtools");
  const s = subjects.find(x => x.id === current);
  if (!s) { box.innerHTML = ""; subjMode = null; return; }
  const sn = notes.filter(n => n.subject === s.id);
  const pool = sn.reduce((k, n) => k + (n.quiz?.questions?.length || 0), 0);
  const due = dueCards(sn).length;
  if (subjMode === "rename") {
    box.innerHTML = `<form class="inline-form" id="renameform">
      <input type="text" id="renameinput" value="${esc(s.name)}" maxlength="40" aria-label="Nuevo nombre de la asignatura">
      <button class="primary" type="submit">Guardar nombre</button><button class="ghost" type="button" id="subjcancel">Cancelar</button></form>`;
    $("renameinput").focus();
  } else if (subjMode === "delete") {
    box.innerHTML = `<div class="confirm"><span>¿Borrar «${esc(s.name)}»${sn.length ? (sn.length > 1 ? ` y sus ${sn.length} apuntes` : " y su apunte") : ""}? No se puede deshacer.</span>
      <button class="danger" id="subjyes">Sí, borrar</button><button class="ghost" id="subjcancel">Cancelar</button></div>`;
  } else {
    box.innerHTML = `<div class="actions">
      <button class="small primary" id="examgo" ${pool < 4 ? "disabled" : ""}>Examen de ${esc(s.name)}</button>
      <button class="small" id="subjreview" ${due ? "" : "disabled"}>Repasar ${esc(s.name)} (${due})</button>
      <button class="small ghost" id="subjrename">Renombrar</button>
      <button class="small danger" id="subjdel">Borrar asignatura</button></div>
      ${pool < 4 && sn.length ? `<p class="note" style="margin-top:6px">Para el examen de la asignatura, haz antes algún test en sus apuntes.</p>` : ""}`;
  }
}
function matches(n, q) {
  if (!q) return true;
  const hay = (n.name + " " + (n.summary?.text || "") + " " + (n.docText || "") + " " + (n.pdfText || "")).toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}
function renderList() {
  // Al buscar se busca en todas las asignaturas.
  const list = notes.filter(n => (query || current === "all" || n.subject === current) && matches(n, query)).sort((a, b) => b.added - a.added);
  $("listtitle").textContent = query ? "Resultados de la búsqueda" : current === "all" ? "Todos los apuntes" : sname(current);
  $("search").hidden = notes.length < 4 && !query;
  $("list").innerHTML = list.length ? list.map(n => {
    const chips = [];
    if (n.summary) chips.push(`<span class="chip">resumen</span>`);
    if (n.quizStats) chips.push(`<span class="chip ${n.quizStats.best / n.quizStats.total >= 0.8 ? "good" : ""}">test ${n.quizStats.best}/${n.quizStats.total}</span>`);
    else if (n.quiz) chips.push(`<span class="chip">test</span>`);
    if (n.cards?.length) { const d = dueCards([n]).length; chips.push(`<span class="chip">${n.cards.length} tarjetas${d ? ` · ${d} hoy` : ""}</span>`); }
    if (n.map) chips.push(`<span class="chip">mapa</span>`);
    if (n.video) chips.push(`<span class="chip">vídeo</span>`);
    return `<button class="item" data-id="${esc(n.id)}" aria-current="${mode === "note" && n.id === openId}">
      <span class="kind">${KIND_LABEL[n.kind] || "?"}</span>
      <div><span class="name">${esc(n.name)}${n.example ? '<span class="example">Ejemplo</span>' : ""}</span>
      <span class="meta">${current === "all" || query ? esc(sname(n.subject)) + " · " : ""}${fmtDate(n.added)} · ${fmtSize(n.size)}</span>
      ${chips.length ? `<span class="chips">${chips.join("")}</span>` : ""}</div>
    </button>`;
  }).join("") : `<p class="empty">${query ? "No hay apuntes que coincidan con la búsqueda." : "Aún no hay apuntes aquí. Sube el primero con el botón «Subir apuntes»."}</p>`;
}

// ---------- Visor ----------
function renderViewer() {
  if (mode === "review") return renderReview();
  if (mode === "exam") return renderExam();
  const v = $("viewer");
  const n = notes.find(x => x.id === openId);
  if (!n) { v.innerHTML = `<p class="empty" style="border:0">Elige un apunte de la lista para verlo.</p>`; return; }
  const tab = (id, label) => `<button class="vtab" role="tab" data-v="${id}" aria-selected="${view === id}">${label}</button>`;
  v.innerHTML = `
    <div class="vhead">
      <div><h2>${esc(n.name)}${n.example ? '<span class="example">Ejemplo</span>' : ""}</h2>
      <p class="sub">${esc(sname(n.subject))} · ${KIND_LABEL[n.kind]} · subido el ${fmtDate(n.added)}</p></div>
      <div class="actions"><button class="small ghost backbtn" id="backlist">Volver a la lista</button><button class="small" id="editbtn">Editar</button><button class="small danger" id="delbtn">Borrar</button></div>
    </div>
    <div id="editbox"></div>
    <div id="confirm"></div>
    <div class="vtabs" role="tablist">${tab("apunte", "Apunte")}${tab("resumen", "Resumen")}${tab("quiz", "Test")}${tab("tarjetas", "Tarjetas")}${tab("mapa", "Mapa")}${tab("video", "Vídeo")}${tab("preguntar", "Preguntar")}</div>
    <div class="content" id="content"></div>`;
  renderEdit(n); renderConfirm();
  ({ apunte: renderOriginal, resumen: renderSummary, quiz: renderQuiz, tarjetas: renderCards, mapa: renderMap, video: renderVideo, preguntar: renderChat }[view] || renderOriginal)(n);
}
function renderEdit(n) {
  const box = $("editbox"); if (!box) return;
  box.innerHTML = editing ? `<form class="inline-form" id="editform">
    <input type="text" id="editname" value="${esc(n.name)}" maxlength="80" aria-label="Nombre del apunte">
    <select id="editsubj" aria-label="Asignatura">${subjects.map(s => `<option value="${esc(s.id)}" ${s.id === n.subject ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
    <button class="primary" type="submit">Guardar</button><button class="ghost" type="button" id="editcancel">Cancelar</button></form>` : "";
}
function renderConfirm() {
  const box = $("confirm"); if (!box) return;
  box.innerHTML = confirming ? `<div class="confirm"><span>¿Borrar este apunte con todo lo que has creado de él? No se puede deshacer.</span>
    <button class="danger" id="yesdel">Sí, borrar</button><button class="ghost" id="nodel">Cancelar</button></div>` : "";
}
function busyHtml(what) { return `<div class="busy"><span class="spin"></span>${busy?.retry ? "Gemini está saturado; reintentando y probando otro modelo…" : what}</div>`; }
function errHtml(n, what) { return lastError && lastError.id === n.id && lastError.what === what ? `<p class="err">${esc(lastError.msg)}</p>` : ""; }
const isBusyWith = (n, what) => busy && busy.id === n.id && busy.what === what;
const noKeyHint = () => ls.get("gemini-key") ? "" : `<p class="note">Para crear esto hace falta conectar Gemini en «Ajustes».</p>`;

const pdfView = { pdf: null, io: null, cleanup() { this.io?.disconnect(); this.pdf?.destroy(); this.pdf = this.io = null; } };
async function renderOriginal(n) {
  const c = $("content");
  c.innerHTML = `<p class="sub">Cargando…</p>`;
  try {
    if (n.kind === "img") {
      const img = new Image(); img.alt = n.name; img.className = "orig"; img.src = URL.createObjectURL(n.blob);
      img.onload = () => URL.revokeObjectURL(img.src);
      c.replaceChildren(img);
    } else if (n.kind === "txt" || n.kind === "docx") {
      const t = (await noteText(n)).trim();
      if (openId !== n.id || view !== "apunte") return;
      c.innerHTML = `<div class="text">${esc(t || "Este documento no tiene texto.")}</div>`;
    } else if (n.kind === "pdf") {
      const lib = await getPdfjs();
      pdfView.cleanup();
      const pdf = await lib.getDocument({ data: new Uint8Array(await n.blob.arrayBuffer()) }).promise;
      if (openId !== n.id || view !== "apunte") { pdf.destroy(); return; }
      const max = Math.min(pdf.numPages, 80);
      c.innerHTML = `<p class="sub">${pdf.numPages} página${pdf.numPages > 1 ? "s" : ""}</p><div class="pages" id="pages">${
        Array.from({ length: max }, (_, i) => `<div class="pageph" data-page="${i + 1}">Página ${i + 1}</div>`).join("")}</div>
        ${pdf.numPages > max ? `<p class="sub">Se muestran las primeras ${max} páginas.</p>` : ""}`;
      // Cada página se dibuja solo cuando está a punto de verse.
      const draw = async (ph) => {
        const page = await pdf.getPage(+ph.dataset.page);
        const w = Math.min(760, ph.clientWidth || 600) * Math.min(1.5, window.devicePixelRatio || 1);
        const vp0 = page.getViewport({ scale: 1 });
        const vpt = page.getViewport({ scale: w / vp0.width });
        const cv = document.createElement("canvas"); cv.width = vpt.width; cv.height = vpt.height;
        await page.render({ canvasContext: cv.getContext("2d"), viewport: vpt }).promise;
        // Se pasa a imagen y se libera el lienzo: el iPhone tiene poca memoria para lienzos.
        const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.85));
        cv.width = cv.height = 0;
        const img = new Image(); img.alt = "Página " + ph.dataset.page; img.className = "page"; img.src = URL.createObjectURL(blob);
        img.onload = () => URL.revokeObjectURL(img.src);
        ph.replaceWith(img);
      };
      const io = new IntersectionObserver((ents) => ents.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); draw(e.target).catch(() => {}); } }), { rootMargin: "600px 0px" });
      c.querySelectorAll(".pageph").forEach(ph => io.observe(ph));
      pdfView.pdf = pdf; pdfView.io = io;
    }
  } catch (e) {
    c.innerHTML = `<p class="sub">No se pudo mostrar este archivo${navigator.onLine === false ? " sin internet" : ""}. Sigue guardado y puedes usar el resto de pestañas igualmente.</p>`;
  }
}

function renderSummary(n) {
  const c = $("content");
  const b = isBusyWith(n, "resumen");
  const modeBtn = (m, l) => `<button class="tab small" data-sm="${m}" aria-pressed="${sumMode === m}">${l}</button>`;
  c.innerHTML = `<div class="stack">
    <div class="actions">${modeBtn("corto", "Corto")}${modeBtn("detallado", "Detallado")}
      <button class="primary" id="gosum" ${busy ? "disabled" : ""}>${n.summary ? "Hacer otro resumen" : "Hacer resumen"}</button></div>
    ${errHtml(n, "resumen")}
    ${b ? busyHtml(busy.partial ? "Gemini está escribiendo…" : "Gemini está leyendo tus apuntes…") : ""}
    ${b && busy.partial ? `<div class="md" id="partial">${md(busy.partial)}</div>` : n.summary ? `${canSpeak ? `<div class="actions">
        <button class="small" id="speakbtn">${speaking === n.id ? "Parar audio" : "Escuchar resumen"}</button>
        <label class="note" for="rate">Velocidad</label>
        <select id="rate">${[0.8, 1, 1.25, 1.5].map(r => `<option value="${r}" ${r === speakRate ? "selected" : ""}>${String(r).replace(".", ",")}x</option>`).join("")}</select>
        <button class="small ghost" id="copysum">Copiar</button>
      </div>` : ""}
      <p class="note">Resumen ${n.summary.mode} · ${fmtDate(n.summary.at)}</p><div class="md">${md(n.summary.text)}</div>`
      : (b ? "" : `<p class="note">Elige corto o detallado y pulsa «Hacer resumen». El resumen se guarda con el apunte.</p>${noKeyHint()}`)}
  </div>`;
}

function quizHtml(qs, ans, prefix, showFrom) {
  return `<ol class="qlist">${qs.map((x, i) => {
    const chosen = ans[i];
    return `<li class="q"><p><span class="num">${i + 1}.</span>${esc(x.question)}${showFrom && x.from ? `<span class="from">${esc(x.from)}</span>` : ""}</p>
      ${x.options.map((o, j) => {
        let cls = "";
        if (chosen !== undefined) { if (j === x.answer) cls = "right"; else if (j === chosen) cls = "wrong"; }
        return `<button class="opt ${cls}" data-${prefix}q="${i}" data-o="${j}" ${chosen !== undefined ? "disabled" : ""}>${esc(o)}</button>`;
      }).join("")}
      ${chosen !== undefined ? `<div class="expl">${chosen === x.answer ? "Correcto. " : "No era esa. "}${esc(x.explanation)}</div>` : ""}
    </li>`;
  }).join("")}</ol>`;
}
const verdict = (r, t) => r === t ? "¡Perfecto! Te lo sabes." : r / t >= 0.8 ? "¡Muy bien! Casi perfecto." : r / t >= 0.5 ? "Bien, pero repasa las que has fallado." : "Toca repasar este tema otra vez.";
function renderQuiz(n) {
  const c = $("content");
  const b = isBusyWith(n, "quiz");
  const cntBtn = (k) => `<button class="tab small" data-qc="${k}" aria-pressed="${quizCount === k}">${k}</button>`;
  const q = n.quiz?.questions || [];
  const a = answers[n.id] ||= [];
  const done = a.filter(x => x !== undefined).length;
  const right = q.reduce((s, x, i) => s + (a[i] === x.answer ? 1 : 0), 0);
  if (q.length && done === q.length && !recorded[n.id]) {
    recorded[n.id] = true;
    const prev = n.quizStats?.total === q.length ? n.quizStats.best : 0;
    n.quizStats = { best: Math.max(prev, right), last: right, total: q.length, at: Date.now() };
    saveNote(n); renderList(); renderSubjTools();
  }
  c.innerHTML = `<div class="stack">
    <div class="actions"><span class="note">Preguntas:</span>${cntBtn(5)}${cntBtn(10)}${cntBtn(15)}
      <button class="primary" id="goquiz" ${busy ? "disabled" : ""}>${q.length ? "Hacer otro test" : "Hacer test"}</button></div>
    ${errHtml(n, "quiz")}
    ${b ? busyHtml("Gemini está preparando las preguntas…") : ""}
    ${q.length ? `
      <div class="actions"><span class="score">${right} de ${q.length}</span>
        <span class="note">${done < q.length ? `Te quedan ${q.length - done}` : verdict(right, q.length)}</span>
        ${done ? `<button class="small ghost" id="retry">Repetir</button>` : ""}
        ${n.quizStats ? `<span class="note">Tu mejor nota: ${n.quizStats.best}/${n.quizStats.total}</span>` : ""}</div>
      ${quizHtml(q, a, "", false)}
      ${done === q.length ? `<div class="result"><b>${right} de ${q.length}. ${verdict(right, q.length)}</b><div class="actions"><button class="small" id="retry2">Repetir</button><button class="small primary" id="goquiz2" ${busy ? "disabled" : ""}>Test nuevo</button></div></div>` : ""}`
      : (b ? "" : `<p class="note">Elige cuántas preguntas quieres y pulsa «Hacer test». Al responder verás al momento si aciertas y por qué.</p>${noKeyHint()}`)}
  </div>`;
}

function renderCards(n) {
  const c = $("content");
  const b = isBusyWith(n, "tarjetas");
  const cards = n.cards || [];
  const due = dueCards([n]).length;
  const cntBtn = (k) => `<button class="tab small" data-cc="${k}" aria-pressed="${cardCount === k}">${k}</button>`;
  c.innerHTML = `<div class="stack">
    ${cards.length ? `<div class="actions">
        <button class="primary" id="reviewnote" ${due ? "" : "disabled"}>${due ? `Repasar ahora (${due})` : "Nada pendiente hoy"}</button>
        <button id="practicenote">Practicar todas</button></div>
      <p class="note">${cards.length} tarjetas. Las que te sabes bien vuelven a salir más tarde y las que fallas, antes.</p>` : ""}
    <div class="actions"><span class="note">${cards.length ? "Crear más:" : "Tarjetas:"}</span>${cntBtn(10)}${cntBtn(15)}${cntBtn(25)}
      <button class="${cards.length ? "" : "primary"}" id="gocards" ${busy ? "disabled" : ""}>${cards.length ? "Añadir tarjetas" : "Hacer tarjetas"}</button></div>
    ${errHtml(n, "tarjetas")}
    ${b ? busyHtml("Gemini está haciendo las tarjetas…") : ""}
    ${cards.length ? `<details><summary>Ver todas las tarjetas</summary><ul class="cardlist" style="margin-top:8px">${cards.map(k => `<li><b>${esc(k.front)}</b><span>${esc(k.back)}</span><span class="note">Próximo repaso: ${k.due <= endOfToday() ? "hoy" : fmtDate(k.due)}</span></li>`).join("")}</ul>
      <div class="actions" style="margin-top:8px"><button class="small danger" id="delcards">Borrar todas las tarjetas</button></div></details>`
      : (b ? "" : `<p class="note">Gemini saca preguntas y respuestas cortas del apunte. Luego, cada día, «Repasar» te enseña las que te tocan, justo antes de que se te olviden.</p>${noKeyHint()}`)}
  </div>`;
}

function renderMap(n) {
  const c = $("content");
  const b = isBusyWith(n, "mapa");
  const modeBtn = (m, l) => `<button class="tab small" data-mm="${m}" aria-pressed="${mapMode === m}">${l}</button>`;
  const tree = n.map?.tree;
  c.innerHTML = `<div class="stack">
    <div class="actions">${modeBtn("mapa", "Mapa mental")}${modeBtn("esquema", "Esquema")}
      <button class="primary" id="gomap" ${busy ? "disabled" : ""}>${tree ? "Hacer otro mapa" : "Hacer mapa"}</button></div>
    ${errHtml(n, "mapa")}
    ${b ? busyHtml("Gemini está ordenando las ideas…") : ""}
    ${tree ? (mapMode === "mapa" ? `<p class="note">Desliza para ver el mapa entero.</p><div class="mapwrap">${mapSvg(tree)}</div>` : outlineHtml(tree))
      : (b ? "" : `<p class="note">Pulsa «Hacer mapa» y Gemini ordenará el apunte en un mapa mental. Con «Esquema» verás lo mismo como lista.</p>${noKeyHint()}`)}
  </div>`;
}
function wrapText(s, max) {
  const words = String(s).split(/\s+/), lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) { lines.push(cur); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}
function mapSvg(tree) {
  const W = 150, COL = 172, LH = 17, PAD = 8, GAP = 10;
  const root = { label: tree.title || "Tema", depth: 0, kids: [] };
  (tree.branches || []).forEach((b, bi) => {
    const bn = { label: b.title, depth: 1, branch: bi % 6, kids: [] };
    (b.children || []).forEach(ch => {
      const cn = { label: ch.title, depth: 2, branch: bi % 6, kids: [] };
      (ch.details || []).forEach(d => cn.kids.push({ label: d, depth: 3, branch: bi % 6, kids: [] }));
      bn.kids.push(cn);
    });
    root.kids.push(bn);
  });
  let cursor = GAP, maxDepth = 0;
  const nodes = [];
  (function lay(nd) {
    nd.lines = wrapText(nd.label, nd.depth === 0 ? 16 : 19);
    nd.h = nd.lines.length * LH + PAD * 2;
    nd.x = 10 + nd.depth * COL;
    maxDepth = Math.max(maxDepth, nd.depth);
    nodes.push(nd);
    if (!nd.kids.length) { nd.y = cursor + nd.h / 2; cursor += nd.h + GAP; }
    else { nd.kids.forEach(lay); nd.y = (nd.kids[0].y + nd.kids[nd.kids.length - 1].y) / 2; }
  })(root);
  const width = 10 + maxDepth * COL + W + 10, height = Math.max(cursor, root.h + GAP * 2);
  const links = [], boxes = [];
  for (const nd of nodes) {
    for (const k of nd.kids) {
      const x1 = nd.x + W, x2 = k.x, mx = (x1 + x2) / 2;
      links.push(`<path class="link" d="M${x1},${nd.y} C${mx},${nd.y} ${mx},${k.y} ${x2},${k.y}"/>`);
    }
    const cls = nd.depth === 0 ? "root" : `b${nd.branch} d${nd.depth}`;
    const top = nd.y - nd.h / 2;
    const tspans = nd.lines.map((l, i) => `<tspan x="${nd.x + 10}" y="${top + PAD + LH * (i + 1) - 4}">${esc(l)}</tspan>`).join("");
    boxes.push(`<g class="${cls}"><rect x="${nd.x}" y="${top}" width="${W}" height="${nd.h}" rx="8"/><text>${tspans}</text></g>`);
  }
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Mapa mental de ${esc(root.label)}">${links.join("")}${boxes.join("")}</svg>`;
}
function outlineHtml(tree) {
  return `<div class="outline"><h2>${esc(tree.title || "Tema")}</h2>${(tree.branches || []).map((b, bi) => `
    <section class="b${bi % 6}"><h3><span class="lvl">${bi + 1}.</span>${esc(b.title)}</h3>
      <ul>${(b.children || []).map((ch, ci) => `<li><strong><span class="lvl">${bi + 1}.${ci + 1}</span>${esc(ch.title)}</strong>
        ${(ch.details || []).length ? `<ul>${ch.details.map(d => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ul>
    </section>`).join("")}</div>`;
}

// ---------- Voz del dispositivo (audio y vídeo) ----------
const canSpeak = "speechSynthesis" in window;
let speakRate = +ls.get("velocidad-voz") || 1;
let voice = null, speakRun = 0;
function pickVoice() {
  if (!canSpeak) return;
  const vs = speechSynthesis.getVoices().filter(v => /^es/i.test(v.lang));
  const score = (v) => (/^es[-_]ES/i.test(v.lang) ? 4 : 0) + (/google|natural|neural|premium|enhanced|mejorad/i.test(v.name) ? 3 : 0) + (/m[oó]nica|luc[ií]a|elvira|helena|paulina/i.test(v.name) ? 1 : 0) + (v.localService ? 1 : 0);
  voice = vs.sort((a, b) => score(b) - score(a))[0] || null;
}
if (canSpeak) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function utter(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice ? voice.lang : "es-ES"; if (voice) u.voice = voice; u.rate = speakRate;
  return u;
}
function plainText(mdText) {
  return mdText.replace(/[#*_`>|]/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\[(.*?)\]\(.*?\)/g, "$1");
}
function speak(n) {
  if (!canSpeak) return;
  speechSynthesis.cancel();
  const parts = plainText(n.summary.text).match(/[^.!?:\n]+[.!?:]*/g)?.map(s => s.trim()).filter(Boolean) || [];
  const run = ++speakRun;
  speaking = n.id;
  parts.forEach((p, i) => {
    const u = utter(p);
    if (i === parts.length - 1) u.onend = () => { if (run === speakRun && speaking === n.id) { speaking = null; if (view === "resumen") renderViewer(); } };
    speechSynthesis.speak(u);
  });
}
function stopSpeak() { speakRun++; if (canSpeak) speechSynthesis.cancel(); speaking = null; }

// ---------- Vídeo-lección (escenas animadas + voz del dispositivo) ----------
const vp = { id: null, i: 0, playing: false, ended: false, timers: [], run: 0 };
function vClear() { vp.run++; vp.timers.forEach(clearTimeout); vp.timers = []; if (canSpeak) speechSynthesis.cancel(); }
function vStop() { vClear(); vp.playing = false; }
function renderVideo(n) {
  const c = $("content");
  const b = isBusyWith(n, "video");
  const sc = n.video?.script;
  if (vp.id !== n.id) { vStop(); vp.id = n.id; vp.i = 0; vp.ended = false; }
  c.innerHTML = `<div class="stack">
    <div class="actions"><button class="${sc ? "" : "primary"}" id="govideo" ${busy ? "disabled" : ""}>${sc ? "Hacer otro vídeo" : "Hacer vídeo"}</button>
      ${sc ? `<span class="note">${esc(sc.title || "")} · ${sc.scenes.length} escenas</span>` : ""}</div>
    ${errHtml(n, "video")}
    ${b ? busyHtml("Gemini está escribiendo el guion del vídeo…") : ""}
    ${sc ? `<div class="player">
        <div class="bars" id="vbars"></div>
        <div class="stage" id="vstage"></div>
        <div class="actions"><button id="vprev">Anterior</button><button class="primary" id="vplay">Reproducir</button><button id="vnext">Siguiente</button></div>
        ${canSpeak ? "" : `<p class="note">Este navegador no tiene voz: el vídeo avanza solo con subtítulos.</p>`}
        <div class="subs" id="vsubs" aria-live="polite"></div>
      </div>`
      : (b ? "" : `<p class="note">Pulsa «Hacer vídeo» y Gemini preparará una vídeo-lección corta con este apunte: escenas animadas y una voz que te lo explica.</p>${noKeyHint()}`)}
  </div>`;
  if (sc) vDraw(n, false);
}
function vDraw(n, animate) {
  const sc = n.video.script, s = sc.scenes[vp.i];
  if (!$("vstage")) return;
  $("vbars").innerHTML = sc.scenes.map((_, k) => `<span class="${k <= vp.i ? "done" : ""}"></span>`).join("");
  $("vstage").innerHTML = `<span class="scn">${vp.i + 1} / ${sc.scenes.length}</span>
    <h3 class="fade"><span>${esc(s.heading)}</span></h3>
    <ul>${(s.points || []).map(p => `<li class="${animate ? "" : "on"}">${esc(p)}</li>`).join("")}</ul>`;
  $("vsubs").textContent = s.narration;
  $("vplay").textContent = vp.playing ? "Pausa" : (vp.ended ? "Ver otra vez" : "Reproducir");
}
function vPlayScene(n) {
  vClear();
  const sc = n.video.script, s = sc.scenes[vp.i];
  vDraw(n, true);
  document.querySelectorAll("#vstage li").forEach((li, k) => vp.timers.push(setTimeout(() => li.classList.add("on"), 400 + k * 1600)));
  const est = Math.max(4000, s.narration.split(/\s+/).length * 420 / speakRate);
  let advanced = false;
  const run = vp.run;
  const next = () => {
    if (advanced || run !== vp.run || !vp.playing || vp.id !== n.id) return; advanced = true;
    if (vp.i < sc.scenes.length - 1) vp.timers.push(setTimeout(() => { vp.i++; vPlayScene(n); }, 700));
    else { vp.playing = false; vp.ended = true; vDraw(n, false); }
  };
  if (canSpeak) {
    const u = utter(s.narration); u.onend = next;
    speechSynthesis.speak(u);
    vp.timers.push(setTimeout(next, est * 2.2)); // por si el navegador no avisa al terminar
  } else vp.timers.push(setTimeout(next, est));
}

// ---------- Preguntar al apunte ----------
function renderChat(n) {
  const c = $("content");
  const b = isBusyWith(n, "preguntar");
  const chat = n.chat || [];
  c.innerHTML = `<div class="stack">
    <div class="chat" id="chatlog">
      ${chat.length ? "" : `<p class="note">Pregúntale lo que no entiendas de este apunte y te lo explica. Por ejemplo:</p>`}
      ${chat.map(m => m.role === "user" ? `<div class="msg me">${esc(m.text)}</div>` : `<div class="msg ai"><div class="md">${md(m.text)}</div></div>`).join("")}
      ${b && busy.partial ? `<div class="msg ai"><div class="md" id="partial">${md(busy.partial)}</div></div>` : ""}
    </div>
    ${b ? busyHtml(busy.partial ? "Escribiendo…" : "Pensando la respuesta…") : ""}
    ${errHtml(n, "preguntar")}
    ${chat.length ? "" : `<div class="suggest">${CHAT_SUGGESTIONS.map(s => `<button class="small" data-ask="${esc(s)}" ${busy ? "disabled" : ""}>${esc(s)}</button>`).join("")}</div>`}
    <form class="askform" id="askform">
      <textarea id="askinput" rows="2" placeholder="Escribe tu duda…" aria-label="Tu pregunta"></textarea>
      <button class="primary" type="submit" ${busy ? "disabled" : ""}>Preguntar</button>
    </form>
    ${chat.length ? `<div class="actions"><button class="small ghost" id="clearchat" ${busy ? "disabled" : ""}>Borrar conversación</button></div>` : ""}
    ${noKeyHint()}
  </div>`;
}
async function ask(n, question) {
  question = question.trim(); if (!question || busy) return;
  if (!ensureKey()) return;
  const history = (n.chat || []).slice(-12);
  n.chat = [...(n.chat || []), { role: "user", text: question }];
  busy = { id: n.id, what: "preguntar" }; lastError = null; refreshIfOpen(n.id);
  try {
    const text = await generate(n, { prompt: question, history, system: CHAT_SYSTEM, onText: streamTo(n, "preguntar") });
    n.chat.push({ role: "model", text });
    await saveNote(n);
  } catch (e) {
    n.chat.pop();
    lastError = { id: n.id, what: "preguntar", msg: e instanceof AIError ? e.message : "Algo ha fallado: " + (e.message || e) };
  } finally { busy = null; refreshIfOpen(n.id); scrollChat(); }
}
function scrollChat() { const box = $("askform"); if (box && isPhone()) box.scrollIntoView({ block: "nearest" }); }
function streamTo(n, what) {
  return (partial) => {
    if (!busy || busy.id !== n.id) return;
    const first = !busy.partial;
    busy.partial = partial;
    const el = $("partial");
    if (el && !first) el.innerHTML = md(partial);
    else if (mode === "note" && openId === n.id && view === what) renderViewer();
  };
}

// ---------- Repaso de tarjetas ----------
let rs = null; // { title, queue:[{noteId, cardId}], i, flipped, total, done, practice }
function startReview(scopeNotes, title, practice) {
  stopSpeak(); vStop();
  const queue = practice
    ? shuffle(scopeNotes.flatMap(n => (n.cards || []).map(c => ({ noteId: n.id, cardId: c.id }))))
    : shuffle(dueCards(scopeNotes));
  if (!queue.length) { toast("No tienes tarjetas pendientes para hoy. ¡Bien hecho!"); return; }
  rs = { title, queue, i: 0, flipped: false, total: queue.length, done: 0, practice: !!practice, right: 0 };
  mode = "review"; renderViewer(); renderList(); showViewer();
}
function findCard(ref) {
  const n = notes.find(x => x.id === ref.noteId);
  return n ? { n, c: (n.cards || []).find(k => k.id === ref.cardId) } : {};
}
function renderReview() {
  const v = $("viewer");
  const head = `<div class="vhead"><div><h2>${esc(rs.title)}</h2><p class="sub">${rs.practice ? "Práctica libre: no cambia tus fechas de repaso." : "Las que aciertes volverán más tarde; las que falles, antes."}</p></div>
    <div class="actions"><button class="small" id="endreview">Terminar</button></div></div>
    <div class="progress" aria-hidden="true"><span style="width:${Math.round(100 * rs.done / rs.total)}%"></span></div>`;
  if (rs.i >= rs.queue.length) {
    v.innerHTML = `${head}<div class="result"><b>¡Repaso terminado!</b><span>${rs.total} tarjeta${rs.total > 1 ? "s" : ""} repasada${rs.total > 1 ? "s" : ""}${rs.practice ? `, ${rs.right} a la primera` : ""}.</span>
      <span class="note">${dueCards(notes).length ? `Aún te quedan ${dueCards(notes).length} para hoy en otros apuntes.` : "No te queda nada pendiente para hoy."}</span>
      <div class="actions"><button class="small primary" id="endreview2">Volver a mis apuntes</button></div></div>`;
    renderTop(); return;
  }
  const { n, c } = findCard(rs.queue[rs.i]);
  if (!c) { rs.queue.splice(rs.i, 1); rs.total = Math.max(rs.done, rs.total - 1); return renderReview(); }
  const iv = nextIntervals(c);
  v.innerHTML = `${head}
    <div class="flash">
      <p class="note">${rs.done + 1} de ${rs.total} · ${esc(n.name)}</p>
      <button class="card ${rs.flipped ? "flip" : ""}" id="flipcard" aria-label="${rs.flipped ? "Tarjeta" : "Toca para ver la respuesta"}">
        <span class="lab">Pregunta</span><span>${esc(c.front)}</span>
        ${rs.flipped ? `<span class="back">${esc(c.back)}</span>` : `<span class="note">Piensa la respuesta y toca para verla</span>`}
      </button>
      ${rs.flipped ? (rs.practice
        ? `<div class="grades" style="grid-template-columns:1fr 1fr"><button class="g0" data-g="0">La he fallado</button><button class="g3" data-g="2">Me la sabía</button></div>`
        : `<p class="note">¿Qué tal te la sabías?</p><div class="grades">
          <button class="g0" data-g="0">Otra vez<small>${ivLabel(iv[0])}</small></button>
          <button data-g="1">Difícil<small>${ivLabel(iv[1])}</small></button>
          <button data-g="2">Bien<small>${ivLabel(iv[2])}</small></button>
          <button class="g3" data-g="3">Fácil<small>${ivLabel(iv[3])}</small></button></div>`)
        : `<button class="primary" id="showans">Ver respuesta</button>`}
    </div>`;
}
function gradeCurrent(g) {
  const ref = rs.queue[rs.i];
  const { n, c } = findCard(ref);
  if (!c) return;
  if (rs.practice) {
    if (g === 0) rs.queue.push(ref); else { rs.done++; if (!ref.missed) rs.right++; }
    if (g === 0) ref.missed = true;
  } else {
    gradeCard(c, g);
    if (g === 0) rs.queue.push(ref); else rs.done++;
    saveNote(n);
  }
  rs.i++; rs.flipped = false;
  renderReview(); renderTop();
}

// ---------- Examen de la asignatura ----------
let ex = null; // { subject, questions, answers, recorded }
function startExam(subjectId) {
  stopSpeak(); vStop();
  const pool = notes.filter(n => n.subject === subjectId).flatMap(n => (n.quiz?.questions || []).map(q => ({ ...q, from: n.name })));
  if (pool.length < 4) { toast("Haz antes algún test en los apuntes de esta asignatura."); return; }
  ex = { subject: subjectId, questions: shuffle(pool).slice(0, 20), answers: [] };
  mode = "exam"; renderViewer(); renderList(); showViewer();
}
function renderExam() {
  const v = $("viewer");
  const q = ex.questions, a = ex.answers;
  const done = a.filter(x => x !== undefined).length;
  const right = q.reduce((s, x, i) => s + (a[i] === x.answer ? 1 : 0), 0);
  const nota = (10 * right / q.length).toFixed(1).replace(".", ",");
  v.innerHTML = `<div class="vhead"><div><h2>Examen de ${esc(sname(ex.subject))}</h2>
      <p class="sub">${q.length} preguntas mezcladas de los tests de todos sus apuntes.</p></div>
      <div class="actions"><button class="small" id="endexam">Salir</button></div></div>
    <div class="actions"><span class="score">${right} de ${q.length}</span><span class="note">${done < q.length ? `Te quedan ${q.length - done}` : ""}</span></div>
    ${quizHtml(q, a, "x", true)}
    ${done === q.length ? `<div class="result"><b>Tu nota: ${nota} sobre 10.</b><span>${verdict(right, q.length)}</span>
      <div class="actions"><button class="small primary" id="examagain">Otro examen</button><button class="small" id="endexam2">Volver</button></div></div>` : ""}`;
}

// ---------- Acciones ----------
function showViewer() { if (isPhone()) $("viewer").scrollIntoView({ behavior: "smooth", block: "start" }); }
function ensureKey() {
  if (ls.get("gemini-key")) return true;
  openSettings(); $("keyinput").focus(); toast("Primero conecta Gemini");
  return false;
}
function openSettings() { $("settings").hidden = false; renderStorage(); $("settings").scrollIntoView({ behavior: "smooth", block: "start" }); }
async function addFiles(files) {
  if (!files.length) return;
  let subject = $("target").value;
  if (!subject) { const s = { id: uid(), name: "General", created: Date.now() }; await put("subjects", s); subjects.push(s); subject = s.id; }
  let last = null, ok = 0;
  for (const f of files) {
    const n = { id: uid(), subject, name: baseName(f.name), kind: kindOf(f), size: f.size, added: Date.now(), blob: f };
    if (n.kind === "txt") n.docText = await f.text().catch(() => undefined); // para poder buscar dentro
    try { await put("notes", n); notes.push(n); last = n.id; ok++; } catch (e) { toast("No se pudo guardar " + f.name + ". Puede que el móvil no tenga espacio."); }
  }
  if (ok) {
    mode = "note"; openId = last; confirming = editing = false; view = "apunte"; current = subject; query = ""; $("search").value = "";
    render(); showViewer(); toast(ok === 1 ? "Apunte guardado" : ok + " apuntes guardados");
  }
}
async function runAI(n, what) {
  if (busy || !ensureKey()) return;
  busy = { id: n.id, what }; lastError = null; refreshIfOpen(n.id);
  try {
    if (what === "resumen") {
      const text = await generate(n, { prompt: SUMMARY_PROMPTS[sumMode], system: TEACHER, onText: streamTo(n, "resumen") });
      n.summary = { mode: sumMode, text, at: Date.now() };
    } else if (what === "video") {
      const script = parseJSON(await generate(n, { prompt: VIDEO_PROMPT, schema: VIDEO_SCHEMA, system: TEACHER }), "el vídeo");
      script.scenes = (script.scenes || []).filter(s => s.heading && s.narration);
      if (!script.scenes.length) throw new AIError("Gemini no ha podido preparar un vídeo de este apunte. Vuelve a intentarlo.");
      n.video = { script, at: Date.now() };
      vStop(); vp.i = 0; vp.ended = false;
    } else if (what === "mapa") {
      const tree = parseJSON(await generate(n, { prompt: MAP_PROMPT, schema: MAP_SCHEMA, system: TEACHER }), "el mapa");
      if (!tree || !Array.isArray(tree.branches) || !tree.branches.length) throw new AIError("Gemini no ha podido sacar un mapa de este apunte. Vuelve a intentarlo.");
      n.map = { tree, at: Date.now() };
    } else if (what === "tarjetas") {
      const data = parseJSON(await generate(n, { prompt: cardsPrompt(cardCount, n.cards || []), schema: CARDS_SCHEMA, system: TEACHER }), "las tarjetas");
      const seen = new Set((n.cards || []).map(c => c.front.toLowerCase()));
      const fresh = (data.cards || []).filter(c => c.front && c.back && !seen.has(c.front.toLowerCase())).map(c => newCard(c.front.trim(), c.back.trim()));
      if (!fresh.length) throw new AIError("Gemini no ha podido sacar tarjetas nuevas de este apunte. Vuelve a intentarlo.");
      n.cards = [...(n.cards || []), ...fresh];
    } else {
      const data = parseJSON(await generate(n, { prompt: quizPrompt(quizCount), schema: QUIZ_SCHEMA, system: TEACHER }), "el test");
      const qs = (data.questions || []).filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
      if (!qs.length) throw new AIError("Gemini no ha podido sacar preguntas de este apunte. Prueba con otro o vuelve a intentarlo.");
      n.quiz = { questions: qs, at: Date.now() };
      answers[n.id] = []; recorded[n.id] = false;
    }
    await saveNote(n);
    toast({ resumen: "Resumen listo", quiz: "Test listo", mapa: "Mapa listo", video: "Vídeo listo", tarjetas: "Tarjetas listas" }[what]);
  } catch (e) {
    lastError = { id: n.id, what, msg: e instanceof AIError ? e.message : "Algo ha fallado: " + (e.message || e) };
  } finally {
    busy = null; refreshIfOpen(n.id); renderTop();
  }
}
function render() { renderNotice(); renderTop(); renderTabs(); renderList(); renderViewer(); }
function refreshIfOpen(id) { if (mode === "note" && openId === id) renderViewer(); renderList(); }

// ---------- Copia de seguridad ----------
function blobToDataURL(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
}
async function dataURLToBlob(u) { return (await fetch(u)).blob(); }
async function makeBackup() {
  // Se arma por trozos para no tener toda la copia en un solo texto gigante en memoria.
  const head = JSON.stringify({ app: "apuntes-erika", version: 1, exported: Date.now(), subjects });
  const parts = [head.slice(0, -1) + ',"notes":['];
  notes.forEach((n, i) => {
    const { blob, ...rest } = n;
    const meta = JSON.stringify({ ...rest, fileType: blob.type || "" });
    parts.push((i ? "," : "") + meta.slice(0, -1) + ',"file":"', blobToDataURL(blob), '"}');
  });
  parts.push("]}");
  const resolved = await Promise.all(parts);
  return new File(resolved, `apuntes-erika-${new Date().toISOString().slice(0, 10)}.json`, { type: "application/json" });
}
async function doBackup() {
  const btn = $("backupbtn"); btn.disabled = true; btn.textContent = "Preparando…";
  try {
    const file = await makeBackup();
    let shared = false;
    if (navigator.canShare?.({ files: [file] }) && isPhone()) {
      try { await navigator.share({ files: [file], title: "Copia de mis apuntes" }); shared = true; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    if (!shared) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    ls.set("ultima-copia", String(Date.now()));
    toast("Copia guardada"); renderTop();
  } catch (e) { toast("No se pudo preparar la copia."); }
  finally { btn.disabled = false; btn.textContent = "Guardar copia"; }
}
let pendingRestore = null;
async function readBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "apuntes-erika" || !Array.isArray(data.notes)) throw new Error();
    const okId = (v) => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
    data.subjects = (data.subjects || []).filter(s => okId(s.id) && typeof s.name === "string");
    data.notes = data.notes.filter(x => okId(x.id) && okId(x.subject) && KIND_LABEL[x.kind] && typeof x.name === "string" && typeof x.file === "string");
    data.notes.forEach(x => { if (x.quizStats) x.quizStats = { best: +x.quizStats.best || 0, last: +x.quizStats.last || 0, total: +x.quizStats.total || 1, at: +x.quizStats.at || 0 }; });
    pendingRestore = data;
    const nNew = data.notes.filter(x => !notes.some(n => n.id === x.id)).length;
    $("restoreconfirm").innerHTML = `<div class="confirm" style="border-color:var(--accent)"><span>Esta copia es del ${new Date(data.exported).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" })} y tiene ${data.notes.length} apuntes (${nNew} que no tienes ahora). Se añaden los que falten y, de los que ya tienes, se queda la versión más reciente. No se borra nada.</span>
      <button class="primary small" id="restoreyes">Recuperar</button><button class="ghost small" id="restoreno">Cancelar</button></div>`;
  } catch (e) { toast("Ese archivo no es una copia de esta app."); }
}
async function applyRestore() {
  const data = pendingRestore; pendingRestore = null; $("restoreconfirm").innerHTML = "";
  if (!data) return;
  let count = 0;
  for (const s of data.subjects) { if (!subjects.some(k => k.id === s.id)) await put("subjects", s); }
  for (const x of data.notes) {
    const mine = notes.find(n => n.id === x.id);
    if (mine && (mine.updated || mine.added || 0) >= (x.updated || x.added || 0)) continue; // la de este móvil es más nueva
    const { file, fileType, ...rest } = x;
    if (!data.subjects.some(s => s.id === rest.subject) && !subjects.some(s => s.id === rest.subject)) continue;
    try { await put("notes", { ...rest, blob: new Blob([await dataURLToBlob(file)], { type: fileType }) }); count++; } catch (e) {}
  }
  subjects = (await all("subjects")).sort((a, b) => a.created - b.created);
  notes = await all("notes");
  mode = "note"; current = "all"; render(); toast(count ? `${count} apunte${count > 1 ? "s" : ""} recuperado${count > 1 ? "s" : ""}` : "Ya tenías todo lo de esa copia");
}

// ---------- Enlace con la clave ----------
function readKeyFromLink() {
  const m = location.hash.match(/(?:^#|&)clave=([^&]+)/);
  if (!m) return;
  const k = decodeURIComponent(m[1]).trim();
  history.replaceState(null, "", location.pathname + location.search);
  if (/^AIza[\w-]{20,}$/.test(k)) { ls.set("gemini-key", k); ls.del("gemini-models"); setTimeout(() => toast("Gemini conectado. ¡Listo para estudiar!"), 600); }
}
async function copyKeyLink() {
  const link = location.origin + location.pathname + "#clave=" + encodeURIComponent(ls.get("gemini-key") || "");
  try { await navigator.clipboard.writeText(link); toast("Enlace copiado. Mándaselo por WhatsApp."); }
  catch (e) {
    $("restoreconfirm").innerHTML = "";
    const box = document.createElement("input"); box.type = "text"; box.value = link; box.readOnly = true; box.style.width = "100%";
    $("keylink").after(box); box.select(); toast("Copia el enlace que ha aparecido.");
  }
}

// ---------- Eventos ----------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  const n = notes.find(x => x.id === openId);
  // cabecera y ajustes
  if (t.id === "reviewbtn") { startReview(notes, "Repaso de hoy"); return; }
  if (t.id === "settingsbtn") { if ($("settings").hidden) openSettings(); else $("settings").hidden = true; return; }
  if (t.id === "settingsclose") { $("settings").hidden = true; return; }
  if (t.id === "welcomeok") { ls.set("bienvenida-vista", "1"); renderTop(); if (!ls.get("gemini-key")) openSettings(); return; }
  if (t.id === "keyforget") { ls.del("gemini-key"); ls.del("gemini-models"); renderTop(); toast("Clave quitada"); return; }
  if (t.id === "keylink") { copyKeyLink(); return; }
  if (t.id === "backupbtn" || t.id === "bannerbackup") { if (t.id === "bannerbackup") openSettings(); doBackup(); return; }
  if (t.id === "noticeok") { ls.set("aviso-ios-luego", "1"); renderNotice(); return; }
  if (t.id === "bannerlater") { ls.set("aviso-copia-luego", String(Date.now() + 5 * DAY)); renderTop(); return; }
  if (t.id === "restoreyes") { if (busy) { toast("Espera a que Gemini termine."); return; } applyRestore(); return; }
  if (t.id === "restoreno") { pendingRestore = null; $("restoreconfirm").innerHTML = ""; return; }
  // asignaturas
  if (t.dataset.s) { current = t.dataset.s; subjMode = null; renderTabs(); renderList(); return; }
  if (t.id === "addsubj") { $("newsubj").hidden = false; $("subjname").focus(); return; }
  if (t.id === "cancelsubj") { $("newsubj").hidden = true; return; }
  if (t.id === "subjrename") { subjMode = "rename"; renderSubjTools(); return; }
  if (t.id === "subjdel") { subjMode = "delete"; renderSubjTools(); return; }
  if (t.id === "subjcancel") { subjMode = null; renderSubjTools(); return; }
  if (t.id === "examgo" || t.id === "examagain") { startExam(t.id === "examgo" ? current : ex.subject); return; }
  if (t.id === "subjreview") { startReview(notes.filter(x => x.subject === current), "Repaso de " + sname(current)); return; }
  if (t.id === "subjyes") {
    const id = current;
    for (const x of notes.filter(k => k.subject === id)) await del("notes", x.id);
    await del("subjects", id);
    notes = notes.filter(k => k.subject !== id); subjects = subjects.filter(s => s.id !== id);
    if (!notes.find(k => k.id === openId)) { openId = null; stopSpeak(); vStop(); }
    if (mode !== "note") mode = "note";
    current = "all"; subjMode = null; render(); toast("Asignatura borrada");
    return;
  }
  // lista
  if (t.dataset.id) {
    stopSpeak(); vStop(); mode = "note";
    if (openId !== t.dataset.id) { openId = t.dataset.id; view = "apunte"; }
    confirming = editing = false; renderList(); renderViewer(); showViewer(); return;
  }
  // repaso
  if (t.id === "flipcard" || t.id === "showans") { if (!rs.flipped) { rs.flipped = true; renderReview(); } return; }
  if (t.dataset.g !== undefined && rs) { gradeCurrent(+t.dataset.g); return; }
  if (t.id === "endreview" || t.id === "endreview2") { rs = null; mode = "note"; renderViewer(); renderList(); renderTop(); return; }
  // examen
  if (t.dataset.xq !== undefined && ex) { ex.answers[+t.dataset.xq] = +t.dataset.o; renderExam(); return; }
  if (t.id === "endexam" || t.id === "endexam2") { ex = null; mode = "note"; renderViewer(); renderList(); return; }
  if (!n) return;
  // apunte abierto
  if (t.id === "backlist") { $("listcol").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  if (t.dataset.v) { stopSpeak(); vStop(); view = t.dataset.v; lastError = null; renderViewer(); return; }
  if (t.id === "editbtn") { editing = !editing; confirming = false; renderEdit(n); renderConfirm(); if (editing) $("editname").focus(); return; }
  if (t.id === "editcancel") { editing = false; renderEdit(n); return; }
  if (t.id === "delbtn" && busy?.id === n.id) { toast("Espera a que Gemini termine con este apunte."); return; }
  if (t.id === "delbtn") { confirming = true; editing = false; renderConfirm(); renderEdit(n); return; }
  if (t.id === "nodel") { confirming = false; renderConfirm(); return; }
  if (t.id === "yesdel") {
    stopSpeak(); vStop();
    await del("notes", openId); notes = notes.filter(x => x.id !== openId); openId = null; confirming = false; render(); toast("Apunte borrado");
    if (isPhone()) $("listcol").scrollIntoView({ behavior: "smooth" });
    return;
  }
  if (t.id === "gosum") { runAI(n, "resumen"); return; }
  if (t.dataset.sm) { sumMode = t.dataset.sm; renderViewer(); return; }
  if (t.id === "speakbtn") { if (speaking === n.id) stopSpeak(); else speak(n); renderViewer(); return; }
  if (t.id === "copysum") { try { await navigator.clipboard.writeText(n.summary.text); toast("Resumen copiado"); } catch (err) { toast("No se pudo copiar"); } return; }
  if (t.id === "goquiz" || t.id === "goquiz2") { runAI(n, "quiz"); return; }
  if (t.dataset.qc) { quizCount = +t.dataset.qc; renderViewer(); return; }
  if (t.dataset.q !== undefined) { (answers[n.id] ||= [])[+t.dataset.q] = +t.dataset.o; renderViewer(); return; }
  if (t.id === "retry" || t.id === "retry2") { answers[n.id] = []; recorded[n.id] = false; renderViewer(); return; }
  if (t.id === "gocards") { runAI(n, "tarjetas"); return; }
  if (t.dataset.cc) { cardCount = +t.dataset.cc; renderViewer(); return; }
  if (t.id === "reviewnote") { startReview([n], "Repaso: " + n.name); return; }
  if (t.id === "practicenote") { startReview([n], "Práctica: " + n.name, true); return; }
  if (t.id === "delcards") { if (t.dataset.sure) { n.cards = []; await saveNote(n); renderViewer(); renderTop(); renderList(); toast("Tarjetas borradas"); } else { t.dataset.sure = "1"; t.textContent = "Toca otra vez para confirmar"; } return; }
  if (t.id === "gomap") { runAI(n, "mapa"); return; }
  if (t.dataset.mm) { mapMode = t.dataset.mm; renderViewer(); return; }
  if (t.id === "govideo") { vStop(); runAI(n, "video"); return; }
  if (t.id === "vplay" && n.video) {
    if (vp.playing) { vStop(); vDraw(n, false); }
    else { stopSpeak(); if (vp.ended) vp.i = 0; vp.playing = true; vp.ended = false; vPlayScene(n); }
    return;
  }
  if ((t.id === "vnext" || t.id === "vprev") && n.video) {
    const max = n.video.script.scenes.length - 1;
    vp.i = Math.min(max, Math.max(0, vp.i + (t.id === "vnext" ? 1 : -1))); vp.ended = false;
    if (vp.playing) vPlayScene(n); else { vClear(); vDraw(n, false); }
    return;
  }
  if (t.dataset.ask) { ask(n, t.dataset.ask); return; }
  if (t.id === "clearchat") { n.chat = []; await saveNote(n); renderViewer(); return; }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "rate") {
    speakRate = +e.target.value; ls.set("velocidad-voz", String(speakRate));
    const n = notes.find(x => x.id === openId);
    if (n && speaking === n.id) speak(n);
  }
  if (e.target.id === "restorefile" && e.target.files[0]) { readBackup(e.target.files[0]); e.target.value = ""; }
});
document.addEventListener("submit", async (e) => {
  const id = e.target.id;
  if (["renameform", "editform", "askform", "keyform", "newsubj"].includes(id)) e.preventDefault(); else return;
  const n = notes.find(x => x.id === openId);
  if (id === "keyform") {
    let k = $("keyinput").value.trim(); if (!k) return;
    const fromLink = k.match(/clave=([^&\s]+)/); if (fromLink) k = decodeURIComponent(fromLink[1]); // también vale pegar el enlace entero
    ls.set("gemini-key", k); ls.del("gemini-models"); $("keyinput").value = "";
    renderTop(); toast("Clave guardada. ¡Ya puedes crear resúmenes y tests!");
  } else if (id === "newsubj") {
    const name = $("subjname").value.trim(); if (!name) return;
    const s = { id: uid(), name, created: Date.now() };
    await put("subjects", s); subjects.push(s); current = s.id;
    $("subjname").value = ""; $("newsubj").hidden = true; render(); toast("Asignatura creada");
  } else if (id === "renameform") {
    const name = $("renameinput").value.trim(); const s = subjects.find(x => x.id === current);
    if (!name || !s) return;
    s.name = name; await put("subjects", s); subjMode = null; render(); toast("Nombre cambiado");
  } else if (id === "editform" && n) {
    const name = $("editname").value.trim(); if (!name) return;
    n.name = name; n.subject = $("editsubj").value || n.subject;
    await saveNote(n); editing = false; render(); toast("Apunte guardado");
  } else if (id === "askform" && n) {
    const q = $("askinput").value; $("askinput").value = ""; ask(n, q);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.target.id === "askinput" && e.key === "Enter" && !e.shiftKey && !isPhone()) { e.preventDefault(); $("askform").requestSubmit(); }
  if (mode === "review" && rs && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
    if (e.key === " " && !rs.flipped) { e.preventDefault(); rs.flipped = true; renderReview(); }
    else if (rs.flipped && /^[1-4]$/.test(e.key)) gradeCurrent(rs.practice ? (e.key === "1" ? 0 : 2) : +e.key - 1);
  }
});
$("search").addEventListener("input", (e) => { query = e.target.value.trim(); renderList(); });
$("file").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
const drop = $("drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });
// Al volver a la app (por ejemplo al día siguiente), se actualizan las tarjetas pendientes.
document.addEventListener("visibilitychange", () => { if (!document.hidden) { renderTop(); renderList(); } });

// ---------- Arranque ----------
(async () => {
  readKeyFromLink();
  await openDB();
  try { navigator.storage?.persist?.(); } catch (e) {}
  subjects = await all("subjects");
  // El ejemplo solo se crea la primera vez; si luego se borra, no vuelve.
  if (!subjects.length && !ls.get("ejemplo-creado")) { await seed(); subjects = await all("subjects"); }
  ls.set("ejemplo-creado", "1");
  notes = await all("notes");
  await upgradeExample();
  subjects.sort((a, b) => a.created - b.created);
  openId = (notes.find(n => n.example) || notes.slice().sort((a, b) => b.added - a.added)[0] || {}).id || null;
  if (notes.find(n => n.id === openId)?.summary) view = "resumen";
  render();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
