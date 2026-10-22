"use strict";
const APP_VERSION = "2026-10-22a";

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
// raw = viene de la sincronización: se guarda tal cual, sin marcarlo como cambio nuevo.
function put(store, obj, raw) {
  if (!raw) { obj.updated = Date.now(); if (typeof syncSoon === "function") syncSoon(); }
  if (!db) { mem[store] = mem[store].filter(x => x.id !== obj.id).concat(obj); return Promise.resolve(); }
  return new Promise((res, rej) => {
    try { const t = db.transaction(store, "readwrite"); t.objectStore(store).put(obj); t.oncomplete = res; t.onerror = () => rej(t.error); }
    catch (e) { rej(e); }
  });
}
function del(store, id, raw) {
  if (!raw && typeof tomb === "function") { tomb(store === "notes" ? "note" : "subject", id); if (store === "notes") tomb("file", id); }
  if (!db) { mem[store] = mem[store].filter(x => x.id !== id); return Promise.resolve(); }
  return new Promise((res) => {
    try { const t = db.transaction(store, "readwrite"); t.objectStore(store).delete(id); t.oncomplete = res; t.onerror = res; }
    catch (e) { res(); }
  });
}
const saveNote = (n) => { if (!notes.includes(n)) return Promise.resolve(); return put("notes", n).catch(() => toast("No se pudo guardar. Puede que el móvil no tenga espacio.")); };
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
    scenes: { type: "ARRAY", items: { type: "OBJECT", properties: {
      layout: { type: "STRING", enum: ["portada", "lista", "definicion", "comparacion", "dato", "pregunta", "resumen"] },
      icon: { type: "STRING" }, heading: { type: "STRING" }, points: { type: "ARRAY", items: { type: "STRING" } },
      term: { type: "STRING" }, definition: { type: "STRING" },
      left_title: { type: "STRING" }, left_points: { type: "ARRAY", items: { type: "STRING" } },
      right_title: { type: "STRING" }, right_points: { type: "ARRAY", items: { type: "STRING" } },
      big: { type: "STRING" }, question: { type: "STRING" }, answer: { type: "STRING" }, narration: { type: "STRING" }
    }, required: ["layout", "heading", "narration"] } }
  },
  required: ["title", "scenes"]
};
const VIDEO_PROMPT = `Escribe el guion de una VIDEO-LECCIÓN para repasar estos apuntes, de 6 a 10 escenas, variada y visual. Cada escena tiene un tipo ("layout"):
- "portada": la primera. "heading" es el tema y "points" una sola frase gancho.
- "lista": "heading" y de 2 a 4 "points" cortos.
- "definicion": "term" es un concepto clave y "definition" su definición en una frase.
- "comparacion": compara dos cosas con "left_title"/"left_points" y "right_title"/"right_points" (2 o 3 puntos por lado).
- "dato": "big" es un número, fecha o dato muy corto (máximo 12 caracteres) y "points" una frase que lo explique.
- "pregunta": "question" es una pregunta para que Erika piense y "answer" la respuesta corta. Pon una o dos a mitad del vídeo.
- "resumen": la última. "heading" y 3 "points" con lo que no puede olvidar.
Usa al menos 4 tipos distintos. "icon" es UN emoji que represente la escena. Los textos en pantalla tienen como mucho 10 palabras.
"narration" es lo que dice el profesor en voz alta: 2 a 4 frases naturales y cercanas, como si se lo explicaras a una amiga, con algún ejemplo. En las preguntas, la narración plantea la pregunta, dice algo como «piénsalo un momento» y luego da la respuesta. La narración no lleva emojis, símbolos ni Markdown.`;
const PODCAST_PROMPT = "Escribe el guion de una EXPLICACIÓN EN AUDIO de estos apuntes, de unos 3 minutos (entre 350 y 500 palabras), como un profesor cercano que se lo cuenta a Erika. Empieza diciendo en una frase de qué va el tema, explica las ideas en orden y con ejemplos o comparaciones de la vida diaria, y termina con un repaso de las 3 ideas clave y una pregunta para que piense. Es para escuchar, no para leer: frases cortas, sin títulos, viñetas, listas, símbolos, emojis ni Markdown. No inventes datos que no estén en los apuntes.";
const CHAT_SYSTEM = TEACHER + " Responde a las dudas de Erika sobre sus apuntes de forma clara y breve (normalmente menos de 150 palabras), con ejemplos cuando ayuden y **negrita** en los términos clave. Usa Markdown sencillo. Si la respuesta no está en los apuntes, dilo y luego responde con conocimiento general, avisando de que no viene en sus apuntes.";
const CHAT_SUGGESTIONS = ["¿Qué es lo más importante para el examen?", "Explícamelo como si tuviera 10 años", "Ponme un ejemplo", "¿Qué me pueden preguntar de esto?"];

// ---------- Estado ----------
let subjects = [], notes = [], current = "all", openId = null;
let mode = "note"; // note | review | exam
let view = "apunte"; // pestaña del apunte abierto
let busy = null; // { id, what, partial, retry }
let lastError = null; // { id, what, msg }
let sumMode = ls.get("resumen-defecto") || "corto", quizCount = +ls.get("preguntas-defecto") || 10, cardCount = 15, mapMode = "mapa";
let confirming = false, editing = false, subjMode = null, query = "";
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
  c.seen = true;
  if (g === 0) { c.reps = 0; c.interval = 0; c.ease = Math.max(1.3, c.ease - 0.2); c.due = Date.now(); return; }
  if (g === 1) c.ease = Math.max(1.3, c.ease - 0.15);
  if (g === 3) c.ease += 0.15;
  c.interval = iv[g]; c.reps++; c.due = Date.now() + c.interval * DAY;
}
const isNew = (c) => !c.seen && c.reps === 0;
const todayStr = () => new Date().toDateString();
const readJSON = (k, def) => { try { return JSON.parse(ls.get(k)) ?? def; } catch (e) { return def; } };
function newToday() { const o = readJSON("nuevas-hoy", {}); return o.d === todayStr() ? o.n : 0; }
function bumpNewToday() { ls.set("nuevas-hoy", JSON.stringify({ d: todayStr(), n: newToday() + 1 })); }
const newLimit = () => { const v = ls.get("nuevas-dia"); return v === null ? 20 : +v; }; // 0 = sin límite
// Lo que toca repasar hoy: las ya vistas que vencen y, como mucho, el límite diario de nuevas.
function reviewQueue(scopeNotes) {
  const lim = endOfToday(), old = [], fresh = [];
  for (const n of scopeNotes) for (const c of n.cards || []) if (c.due <= lim) (isNew(c) ? fresh : old).push({ noteId: n.id, cardId: c.id });
  const room = newLimit() ? Math.max(0, newLimit() - newToday()) : Infinity;
  return [...shuffle(old), ...fresh.slice(0, room)];
}
function markStudyDay() {
  const days = readJSON("dias-repaso", []), t = todayStr();
  if (days[days.length - 1] !== t) { days.push(t); ls.set("dias-repaso", JSON.stringify(days.slice(-400))); }
}
function streak() {
  const days = new Set(readJSON("dias-repaso", []));
  const d = new Date(); if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  let k = 0; while (days.has(d.toDateString())) { k++; d.setDate(d.getDate() - 1); }
  return k;
}
function cardStats(cards) {
  let nw = 0, lr = 0, ms = 0;
  for (const c of cards) { if (isNew(c)) nw++; else if (c.interval >= 21) ms++; else lr++; }
  return { nw, lr, ms };
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
  v: 2,
  title: "La célula en dos minutos",
  scenes: [
    { anim: "portada", emoji: "🔬", title: "La célula", items: [{ emoji: "🧱", label: "Qué es", cue: "pieza" }, { emoji: "⚖️", label: "Sus tipos", cue: "tipos" }, { emoji: "⚙️", label: "Sus órganos", cue: "órganos" }],
      narration: "Hoy repasamos la célula, la pieza más pequeña de la que está hecho cualquier ser vivo. Veremos sus tipos y los pequeños órganos que tiene dentro." },
    { anim: "definicion", emoji: "🧱", title: "Célula", items: [{ emoji: "🧬", label: "Unidad básica de la vida", cue: "unidad" }, { emoji: "🏠", label: "Como los ladrillos", cue: "ladrillos" }, { emoji: "🧍", label: "Forman tu cuerpo", cue: "cuerpo" }],
      narration: "Una célula es la unidad básica de la vida. Igual que una casa está hecha de ladrillos, tu cuerpo está hecho de células." },
    { anim: "comparar", emoji: "⚖️", title: "Dos tipos de célula", left_title: "Procariota", right_title: "Eucariota",
      items: [{ emoji: "🚫", label: "Sin núcleo", side: "izquierda", cue: "procariotas" }, { emoji: "🦠", label: "Bacterias", side: "izquierda", cue: "bacterias" }, { emoji: "🟣", label: "Con núcleo", side: "derecha", cue: "eucariotas" }, { emoji: "🐶", label: "Animales y plantas", side: "derecha", cue: "animales" }],
      narration: "Hay dos grandes tipos. Las procariotas no tienen núcleo definido, como las bacterias. Las eucariotas sí lo tienen, como las de animales y plantas." },
    { anim: "partes", emoji: "🧫", title: "Dentro de la célula", items: [{ emoji: "🧠", label: "Núcleo", text: "Guarda el ADN", cue: "núcleo" }, { emoji: "⚡", label: "Mitocondria", text: "Da energía", cue: "mitocondria" }, { emoji: "🏭", label: "Ribosoma", text: "Fabrica proteínas", cue: "ribosomas" }, { emoji: "🌿", label: "Cloroplasto", text: "Fotosíntesis", cue: "cloroplasto" }],
      narration: "Dentro de la célula hay pequeños órganos. El núcleo guarda el ADN y lo dirige todo. La mitocondria da energía. Los ribosomas fabrican proteínas. Y el cloroplasto, solo en las plantas, hace la fotosíntesis." },
    { anim: "escena", emoji: "🌱", title: "La fotosíntesis en acción", items: [{ emoji: "☀️", label: "Luz del sol", action: "brilla", to: 2, cue: "sol" }, { emoji: "💧", label: "Agua", action: "sube", to: 2, cue: "agua" }, { emoji: "🌱", label: "Planta", action: "crece", to: 4, cue: "planta" }, { emoji: "🍬", label: "Azúcar", action: "late", cue: "azúcar" }, { emoji: "🫧", label: "Oxígeno", action: "sube", cue: "oxígeno" }],
      narration: "Mira la fotosíntesis en acción. La luz del sol y el agua llegan a la planta. En el cloroplasto, la planta fabrica azúcar para alimentarse y suelta oxígeno al aire." },
    { anim: "proceso", emoji: "⚡", title: "Cómo consigues energía", items: [{ emoji: "🍎", label: "Glucosa", text: "De lo que comes", cue: "glucosa" }, { emoji: "⚡", label: "Mitocondria", cue: "mitocondria" }, { emoji: "🔋", label: "ATP", text: "La pila de la célula", cue: "ATP" }, { emoji: "🏃", label: "Energía para vivir", cue: "moverte" }],
      narration: "Y así consigues energía. La glucosa de lo que comes llega a la mitocondria, que la convierte en ATP, la pila de la célula. Con esa energía puedes moverte, pensar y vivir." },
    { anim: "pregunta", emoji: "🤔", title: "Piensa", question: "¿Dónde se hace la fotosíntesis?", answer: "En el cloroplasto",
      narration: "Una pregunta. ¿Dónde se hace la fotosíntesis? Piénsalo un momento. Exacto: en el cloroplasto, que solo tienen las células vegetales." },
    { anim: "resumen", emoji: "✅", title: "Lo que no puedes olvidar", items: [{ emoji: "🦠", label: "Procariota sin núcleo", cue: "procariota" }, { emoji: "⚡", label: "Mitocondria: energía", cue: "mitocondria" }, { emoji: "🌿", label: "Cloroplasto: solo plantas", cue: "cloroplasto" }],
      narration: "Para el examen: procariota sin núcleo y eucariota con núcleo, la mitocondria da energía, y el cloroplasto solo está en las plantas." }
  ]
};
const EXAMPLE_PODCAST = "Hola, Erika. Hoy vamos a hablar de la célula, que es la unidad básica de la vida. Piensa en un edificio: está hecho de ladrillos. Pues todos los seres vivos están hechos de células, ya sea una sola, como una bacteria, o millones, como tú. Hay dos tipos. Las procariotas no tienen un núcleo definido; las bacterias son el ejemplo típico. Las eucariotas sí tienen núcleo, rodeado de una membrana, y son las de animales y plantas. Dentro de la célula hay pequeños órganos con trabajos distintos. La mitocondria es la central de energía: fabrica ATP mediante la respiración celular. El cloroplasto hace la fotosíntesis, pero solo está en las células vegetales. Los ribosomas fabrican proteínas. Y el núcleo guarda el ADN y dirige todo. Repasemos lo clave: procariota sin núcleo y eucariota con núcleo; la mitocondria da energía; y el cloroplasto solo aparece en las plantas. Y una pregunta para pensar: ¿por qué crees que nuestras células no necesitan cloroplastos?";
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
  if (!n.video || !n.video.script.scenes[0].anim) { n.video = { script: EXAMPLE_VIDEO, at: Date.now() }; changed = true; }
  if (!n.podcast) { n.podcast = { text: EXAMPLE_PODCAST, at: Date.now() }; changed = true; }
  if (!n.cards) { n.cards = EXAMPLE_CARDS.map(([f, b]) => newCard(f, b)); changed = true; }
  if (/\.txt$/.test(n.name)) { n.name = baseName(n.name); changed = true; }
  if (changed) await put("notes", n);
}

// ---------- Cabecera, bienvenida y ajustes ----------
function renderTop() {
  const has = !!ls.get("gemini-key");
  $("keydot").classList.toggle("on", has);
  const due = reviewQueue(notes).length;
  $("duecount").textContent = due;
  $("reviewbtn").setAttribute("aria-label", `Repasar: ${due} tarjeta${due === 1 ? "" : "s"} para hoy`);
  $("keystatus").textContent = has ? "Conectada: hay una clave guardada en este móvil." : "Todavía no hay ninguna clave guardada. Sin ella se pueden ver los apuntes, pero no crear resúmenes ni tests nuevos.";
  $("keylink").disabled = !has && !syncCfg(); $("keyforget").disabled = !has;
  $("keysteps").hidden = has;
  $("welcome").hidden = !!ls.get("bienvenida-vista");
  $("welcomekey").textContent = has ? "Ya está todo conectado. ¡A estudiar!" : "Falta conectar Gemini. Copia el enlace que te han mandado por WhatsApp y pulsa «Pegar enlace».";
  $("pastekey").hidden = has; $("pastekey2").hidden = has;
  const last = +ls.get("ultima-copia") || 0;
  $("backupstatus").textContent = last ? `Última copia: ${new Date(last).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" })}.` : "Todavía no has guardado ninguna copia.";
  const own = notes.filter(n => !n.example).length;
  const snooze = +ls.get("aviso-copia-luego") || 0;
  const show = own >= 3 && Date.now() - last > 14 * DAY && Date.now() > snooze;
  $("backupbanner").hidden = !show;
  renderSugBadge();
  if (show) $("backuptext").textContent = last ? `Hace ${Math.floor((Date.now() - last) / DAY)} días que no guardas una copia de tus apuntes.` : "Ya tienes varios apuntes: guarda una copia por si cambias de móvil.";
  renderToday();
}
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = () => navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
function renderNotice() {
  const box = $("notice");
  let msg = "";
  if (/WhatsApp|Instagram|FBAN|FBAV|FB_IAB|Line\/|; wv\)/.test(navigator.userAgent)) msg = "Estás dentro del navegador de WhatsApp (o de otra app) y aquí no se guarda nada. Toca el menú ⋮ o el botón de compartir y elige «Abrir en Chrome» o «Abrir en Safari».";
  else if (!db) msg = "Este navegador no deja guardar datos (¿modo incógnito?). Lo que subas se perderá al cerrar. Ábrela en una ventana normal.";
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

// ---------- Fondo personalizable con motivos de estudio ----------
// Cada dibujo es un azulejo SVG que se repite; el color y el tamaño se eligen en Ajustes.
const PATTERNS = {
  ninguno: { label: "Liso", tile: 0 },
  rayas: { label: "Cuaderno", tile: 32, svg: (c) => `<path d='M0 31.5H32' stroke='${c}' stroke-width='1'/>` },
  cuadricula: { label: "Cuadrícula", tile: 24, svg: (c) => `<path d='M23.5 0V24M0 23.5H24' stroke='${c}' stroke-width='1' fill='none'/>` },
  milimetrado: { label: "Milimetrado", tile: 50, svg: (c) => `<path d='${[10, 20, 30, 40].map(k => `M${k} 0V50M0 ${k}H50`).join("")}' stroke='${c}' stroke-width='.5' opacity='.6'/><path d='M49.5 0V50M0 49.5H50' stroke='${c}' stroke-width='1.2'/>` },
  puntos: { label: "Puntos", tile: 22, svg: (c) => `<circle cx='11' cy='11' r='1.5' fill='${c}'/>` },
  formulas: { label: "Fórmulas", tile: 300, svg: (c) => {
    const t = [["π", 20, 40, -12, 30], ["E=mc²", 150, 30, 6, 20], ["√x", 250, 80, -8, 24], ["∑", 70, 120, 10, 34], ["H₂O", 190, 140, -6, 20], ["∫ f(x)dx", 20, 210, 4, 18], ["Δ", 250, 220, 0, 28], ["α+β", 140, 250, -10, 20], ["x²", 100, 60, 8, 22], ["∞", 230, 285, 0, 26], ["%", 40, 280, 0, 22]];
    return t.map(([s, x, y, r, f]) => `<text x='${x}' y='${y}' font-size='${f}' font-family='Georgia,serif' fill='${c}' transform='rotate(${r} ${x} ${y})'>${s}</text>`).join("") +
      `<g transform='translate(105 185)' fill='none' stroke='${c}' stroke-width='1.6'><ellipse rx='22' ry='8'/><ellipse rx='22' ry='8' transform='rotate(60)'/><ellipse rx='22' ry='8' transform='rotate(-60)'/><circle r='2.5' fill='${c}'/></g>`;
  } },
  iconos: { label: "Material", tile: 240, svg: (c) => {
    const g = (x, y, r, d) => `<g transform='translate(${x} ${y}) rotate(${r})' fill='none' stroke='${c}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${d}</g>`;
    return g(20, 20, -8, "<path d='M0 4c8-4 16-4 22 1v26c-6-5-14-5-22-1zM44 4c-8-4-16-4-22 1v26c6-5 14-5 22-1z'/>") + // libro
      g(150, 18, 35, "<path d='M0 0h8v40l-4 8-4-8zM0 8h8'/>") + // lápiz
      g(95, 95, 0, "<path d='M12 0a12 12 0 0 0-7 22v6h14v-6A12 12 0 0 0 12 0zM6 32h12M8 36h8'/>") + // bombilla
      g(185, 110, -6, "<path d='M0 10 22 0l22 10-22 10zM8 14v10c8 6 20 6 28 0V14M44 10v14'/>") + // birrete
      g(25, 150, 10, "<path d='M8 0h12M11 0v14L2 34c-1 3 1 5 4 5h16c3 0 5-2 4-5l-9-20V0M6 26h16'/>") + // matraz
      g(140, 180, -12, "<path d='M0 0h44v12H0zM8 0v5M16 0v7M24 0v5M32 0v7M40 0v5'/>") + // regla
      g(210, 205, 0, "<path d='m10 0 3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z'/>") + // estrella
      g(85, 210, -20, "<circle cx='9' cy='9' r='8'/><circle cx='29' cy='9' r='8'/><path d='M17 9h4'/>"); // gafas
  } },
  estrellas: { label: "Estrellas", tile: 160, svg: (c) => [[20, 30, 1.6], [90, 15, 1], [140, 60, 1.8], [60, 80, 1.1], [120, 120, 1.4], [30, 130, 1], [80, 150, 1.7], [150, 145, .9]].map(([x, y, r]) => `<circle cx='${x}' cy='${y}' r='${r}' fill='${c}'/>`).join("") + `<path d='M100 40l2 5 5 2-5 2-2 5-2-5-5-2 5-2z' fill='${c}'/>` },
  corazones: { label: "Corazones", tile: 90, svg: (c) => `<path d='M22 30c-6-5-10-8-10-13a5 5 0 0 1 10-2 5 5 0 0 1 10 2c0 5-4 8-10 13z' fill='none' stroke='${c}' stroke-width='1.6'/><path d='M67 75c-4-3-7-6-7-9a3.5 3.5 0 0 1 7-1.5 3.5 3.5 0 0 1 7 1.5c0 3-3 6-7 9z' fill='${c}'/>` }
};
const BG_PRESETS = {
  clasico: { label: "Clásico" },
  cuaderno: { label: "Cuaderno", color: "#fbf8f0", pattern: "rayas", patColor: "#8fb3e8", opacity: 0.55 },
  milimetrado: { label: "Papel milimetrado", color: "#f3f8f4", pattern: "milimetrado", patColor: "#7fb89a", opacity: 0.45 },
  bullet: { label: "Bullet journal", color: "#f7f3ee", pattern: "puntos", patColor: "#9a8f80", opacity: 0.6 },
  pizarra: { label: "Pizarra", color: "#28392f", pattern: "formulas", patColor: "#ffffff", opacity: 0.14 },
  ciencias: { label: "Ciencias", color: "#eef3ff", color2: "#f6efff", pattern: "formulas", patColor: "#5b6fd6", opacity: 0.16 },
  material: { label: "Material escolar", color: "#fff7ec", pattern: "iconos", patColor: "#e08a3c", opacity: 0.22 },
  noche: { label: "Noche de estudio", color: "#141a33", color2: "#2b1f4d", pattern: "estrellas", patColor: "#ffe9a8", opacity: 0.55 },
  rosa: { label: "Rosa", color: "#fdf0f5", color2: "#fff6ec", pattern: "corazones", patColor: "#e0709a", opacity: 0.25 }
};
const bgCfg = () => readJSON("fondo", {});
function setBg(patch) { ls.set("fondo", JSON.stringify({ ...bgCfg(), ...patch })); applyPrefs(); }
const lum = (hex) => {
  const m = /^#?([\da-f]{6})$/i.exec(hex || ""); if (!m) return 1;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const mix = (a, b, t) => { // mezcla dos colores hex
  const p = (h) => [0, 2, 4].map(i => parseInt(h.replace("#", "").slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
};
function patternURL(name, color, scale = 1) {
  const p = PATTERNS[name]; if (!p || !p.tile) return null;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${p.tile}' height='${p.tile}' viewBox='0 0 ${p.tile} ${p.tile}'>${p.svg(color)}</svg>`;
  return { url: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, size: Math.round(p.tile * scale) };
}
function applyBg() {
  const b = bgCfg();
  let fx = $("bgfx");
  if (!fx) { fx = document.createElement("div"); fx.id = "bgfx"; fx.setAttribute("aria-hidden", "true"); fx.innerHTML = `<div class="photo"></div><div class="veil"></div><div class="pat"></div>`; document.body.prepend(fx); }
  const photo = ls.get("fondo-foto");
  const custom = !!(b.color || photo);
  fx.hidden = !custom && (!b.pattern || b.pattern === "ninguno");
  // Con un fondo propio, el tema claro u oscuro lo decide el fondo para que siempre se lea bien.
  const darkBg = b.color ? (lum(b.color) + lum(b.color2 || b.color)) / 2 < 0.18 : null;
  fx.style.background = b.color ? (b.color2 ? `linear-gradient(${b.angle ?? 160}deg, ${b.color}, ${b.color2})` : b.color) : "var(--paper)";
  const ph = fx.querySelector(".photo"), veil = fx.querySelector(".veil"), pat = fx.querySelector(".pat");
  ph.style.backgroundImage = photo ? `url("${photo}")` : "none";
  ph.style.filter = photo && b.blur ? `blur(${b.blur}px)` : "none";
  veil.style.opacity = photo ? (b.veil ?? 0.55) : 0;
  const pc = b.patColor || (darkBg ? "#ffffff" : getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2b4fd8");
  const pu = patternURL(b.pattern, pc, b.size || 1);
  pat.style.backgroundImage = pu ? pu.url : "none";
  pat.style.backgroundSize = pu ? `${pu.size}px ${pu.size}px` : "";
  pat.style.opacity = b.opacity ?? 0.3;
  document.documentElement.classList.toggle("glass", b.panels === "cristal");
  document.documentElement.classList.toggle("hasbg", !fx.hidden);
  return darkBg;
}
async function setBgPhoto(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    ls.set("fondo-foto", cv.toDataURL("image/jpeg", 0.8));
    if (!ls.get("fondo-foto")) throw new Error();
    applyPrefs(); renderPrefs(); toast("Foto de fondo puesta");
  } catch (e) { toast("No se pudo usar esa foto. Prueba con otra."); }
}
function bgPrefsHtml() {
  const b = bgCfg(), photo = ls.get("fondo-foto");
  const active = Object.entries(BG_PRESETS).find(([, p]) => p.color === b.color && p.pattern === b.pattern && (p.color2 || null) === (b.color2 || null))?.[0] || (!b.color && !b.pattern ? "clasico" : null);
  const prev = (p) => { const pu = patternURL(p.pattern, p.patColor || "#2b4fd8", 0.6); return `background:${p.color2 ? `linear-gradient(160deg,${p.color},${p.color2})` : p.color || "var(--paper)"};${pu ? `--pat:${pu.url};--patsize:${pu.size}px;--patop:${Math.min(1, (p.opacity || .3) * 1.6)}` : ""}`; };
  const pc = b.patColor || "#2b4fd8";
  return `
    <p class="note">Fondos listos</p>
    <div class="bgpresets">${Object.entries(BG_PRESETS).map(([k, p]) => `<button class="bgp" data-bgpreset="${k}" aria-pressed="${active === k}"><span class="sw" style="${esc(prev(p))}"></span>${p.label}</button>`).join("")}</div>
    <details class="bgcustom" ${ls.get("fondo-abierto") === "1" ? "open" : ""}><summary>Personalizar el fondo a tu gusto</summary>
      <div class="stack" style="margin-top:10px">
        <div class="row wrap"><button class="small cpinline" data-cpick="bg.color"><span style="background:${esc(b.color || "#f6f8fb")}"></span>Color</button>
          ${b.color2 ? `<button class="small cpinline" data-cpick="bg.color2"><span style="background:${esc(b.color2)}"></span>Segundo color</button>` : ""}
          <button class="small ghost" id="bggrad">${b.color2 ? "Quitar degradado" : "Añadir degradado"}</button></div>
        ${b.color2 ? `<label class="note" for="bgangle">Dirección del degradado</label><input type="range" id="bgangle" min="0" max="360" step="15" value="${b.angle ?? 160}">` : ""}
        <p class="note">Dibujo</p>
        <div class="bgpats">${Object.entries(PATTERNS).map(([k, p]) => { const pu = patternURL(k, pc, 0.5); return `<button class="bgpat" data-bgpat="${k}" aria-pressed="${(b.pattern || "ninguno") === k}"><span class="sw" style="${pu ? esc(`--pat:${pu.url};--patsize:${pu.size}px;--patop:1`) : ""}"></span>${p.label}</button>`; }).join("")}</div>
        ${b.pattern && b.pattern !== "ninguno" ? `
          <div class="row"><button class="small cpinline" data-cpick="bg.patColor"><span style="background:${esc(pc)}"></span>Color del dibujo</button></div>
          <label class="note" for="bgopacity">Intensidad</label><input type="range" id="bgopacity" min="0.05" max="1" step="0.05" value="${b.opacity ?? 0.3}">
          <label class="note" for="bgsize">Tamaño</label><input type="range" id="bgsize" min="0.5" max="2.5" step="0.1" value="${b.size || 1}">` : ""}
        <p class="note">Foto propia de fondo</p>
        <div class="actions"><label class="btn small" for="bgphoto">${photo ? "Cambiar foto" : "Elegir foto"}</label><input type="file" id="bgphoto" accept="image/*" hidden>
          ${photo ? `<button class="small ghost" id="bgphotodel">Quitar foto</button>` : ""}</div>
        ${photo ? `<label class="note" for="bgveil">Velo para que se lea bien</label><input type="range" id="bgveil" min="0" max="0.9" step="0.05" value="${b.veil ?? 0.55}">
          <label class="note" for="bgblur">Desenfoque</label><input type="range" id="bgblur" min="0" max="20" step="1" value="${b.blur || 0}">` : ""}
        <p class="note">Paneles</p><div class="actions">
          <button class="tab small" data-bgpanels="solidos" aria-pressed="${b.panels !== "cristal"}">Sólidos</button>
          <button class="tab small" data-bgpanels="cristal" aria-pressed="${b.panels === "cristal"}">Cristal (se ve el fondo)</button></div>
        <div class="actions"><button class="small ghost" id="bgreset">Volver al fondo normal</button></div>
      </div>
    </details>`;
}

// ---------- Selector de color propio (igual en todos los móviles y ordenadores) ----------
const hexOk = (h) => /^#[\da-f]{6}$/i.test(h || "");
function hexToHsl(hex) {
  let [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = Math.round(h * 60); if (h < 0) h += 360;
  }
  return [h, Math.round(s * 100), Math.round(l * 100)];
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, "0");
  return "#" + f(0) + f(8) + f(4);
}
const PICK_SWATCHES = [0, 20, 40, 55, 90, 140, 170, 195, 215, 250, 275, 300, 330, 350]
  .flatMap(h => [[h, 85, 88], [h, 70, 70], [h, 70, 50], [h, 75, 32]].map(a => hslToHex(...a)))
  .concat(["#ffffff", "#f6f8fb", "#e6e6e6", "#bdbdbd", "#8a8a8a", "#5a5a5a", "#2e2e2e", "#141414", "#000000", "#fff8e7", "#f5ecd7", "#1d2a44"]);
const cpick = { key: null, val: "#2b4fd8", hsl: [0, 0, 0] };
// Cada color que se puede elegir: de dónde se lee, dónde se guarda y cómo se quita.
function cpickTarget(key) {
  if (key === "accent") return { title: "Color principal", get: () => ls.get("color-propio") || accentSet()[1], set: (v) => { ls.set("color", "propio"); ls.set("color-propio", v); applyPrefs(); }, reset: () => { ls.set("color", "azul"); applyPrefs(); } };
  if (key.startsWith("bg.")) {
    const f = key.slice(3), def = { color: "#f6f8fb", color2: "#e9ddff", patColor: "#2b4fd8" }[f];
    return { title: { color: "Color del fondo", color2: "Segundo color del degradado", patColor: "Color del dibujo" }[f], get: () => bgCfg()[f] || (f === "color2" ? bgCfg().color : null) || def,
      set: (v) => setBg(f === "color2" && !bgCfg().color ? { color: "#f6f8fb", color2: v } : { [f]: v }), reset: () => setBg({ [f]: null }) };
  }
  if (key.startsWith("c.")) {
    const t = key.slice(2), p = PARTS.find(x => x[0] === t);
    return { title: p[1], get: () => partColors()[t] || getComputedStyle(document.documentElement).getPropertyValue("--" + p[3]).trim() || "#888888",
      set: (v) => setPartColor(t, v), reset: () => setPartColor(t, null) };
  }
  return null;
}
function openColorPicker(key) {
  const tg = cpickTarget(key); if (!tg) return;
  let v = String(tg.get() || "").trim(); if (!hexOk(v)) v = "#2b4fd8";
  cpick.key = key; cpick.val = v.toLowerCase(); cpick.hsl = hexToHsl(cpick.val);
  let box = $("cpick");
  if (!box) { box = document.createElement("div"); box.id = "cpick"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); document.body.appendChild(box); }
  box.innerHTML = `<div class="cpsheet">
    <div class="cphead"><span class="cpprev" id="cpprev"></span><div><b>${esc(tg.title)}</b><input id="cphex" value="${cpick.val}" maxlength="7" aria-label="Código del color" spellcheck="false" autocomplete="off"></div></div>
    <div class="cpgrid">${PICK_SWATCHES.map(h => `<button class="cpsw" data-cpv="${h}" style="--c:${h}" aria-label="${h}"></button>`).join("")}</div>
    <label class="note" for="cph">Tono</label><input type="range" id="cph" min="0" max="359">
    <label class="note" for="cps">Intensidad</label><input type="range" id="cps" min="0" max="100">
    <label class="note" for="cpl">Claro / oscuro</label><input type="range" id="cpl" min="0" max="100">
    <div class="actions"><button class="ghost" id="cpreset">Quitar</button><button class="primary" id="cpok">Listo</button></div>
  </div>`;
  box.hidden = false; document.documentElement.classList.add("lbopen");
  cpPaint(false);
}
function cpPaint(apply = true) {
  const [h, s, l] = cpick.hsl, v = cpick.val;
  $("cpprev").style.background = v;
  if (document.activeElement?.id !== "cphex") $("cphex").value = v;
  $("cph").value = h; $("cps").value = s; $("cpl").value = l;
  $("cph").style.background = `linear-gradient(90deg, ${[0, 60, 120, 180, 240, 300, 360].map(x => hslToHex(x % 360, Math.max(s, 40), 50)).join(",")})`;
  $("cps").style.background = `linear-gradient(90deg, ${hslToHex(h, 0, l)}, ${hslToHex(h, 100, Math.min(Math.max(l, 25), 75))})`;
  $("cpl").style.background = `linear-gradient(90deg, #000, ${hslToHex(h, s, 50)}, #fff)`;
  document.querySelectorAll(".cpsw").forEach(b => b.setAttribute("aria-pressed", b.dataset.cpv === v));
  if (apply) cpickTarget(cpick.key)?.set(v);
}
function cpSet(v, fromHsl) { cpick.val = v.toLowerCase(); if (!fromHsl) cpick.hsl = hexToHsl(cpick.val); cpPaint(); }
function closeColorPicker() { const b = $("cpick"); if (!b || b.hidden) return; b.hidden = true; document.documentElement.classList.remove("lbopen"); cpick.key = null; renderPrefs(); }

let cpDownOnBackdrop = false;
document.addEventListener("pointerdown", (e) => { cpDownOnBackdrop = e.target.id === "cpick"; }, true);

// ---------- Colores de cada parte de la app ----------
// [clave, nombre, explicación, variable CSS]
const PARTS = [
  ["sheet", "Recuadros", "Las tarjetas y cajas grandes (apuntes, Hoy, Ajustes…)", "sheet"],
  ["box", "Cajitas de texto", "El fondo detrás de los textos: subtítulos, audio, chat, datos…", "box"],
  ["ink", "Texto", "El color de las letras", "ink"],
  ["inksoft", "Texto secundario", "Fechas, notas y explicaciones pequeñas", "ink-soft"],
  ["line", "Bordes", "Las líneas de alrededor de los recuadros", "line"],
  ["marker", "Subrayado", "El rotulador del título", "marker"],
  ["ok", "Aciertos", "Respuestas bien y cosas hechas", "ok"],
  ["danger", "Fallos", "Respuestas mal y botón de borrar", "danger"],
  ["video", "Vídeos", "El color de las escenas de los vídeos", "video"]
];
const PALETTES = {
  clasica: ["Clásica", {}],
  pastel: ["Pastel lila", { sheet: "#fbf8ff", box: "#f1eafc", ink: "#2e2346", inksoft: "#6f6390", line: "#e2d6f5", marker: "#ffc6e3", accent: "#7a4fd6", video: "#7a4fd6" }],
  menta: ["Menta", { sheet: "#f8fffb", box: "#e6f6ee", ink: "#18392b", inksoft: "#4f7565", line: "#cfe9dc", marker: "#b8f0d0", accent: "#1f8a5b", video: "#1f8a5b" }],
  melocoton: ["Melocotón", { sheet: "#fffaf5", box: "#ffeede", ink: "#3d2516", inksoft: "#8a6550", line: "#f6dcc6", marker: "#ffd59e", accent: "#d0612a", video: "#d0612a" }],
  cielo: ["Cielo", { sheet: "#f7fbff", box: "#e3f1ff", ink: "#12304d", inksoft: "#4f6f8f", line: "#cfe3f6", marker: "#bfe3ff", accent: "#1677c9", video: "#1677c9" }],
  noche: ["Noche", { sheet: "#1d2233", box: "#262c42", ink: "#eef0fa", inksoft: "#a7aeca", line: "#353d59", marker: "#6b5bc4", accent: "#9b8cff", video: "#5a48d6" }],
  contraste: ["Alto contraste", { sheet: "#ffffff", box: "#ffffff", ink: "#000000", inksoft: "#262626", line: "#000000", marker: "#ffe100", accent: "#0040c0", ok: "#006b2e", danger: "#b00000" }]
};
const partColors = () => readJSON("colores", {});
function setPartColor(k, v) { const c = partColors(); if (v) c[k] = v; else delete c[k]; ls.set("colores", JSON.stringify(c)); applyPrefs(); }
function applyPalette(id) {
  const [, p] = PALETTES[id] || PALETTES.clasica;
  const { accent, ...rest } = p;
  ls.set("colores", JSON.stringify(rest));
  if (accent) { ls.set("color", "propio"); ls.set("color-propio", accent); } else if (ls.get("color") === "propio") ls.set("color", "azul");
  applyPrefs(); renderPrefs(); toast("Colores cambiados");
}
// Si se cambia el color de los recuadros y no el del texto, el texto se pone claro u oscuro solo para que se lea.
function partsCss() {
  const c = partColors(), v = [];
  for (const [k, , , css] of PARTS) if (hexOk(c[k]) && k !== "video") v.push(`--${css}:${c[k]}`);
  const darkSheet = hexOk(c.sheet) ? lum(c.sheet) < 0.2 : null;
  if (darkSheet !== null) {
    if (!hexOk(c.ink)) v.push(`--ink:${darkSheet ? "#eef1f7" : "#1d2a44"}`);
    if (!hexOk(c.inksoft)) v.push(`--ink-soft:${darkSheet ? "#a9b2c7" : "#5a6684"}`);
    if (!hexOk(c.line)) v.push(`--line:${mix(c.sheet, darkSheet ? "#ffffff" : "#000000", 0.14)}`);
    if (!hexOk(c.box)) v.push(`--box:${mix(c.sheet, darkSheet ? "#ffffff" : "#000000", 0.05)}`);
    v.push(`color-scheme:${darkSheet ? "dark" : "light"}`);
    if (!bgCfg().color && !ls.get("fondo-foto")) v.push(`--paper:${mix(c.sheet, darkSheet ? "#000000" : "#8090a8", darkSheet ? 0.35 : 0.08)}`);
  }
  let css = v.length ? `html:root:root{${v.join(";")}}` : "";
  // Las letras que van directamente sobre el fondo (título, «Todos los apuntes»…) se leen según el fondo, no según los recuadros.
  const b = bgCfg();
  const pageDark = b.color ? (lum(b.color) + lum(b.color2 || b.color)) / 2 < 0.18 : darkSheet;
  if (pageDark !== null && darkSheet !== null && pageDark !== darkSheet) {
    const ink = (d) => d ? ["#eef1f7", "#c3cad9"] : ["#1d2a44", "#4a5570"];
    const [pi, ps] = ink(pageDark), [si, ss] = hexOk(c.ink) ? [c.ink, hexOk(c.inksoft) ? c.inksoft : c.ink] : ink(darkSheet);
    css += `body{--ink:${pi};--ink-soft:${ps}}.panel,.viewer,.item,label.drop,.banner,.cpsheet,button,select,input,textarea{--ink:${si};--ink-soft:${ss}}`;
  }
  return css;
}
function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
function partsPrefsHtml() {
  const c = partColors(), cs = getComputedStyle(document.documentElement), cur = (css) => cs.getPropertyValue("--" + css).trim();
  const warn = hexOk(cur("ink")) && hexOk(cur("sheet")) && contrast(cur("ink"), cur("sheet")) < 3.5;
  return `
    <p class="note">Combinaciones listas</p>
    <div class="actions">${Object.entries(PALETTES).map(([k, [label, p]]) => `<button class="small palbtn" data-palette="${k}"><span class="pdots">${[p.sheet || "#ffffff", p.box || "#f6f8fb", p.accent || "#2b4fd8", p.ink || "#1d2a44"].map(x => `<i style="background:${x}"></i>`).join("")}</span>${label}</button>`).join("")}</div>
    <p class="note">O cambia cada parte por separado:</p>
    <div class="parts">${PARTS.map(([k, label, help, css]) => {
      const val = c[k] || (k === "video" ? "" : cur(css));
      return `<div class="part"><button class="cpbtn" data-cpick="c.${k}" aria-label="Cambiar color: ${esc(label)}"><span style="background:${esc(val || "linear-gradient(135deg,#2b4fd8,#8a3fd1,#138a7a,#c2456a)")}"></span></button>
        <div><b>${esc(label)}</b><span class="note">${esc(help)}${k === "video" && !c.video ? " (ahora: variados)" : ""}</span></div>
        ${c[k] ? `<button class="small ghost" data-cpreset="${k}" aria-label="Quitar color de ${esc(label)}">↺</button>` : ""}</div>`;
    }).join("")}</div>
    ${warn ? `<p class="note errtext">Ojo: con estos colores el texto se lee mal. Toca «Texto» y elige uno más claro u oscuro, o pulsa ↺.</p>` : ""}
    ${Object.keys(c).length ? `<div class="actions"><button class="small ghost" data-palette="clasica">Volver a los colores normales</button></div>` : ""}`;
}

// ---------- Ajustes personales: color, tema, letra, voz y estudio ----------
const COLORS = {
  azul: ["Azul", "#2b4fd8", "#e4eaff", "#7d97ff", "#232d55"],
  morado: ["Morado", "#6d3fd1", "#eee6ff", "#b195ff", "#2f2550"],
  rosa: ["Rosa", "#c2367a", "#fde4f0", "#ff8cc0", "#4a2236"],
  verde: ["Verde", "#1f7a4d", "#dff3e7", "#6fd6a0", "#183b2a"],
  naranja: ["Naranja", "#b85412", "#ffeadb", "#ffa564", "#45291a"],
  turquesa: ["Turquesa", "#0f7d8c", "#dcf3f5", "#5fd0de", "#173b40"]
};
function accentSet() {
  if (ls.get("color") === "propio") {
    const c = /^#[\da-f]{6}$/i.test(ls.get("color-propio") || "") ? ls.get("color-propio") : "#2b4fd8";
    // versión oscura legible sobre blanco y versión clara para el tema oscuro
    let la = c; while (lum(la) > 0.18) la = mix(la, "#000000", 0.08);
    let da = c; while (lum(da) < 0.35) da = mix(da, "#ffffff", 0.08);
    return [null, la, mix(la, "#ffffff", 0.88), da, mix(da, "#11161f", 0.75)];
  }
  return COLORS[ls.get("color")] || COLORS.azul;
}
function applyPrefs() {
  const [, la, lsoft, da, dsoft] = accentSet();
  let st = $("themevars");
  if (!st) { st = document.createElement("style"); st.id = "themevars"; document.head.appendChild(st); }
  st.textContent = `:root{--accent:${la};--accent-soft:${lsoft}}
    @media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--accent:${da};--accent-soft:${dsoft}}}
    :root[data-theme="dark"]{--accent:${da};--accent-soft:${dsoft}}` + partsCss();
  const tema = ls.get("tema") || "auto";
  if (tema === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = tema;
  const darkBg = applyBg();
  if (darkBg !== null) document.documentElement.dataset.theme = darkBg ? "dark" : "light";
  document.documentElement.style.fontSize = { normal: "100%", grande: "112.5%", enorme: "125%" }[ls.get("letra")] || "100%";
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = la;
}
function renderPrefs() {
  const box = $("prefs"); if (!box) return;
  const chip = (key, val, label, def) => `<button class="tab small" data-pref="${key}" data-val="${val}" aria-pressed="${(ls.get(key) ?? def) === String(val)}">${label}</button>`;
  const col = ls.get("color") || "azul";
  const allCards = notes.flatMap(n => n.cards || []), cs = cardStats(allCards);
  const tested = notes.filter(n => n.quizStats);
  const avg = tested.length ? (10 * tested.reduce((k, n) => k + n.quizStats.best / n.quizStats.total, 0) / tested.length).toFixed(1).replace(".", ",") : "–";
  const sk = streak();
  box.innerHTML = `
    <section><h3>Apariencia</h3>
      <p class="note">Color de la app</p>
      <div class="swatches">${Object.entries(COLORS).map(([k, v]) => `<button class="swatch" data-color="${k}" style="--sw:${v[1]}" aria-pressed="${k === col}"><span></span>${v[0]}</button>`).join("")}
        <button class="swatch anycolor" data-cpick="accent" aria-pressed="${col === "propio"}" style="--sw:${esc(col === "propio" ? ls.get("color-propio") : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)")}"><span></span>El que quieras</button></div>
      <p class="note">Tema</p>${bgCfg().color ? `<p class="note">Con un fondo de color, el tema claro u oscuro se elige solo para que se lea bien.</p>` : `<div class="actions">${chip("tema", "auto", "Como el móvil", "auto")}${chip("tema", "light", "Claro", "auto")}${chip("tema", "dark", "Oscuro", "auto")}</div>`}
      <h3 style="margin-top:6px">Colores de cada parte</h3>
      ${partsPrefsHtml()}
      <h3 style="margin-top:6px">Fondo</h3>
      ${bgPrefsHtml()}
      <p class="note">Tamaño de letra</p><div class="actions">${chip("letra", "normal", "Normal", "normal")}${chip("letra", "grande", "Grande", "normal")}${chip("letra", "enorme", "Muy grande", "normal")}</div>
    </section>
    <section><h3>Voz</h3>
      ${canSpeak ? (voices.length ? `<label class="note" for="voicesel">Voz para audios, vídeos y tarjetas</label>
        <select id="voicesel">${voices.map(v => `<option value="${esc(v.name)}" ${voice && v.name === voice.name ? "selected" : ""}>${esc(v.name.replace(/^(Microsoft|Google)\s*/, ""))} (${esc(v.lang)})</option>`).join("")}</select>` : `<p class="note">Este móvil no tiene voces en español instaladas; se usará la que tenga.</p>`)
        + `<div class="actions"><label class="note" for="prefrate">Velocidad</label>${rateSelect("prefrate")}<button class="small" id="voicetest">Probar</button></div>`
        : `<p class="note">Este navegador no tiene voz.</p>`}
    </section>
    <section><h3>Estudio</h3>
      <p class="note">Tarjetas nuevas cada día (para no agobiarte)</p><div class="actions">${[10, 20, 30].map(k => chip("nuevas-dia", k, k, "20")).join("")}${chip("nuevas-dia", 0, "Sin límite", "20")}</div>
      <p class="note">Leer las tarjetas en voz alta al repasar</p><div class="actions">${chip("leer-tarjetas", "1", "Sí", "0")}${chip("leer-tarjetas", "0", "No", "0")}</div>
      <p class="note">Resumen por defecto</p><div class="actions">${chip("resumen-defecto", "corto", "Corto", "corto")}${chip("resumen-defecto", "detallado", "Detallado", "corto")}</div>
      <p class="note">Preguntas por test</p><div class="actions">${[5, 10, 15].map(k => chip("preguntas-defecto", k, k, "10")).join("")}</div>
    </section>
    <section><h3>Tus números</h3>
      <div class="statgrid">
        <div><b>${notes.length}</b><span>apuntes</span></div>
        <div><b>${cs.ms}<small>/${allCards.length}</small></b><span>tarjetas dominadas</span></div>
        <div><b>${avg}</b><span>nota media en tests</span></div>
        <div><b>${sk}</b><span>día${sk === 1 ? "" : "s"} seguido${sk === 1 ? "" : "s"}</span></div>
      </div>
    </section>`;
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
  const due = reviewQueue(sn).length;
  if (subjMode === "rename") {
    box.innerHTML = `<form class="inline-form" id="renameform">
      <input type="text" id="renameinput" value="${esc(s.name)}" maxlength="40" aria-label="Nuevo nombre de la asignatura">
      <button class="primary" type="submit">Guardar nombre</button><button class="ghost" type="button" id="subjcancel">Cancelar</button></form>`;
    $("renameinput").focus();
  } else if (subjMode === "exam") {
    box.innerHTML = `<form class="inline-form" id="examdateform">
      <label class="note" for="examdate">Examen de ${esc(s.name)}</label>
      <input type="date" id="examdate" value="${esc(s.exam || "")}" min="${new Date().toISOString().slice(0, 10)}">
      <button class="primary" type="submit">Guardar</button>${s.exam ? `<button class="ghost" type="button" id="examclear">Quitar fecha</button>` : ""}<button class="ghost" type="button" id="subjcancel">Cancelar</button></form>`;
  } else if (subjMode === "delete") {
    box.innerHTML = `<div class="confirm"><span>¿Borrar «${esc(s.name)}»${sn.length ? (sn.length > 1 ? ` y sus ${sn.length} apuntes` : " y su apunte") : ""}? No se puede deshacer.</span>
      <button class="danger" id="subjyes">Sí, borrar</button><button class="ghost" id="subjcancel">Cancelar</button></div>`;
  } else {
    box.innerHTML = `<div class="actions">
      <button class="small primary" id="examgo" ${pool < 4 ? "disabled" : ""}>Examen de ${esc(s.name)}</button>
      <button class="small" id="subjreview" ${due ? "" : "disabled"}>Repasar ${esc(s.name)} (${due})</button>
      ${sn.some(n => n.missed?.length) ? `<button class="small" id="subjmissed">Mis fallos</button>` : ""}
      <button class="small" id="subjexam">${s.exam && daysTo(s.exam) >= 0 ? `Examen ${whenText(daysTo(s.exam))}` : "Fecha de examen"}</button>
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
    if (n.cards?.length) { const d = reviewQueue([n]).length; chips.push(`<span class="chip">${n.cards.length} tarjetas${d ? ` · ${d} hoy` : ""}</span>`); }
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
    <div class="vtabs" role="tablist">${tab("apunte", "Apunte")}${tab("resumen", "Resumen")}${tab("audio", "Audio")}${tab("quiz", "Test")}${tab("tarjetas", "Tarjetas")}${tab("mapa", "Mapa")}${tab("video", "Vídeo")}${tab("preguntar", "Preguntar")}</div>
    <div class="content" id="content"></div>`;
  renderEdit(n); renderConfirm();
  return ({ apunte: renderOriginal, resumen: renderSummary, audio: renderAudio, quiz: renderQuiz, tarjetas: renderCards, mapa: renderMap, video: renderVideo, preguntar: renderChat }[view] || renderOriginal)(n);
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

// Visor de fotos a pantalla completa: zoom con dos dedos, rueda o doble toque; arrastrar para moverse; girar.
const photoView = { url: null };
function openPhoto(src) {
  let lb = $("lightbox");
  if (!lb) {
    lb = document.createElement("div"); lb.id = "lightbox"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-label", "Foto en grande");
    lb.innerHTML = `<div class="lbstage"><img alt=""></div><div class="lbbar"><button id="lbout" aria-label="Alejar">−</button><button id="lbin" aria-label="Acercar">+</button><button id="lbrot" aria-label="Girar">⟳</button><button id="lbfit">Ajustar</button><button id="lbclose" aria-label="Cerrar">✕</button></div>`;
    document.body.appendChild(lb);
    const st = lb.querySelector(".lbstage"), im = lb.querySelector("img");
    const v = lb.v = { s: 1, x: 0, y: 0, r: 0 };
    const draw = () => { im.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.s}) rotate(${v.r}deg)`; };
    lb.fit = () => { v.s = 1; v.x = v.y = 0; draw(); };
    const zoomAt = (f, cx, cy) => {
      const ns = Math.min(8, Math.max(1, v.s * f)), k = ns / v.s;
      const r = st.getBoundingClientRect(), ox = cx - r.left - r.width / 2, oy = cy - r.top - r.height / 2;
      v.x = ox - (ox - v.x) * k; v.y = oy - (oy - v.y) * k; v.s = ns; if (ns === 1) v.x = v.y = 0; draw();
    };
    lb.zoom = (f) => { const r = st.getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); };
    lb.rot = () => { v.r = (v.r + 90) % 360; draw(); };
    lb.draw = draw;
    const pts = new Map(); let last = null, tapAt = 0;
    st.addEventListener("pointerdown", (e) => { st.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); last = null;
      if (pts.size === 1) { const now = Date.now(); if (now - tapAt < 300) zoomAt(v.s > 1.2 ? 1 / v.s : 2.5, e.clientX, e.clientY); tapAt = now; } });
    st.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (last) zoomAt(d / last, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); last = d;
      } else if (pts.size === 1 && v.s > 1) { v.x += e.clientX - prev[0]; v.y += e.clientY - prev[1]; draw(); }
    });
    const up = (e) => { pts.delete(e.pointerId); last = null; };
    st.addEventListener("pointerup", up); st.addEventListener("pointercancel", up);
    st.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
  }
  lb.querySelector("img").src = src; lb.v.r = 0; lb.fit(); lb.hidden = false; document.documentElement.classList.add("lbopen");
  history.pushState({ lb: 1 }, ""); $("lbclose").focus();
}
function closePhoto(fromHistory) {
  const lb = $("lightbox"); if (!lb || lb.hidden) return;
  lb.hidden = true; document.documentElement.classList.remove("lbopen");
  if (!fromHistory && history.state?.lb) history.back();
}
window.addEventListener("popstate", () => closePhoto(true));
const pdfView = { pdf: null, io: null, cleanup() { this.io?.disconnect(); this.pdf?.destroy(); this.pdf = this.io = null; } };
async function renderOriginal(n) {
  const c = $("content");
  c.innerHTML = `<p class="sub">Cargando…</p>`;
  try {
    if (n.kind === "img") {
      if (photoView.url) URL.revokeObjectURL(photoView.url);
      const url = URL.createObjectURL(n.blob);
      c.innerHTML = `<div class="photobox"><button class="photoopen" id="photoopen" aria-label="Ver la foto en grande"><img class="orig" alt="${esc(n.name)}"></button>
        <div class="actions"><button class="small" id="photozoom">🔍 Ver en grande</button></div>
        <p class="note">Toca la foto para verla a pantalla completa. Con dos dedos (o la rueda del ratón) haces zoom.</p></div>`;
      const img = c.querySelector("img.orig");
      img.onerror = () => { c.innerHTML = `<p class="note">Este navegador no puede mostrar esta foto (seguramente es HEIC del iPhone). Gemini sí la lee, así que puedes crear el resumen, el test y lo demás. Para verla aquí, súbela otra vez como JPG o haz una captura de pantalla de ella.</p>`; };
      img.src = url; photoView.url = url;
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
    ${b && busy.partial ? `<div class="md" id="partial">${md(busy.partial)}</div>` : n.summary ? `<div class="actions">
        ${canSpeak ? `<button class="small" id="speakbtn">Escuchar resumen</button>` : ""}
        <button class="small ghost" id="copysum">Copiar</button>
      </div>
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
  if (quizKind === "desarrollo") return renderOpen(n);
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
    <div class="actions"><button class="tab small" data-qk="test" aria-pressed="true">Tipo test</button><button class="tab small" data-qk="desarrollo" aria-pressed="false">Para desarrollar</button></div>
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

let cardEdit = null, cardAdd = false;
function renderCards(n) {
  const c = $("content");
  const b = isBusyWith(n, "tarjetas");
  const cards = n.cards || [];
  const due = reviewQueue([n]).length;
  const st = cardStats(cards), sk = streak();
  const cntBtn = (k) => `<button class="tab small" data-cc="${k}" aria-pressed="${cardCount === k}">${k}</button>`;
  const item = (k) => cardEdit === k.id
    ? `<li><form class="stack" id="cardeditform" data-card="${esc(k.id)}">
        <label class="note" for="cefront">Pregunta</label><textarea id="cefront" rows="2">${esc(k.front)}</textarea>
        <label class="note" for="ceback">Respuesta</label><textarea id="ceback" rows="2">${esc(k.back)}</textarea>
        <div class="actions"><button class="small primary" type="submit">Guardar</button><button class="small ghost" type="button" id="cecancel">Cancelar</button></div></form></li>`
    : `<li><b>${esc(k.front)}</b><span>${esc(k.back)}</span>
        <span class="row" style="justify-content:space-between"><span class="note">${isNew(k) ? "Nueva" : k.interval >= 21 ? "Dominada" : "Aprendiendo"} · próximo repaso: ${k.due <= endOfToday() ? "hoy" : fmtDate(k.due)}</span>
        <span class="actions"><button class="small ghost" data-ce="${esc(k.id)}">Editar</button><button class="small ghost danger" data-cd="${esc(k.id)}">Borrar</button></span></span></li>`;
  c.innerHTML = `<div class="stack">
    ${cards.length ? `<div class="cstats">
        <div class="cbar" aria-hidden="true">${st.nw ? `<span class="s-new" style="flex:${st.nw}"></span>` : ""}${st.lr ? `<span class="s-lr" style="flex:${st.lr}"></span>` : ""}${st.ms ? `<span class="s-ms" style="flex:${st.ms}"></span>` : ""}</div>
        <div class="clegend"><span><i class="s-new"></i>${st.nw} nuevas</span><span><i class="s-lr"></i>${st.lr} aprendiendo</span><span><i class="s-ms"></i>${st.ms} dominadas</span></div>
        ${sk ? `<p class="note">🔥 Llevas ${sk} día${sk > 1 ? "s" : ""} seguido${sk > 1 ? "s" : ""} repasando.</p>` : ""}
      </div>
      <div class="actions">
        <button class="primary" id="reviewnote" ${due ? "" : "disabled"}>${due ? `Repasar ahora (${due})` : "Nada pendiente hoy"}</button>
        <button id="practicenote">Practicar todas</button>
        ${canSpeak ? `<button id="listencards">Escuchar tarjetas</button>` : ""}</div>` : ""}
    <div class="actions"><span class="note">${cards.length ? "Crear más con Gemini:" : "Tarjetas:"}</span>${cntBtn(10)}${cntBtn(15)}${cntBtn(25)}
      <button class="${cards.length ? "" : "primary"}" id="gocards" ${busy ? "disabled" : ""}>${cards.length ? "Añadir tarjetas" : "Hacer tarjetas"}</button>
      <button class="ghost" id="cardaddtoggle">${cardAdd ? "Cerrar" : "Escribir una a mano"}</button></div>
    ${cardAdd ? `<form class="stack panelish" id="cardaddform">
        <label class="note" for="cafront">Pregunta</label><textarea id="cafront" rows="2" placeholder="Por ejemplo: ¿Qué produce la mitocondria?"></textarea>
        <label class="note" for="caback">Respuesta</label><textarea id="caback" rows="2" placeholder="Energía (ATP)"></textarea>
        <div class="actions"><button class="small primary" type="submit">Añadir tarjeta</button></div></form>` : ""}
    ${errHtml(n, "tarjetas")}
    ${b ? busyHtml("Gemini está haciendo las tarjetas…") : ""}
    ${cards.length ? `<details ${cardEdit ? "open" : ""}><summary>Ver y editar las ${cards.length} tarjetas</summary><ul class="cardlist" style="margin-top:8px">${cards.map(item).join("")}</ul>
      <div class="actions" style="margin-top:8px"><button class="small danger" id="delcards">Borrar todas las tarjetas</button></div></details>`
      : (b ? "" : `<p class="note">Gemini saca preguntas y respuestas cortas del apunte (o escríbelas tú). Luego, cada día, «Repasar» te enseña las que te tocan, justo antes de que se te olviden.</p>${noKeyHint()}`)}
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

// ---------- Voz del dispositivo ----------
const canSpeak = "speechSynthesis" in window;
let speakRate = +ls.get("velocidad-voz") || 1;
let voice = null, voices = [];
function pickVoice() {
  if (!canSpeak) return;
  const score = (v) => (/^es[-_]ES/i.test(v.lang) ? 4 : 0) + (/google|natural|neural|premium|enhanced|mejorad/i.test(v.name) ? 3 : 0) + (/m[oó]nica|luc[ií]a|elvira|helena|paulina|marisol/i.test(v.name) ? 1 : 0) + (v.localService ? 1 : 0);
  voices = speechSynthesis.getVoices().filter(v => /^es/i.test(v.lang)).sort((a, b) => score(b) - score(a));
  voice = voices.find(v => v.name === ls.get("voz")) || voices[0] || null;
  if (!$("settings").hidden) renderPrefs();
}
if (canSpeak) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function utter(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice ? voice.lang : "es-ES"; if (voice) u.voice = voice; u.rate = speakRate;
  return u;
}
function plainText(mdText) {
  return String(mdText || "").replace(/[#*_`>|]/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\[(.*?)\]\(.*?\)/g, "$1");
}
const sentences = (text) => plainText(text).match(/[^.!?:\n]+[.!?:]*/g)?.map(s => s.trim()).filter(s => s.length > 1) || [];
const rateSelect = (id) => `<select id="${id}" aria-label="Velocidad de la voz">${[0.8, 0.9, 1, 1.15, 1.3, 1.5].map(r => `<option value="${r}" ${r === speakRate ? "selected" : ""}>${String(r).replace(".", ",")}x</option>`).join("")}</select>`;
function setRate(r) { speakRate = r; ls.set("velocidad-voz", String(r)); }

// ---------- Reproductor de audio: lee frase a frase, se puede pausar, saltar y ver por dónde va ----------
const rd = { key: null, parts: [], i: 0, playing: false, run: 0, timer: null };
function rdStop() { rd.run++; clearTimeout(rd.timer); rd.playing = false; if (canSpeak) speechSynthesis.cancel(); rdPaint(); }
const stopSpeak = rdStop;
function rdLoad(key, parts) { if (rd.key !== key || rd.parts.length !== parts.length) { rdStop(); rd.key = key; rd.i = 0; } rd.parts = parts; }
function rdPlay() {
  if (!canSpeak || !rd.parts.length) return;
  vStop();
  const run = ++rd.run; clearTimeout(rd.timer); speechSynthesis.cancel();
  rd.playing = true; rdPaint();
  const p = rd.parts[rd.i];
  const u = utter(p.text); rd.u = u;
  let done = false;
  const next = () => {
    if (done || run !== rd.run) return; done = true; clearTimeout(rd.timer);
    rd.timer = setTimeout(() => {
      if (run !== rd.run) return;
      if (rd.i < rd.parts.length - 1) { rd.i++; rdPlay(); }
      else { rd.playing = false; rd.i = 0; rdPaint(); }
    }, (p.pause ?? 250) / speakRate);
  };
  u.onend = next; u.onerror = next;
  speechSynthesis.speak(u);
  rd.timer = setTimeout(next, Math.max(5000, p.text.split(/\s+/).length * 900 / speakRate)); // por si el navegador no avisa al terminar
}
function rdJump(i) { rd.i = Math.max(0, Math.min(rd.parts.length - 1, i)); if (rd.playing) rdPlay(); else rdPaint(); }
function rdPaint() {
  const box = $("rdtext"); if (!box) return;
  $("rdplay").textContent = rd.playing ? "Pausa" : "Reproducir";
  $("rdplay").setAttribute("aria-pressed", rd.playing);
  $("rdpos").textContent = `${rd.i + 1} / ${rd.parts.length}`;
  $("rdbar").style.width = (100 * (rd.i + (rd.playing ? 0.5 : 0)) / Math.max(1, rd.parts.length)) + "%";
  box.querySelectorAll("[data-si]").forEach(el => el.classList.toggle("now", +el.dataset.si === rd.i && (rd.playing || rd.i > 0)));
  const now = box.querySelector(".now");
  if (now && rd.playing) { const top = now.offsetTop - box.offsetTop; box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: "smooth" }); }
}

// Fuentes de audio de un apunte
let audioSrc = null;
function audioSources(n) {
  const out = [];
  out.push({ id: "podcast", label: "Explicación", ready: !!n.podcast });
  out.push({ id: "resumen", label: "Resumen", ready: !!n.summary });
  out.push({ id: "tarjetas", label: "Tarjetas", ready: !!n.cards?.length });
  if (n.kind === "txt" || n.kind === "docx" || n.pdfText) out.push({ id: "apunte", label: "Apunte entero", ready: true });
  return out;
}
async function audioParts(n, src) {
  if (src === "podcast") return sentences(n.podcast.text).map(t => ({ text: t }));
  if (src === "resumen") return sentences(n.summary.text).map(t => ({ text: t }));
  if (src === "tarjetas") return (n.cards || []).flatMap((c, i) => [
    { text: `Pregunta ${i + 1}. ${c.front}`, pause: 3500, show: c.front, q: true },
    { text: c.back, pause: 1200, show: c.back }]);
  const text = n.kind === "pdf" ? n.pdfText : await noteText(n);
  return sentences(text).slice(0, 600).map(t => ({ text: t }));
}
async function renderAudio(n) {
  const c = $("content");
  const srcs = audioSources(n);
  if (!audioSrc || !srcs.some(s => s.id === audioSrc)) audioSrc = (srcs.find(s => s.ready && s.id !== "apunte") || srcs[0]).id;
  const src = srcs.find(s => s.id === audioSrc);
  const b = isBusyWith(n, "podcast");
  const chips = `<div class="actions">${srcs.map(s => `<button class="tab small" data-as="${s.id}" aria-pressed="${s.id === audioSrc}">${s.label}</button>`).join("")}</div>`;
  const desc = { podcast: "Gemini te lo explica como un profesor, en unos 3 minutos, para escuchar andando o en el bus.", resumen: "Escucha el resumen del apunte.", tarjetas: "Repaso sin mirar: dice la pregunta, te deja unos segundos para pensar y luego la respuesta.", apunte: "Lee el apunte tal cual." }[audioSrc];
  if (!canSpeak) { c.innerHTML = `<div class="stack">${chips}<p class="note">Este navegador no tiene voz. Prueba con Chrome o Safari.</p></div>`; return; }
  if (!src.ready || (audioSrc === "podcast" && b)) {
    c.innerHTML = `<div class="stack">${chips}<p class="note">${desc}</p>${errHtml(n, "podcast")}
      ${audioSrc === "podcast" ? (b ? busyHtml(busy.partial ? "Gemini está escribiendo la explicación…" : "Gemini está preparando la explicación…") + (busy.partial ? `<div class="md" id="partial">${md(busy.partial)}</div>` : "")
        : `<div class="actions"><button class="primary" id="gopodcast" ${busy ? "disabled" : ""}>Crear explicación en audio</button></div>${noKeyHint()}`)
      : audioSrc === "resumen" ? `<p class="note">Todavía no hay resumen. Hazlo en la pestaña «Resumen».</p>` : `<p class="note">Todavía no hay tarjetas. Hazlas en la pestaña «Tarjetas».</p>`}</div>`;
    return;
  }
  c.innerHTML = `<div class="stack">${chips}<p class="note">${desc}</p><p class="sub">Cargando…</p></div>`;
  const parts = await audioParts(n, audioSrc).catch(() => []);
  if (openId !== n.id || view !== "audio") return;
  rdLoad(n.id + ":" + audioSrc, parts);
  c.innerHTML = `<div class="stack">${chips}<p class="note">${desc}</p>
    <div class="audio">
      <div class="actions"><button id="rdprev" aria-label="Frase anterior">‹ Atrás</button><button class="primary big" id="rdplay">Reproducir</button><button id="rdnext" aria-label="Frase siguiente">Adelante ›</button>
        ${rateSelect("rate")}<span class="note" id="rdpos"></span></div>
      <div class="progress"><span id="rdbar"></span></div>
      <div class="rdtext" id="rdtext">${parts.map((p, i) => `<span data-si="${i}" class="${p.q ? "q" : ""}${p.q || (audioSrc === "tarjetas" && i % 2) ? " blk" : ""}">${esc(p.show || p.text)} </span>`).join("")}</div>
      <p class="note">Toca una frase para escuchar desde ahí. Si bloqueas el móvil, el audio puede pararse.</p>
    </div>
    ${audioSrc === "podcast" ? `<div class="actions"><button class="small ghost" id="gopodcast" ${busy ? "disabled" : ""}>Hacer otra explicación</button></div>` : ""}
  </div>`;
  rdPaint();
}

// ---------- Vídeo-lección (escenas animadas + voz del dispositivo) ----------
const vp = { id: null, i: 0, playing: false, ended: false, waiting: false, mute: false, timers: [], run: 0 };
function vClear() { vp.u = null; vp.run++; vp.timers.forEach(clearTimeout); vp.timers = []; if (canSpeak) speechSynthesis.cancel(); }
function vStop() { vClear(); vp.playing = false; vp.waiting = false; musicStop(); }
const LAYOUTS = ["portada", "lista", "definicion", "comparacion", "dato", "pregunta", "resumen"];
// ---------- Vídeo animado: cada escena dibuja y anima lo que la voz va explicando ----------
// Gemini elige el tipo de animación de cada escena y, para cada dibujo, la palabra de la narración
// en la que debe aparecer («cue»). Al llegar la voz a esa palabra, el dibujo entra en escena.
const ANIMS = ["portada", "proceso", "ciclo", "partes", "comparar", "linea", "jerarquia", "grafico", "causa", "escena", "definicion", "pregunta", "resumen", "codigo", "lista", "dato"];
const ACTIONS = ["aparece", "entra", "crece", "late", "gira", "sube", "baja", "brilla", "tiembla"];
const VIDEO2_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    scenes: { type: "ARRAY", items: { type: "OBJECT", properties: {
      anim: { type: "STRING", enum: ANIMS }, title: { type: "STRING" }, emoji: { type: "STRING" },
      items: { type: "ARRAY", items: { type: "OBJECT", properties: {
        emoji: { type: "STRING" }, label: { type: "STRING" }, text: { type: "STRING" }, value: { type: "NUMBER" },
        side: { type: "STRING", enum: ["izquierda", "derecha"] }, action: { type: "STRING", enum: ACTIONS },
        to: { type: "INTEGER" }, line: { type: "INTEGER" }, cue: { type: "STRING" }
      }, required: ["label", "cue"] } },
      subtitle: { type: "STRING" }, big: { type: "STRING" }, code: { type: "STRING" }, output: { type: "STRING" }, file: { type: "STRING" },
      left_title: { type: "STRING" }, right_title: { type: "STRING" },
      question: { type: "STRING" }, answer: { type: "STRING" }, narration: { type: "STRING" }
    }, required: ["anim", "title", "narration"] } }
  },
  required: ["title", "scenes"]
};
const VIDEO2_PROMPT = `Escribe el guion de un VÍDEO ANIMADO para repasar estos apuntes, de 6 a 9 escenas. En cada escena una voz explica algo y en pantalla se ANIMA justo eso: dibujos (emojis) que aparecen, se mueven y se conectan con flechas a la vez que la voz los nombra.
Cada escena tiene "anim" (el tipo de animación), "title" (máx. 6 palabras), "emoji" (uno que represente la escena), "items" (los dibujos) y "narration".
Tipos de "anim" y qué poner en "items":
- "portada": la primera. 2 a 4 items con los temas que se verán.
- "proceso": pasos en orden (3 a 5) que se unen con flechas. Ideal para procedimientos, fases o cómo funciona algo.
- "ciclo": etapas que se repiten en círculo (3 a 6), como el ciclo del agua.
- "partes": el "emoji" de la escena es el objeto y los items son sus partes (3 a 6), cada una unida al centro.
- "jerarquia": el título es lo general y los items los tipos o subgrupos (2 a 5).
- "comparar": "left_title" y "right_title" son lo que se compara; cada item lleva "side" ("izquierda" o "derecha") y es una característica (2 o 3 por lado).
- "linea": línea del tiempo; "label" es la fecha o época y "text" lo que pasó (3 a 5).
- "grafico": barras; cada item lleva "value" (un número de los apuntes) y "label". Solo si hay cifras reales.
- "causa": cadena causa → consecuencia (3 o 4 eslabones).
- "escena": una pequeña escena con personajes u objetos (2 a 5) que actúan: "action" es lo que hace cada uno (aparece, entra, crece, late, gira, sube, baja, brilla, tiembla) y "to" (opcional) es el número del item, empezando en 0, hacia el que va una flecha con algo que viaja (energía, agua, información…). Ejemplo, fotosíntesis: ☀️ brilla to 1, 🌱 crece, 💧 sube to 1, 🫧 O₂ sube.
- "definicion": "title" es el concepto y los items 2 o 3 rasgos clave (emoji + label corto).
- "pregunta": "question" para que Erika piense y "answer" corta; items puede ir vacío.
- "codigo": para PROGRAMACIÓN. "code" es un trozo de código corto y real (3 a 12 líneas, bien indentado, con saltos de línea), "file" el nombre del archivo (p. ej. Main.java), "output" lo que sale por pantalla al ejecutarlo (opcional) e "items" son notas (1 a 3) que explican líneas concretas: cada una con "line" (número de línea, empezando en 1), "label" corto y "cue". Si los apuntes son de programación, usa "codigo" en al menos la mitad de las escenas.
- "lista": 2 a 4 ideas cortas en items, cada una con su emoji.
- "dato": "big" es un número, fecha o dato muy corto (máx. 10 caracteres) y "subtitle" una frase que lo explique.
- "resumen": la última. 3 items con lo que no puede olvidar.
Usa al menos 5 tipos distintos y prefiere los más visuales (proceso, ciclo, partes, escena, comparar, linea, codigo). "subtitle" (opcional, máx. 12 palabras) es una frase corta bajo el título en portada, definicion y dato. Elige el tipo que mejor dibuje lo que se explica.
Cada item: "emoji" (UN emoji concreto que dibuje la cosa), "label" (máx. 4 palabras), "text" opcional (máx. 8 palabras) y "cue": UNA palabra que aparezca TAL CUAL en la narración, en el momento en que se habla de ese item. Los items van en el mismo orden en que se nombran.
"narration": lo que dice el profesor en voz alta, 2 a 4 frases naturales y cercanas, como si se lo explicaras a una amiga, nombrando los items en orden. En las preguntas plantea la pregunta, di «piénsalo un momento» y luego da la respuesta. Sin emojis, símbolos ni Markdown en la narración. No inventes datos que no estén en los apuntes.`;

const emo = (x) => esc(Array.from(String(x || "").trim()).slice(0, 3).join(""));
const normW = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ\s]/g, " ").split(/\s+/).filter(Boolean);
// Palabra de la narración en la que aparece un dibujo (o -1 si no se encuentra).
function findCue(nwords, cue, from) {
  const c = normW(cue); if (!c.length) return -1;
  const whole = findCue1(nwords, c, from); if (whole >= 0) return whole;
  // si la frase entera no está, vale la primera palabra con sentido que sí aparezca
  for (const w of c.filter(w => w.length >= 4)) { const i = findCue1(nwords, [w], from); if (i >= 0) return i; }
  return -1;
}
function findCue1(nwords, c, from) {
  const at = (s) => { for (let i = s; i < nwords.length; i++) if (c.every((w, j) => (nwords[i + j] || "").startsWith(w.slice(0, Math.max(4, w.length - 2))))) return i; return -1; };
  const i = at(from); return i >= 0 ? i : at(0);
}
// Resaltado sencillo de código (Java, JavaScript, Python, C…): comentarios, textos, números, palabras clave y tipos.
const CODE_KW = new Set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch this throw throws try void volatile while var let function async await yield def elif lambda None True False and or not in is pass print from as with null true false undefined struct include using namespace".split(" "));
function hlCode(src) {
  const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|([^\w\s])|(\s+)/g;
  let out = "", m;
  while ((m = re.exec(src))) {
    const [t, com, str, num, id, sym] = m;
    if (com) out += `<span class="c-com">${esc(com)}</span>`;
    else if (str) out += `<span class="c-str">${esc(str)}</span>`;
    else if (num) out += `<span class="c-num">${num}</span>`;
    else if (id) out += CODE_KW.has(id) ? `<span class="c-kw">${id}</span>` : /^[A-Z]/.test(id) ? `<span class="c-ty">${id}</span>` : src[re.lastIndex] === "(" ? `<span class="c-fn">${id}</span>` : esc(id);
    else out += esc(t);
  }
  return out;
}
const looksCode = (t) => /[;{}]|\w\(.*\)|\bnew \w|=\s*\S|^\s*(public|private|int|double|String|for|while|if|def|print|import|return|System)\b/m.test(String(t || ""));
// Los vídeos hechos con la versión anterior se pasan al formato animado sin gastar Gemini.
function fromV1(s) {
  let pts = (s.points || []).map(String).filter(Boolean);
  // Escenas antiguas sin puntos: se dibujan las frases de la narración
  if (!pts.length && /lista|resumen|^$/.test(s.layout || "")) pts = String(s.narration || "").split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/).map(x => x.trim().replace(/[.]$/, "")).filter(Boolean).slice(0, 4);
  const b = { title: s.heading || s.term || "", emoji: s.icon, narration: s.narration || "" };
  const its = (arr, side) => (arr || []).filter(Boolean).map(p => ({ label: String(p), cue: String(p), side }));
  switch (s.layout) {
    case "portada": return { ...b, anim: "portada", subtitle: pts[0] };
    case "definicion": {
      const t = String(s.term || ""), def = s.definition || pts.join(" ");
      if (looksCode(t)) return { ...b, anim: "codigo", code: t.replace(/;\s*(?=\S)/g, ";\n"), items: def ? [{ label: def, cue: def }] : [] };
      return { ...b, anim: "definicion", title: t || b.title, subtitle: def };
    }
    case "comparacion": return { ...b, anim: "comparar", left_title: s.left_title, right_title: s.right_title, items: [...its(s.left_points, "izquierda"), ...its(s.right_points, "derecha")] };
    case "dato": return { ...b, anim: "dato", big: s.big || pts[0] || "", subtitle: s.big ? pts[0] : pts[1] };
    case "pregunta": return { ...b, anim: "pregunta", question: s.question || pts[0], answer: s.answer || pts[1] };
    case "resumen": return { ...b, anim: "resumen", items: its(pts) };
    default: return { ...b, anim: "lista", items: its(pts) };
  }
}
const VSTYLES = { blanca: "Pizarra blanca", tiza: "Pizarra de tiza", color: "Colores" };
const vStyle = () => VSTYLES[ls.get("video-estilo")] ? ls.get("video-estilo") : "blanca";
const PEN_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="rotate(35 32 32)"><rect x="25" y="2" width="14" height="42" rx="3" fill="var(--pen-body)"/><rect x="25" y="8" width="14" height="6" fill="var(--pen-band)"/><path d="M25 44h14l-7 14z" fill="#f2d4a6"/><path d="M29.6 53h4.8L32 58z" fill="var(--pen-ink)"/></g></svg>`;
function sceneHtml2(s, i, total) {
  if (!s.anim) s = fromV1(s);
  const A = ANIMS.includes(s.anim) ? s.anim : "lista";
  const items = (s.items || []).filter(x => x && (x.label || x.emoji)).slice(0, 7);
  const n = items.length;
  const words = (t) => esc(t).split(" ").map((w, k) => `<span class="w" style="--d:${k}">${w}</span>`).join(" ");
  const ico = (x, k, cls = "") => x.emoji ? `<span class="ie ${cls} act-${ACTIONS.includes(x.action) ? x.action : "aparece"}">${emo(x.emoji)}</span>` : `<span class="ie num ${cls}">${k + 1}</span>`;
  const it = (x, k, cls = "", style = "") => `<div class="it ${cls}" data-k="${k}" data-cue="${esc(x.cue || x.label)}"${x.line ? ` data-line="${+x.line}"` : ""}${style ? ` style="${style}"` : ""}>
      ${ico(x, k)}<span class="il">${esc(x.label || "")}</span>${x.text ? `<span class="it2">${esc(x.text)}</span>` : ""}</div>`;
  const pos = (x, y) => `left:${x.toFixed(1)}%;top:${y.toFixed(1)}%`;
  const core = (label) => `<div class="core" data-k="c"><span class="ie big act-late">${emo(s.emoji || "⭐")}</span>${label ? `<span class="il">${esc(label)}</span>` : ""}</div>`;
  const sub = s.subtitle ? `<p class="subt rev">${esc(s.subtitle)}</p>` : "";
  let body = "", wires = [];
  if (A === "portada") body = `<div class="hero"><span class="ie hugee act-crece">${emo(s.emoji || "📘")}</span><h3 class="big">${words(s.title)}</h3>${sub}<div class="chips">${items.map((x, k) => it(x, k, "chipit")).join("")}</div></div>`;
  else if (A === "proceso" || A === "causa") { body = `<div class="flow ${A === "causa" ? "vert" : ""}">${items.map((x, k) => it(x, k, "step")).join("")}</div>`; wires = items.slice(1).map((_, k) => [k, k + 1]); }
  else if (A === "ciclo") { body = `<div class="ring">${core("")}<span class="orbitline"></span>${items.map((x, k) => { const a = -Math.PI / 2 + 2 * Math.PI * k / n; return it(x, k, "abs", pos(50 + 38 * Math.cos(a), 50 + 38 * Math.sin(a))); }).join("")}</div>`; wires = items.map((_, k) => [k, (k + 1) % n]); }
  else if (A === "partes") { body = `<div class="ring">${core("")}${items.map((x, k) => { const a = -Math.PI / 2 + Math.PI / n + 2 * Math.PI * k / n; return it(x, k, "abs", pos(50 + 39 * Math.cos(a), 50 + 37 * Math.sin(a))); }).join("")}</div>`; wires = items.map((_, k) => ["c", k]); }
  else if (A === "jerarquia") { body = `<div class="tree"><div class="rootw">${core(s.title)}</div><div class="kids">${items.map((x, k) => it(x, k, "kid")).join("")}</div></div>`; wires = items.map((_, k) => ["c", k]); }
  else if (A === "escena") {
    body = `<div class="ring">${items.map((x, k) => it(x, k, "abs actor", pos(12 + 76 * (k + 0.5) / n, n <= 3 ? 50 : (k % 2 ? 70 : 28)))).join("")}</div>`;
    wires = items.map((x, k) => Number.isInteger(x.to) && x.to !== k && x.to >= 0 && x.to < n ? [k, x.to, "flow"] : null).filter(Boolean);
  } else if (A === "comparar") {
    const L = items.filter(x => x.side !== "derecha"), R = items.filter(x => x.side === "derecha");
    const col = (arr, t, cls) => `<div class="cmpcol ${cls}"><b>${esc(t || "")}</b>${arr.map(x => it(x, items.indexOf(x), "cmpit")).join("")}</div>`;
    body = `<div class="cmp">${col(L, s.left_title, "l")}<span class="vs">vs</span>${col(R, s.right_title, "r")}</div>`;
  } else if (A === "linea") body = `<div class="tl"><div class="tlline"><i></i></div>${items.map((x, k) => it(x, k, "abs tlp " + (k % 2 ? "dn" : "up"), `left:${(13 + 74 * (n === 1 ? 0.5 : k / (n - 1))).toFixed(1)}%;top:50%`)).join("")}</div>`;
  else if (A === "grafico") {
    const max = Math.max(...items.map(x => Math.abs(+x.value || 0)), 1);
    body = `<div class="bars2">${items.map((x, k) => `<div class="it bar" data-k="${k}" data-cue="${esc(x.cue || x.label)}" data-v="${+x.value || 0}" style="--v:${Math.max(4, 100 * Math.abs(+x.value || 0) / max).toFixed(1)}">
      <span class="bv">${esc(String(+x.value || 0).replace(".", ","))}</span><i></i>${x.emoji ? `<span class="ie">${emo(x.emoji)}</span>` : ""}<span class="il">${esc(x.label || "")}</span></div>`).join("")}</div>`;
  } else if (A === "definicion") body = `<div class="defn"><span class="ie hugee act-crece">${emo(s.emoji || "📖")}</span><div><p class="term">${words(s.title)}</p>${sub}<div class="chips">${items.map((x, k) => it(x, k, "chipit")).join("")}</div></div></div>`;
  else if (A === "pregunta") body = `<div class="quest"><span class="ie hugee act-tiembla">${emo(s.emoji || "🤔")}</span><p class="qq">${esc(s.question || s.title)}</p>
      <svg class="clock" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16"/><circle class="hand" cx="20" cy="20" r="16"/></svg>
      ${s.answer ? `<p class="ans it" data-k="a" data-cue="${esc(s.answer)}"><span>${esc(s.answer)}</span></p>` : ""}</div>`;
  else if (A === "dato") body = `<div class="dato"><span class="ie hugee act-crece">${emo(s.emoji || "📌")}</span><p class="huge2" data-big="${esc(s.big || "")}">${esc(s.big || "")}</p>${sub}<div class="chips">${items.map((x, k) => it(x, k, "chipit")).join("")}</div></div>`;
  else if (A === "codigo") {
    const lines = String(s.code || "").replace(/\t/g, "  ").split("\n").slice(0, 16);
    const fname = s.file || (/class\s+(\w+)/.exec(s.code || "")?.[1] ? /class\s+(\w+)/.exec(s.code)[1] + ".java" : /def |print\(/.test(s.code || "") ? "main.py" : "Main.java");
    body = `<div class="codewrap ${n ? "withnotes" : ""}"><div class="ide"><div class="idebar"><i></i><i></i><i></i><span>${esc(fname)}</span></div>
      <pre class="code"><code>${lines.map((l, k) => `<span class="ln" data-line="${k + 1}"><span class="lnno">${k + 1}</span>${hlCode(l) || " "}</span>`).join("")}</code></pre>
      ${s.output ? `<div class="out it" data-k="o" data-cue="${esc(s.output_cue || "")}"><span class="outt">Salida</span><pre>${esc(s.output)}</pre></div>` : ""}</div>
      ${n ? `<div class="notes">${items.map((x, k) => it(x, k, "note")).join("")}</div>` : ""}</div>`;
  }
  else if (A === "resumen") body = `<div class="checks2">${items.map((x, k) => it(x, k, "chk")).join("")}</div>`;
  else body = `<div class="checks2 lista">${items.map((x, k) => it(x, k, "chk")).join("")}</div>`;
  const vst = vStyle(), vc = partColors().video;
  const style = vst === "color" && hexOk(vc) ? ` style="--v1:${mix(vc, "#000000", 0.55)};--v2:${vc}"` : "";
  return { wires, s, html: `<div class="scene a2 a-${A} vs-${vst} ${vst === "color" ? "" : "board"} ${vst === "color" ? (hexOk(vc) ? "tc" : "t" + (i % 5)) : ""}"${style}>
    <span class="blob b1"></span><span class="blob b2"></span>
    <span class="scn">${i + 1} / ${total}</span>
    ${A === "portada" ? "" : `<p class="stitle"><span>${esc(s.title)}</span></p>`}
    <div class="dia">${body}<svg class="wires" aria-hidden="true"></svg><svg class="scrib" aria-hidden="true"><path/></svg></div>
    <span class="pen" aria-hidden="true">${PEN_SVG}</span>
    <p class="cap"></p>
    <span class="sprog"><i></i></span></div>` };
}
// Flechas entre dibujos: se calculan con las posiciones reales, así valen para móvil y ordenador.
function vWires() {
  const st = $("vstage"), svg = st?.querySelector(".wires"); if (!svg || !vp.wires) return;
  const box = svg.parentElement.getBoundingClientRect(); if (!box.width) return;
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  const flowIe = !!st.querySelector(".a-proceso, .a-causa"); // en los pasos en columna la flecha va de dibujo a dibujo
  const at = (k) => { const el = (flowIe && st.querySelector(`.dia [data-k="${k}"] .ie`)) || st.querySelector(`.dia [data-k="${k}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top, r: Math.max(r.width, r.height) / 2 + 6 }; };
  svg.innerHTML = `<defs><filter id="rough" filterUnits="userSpaceOnUse" x="0" y="0" width="${box.width}" height="${box.height}"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="3"/><feDisplacementMap in="SourceGraphic" scale="3"/></filter><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>` +
    vp.wires.map(([a, b, kind], j) => {
      const p = at(a), q = at(b); if (!p || !q) return "";
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
      if (d < p.r + q.r + 6) return "";
      const x1 = p.x + dx / d * p.r, y1 = p.y + dy / d * p.r, x2 = q.x - dx / d * q.r, y2 = q.y - dy / d * q.r;
      const bend = st.querySelector(".a-ciclo") ? 0.25 : 0; // en el ciclo las flechas van curvas
      const cx = (x1 + x2) / 2 - dy * bend, cy = (y1 + y2) / 2 + dx * bend;
      const len = Math.hypot(x2 - x1, y2 - y1) * (bend ? 1.15 : 1);
      const on = st.querySelector(`.dia [data-k="${b}"]`)?.classList.contains("on");
      return `<path id="vw${j}" class="wire${on ? " on" : ""}" data-to="${b}" d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" style="--len:${len.toFixed(0)}" marker-end="url(#ah)"/>` +
        (kind === "flow" || st.querySelector(".a-proceso, .a-ciclo, .a-causa") ? `<circle class="spark${on ? " on" : ""}" data-to="${b}" r="4"><animateMotion dur="${(1.2 + len / 200).toFixed(2)}s" repeatCount="indefinite"><mpath href="#vw${j}"/></animateMotion></circle>` : "");
    }).join("");
}
window.addEventListener("resize", () => { clearTimeout(vp.rz); vp.rz = setTimeout(vWires, 150); });
// Prepara a qué palabra de la narración aparece cada dibujo y las frases para el subtítulo de dentro.
function vCues(s) {
  const st = $("vstage"); const narr = String(s.narration || "");
  const nw = normW(narr), total = narr.split(/\s+/).filter(Boolean).length;
  const els = [...st.querySelectorAll(".dia [data-cue]")];
  let from = 0;
  vp.cues = els.map((el, j) => {
    let w = findCue(nw, el.dataset.cue, from);
    if (w < 0) w = Math.round((j + 1) / (els.length + 1) * total * 0.85); else from = w;
    if (el.dataset.k === "a") w = Math.max(w, Math.round(total * 0.55)); // la respuesta, nunca antes de plantear la pregunta
    return { el, w };
  });
  vp.sents = []; let off = 0;
  for (const p of narr.split(/(?<=[.!?…:;])\s+(?=\S)/).map(x => x.trim()).filter(Boolean)) { const k = p.split(/\s+/).length; vp.sents.push({ off, k, text: p }); off += k; }
}
function vReveal(k) {
  const st = $("vstage"); if (!st) return;
  const cap = st.querySelector(".cap");
  if (cap && vp.playing && vp.sents) { const s = vp.sents.find(x => k + 1 >= x.off && k + 1 < x.off + x.k) || vp.sents[vp.sents.length - 1]; if (s && cap.textContent !== s.text) cap.textContent = s.text; }
  if (!vp.cues) return;
  let last = null;
  for (const c of vp.cues) if (c.w <= k && !c.el.classList.contains("on")) { c.el.classList.add("on"); last = c.el; vOnShow(c.el); }
  if (last && !last.classList.contains("ans")) { st.querySelectorAll(".dia .now").forEach(e => e.classList.remove("now")); last.classList.add("now"); st.querySelector(".dia")?.classList.add("focus"); }
  if (last) vMark(last);
}
// El rotulador va hasta lo que se acaba de dibujar y lo rodea con un círculo a mano.
function vPen(el) {
  const st = $("vstage"), sc = st?.querySelector(".scene"), pen = sc?.querySelector(".pen"); if (!pen || !el) return;
  const a = sc.getBoundingClientRect(), r = (el.querySelector(".il") || el.querySelector(".ie") || el).getBoundingClientRect();
  pen.style.left = (r.right - a.left - 6) + "px"; pen.style.top = (r.bottom - a.top - 40) + "px"; pen.classList.add("on");
  pen.classList.remove("wr"); void pen.offsetWidth; pen.classList.add("wr");
}
function vMark(el) {
  vPen(el);
  const st = $("vstage"), dia = st?.querySelector(".dia"), svg = dia?.querySelector(".scrib"); if (!svg || el.classList.contains("bar")) return;
  const a = dia.getBoundingClientRect(), r = (el.querySelector(".ie:not(.num)") || el).getBoundingClientRect();
  if (!a.width || !r.width) return;
  svg.setAttribute("viewBox", `0 0 ${a.width} ${a.height}`);
  const cx = r.left + r.width / 2 - a.left, cy = r.top + r.height / 2 - a.top, rx = r.width / 2 + 10, ry = r.height / 2 + 8;
  let d = "", seed = (el.dataset.k || "0").charCodeAt(0);
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280 - 0.5) * 6;
  for (let t = 0; t <= 26; t++) { const ang = -2.2 + t / 24 * Math.PI * 2.15; d += (t ? "L" : "M") + (cx + Math.cos(ang) * (rx + rnd())).toFixed(1) + " " + (cy + Math.sin(ang) * (ry + rnd())).toFixed(1); }
  const p = svg.querySelector("path"); p.setAttribute("d", d);
  p.classList.remove("on"); void p.getBBox?.(); requestAnimationFrame(() => p.classList.add("on"));
}
function vOnShow(el) {
  const st = $("vstage"), k = el.dataset.k;
  if (el.dataset.line) { st.querySelectorAll(".ln.hl").forEach(x => x.classList.remove("hl")); st.querySelector(`.ln[data-line="${el.dataset.line}"]`)?.classList.add("hl"); }
  st.querySelectorAll(`.wires [data-to="${k}"]`).forEach(w => w.classList.add("on"));
  const tl = st.querySelector(".tlline i"); if (tl && el.classList.contains("tlp")) tl.style.width = el.style.left;
  if (el.classList.contains("bar")) { // las cifras cuentan desde cero
    const to = +el.dataset.v, b = el.querySelector(".bv"), t0 = performance.now(), dec = to % 1 ? 1 : 0;
    const step = (t) => { const f = Math.min(1, (t - t0) / 900); if (b) b.textContent = (to * f).toFixed(dec).replace(".", ","); if (f < 1 && el.isConnected) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
}

// Música suave de fondo hecha en el propio móvil (acordes tranquilos, sin descargar nada).
const music = { ctx: null, on: false, timer: null, master: null };
function musicStart() {
  if (ls.get("video-musica") !== "1" || music.on) return;
  try { music.ctx = music.ctx || new (window.AudioContext || window.webkitAudioContext)(); music.ctx.resume?.(); } catch (e) { return; }
  const ctx = music.ctx; music.on = true;
  const master = ctx.createGain(); master.gain.setValueAtTime(0, ctx.currentTime); master.gain.linearRampToValueAtTime(0.045, ctx.currentTime + 2);
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1100; lp.connect(master); master.connect(ctx.destination);
  music.master = master;
  const chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 52, 55, 60], [55, 59, 62, 67]];
  let k = 0;
  const play = () => {
    if (!music.on || music.master !== master) return;
    const t = ctx.currentTime;
    chords[k++ % chords.length].forEach((m, j) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = j ? "sine" : "triangle"; o.frequency.value = 440 * 2 ** ((m - 69) / 12);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t + 1); g.gain.linearRampToValueAtTime(0, t + 4.2);
      o.connect(g); g.connect(lp); o.start(t); o.stop(t + 4.3);
    });
    music.timer = setTimeout(play, 3900);
  };
  play();
}
function musicStop() {
  music.on = false; clearTimeout(music.timer);
  const m = music.master; music.master = null;
  if (m) try { m.gain.cancelScheduledValues(music.ctx.currentTime); m.gain.setValueAtTime(m.gain.value, music.ctx.currentTime); m.gain.linearRampToValueAtTime(0, music.ctx.currentTime + 0.6); setTimeout(() => m.disconnect(), 800); } catch (e) {}
}
function renderVideo(n) {
  const c = $("content");
  const b = isBusyWith(n, "video");
  const sc = n.video?.script;
  if (vp.id !== n.id) { vStop(); vp.id = n.id; vp.i = 0; vp.ended = false; vp.waiting = false; vp.mute = false; }
  const auto = ls.get("video-auto") !== "0";
  c.innerHTML = `<div class="stack">
    <div class="actions"><button class="${sc ? "" : "primary"}" id="govideo" ${busy ? "disabled" : ""}>${sc ? "Hacer otro vídeo" : "Hacer vídeo"}</button>
      ${sc ? `<span class="note">${esc(sc.title || "")} · ${sc.scenes.length} escenas · unos ${Math.max(1, Math.round(sc.scenes.reduce((k, s) => k + String(s.narration || "").split(/\s+/).length, 0) / 150 / speakRate))} min</span>` : ""}</div>
    ${sc && sc.v !== 2 && !n.example ? `<p class="note vold">Este vídeo se hizo con la versión anterior y se ha adaptado solo. Para que salga con animaciones y dibujos nuevos, pulsa «Hacer otro vídeo».</p>` : ""}
    ${errHtml(n, "video")}
    ${b ? busyHtml("Gemini está escribiendo el guion del vídeo…") : ""}
    ${sc ? `<div class="player" id="player">
        <div class="stage" id="vstage" role="button" tabindex="0" aria-label="Vídeo: toca para reproducir o pausar"></div>
        <div class="bars" id="vbars"></div>
        <div class="actions vctl"><button id="vprev" aria-label="Escena anterior">‹</button><button class="primary big" id="vplay">Reproducir</button><button id="vnext" aria-label="Escena siguiente">›</button>
          ${rateSelect("vrate")}<button class="small ghost" id="vfull">Pantalla completa</button></div>
        <div class="actions vstyle"><span class="note">Estilo:</span>${Object.entries(VSTYLES).map(([k, v]) => `<button class="tab small" data-vstyle="${k}" aria-pressed="${vStyle() === k}">${v}</button>`).join("")}</div>
        <label class="vauto"><input type="checkbox" id="vauto" ${auto ? "checked" : ""}> Pasar de escena sola al terminar de hablar</label>
        <label class="vauto"><input type="checkbox" id="vmusic" ${ls.get("video-musica") === "1" ? "checked" : ""}> Música suave de fondo</label>
        <p class="note" id="vnovoice" ${canSpeak && !vp.mute ? "hidden" : ""}>Sin voz en este navegador: el vídeo va con subtítulos.</p>
        <div class="subs" id="vsubs" aria-live="polite"></div>
      </div>`
      : (b ? "" : `<p class="note">Pulsa «Hacer vídeo» y Gemini preparará una vídeo-lección con este apunte: escenas animadas con dibujos, comparaciones, preguntas y una voz que te lo explica.</p>${noKeyHint()}`)}
  </div>`;
  if (sc) vDraw(n, false);
}
// Si Gemini deja una escena sin su contenido, se rellena con frases de la narración para que nunca salga vacía.
const shortLine = (t) => { const w = String(t || "").trim().split(/\s+/); return w.length > 12 ? w.slice(0, 12).join(" ") + "…" : w.join(" "); };
function sceneHtml(s, i, total) {
  const L = LAYOUTS.includes(s.layout) ? s.layout : "lista";
  const said = sentences(s.narration || "").map(shortLine);
  const list = (a) => (a || []).map(x => String(x || "").trim()).filter(Boolean);
  let points = list(s.points); if (!points.length && ["lista", "resumen"].includes(L)) points = said.slice(0, 3);
  const icon = String(s.icon || "").trim().slice(0, 4) || ["📘", "💡", "🧠", "✏️", "⭐"][i % 5];
  const pts = (arr, cls = "") => list(arr).length ? `<ul class="${cls}">${list(arr).map((p, k) => `<li style="--d:${k}">${esc(p)}</li>`).join("")}</ul>` : "";
  const words = (t) => esc(t).split(" ").map((w, k) => `<span class="w" style="--d:${k}">${w}</span>`).join(" ");
  const heading = s.heading || said[0] || "";
  let body;
  if (L === "portada") body = `<h3 class="big">${words(heading)}</h3>${points[0] || said[0] ? `<p class="lead rev">${esc(points[0] || said[0])}</p>` : ""}`;
  else if (L === "definicion") body = `<p class="kick">${esc(heading)}</p><p class="term">${words(s.term || heading)}</p><p class="def rev">${esc(s.definition || points.join(" ") || said[0] || "")}</p>`;
  else if (L === "comparacion" && (list(s.left_points).length || list(s.right_points).length)) body = `<p class="kick">${esc(heading)}</p><div class="cols">
      <div class="rev" style="--d:0"><b>${esc(s.left_title || "")}</b>${pts(s.left_points)}</div><div class="rev" style="--d:1"><b>${esc(s.right_title || "")}</b>${pts(s.right_points)}</div></div>`;
  else if (L === "dato") body = `<p class="kick">${esc(heading)}</p><p class="huge">${esc(s.big || points[0] || "")}</p>${s.big && (points[0] || said[0]) ? `<p class="lead rev">${esc(points[0] || said[0])}</p>` : ""}`;
  else if (L === "pregunta") body = `<p class="kick">${esc(s.heading || "Piensa")}</p><p class="qq">${esc(s.question || points[0] || said[0] || "")}</p>${s.answer || points[1] ? `<p class="ans"><span>${esc(s.answer || points[1])}</span></p>` : ""}`;
  else if (L === "resumen") body = `<p class="kick">${esc(heading)}</p>${pts(points, "checks")}`;
  else body = `<p class="kick">${esc(heading)}</p>${pts(points.length ? points : said.slice(0, 3))}`;
  const vc = partColors().video;
  const style = hexOk(vc) ? ` style="--v1:${mix(vc, "#000000", 0.55)};--v2:${vc}"` : "";
  return `<div class="scene l-${L} ${hexOk(vc) ? "tc" : "t" + (i % 5)}"${style}>
    <span class="blob b1"></span><span class="blob b2"></span>
    <span class="scn">${i + 1} / ${total}</span>
    <span class="vicon" aria-hidden="true">${esc(icon)}</span>
    <div class="sbody">${body}</div>
    <span class="sprog"><i></i></span></div>`;
}
function vDraw(n, animate) {
  const sc = n.video.script, s = sc.scenes[vp.i];
  if (!$("vstage")) return;
  $("vbars").innerHTML = sc.scenes.map((_, k) => `<button class="${k < vp.i ? "done" : k === vp.i ? "now" : ""}" data-vs="${k}" aria-label="Ir a la escena ${k + 1}"></button>`).join("");
  const r = sceneHtml2(s, vp.i, sc.scenes.length);
  const st = $("vstage");
  st.innerHTML = r.html; vp.wires = r.wires; vp.cues = null;
  st.classList.toggle("v2", true);
  st.classList.toggle("anim", !!animate);
  st.classList.toggle("still", !animate);
  vCues(s);
  if (!animate) { st.querySelectorAll(".dia [data-cue], .ln").forEach(e => e.classList.add("on")); st.querySelectorAll(".ln").forEach(e => e.classList.add("typed")); }
  requestAnimationFrame(vWires);
  const words = String(s.narration || "").split(/\s+/).filter(Boolean);
  $("vsubs").innerHTML = words.map((w, k) => `<span data-w="${k}">${esc(w)}</span>`).join(" ");
  $("vplay").textContent = vp.waiting ? "Siguiente escena ›" : vp.playing ? "Pausa" : (vp.ended ? "Ver otra vez" : "Reproducir");
  const nv = $("vnovoice"); if (nv) nv.hidden = canSpeak && !vp.mute;
}
function markSaid(k) { document.querySelectorAll("#vsubs span").forEach((el, j) => el.classList.toggle("said", j <= k)); vReveal(k); }
function vPlayScene(n) {
  vClear(); rd.run++; rd.playing = false; vp.waiting = false;
  const sc = n.video.script, s = sc.scenes[vp.i];
  const narr = String(s.narration || "").trim();
  vDraw(n, true);
  // El código se escribe línea a línea al principio de la escena, con el rotulador siguiendo cada línea.
  const lns = [...document.querySelectorAll("#vstage .ln")];
  if (lns.length) { const per = Math.min(650, Math.max(220, 3200 / lns.length)); lns.forEach((l, k) => vp.timers.push(setTimeout(() => { l.classList.add("on", "typed"); vPen(l); }, 500 + k * per))); }
  const big = document.querySelector("#vstage .huge2"); const num = /^(\d+)([.,]\d+)?/.exec(big?.dataset.big || "");
  if (big && num) { const to = parseFloat(num[0].replace(",", ".")), rest = big.dataset.big.slice(num[0].length), dec = num[2] ? num[2].length - 1 : 0, t0 = performance.now();
    const step = (t) => { const f = Math.min(1, (t - t0 - 400) / 1200); if (f > 0) big.textContent = (to * f).toFixed(dec).replace(".", ",") + rest; if (f < 1 && big.isConnected) requestAnimationFrame(step); }; requestAnimationFrame(step); }
  const run = vp.run, t0 = Date.now();
  const words = narr.split(/\s+/).filter(Boolean);
  const est = Math.max(4000, words.length * 400 / speakRate); // lo que tarda en decirse más o menos
  const stage = $("vstage");
  stage.style.setProperty("--dur", est + "ms");
  // Lo que hay en pantalla aparece poco a poco mientras habla, y la respuesta de las preguntas, a mitad.
  const items = [...stage.querySelectorAll("li, .rev")];
  items.forEach((el, k) => vp.timers.push(setTimeout(() => el.classList.add("on"), 700 + k * Math.min(1800, est * 0.7 / (items.length + 1)))));
  const ans = stage.querySelector(".ans");
  if (ans) vp.timers.push(setTimeout(() => ans.classList.add("on"), est * 0.6));
  let finished = false;
  const finish = () => {
    if (finished || run !== vp.run || !vp.playing) return; finished = true;
    // Nunca se pasa de escena antes de que dé tiempo a leerla.
    const wait = Math.max(0, est * 0.85 - (Date.now() - t0));
    vp.timers.push(setTimeout(() => {
      if (run !== vp.run || !vp.playing) return;
      stage.querySelectorAll("li, .rev, .ans").forEach(el => el.classList.add("on")); markSaid(words.length);
      if (vp.i >= sc.scenes.length - 1) { vp.playing = false; vp.ended = true; musicStop(); vDraw(n, false); return; }
      if (ls.get("video-auto") === "0") { vp.waiting = true; $("vplay").textContent = "Siguiente escena ›"; return; }
      vp.timers.push(setTimeout(() => { if (run === vp.run && vp.playing) { vp.i++; vPlayScene(n); } }, 1300));
    }, wait));
  };
  // Sin voz: los subtítulos avanzan solos al ritmo de lectura.
  const silent = (from) => {
    const left = Math.max(1500, est - (Date.now() - t0));
    for (let k = from; k < words.length; k++) vp.timers.push(setTimeout(() => run === vp.run && markSaid(k), (k - from) * left / Math.max(1, words.length - from)));
    vp.timers.push(setTimeout(finish, left));
  };
  if (!canSpeak || vp.mute || !words.length) { silent(0); return; }
  // Se habla frase a frase: así no se corta en Chrome (que para las frases largas) y se puede seguir por dónde va.
  const parts = []; let off = 0;
  for (const p of narr.split(/(?<=[.!?…:;])\s+(?=\S)/).map(x => x.trim()).filter(Boolean)) {
    const nw = p.split(/\s+/).length; parts.push({ text: p, off, nw }); off += nw;
  }
  let pi = 0, everStarted = false;
  const speakPart = () => {
    if (run !== vp.run || !vp.playing) return;
    if (pi >= parts.length) { finish(); return; }
    const p = parts[pi], u = utter(p.text), ts = Date.now();
    vp.u = u; // si no se guarda, Chrome puede tirarla y no avisa al terminar
    let done = false, started = false;
    const starts = []; let pos = 0;
    p.text.split(/\s+/).forEach(w => { pos = p.text.indexOf(w, pos); starts.push(pos); pos += w.length; });
    markSaid(p.off - 1);
    const next = (bad) => {
      if (done || run !== vp.run) return; done = true;
      // Si la voz falla o «termina» sin decir nada, el vídeo sigue con subtítulos en vez de saltarse escenas.
      if (bad || (!started && Date.now() - ts < 400 * p.nw / speakRate * 0.3 && p.nw > 3)) {
        if (!everStarted) { vp.mute = true; const nv = $("vnovoice"); if (nv) nv.hidden = false; }
        silent(p.off); return;
      }
      markSaid(p.off + p.nw - 1); pi++; vp.timers.push(setTimeout(speakPart, 120));
    };
    let heard = false; // si el navegador no dice por qué palabra va, se calcula por tiempo
    u.onstart = () => {
      started = everStarted = true;
      vp.timers.push(setTimeout(() => {
        if (heard || done || run !== vp.run) return;
        for (let j = 0; j < p.nw; j++) vp.timers.push(setTimeout(() => { if (!heard && !done && run === vp.run) markSaid(p.off + j); }, j * 360 / speakRate));
      }, 450));
    };
    u.onend = () => next(false);
    u.onerror = () => { if (run !== vp.run) return; next(!started); };
    u.onboundary = (e) => {
      started = everStarted = heard = true;
      if (run !== vp.run || (e.name && e.name !== "word")) return;
      const k = starts.findIndex((st, j) => e.charIndex >= st && (j === starts.length - 1 || e.charIndex < starts[j + 1]));
      if (k >= 0) markSaid(p.off + k);
    };
    speechSynthesis.speak(u);
    vp.timers.push(setTimeout(() => next(false), 4000 + p.nw * 700 / speakRate)); // por si el navegador no avisa al terminar
  };
  // En Android, hablar justo después de cancelar hace que la frase se pierda: se espera un poco.
  vp.timers.push(setTimeout(speakPart, 250));
}
function vToggle(n) {
  // Se habla algo dentro del toque para que el iPhone deje usar la voz después.
  if (canSpeak && !vp.playing) { vp.mute = false; try { speechSynthesis.cancel(); vp.u = new SpeechSynthesisUtterance(" "); vp.u.volume = 0; speechSynthesis.speak(vp.u); } catch (e) {} }
  if (!vp.playing || vp.waiting) musicStart();
  if (vp.waiting) { vp.waiting = false; vp.i = Math.min(vp.i + 1, n.video.script.scenes.length - 1); vp.playing = true; vPlayScene(n); return; }
  if (vp.playing) { vStop(); vDraw(n, false); }
  else { if (vp.ended) vp.i = 0; vp.playing = true; vp.ended = false; vPlayScene(n); }
}
function vFullscreen() {
  const pl = $("player"); if (!pl) return;
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (pl.classList.contains("theater")) { pl.classList.remove("theater"); $("vfull").textContent = "Pantalla completa"; return; }
  if (pl.requestFullscreen) pl.requestFullscreen().then(() => { try { screen.orientation?.lock?.("landscape").catch(() => {}); } catch (e) {} }).catch(() => { pl.classList.add("theater"); $("vfull").textContent = "Salir"; });
  else { pl.classList.add("theater"); $("vfull").textContent = "Salir"; } // iPhone: no deja pantalla completa, se amplía dentro de la página
}
document.addEventListener("fullscreenchange", () => { const b = $("vfull"); if (b) b.textContent = document.fullscreenElement ? "Salir" : "Pantalla completa"; });

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
function streamTo(n, what, tab = what) {
  return (partial) => {
    if (!busy || busy.id !== n.id) return;
    const first = !busy.partial;
    busy.partial = partial;
    const el = $("partial");
    if (el && !first) el.innerHTML = md(partial);
    else if (mode === "note" && openId === n.id && view === tab) renderViewer();
  };
}

// ---------- Repaso de tarjetas ----------
let rs = null; // { title, queue:[{noteId, cardId}], i, flipped, total, done, practice }
let swallowClick = false;
function startReview(scopeNotes, title, practice) {
  stopSpeak(); vStop();
  const queue = practice
    ? shuffle(scopeNotes.flatMap(n => (n.cards || []).map(c => ({ noteId: n.id, cardId: c.id }))))
    : reviewQueue(scopeNotes);
  if (!queue.length) { toast("No tienes tarjetas pendientes para hoy. ¡Bien hecho!"); return; }
  rs = { title, queue, i: 0, flipped: false, total: queue.length, done: 0, practice: !!practice, right: 0 };
  mode = "review"; renderViewer(); renderList(); showViewer();
}
function findCard(ref) {
  const n = notes.find(x => x.id === ref.noteId);
  return n ? { n, c: (n.cards || []).find(k => k.id === ref.cardId) } : {};
}
const autoRead = () => ls.get("leer-tarjetas") === "1";
function sayOnce(text) { if (!canSpeak) return; rdStop(); speechSynthesis.speak(utter(text)); }
function renderReview() {
  const v = $("viewer");
  const head = `<div class="vhead"><div><h2>${esc(rs.title)}</h2><p class="sub">${rs.practice ? "Práctica libre: no cambia tus fechas de repaso." : "Las que aciertes volverán más tarde; las que falles, antes."}</p></div>
    <div class="actions"><button class="small" id="endreview">Terminar</button></div></div>
    <div class="progress" aria-hidden="true"><span style="width:${Math.round(100 * rs.done / rs.total)}%"></span></div>`;
  if (rs.i >= rs.queue.length) {
    const left = reviewQueue(notes).length, sk = streak();
    v.innerHTML = `${head}<div class="result"><b>¡Repaso terminado! 🎉</b><span>${rs.total} tarjeta${rs.total > 1 ? "s" : ""} repasada${rs.total > 1 ? "s" : ""}${rs.practice ? `, ${rs.right} a la primera` : ""}.</span>
      ${sk ? `<span>🔥 Llevas ${sk} día${sk > 1 ? "s" : ""} seguido${sk > 1 ? "s" : ""} repasando.</span>` : ""}
      <span class="note">${left ? `Aún te quedan ${left} para hoy en otros apuntes.` : "No te queda nada pendiente para hoy."}</span>
      <div class="actions"><button class="small primary" id="endreview2">Volver a mis apuntes</button></div></div>`;
    renderTop(); return;
  }
  const { n, c } = findCard(rs.queue[rs.i]);
  if (!c) { rs.queue.splice(rs.i, 1); rs.total = Math.max(rs.done, rs.total - 1); return renderReview(); }
  v.innerHTML = `${head}
    <div class="flash">
      <div class="row" style="justify-content:space-between"><p class="note">${rs.done + 1} de ${rs.total} · ${esc(n.name)}${isNew(c) ? " · nueva" : ""}</p>
        ${canSpeak ? `<button class="small ghost" id="cardspeak">Escuchar</button>` : ""}</div>
      <button class="card3d ${rs.flipped ? "flip" : ""}" id="flipcard" aria-label="${rs.flipped ? "Respuesta: " + esc(c.back) : "Pregunta: " + esc(c.front) + ". Toca para ver la respuesta"}">
        <span class="face front"><span class="lab">Pregunta</span><span class="txt">${esc(c.front)}</span><span class="note">Toca para darle la vuelta</span></span>
        <span class="face back" aria-hidden="${!rs.flipped}"><span class="lab">Respuesta</span><span class="txt">${esc(c.back)}</span><span class="note">${esc(c.front)}</span></span>
      </button>
      <div id="cardctl">${cardCtl(c)}</div>
    </div>`;
  attachSwipe();
  if (autoRead() && !rs.flipped) sayOnce(c.front);
}
function cardCtl(c) {
  if (!rs.flipped) return `<button class="primary big wide" id="showans">Ver respuesta</button>`;
  const iv = nextIntervals(c);
  return (rs.practice
    ? `<div class="grades" style="grid-template-columns:1fr 1fr"><button class="g0" data-g="0">La he fallado</button><button class="g3" data-g="2">Me la sabía</button></div>`
    : `<p class="note">¿Qué tal te la sabías?</p><div class="grades">
      <button class="g0" data-g="0">Otra vez<small>${ivLabel(iv[0])}</small></button>
      <button data-g="1">Difícil<small>${ivLabel(iv[1])}</small></button>
      <button data-g="2">Bien<small>${ivLabel(iv[2])}</small></button>
      <button class="g3" data-g="3">Fácil<small>${ivLabel(iv[3])}</small></button></div>`)
    + `<p class="note center">También puedes deslizar la tarjeta: a la derecha si te la sabías, a la izquierda si no.</p>`;
}
function flipCard() {
  if (!rs || rs.flipped) return;
  const { c } = findCard(rs.queue[rs.i]); if (!c) return;
  rs.flipped = true;
  const el = $("flipcard");
  el.classList.add("flip"); el.querySelector(".back").setAttribute("aria-hidden", "false");
  el.setAttribute("aria-label", "Respuesta: " + c.back);
  $("cardctl").innerHTML = cardCtl(c);
  if (autoRead()) sayOnce(c.back);
}
// Deslizar la tarjeta: derecha = me la sabía, izquierda = otra vez.
function attachSwipe() {
  const el = $("flipcard"); if (!el) return;
  let x0 = null, dx = 0;
  el.addEventListener("pointerdown", (e) => { if (!rs?.flipped) return; x0 = e.clientX; dx = 0; el.style.transition = "none"; });
  el.addEventListener("pointermove", (e) => {
    if (x0 === null) return;
    dx = e.clientX - x0;
    if (Math.abs(dx) > 10) { try { el.setPointerCapture(e.pointerId); } catch (err) {} }
    el.style.transform = `perspective(1200px) translateX(${dx}px) rotate(${dx / 25}deg) rotateY(180deg)`;
    el.classList.toggle("yes", dx > 70); el.classList.toggle("no", dx < -70);
  });
  const end = () => {
    if (x0 === null) return;
    x0 = null; el.style.transition = ""; el.style.transform = ""; el.classList.remove("yes", "no");
    if (Math.abs(dx) > 10) swallowClick = true;
    if (dx > 90) gradeCurrent(2); else if (dx < -90) gradeCurrent(0);
  };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
}
function gradeCurrent(g) {
  const ref = rs.queue[rs.i];
  const { n, c } = findCard(ref);
  if (!c) return;
  markStudyDay();
  if (rs.practice) {
    if (g === 0) rs.queue.push(ref); else { rs.done++; if (!ref.missed) rs.right++; }
    if (g === 0) ref.missed = true;
  } else {
    const wasNew = isNew(c);
    gradeCard(c, g);
    if (wasNew) bumpNewToday();
    if (g === 0) rs.queue.push(ref); else rs.done++;
    saveNote(n);
  }
  rs.i++; rs.flipped = false;
  renderReview(); renderTop();
}

// ---------- Examen de la asignatura ----------
let ex = null; // { subject, questions, answers, recorded }
function startExam(subjectId, missedOnly) {
  stopSpeak(); vStop();
  const scope = notes.filter(n => subjectId === "all" || n.subject === subjectId);
  const pool = scope.flatMap(n => ((missedOnly ? n.missed : n.quiz?.questions) || []).map(q => ({ ...q, from: n.name, noteId: n.id })));
  if (missedOnly && !pool.length) { toast("No tienes preguntas falladas. ¡Bien!"); return; }
  if (!missedOnly && pool.length < 4) { toast("Haz antes algún test en los apuntes de esta asignatura."); return; }
  ex = { subject: subjectId, missed: !!missedOnly, questions: shuffle(pool).slice(0, missedOnly ? 30 : 20), answers: [] };
  mode = "exam"; renderViewer(); renderList(); showViewer();
}
function renderExam() {
  const v = $("viewer");
  const q = ex.questions, a = ex.answers;
  const done = a.filter(x => x !== undefined).length;
  const right = q.reduce((s, x, i) => s + (a[i] === x.answer ? 1 : 0), 0);
  const nota = (10 * right / q.length).toFixed(1).replace(".", ",");
  v.innerHTML = `<div class="vhead"><div><h2>${ex.missed ? "Repaso de fallos" + (ex.subject === "all" ? "" : ": " + esc(sname(ex.subject))) : "Examen de " + esc(sname(ex.subject))}</h2>
      <p class="sub">${ex.missed ? "Las preguntas que fallaste. Si aciertas, dejan de estar en tu lista de fallos." : `${q.length} preguntas mezcladas de los tests de todos sus apuntes.`}</p></div>
      <div class="actions"><button class="small" id="endexam">Salir</button></div></div>
    <div class="actions"><span class="score">${right} de ${q.length}</span><span class="note">${done < q.length ? `Te quedan ${q.length - done}` : ""}</span></div>
    ${quizHtml(q, a, "x", true)}
    ${done === q.length ? `<div class="result"><b>Tu nota: ${nota} sobre 10.</b><span>${verdict(right, q.length)}</span>
      <div class="actions"><button class="small primary" id="examagain">${ex.missed ? "Otra vez" : "Otro examen"}</button><button class="small" id="endexam2">Volver</button></div></div>` : ""}`;
}

// ---------- Hoy: qué estudiar, exámenes y racha ----------
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const daysTo = (date) => Math.round((new Date(date + "T00:00:00").getTime() - startOfToday()) / DAY);
const whenText = (d) => d === 0 ? "hoy" : d === 1 ? "mañana" : `en ${d} días`;
const upcomingExams = () => subjects.filter(s => s.exam && daysTo(s.exam) >= 0).sort((a, b) => daysTo(a.exam) - daysTo(b.exam));
function suggestions() {
  const exams = upcomingExams();
  const urgency = (n) => { const s = subjects.find(x => x.id === n.subject); const d = s?.exam ? daysTo(s.exam) : -1; return d >= 0 && d <= 21 ? (22 - d) / 4 : 0; };
  return notes.filter(n => !n.example || notes.length === 1).map(n => {
    const why = []; let score = urgency(n);
    const due = reviewQueue([n]).length;
    if (due) { score += Math.min(4, due / 3); why.push(`${due} tarjeta${due > 1 ? "s" : ""}`); }
    if (n.quizStats) { const r = n.quizStats.best / n.quizStats.total; if (r < 0.7) { score += (1 - r) * 5; why.push(`sacaste ${n.quizStats.best}/${n.quizStats.total}`); } }
    else { score += 2; why.push("sin test"); }
    if (n.missed?.length) { score += Math.min(3, n.missed.length / 2); why.push(`${n.missed.length} fallo${n.missed.length > 1 ? "s" : ""}`); }
    if (!n.summary) { score += 0.5; }
    if (urgency(n)) why.unshift("examen cerca");
    return { n, score, why };
  }).filter(x => x.why.length).sort((a, b) => b.score - a.score).slice(0, 3);
}
function renderToday() {
  const box = $("today"); if (!box) return;
  if (!notes.length) { box.hidden = true; return; }
  box.hidden = false;
  const due = reviewQueue(notes).length, sk = streak();
  const missed = notes.reduce((k, n) => k + (n.missed?.length || 0), 0);
  const exams = upcomingExams().slice(0, 4), sug = suggestions();
  const date = new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  box.innerHTML = `<div class="row" style="justify-content:space-between;align-items:baseline"><h2>Hoy</h2><span class="note">${date}${sk ? ` · 🔥 ${sk} día${sk > 1 ? "s" : ""}` : ""}</span></div>
    <div class="todaygrid">
      <button class="tile" id="todayreview" ${due ? "" : "disabled"}><b>${due}</b><span>${due === 1 ? "tarjeta para hoy" : "tarjetas para hoy"}</span></button>
      <button class="tile" id="todaymissed" ${missed ? "" : "disabled"}><b>${missed}</b><span>${missed === 1 ? "pregunta fallada" : "preguntas falladas"}</span></button>
    </div>
    ${exams.length ? `<div class="exams">${exams.map(s => { const d = daysTo(s.exam); return `<button class="exam ${d <= 3 ? "soon" : d <= 10 ? "near" : ""}" data-s="${esc(s.id)}"><span class="dd">${d === 0 ? "¡Hoy!" : d}</span><span><b>${esc(s.name)}</b><small>${d === 0 ? "examen hoy" : d === 1 ? "día para el examen" : "días para el examen"} · ${new Date(s.exam + "T00:00").toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" })}</small></span></button>`; }).join("")}</div>`
      : `<p class="note">Pon la fecha de tus exámenes en cada asignatura (botón «Fecha de examen») y aquí verás la cuenta atrás.</p>`}
    ${sug.length ? `<p class="note">Te sugiero repasar:</p><div class="sugg">${sug.map(x => `<button class="item mini" data-id="${esc(x.n.id)}"><span class="name">${esc(x.n.name)}</span><span class="meta">${esc(sname(x.n.subject))} · ${esc(x.why.join(", "))}</span></button>`).join("")}</div>` : ""}`;
}

// ---------- Fallos: las preguntas de test que has fallado ----------
const qKey = (q) => q.question.trim().toLowerCase();
function markAnswer(n, q, right) {
  if (!n) return;
  const k = qKey(q);
  const had = (n.missed || []).some(m => qKey(m) === k);
  if (right && had) n.missed = n.missed.filter(m => qKey(m) !== k);
  else if (!right && !had) { const { from, noteId, ...clean } = q; n.missed = [...(n.missed || []), clean].slice(-100); }
  else return;
  saveNote(n);
}

// ---------- Preguntas para desarrollar (respuesta escrita corregida por Gemini) ----------
const OPEN_SCHEMA = {
  type: "OBJECT",
  properties: { questions: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, key_points: { type: "ARRAY", items: { type: "STRING" } } }, required: ["question", "key_points"] } } },
  required: ["questions"]
};
const OPEN_PROMPT = "Crea 4 PREGUNTAS PARA DESARROLLAR sobre estos apuntes, como las de un examen escrito: que pidan explicar, comparar, justificar o poner ejemplos (no preguntas de sí o no). Para cada una, \"key_points\" son de 2 a 5 ideas que una respuesta completa debe incluir, según los apuntes.";
const GRADE_SCHEMA = {
  type: "OBJECT",
  properties: { score: { type: "NUMBER" }, good: { type: "STRING" }, missing: { type: "ARRAY", items: { type: "STRING" } }, tip: { type: "STRING" } },
  required: ["score", "good", "missing", "tip"]
};
const gradePrompt = (q, answer) => `Corrige la respuesta de Erika a esta pregunta de examen, usando los apuntes como referencia.
Pregunta: ${q.question}
Ideas que debería incluir: ${q.key_points.join("; ")}
Respuesta de Erika: """${answer}"""
"score" es la nota de 0 a 10 (puede llevar decimales, sé justo pero no durísimo; valora las ideas aunque estén dichas con otras palabras). "good" es una frase que diga lo que ha hecho bien. "missing" son las ideas importantes que faltan o que están mal (vacío si no falta nada). "tip" es un consejo corto para mejorar la respuesta. Habla directamente a Erika, en tono cercano.`;
let quizKind = "test";
function renderOpen(n) {
  const c = $("content");
  const b = isBusyWith(n, "abiertas");
  const qs = n.open?.questions || [];
  const kindBtn = (k, l) => `<button class="tab small" data-qk="${k}" aria-pressed="${quizKind === k}">${l}</button>`;
  c.innerHTML = `<div class="stack">
    <div class="actions">${kindBtn("test", "Tipo test")}${kindBtn("desarrollo", "Para desarrollar")}</div>
    <div class="actions"><button class="${qs.length ? "" : "primary"}" id="goopen" ${busy ? "disabled" : ""}>${qs.length ? "Otras preguntas" : "Hacer preguntas"}</button></div>
    ${errHtml(n, "abiertas")}
    ${b ? busyHtml(busy.grading !== undefined ? "Gemini está corrigiendo tu respuesta…" : "Gemini está preparando las preguntas…") : ""}
    ${qs.length ? `<ol class="qlist">${qs.map((q, i) => {
        const r = q.result;
        return `<li class="q"><p><span class="num">${i + 1}.</span>${esc(q.question)}</p>
          ${r ? `<div class="answered">${esc(q.answer)}</div>
            <div class="grade ${r.score >= 7 ? "good" : r.score >= 5 ? "mid" : "low"}"><b>${String(Math.round(r.score * 10) / 10).replace(".", ",")} / 10</b>
              <p>${esc(r.good)}</p>
              ${r.missing?.length ? `<p class="note">Te faltó:</p><ul>${r.missing.map(m => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
              ${r.tip ? `<p class="note">Consejo: ${esc(r.tip)}</p>` : ""}
              <details><summary>Ver lo que debía incluir</summary><ul>${q.key_points.map(p => `<li>${esc(p)}</li>`).join("")}</ul></details>
              <div class="actions"><button class="small ghost" data-reopen="${i}">Intentarlo otra vez</button></div></div>`
          : `<form class="stack openform" data-oq="${i}"><textarea rows="4" placeholder="Escribe tu respuesta como en el examen…" aria-label="Tu respuesta">${esc(q.draft || "")}</textarea>
              <div class="actions"><button class="small primary" type="submit" ${busy ? "disabled" : ""}>Corregir</button></div></form>`}
        </li>`;
      }).join("")}</ol>` : (b ? "" : `<p class="note">Gemini te hace preguntas como las de un examen escrito. Respondes con tus palabras y te corrige: nota, lo que has hecho bien y lo que te faltó.</p>${noKeyHint()}`)}
  </div>`;
}
async function gradeOpen(n, i, answer) {
  answer = answer.trim();
  if (answer.length < 3) { toast("Escribe tu respuesta primero"); return; }
  if (busy || !ensureKey()) return;
  const q = n.open.questions[i]; q.answer = answer; q.draft = answer;
  busy = { id: n.id, what: "abiertas", grading: i }; lastError = null; refreshIfOpen(n.id);
  try {
    const r = parseJSON(await generate(n, { prompt: gradePrompt(q, answer), schema: GRADE_SCHEMA, system: TEACHER }), "la corrección");
    q.result = { score: Math.max(0, Math.min(10, +r.score || 0)), good: r.good || "", missing: r.missing || [], tip: r.tip || "" };
    await saveNote(n);
  } catch (e) {
    lastError = { id: n.id, what: "abiertas", msg: e instanceof AIError ? e.message : "Algo ha fallado: " + (e.message || e) };
  } finally { busy = null; refreshIfOpen(n.id); }
}

// ---------- Acciones ----------
function showViewer() { if (isPhone()) $("viewer").scrollIntoView({ behavior: "smooth", block: "start" }); }
function ensureKey() {
  if (ls.get("gemini-key")) return true;
  openSettings(); $("keyinput").focus(); toast("Primero conecta Gemini");
  return false;
}
function openSettings() { $("settings").hidden = false; $("ideas").hidden = true; renderPrefs(); renderStorage(); renderSyncStatus(); $("settings").scrollIntoView({ behavior: "smooth", block: "start" }); }
// Las fotos se guardan ya giradas, en JPEG y a un tamaño que se lee bien (los HEIC del iPhone no se ven en todos lados).
async function normalizePhoto(f) {
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    if (k === 1 && /jpe?g|png|webp/.test(f.type) && f.size < 2.5 * 1048576) { bmp.close?.(); return f; }
    const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
    const b = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.88)); cv.width = cv.height = 0;
    return b && b.size ? b : f;
  } catch (e) { return f; }
}
async function addFiles(files) {
  if (!files.length) return;
  let subject = $("target").value;
  if (!subject) { const s = { id: uid(), name: "General", created: Date.now() }; await put("subjects", s); subjects.push(s); subject = s.id; }
  let last = null, ok = 0;
  for (const f of files) {
    const n = { id: uid(), subject, name: baseName(f.name), kind: kindOf(f), size: f.size, added: Date.now(), blob: f };
    if (n.kind === "img") { n.blob = await normalizePhoto(f); n.size = n.blob.size; }
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
    } else if (what === "abiertas") {
      const data = parseJSON(await generate(n, { prompt: OPEN_PROMPT, schema: OPEN_SCHEMA, system: TEACHER }), "las preguntas");
      const qs = (data.questions || []).filter(q => q.question && Array.isArray(q.key_points));
      if (!qs.length) throw new AIError("Gemini no ha podido sacar preguntas de este apunte. Vuelve a intentarlo.");
      n.open = { questions: qs, at: Date.now() };
    } else if (what === "podcast") {
      const text = await generate(n, { prompt: PODCAST_PROMPT, system: TEACHER, onText: streamTo(n, "podcast", "audio") });
      n.podcast = { text, at: Date.now() };
      audioSrc = "podcast"; rd.key = null;
    } else if (what === "video") {
      const script = parseJSON(await generate(n, { prompt: VIDEO2_PROMPT, schema: VIDEO2_SCHEMA, system: TEACHER }), "el vídeo");
      script.v = 2;
      script.scenes = (script.scenes || []).filter(s => s.title && s.narration).map(s => ({ ...s, anim: ANIMS.includes(s.anim) ? s.anim : "proceso" }));
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
    toast({ abiertas: "Preguntas listas", podcast: "Explicación lista", resumen: "Resumen listo", quiz: "Test listo", mapa: "Mapa listo", video: "Vídeo listo", tarjetas: "Tarjetas listas" }[what]);
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

// ---------- Sincronización entre dispositivos (Supabase gratis, opcional) ----------
// Cada apunte, asignatura y archivo se sube como una fila; gana la versión cambiada más tarde.
const sync = { busy: false, timer: null, error: "" };
const syncCfg = () => { const c = readJSON("sync", null); return c && c.url && c.key && c.vault ? c : null; };
const syncOn = () => !!syncCfg() && ls.get("sync-on") === "1";
function newVault() { const a = new Uint8Array(24); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function rpc(fn, body, cfg = syncCfg()) {
  let r;
  try {
    r = await fetch(cfg.url.replace(/\/+$/, "") + "/rest/v1/rpc/" + fn, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: cfg.key, Authorization: "Bearer " + cfg.key }, body: JSON.stringify(body)
    });
  } catch (e) { throw new Error(navigator.onLine === false ? "Sin internet: se sincronizará al volver la conexión." : "No se pudo conectar con Supabase. Revisa la dirección del proyecto."); }
  if (!r.ok) {
    let m = ""; try { m = (await r.json()).message || ""; } catch (e) {}
    if (r.status === 404 || /function|schema cache/i.test(m)) throw new Error("Falta preparar Supabase: pega el código SQL en el SQL Editor y pulsa Run.");
    if (r.status === 401 || r.status === 403) throw new Error("Supabase no acepta la clave. Copia la «anon public» (o «publishable») de Project Settings → API.");
    throw new Error("Supabase ha dado un error (" + r.status + "). " + m);
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}
function syncSoon() { if (!syncOn()) return; clearTimeout(sync.timer); sync.timer = setTimeout(syncNow, 2500); }
function tomb(kind, id) {
  if (!syncCfg()) return;
  const t = readJSON("sync-borrados", []).filter(x => !(x.kind === kind && x.id === id));
  t.push({ kind, id, updated: Date.now() });
  ls.set("sync-borrados", JSON.stringify(t)); syncSoon();
}
const stamp = (x) => x.updated || x.added || x.created || 1;
async function syncPush(vault) {
  const since = +ls.get("sync-subido") || 0, started = Date.now();
  const items = [];
  for (const s of subjects) if (stamp(s) > since) items.push({ kind: "subject", id: s.id, data: s, updated: stamp(s) });
  for (const n of notes) if (stamp(n) > since) { const { blob, ...rest } = n; items.push({ kind: "note", id: n.id, data: rest, updated: stamp(n) }); }
  for (const x of sugs()) if ((x.updated || x.at) > since) items.push({ kind: "sug", id: x.id, data: x, updated: x.updated || x.at });
  const tombs = readJSON("sync-borrados", []);
  for (const t of tombs) items.push({ kind: t.kind, id: t.id, updated: t.updated, deleted: true });
  const days = readJSON("dias-repaso", []);
  if (days.length !== +ls.get("sync-dias")) items.push({ kind: "meta", id: "dias-repaso", data: days, updated: started });
  for (let i = 0; i < items.length; i += 40) await rpc("sync_push", { p_vault: vault, p_items: items.slice(i, i + 40) });
  ls.set("sync-dias", String(days.length));
  ls.set("sync-borrados", JSON.stringify(readJSON("sync-borrados", []).filter(t => t.updated > started)));
  // Los archivos (PDF, fotos…) van uno a uno y solo una vez.
  const sent = new Set(readJSON("sync-archivos", []));
  for (const n of notes) {
    if (sent.has(n.id) || !n.blob?.size) continue;
    if (n.blob.size > 15 * 1048576) continue; // demasiado grande para subirlo de una vez
    await rpc("sync_push", { p_vault: vault, p_items: [{ kind: "file", id: n.id, file: await blobToDataURL(n.blob), updated: n.added || 1 }] });
    sent.add(n.id); ls.set("sync-archivos", JSON.stringify([...sent]));
  }
  ls.set("sync-subido", String(started));
}
async function fetchFile(vault, id) {
  const u = await rpc("sync_file", { p_vault: vault, p_id: id });
  return u ? dataURLToBlob(u) : null;
}
async function syncPull(vault) {
  const full = Date.now() - (+ls.get("sync-completo") || 0) > DAY; // una vez al día se repasa todo, por si se escapó algo
  let since = full ? 0 : (+ls.get("sync-cursor") || 0), max = since;
  const changed = new Set();
  const sent = new Set(readJSON("sync-archivos", []));
  for (;;) {
    const rows = await rpc("sync_pull", { p_vault: vault, p_since: since }) || [];
    for (const r of rows) {
      max = Math.max(max, r.srv);
      if (r.kind === "subject") {
        const i = subjects.findIndex(s => s.id === r.id), loc = subjects[i];
        if (r.deleted) { if (loc && stamp(loc) <= r.updated) { await del("subjects", r.id, true); subjects.splice(i, 1); changed.add("*"); } continue; }
        if (!loc || stamp(loc) < r.updated) { await put("subjects", r.data, true); if (loc) subjects[i] = r.data; else subjects.push(r.data); changed.add("*"); }
      } else if (r.kind === "note") {
        const i = notes.findIndex(n => n.id === r.id), loc = notes[i];
        if (r.deleted) { if (loc && stamp(loc) <= r.updated) { await del("notes", r.id, true); notes.splice(i, 1); changed.add(r.id); } continue; }
        if (loc && stamp(loc) >= r.updated) continue;
        const n = { ...r.data, blob: loc?.blob?.size ? loc.blob : null };
        if (!n.blob) { n.blob = await fetchFile(vault, r.id).catch(() => null) || new Blob([]); if (n.blob.size) sent.add(r.id); }
        await put("notes", n, true);
        if (loc) notes[i] = n; else notes.push(n);
        changed.add(r.id);
      } else if (r.kind === "file" && !r.deleted) {
        sent.add(r.id); // ya está en la nube: no hace falta volver a subirlo
        const loc = notes.find(n => n.id === r.id);
        if (loc && !loc.blob?.size) { const b = await fetchFile(vault, r.id).catch(() => null); if (b) { loc.blob = b; await put("notes", loc, true); changed.add(r.id); } }
      } else if (r.kind === "sug") {
        const a = sugs(), i = a.findIndex(x => x.id === r.id), loc = a[i];
        if (r.deleted) { if (loc && (loc.updated || loc.at) <= r.updated) { a.splice(i, 1); saveSugs(a); changed.add("sug"); } continue; }
        if (!loc || (loc.updated || loc.at) < r.updated) { if (loc) a[i] = r.data; else a.push(r.data); saveSugs(a); changed.add("sug"); }
      } else if (r.kind === "meta" && r.id === "dias-repaso" && Array.isArray(r.data)) {
        const mine = readJSON("dias-repaso", []);
        const merged = [...new Set([...mine, ...r.data])].sort((a, b) => new Date(a) - new Date(b)).slice(-400);
        if (merged.length !== mine.length) { ls.set("dias-repaso", JSON.stringify(merged)); changed.add("*"); }
      }
    }
    if (rows.length < 500) break;
    since = rows[rows.length - 1].srv - 1;
  }
  ls.set("sync-archivos", JSON.stringify([...sent]));
  ls.set("sync-cursor", String(max));
  if (full) ls.set("sync-completo", String(Date.now()));
  return changed;
}
async function syncNow(manual) {
  const cfg = syncCfg();
  if (!syncOn() || sync.busy) return;
  if (busy) { syncSoon(); return; } // mientras Gemini trabaja no se tocan los apuntes
  sync.busy = true; renderSyncStatus();
  try {
    const changed = await syncPull(cfg.vault);
    await syncPush(cfg.vault);
    ls.set("sync-ultima", String(Date.now())); sync.error = "";
    if (changed.has("sug")) { renderSugBadge(); if (!$("ideas").hidden && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) renderSugs(); if (sugUnseen()) toast("Hay novedades en el buzón de sugerencias"); changed.delete("sug"); }
    if (changed.size) {
      subjects.sort((a, b) => a.created - b.created); renderToday();
      if (!notes.some(n => n.id === openId)) { openId = null; if (mode === "note") changed.add(openId); }
      renderTop(); renderTabs(); renderList();
      const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "");
      if (mode === "note" && (changed.has(openId) || changed.has(null)) && !typing && !rd.playing && !vp.playing) renderViewer();
    }
    if (manual) toast("Sincronizado");
  } catch (e) {
    sync.error = e.message;
    if (manual) toast(e.message);
  } finally { sync.busy = false; renderSyncStatus(); }
}
function agoText(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "hace un momento" : s < 3600 ? `hace ${Math.round(s / 60)} min` : s < DAY / 1000 ? `hace ${Math.round(s / 3600)} h` : "el " + fmtDate(t);
}
function renderSyncStatus() {
  const box = $("syncbox"); if (!box) return;
  const cfg = syncCfg(), on = syncOn(), last = +ls.get("sync-ultima") || 0;
  if (!cfg) {
    box.innerHTML = `<p class="note">Para tener los mismos apuntes en el móvil y en el ordenador. Es gratis y solo hay que prepararlo una vez:</p>
      <ol class="note">
        <li>Crea una cuenta en <a href="https://supabase.com/dashboard" target="_blank" rel="noopener">supabase.com</a> y pulsa «New project» (plan Free).</li>
        <li>Pulsa <button class="small" type="button" id="copysql">Copiar código</button>, entra en «SQL Editor», pégalo y pulsa «Run».</li>
        <li>En «Project Settings → API» copia la «Project URL» y la clave «anon public» (o «publishable») y pégalas aquí.</li>
      </ol>
      <form class="stack" id="syncform">
        <input type="url" id="syncurl" placeholder="https://xxxx.supabase.co" autocomplete="off" aria-label="Project URL de Supabase">
        <input type="text" id="synckey" placeholder="Clave anon public" autocomplete="off" aria-label="Clave anon de Supabase">
        <div class="actions"><button class="primary small" type="submit">Conectar</button></div>
      </form>`;
    return;
  }
  const state = sync.busy ? "Sincronizando…" : sync.error ? sync.error : on ? (last ? `Sincronizado ${agoText(last)}.` : "Conectado.") : "Configurada, pero este dispositivo no se sincroniza.";
  box.innerHTML = `<p class="note ${sync.error ? "errtext" : ""}">${esc(state)}</p>
    <div class="actions">
      ${on ? `<button class="small primary" id="syncnow" ${sync.busy ? "disabled" : ""}>Sincronizar ahora</button><button class="small ghost" id="syncoff">Desactivar aquí</button>`
        : `<button class="small primary" id="syncon">Activar en este dispositivo</button>`}
      <button class="small danger ghost" id="syncforget">Olvidar configuración</button>
    </div>
    <p class="note">El enlace de «Copiar enlace para otro móvil» ya lleva la sincronización: al abrirlo en otro móvil o en el ordenador, se conecta solo y descarga los apuntes.${on ? "" : " Al activarla aquí se suben también los apuntes de este dispositivo."}</p>`;
}
async function connectSync(url, key) {
  url = url.trim().replace(/\/+$/, ""); key = key.trim();
  if (!/^https:\/\/.+|^http:\/\/localhost/.test(url) || key.length < 20) { toast("Revisa la dirección y la clave"); return; }
  const cfg = { url, key, vault: syncCfg()?.vault || newVault() };
  try { await rpc("sync_pull", { p_vault: cfg.vault, p_since: Date.now() }, cfg); }
  catch (e) { sync.error = ""; toast(e.message); return; }
  ls.set("sync", JSON.stringify(cfg));
  renderSyncStatus(); toast("Supabase conectado");
}
function syncLinkPart() {
  const c = syncCfg(); if (!c) return "";
  return "&sync=" + btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function syncFromText(t) {
  const m = String(t || "").match(/sync=([\w-]+)/); if (!m) return false;
  try {
    const c = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!c.url || !c.key || !c.vault) return false;
    ls.set("sync", JSON.stringify(c)); ls.set("sync-on", "1");
    return true;
  } catch (e) { return false; }
}

// ---------- Enlace con la clave ----------
function keyFromText(t) {
  const m = String(t || "").match(/AIza[\w-]{20,}/); // vale la clave sola o cualquier enlace que la lleve
  return m ? m[0] : null;
}
function saveKey(k) { ls.set("gemini-key", k); ls.del("gemini-models"); }
function readKeyFromLink() {
  const h = location.hash + location.search;
  if (!/clave=|sync=/.test(h)) return;
  const k = keyFromText(decodeURIComponent(h));
  const s = syncFromText(h);
  history.replaceState(null, "", location.pathname);
  if (s && !ls.get("ejemplo-creado")) ls.set("ejemplo-creado", "1"); // los apuntes llegan de la nube: no hace falta el ejemplo
  if (k) saveKey(k);
  if (k || s) setTimeout(() => toast(s ? "Conectado. Descargando tus apuntes…" : "Gemini conectado. ¡Listo para estudiar!"), 600);
}
async function pasteKey() {
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch (e) {}
  const k = keyFromText(text);
  const s = syncFromText(text);
  if (k) saveKey(k);
  if (k || s) { renderTop(); renderSyncStatus(); toast(s ? "Conectado. Descargando tus apuntes…" : "Gemini conectado. ¡Listo para estudiar!"); if (s) syncNow(); }
  else { openSettings(); $("keyinput").focus(); toast("No he encontrado el enlace copiado. Pégalo aquí a mano."); }
}
async function copyKeyLink() {
  const link = location.origin + location.pathname + "#clave=" + encodeURIComponent(ls.get("gemini-key") || "") + syncLinkPart();
  try { await navigator.clipboard.writeText(link); toast("Enlace copiado. Mándaselo por WhatsApp."); }
  catch (e) {
    $("restoreconfirm").innerHTML = "";
    const box = document.createElement("input"); box.type = "text"; box.value = link; box.readOnly = true; box.style.width = "100%";
    $("keylink").after(box); box.select(); toast("Copia el enlace que ha aparecido.");
  }
}

// ---------- Buzón de sugerencias: Erika deja opiniones e ideas y le llegan a Angel ----------
const SUG_TYPES = { bien: "👍 Me gusta", mal: "👎 No me gusta", idea: "💡 Idea", fallo: "🐞 Algo falla" };
const SUG_AREAS = ["General", "Aspecto y colores", "Resúmenes", "Audio", "Tests", "Tarjetas", "Mapas y esquemas", "Vídeos", "Preguntar", "Repasar y examen", "Subir apuntes", "Sincronizar"];
const VIEW_AREA = { resumen: "Resúmenes", audio: "Audio", quiz: "Tests", tarjetas: "Tarjetas", mapa: "Mapas y esquemas", video: "Vídeos", preguntar: "Preguntar" };
const sugs = () => readJSON("sugerencias", []);
const saveSugs = (a) => ls.set("sugerencias", JSON.stringify(a));
let sugType = "idea", sugArea = null, sugReplying = null;
const sugUnseen = () => { const seen = new Set(readJSON("sug-vistas", [])); return sugs().filter(x => !seen.has(x.id + ":" + (x.updated || x.at))).length; };
function markSugsSeen() { ls.set("sug-vistas", JSON.stringify(sugs().map(x => x.id + ":" + (x.updated || x.at)))); renderSugBadge(); }
function renderSugBadge() { const b = $("sugcount"); if (!b) return; const k = sugUnseen(); b.textContent = k; b.hidden = !k; }
const sugText = (x) => `${SUG_TYPES[x.type] || "💬"} · ${x.area}\n${x.text}${x.reply ? `\nRespuesta: ${x.reply}` : ""}`;
function renderSugs() {
  const box = $("sugbox"); if (!box) return;
  const draft = $("sugtext")?.value || "", reply = $("sugreplytext")?.value;
  if ($("sugarea") && sugArea) sugArea = $("sugarea").value;
  const list = sugs().sort((a, b) => b.at - a.at);
  if (!sugArea) sugArea = mode === "note" && openId && VIEW_AREA[view] ? VIEW_AREA[view] : "General";
  box.innerHTML = `
    <p class="note">Escribe lo que te gusta, lo que no, lo que cambiarías o lo que falla. Se le manda a Angel para mejorar la app.</p>
    <form id="sugform" class="stack">
      <div class="actions">${Object.entries(SUG_TYPES).map(([k, v]) => `<button type="button" class="tab small" data-sugtype="${k}" aria-pressed="${sugType === k}">${v}</button>`).join("")}</div>
      <label class="note" for="sugarea">¿Sobre qué?</label>
      <select id="sugarea">${SUG_AREAS.map(a => `<option ${a === sugArea ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>
      <textarea id="sugtext" rows="3" placeholder="${sugType === "fallo" ? "¿Qué estabas haciendo y qué pasó?" : sugType === "mal" ? "¿Qué no te gusta y cómo te gustaría que fuera?" : sugType === "bien" ? "¿Qué te ha gustado?" : "Cuéntame tu idea…"}" aria-label="Tu sugerencia"></textarea>
      <div class="actions"><button class="primary" type="submit">Enviar</button></div>
    </form>
    <p class="note">${syncOn() ? "Le llega sola a Angel por la sincronización." : "Esta app no tiene la sincronización puesta: al enviarla, pulsa «Mandar por WhatsApp» para que le llegue."}</p>
    ${list.length ? `<div class="sugs">${list.map(x => `<article class="sug ${x.done ? "done" : ""}">
        <div class="row" style="justify-content:space-between"><b>${SUG_TYPES[x.type] || "💬"}</b><span class="note">${esc(x.area)} · ${fmtDate(x.at)}</span></div>
        <p>${esc(x.text)}</p>
        ${x.reply ? `<p class="sugreply"><b>Respuesta:</b> ${esc(x.reply)}</p>` : ""}
        ${sugReplying === x.id ? `<form class="row" id="sugreplyform" data-id="${esc(x.id)}"><input type="text" id="sugreplytext" value="${esc(x.reply || "")}" placeholder="Escribe la respuesta" aria-label="Respuesta"><button class="small primary" type="submit">Guardar</button></form>` : ""}
        <div class="actions">
          <span class="chip ${x.done ? "ok" : ""}">${x.done ? "Hecho ✓" : "Pendiente"}</span>
          <button class="small ghost" data-sugdone="${esc(x.id)}">${x.done ? "Volver a pendiente" : "Marcar hecho"}</button>
          <button class="small ghost" data-sugreply="${esc(x.id)}">Responder</button>
          <button class="small ghost" data-sugwa="${esc(x.id)}">Mandar por WhatsApp</button>
          <button class="small ghost" data-sugdel="${esc(x.id)}" aria-label="Borrar sugerencia">Borrar</button>
        </div></article>`).join("")}</div>
      <div class="actions"><button class="small" id="sugcopy">Copiar todas</button></div>` : ""}`;
  $("sugtext").value = draft;
  if (reply !== undefined && $("sugreplytext")) $("sugreplytext").value = reply;
}
function sugUpdate(id, patch) {
  const a = sugs(), x = a.find(s => s.id === id); if (!x) return;
  Object.assign(x, patch, { updated: Date.now() }); saveSugs(a); syncSoon(); renderSugs(); markSugsSeen();
}
function sugWhatsApp(x) { window.open("https://wa.me/?text=" + encodeURIComponent("Sugerencia para la app de apuntes:\n" + sugText(x)), "_blank", "noopener"); }
function openSugs() { $("ideas").hidden = false; $("settings").hidden = true; sugArea = null; sugReplying = null; renderSugs(); markSugsSeen(); $("ideas").scrollIntoView({ behavior: "smooth", block: "start" }); }

// ---------- Eventos ----------
document.addEventListener("click", async (e) => {
  if (swallowClick) { swallowClick = false; if (e.target.closest("#flipcard")) return; }
  const si = e.target.closest("[data-si]"); if (si) { rdJump(+si.dataset.si); if (!rd.playing) rdPlay(); return; }
  const stage = e.target.closest("#vstage"); if (stage) { const nn = notes.find(x => x.id === openId); if (nn?.video) vToggle(nn); return; }
  if (e.target.id === "cpick") { if (cpDownOnBackdrop) closeColorPicker(); return; }
  const t = e.target.closest("button"); if (!t) return;
  const n = notes.find(x => x.id === openId);
  if (t.dataset.vstyle && n?.video) { ls.set("video-estilo", t.dataset.vstyle); document.querySelectorAll("[data-vstyle]").forEach(b => b.setAttribute("aria-pressed", b === t)); if (vp.playing) vPlayScene(n); else vDraw(n, false); return; }
  if (t.dataset.cpick) { openColorPicker(t.dataset.cpick); return; }
  if (t.dataset.cpv) { cpSet(t.dataset.cpv); return; }
  if (t.id === "cpok") { closeColorPicker(); return; }
  if (t.id === "cpreset") { cpickTarget(cpick.key)?.reset(); closeColorPicker(); return; }
  if (t.dataset.cpreset) { setPartColor(t.dataset.cpreset, null); renderPrefs(); return; }
  if (t.dataset.palette) { applyPalette(t.dataset.palette); return; }
  // ajustes personales
  if (t.dataset.bgpreset) {
    const p = BG_PRESETS[t.dataset.bgpreset]; const keep = bgCfg();
    ls.set("fondo", JSON.stringify(p.color ? { color: p.color, color2: p.color2, pattern: p.pattern, patColor: p.patColor, opacity: p.opacity, panels: keep.panels } : { panels: keep.panels }));
    applyPrefs(); renderPrefs(); return;
  }
  if (t.dataset.bgpat) { setBg({ pattern: t.dataset.bgpat, opacity: ["rayas", "cuadricula", "puntos", "milimetrado", "estrellas"].includes(t.dataset.bgpat) ? 0.45 : 0.2 }); renderPrefs(); return; }
  if (t.dataset.bgpanels) { setBg({ panels: t.dataset.bgpanels }); renderPrefs(); return; }
  if (t.id === "bggrad") { const b = bgCfg(); setBg(b.color2 ? { color2: null } : { color: b.color || "#f6f8fb", color2: mix(b.color || "#f6f8fb", "#c9b8ff", 0.35) }); renderPrefs(); return; }
  if (t.id === "bgphotodel") { ls.del("fondo-foto"); applyPrefs(); renderPrefs(); return; }
  if (t.id === "photoopen" || t.id === "photozoom") { if (photoView.url) openPhoto(photoView.url); return; }
  if (t.id === "lbclose") { closePhoto(); return; }
  if (t.id === "lbin") { $("lightbox").zoom(1.5); return; }
  if (t.id === "lbout") { $("lightbox").zoom(1 / 1.5); return; }
  if (t.id === "lbrot") { $("lightbox").rot(); return; }
  if (t.id === "lbfit") { $("lightbox").fit(); return; }
  if (t.id === "bgreset") { ls.del("fondo"); ls.del("fondo-foto"); applyPrefs(); renderPrefs(); toast("Fondo normal"); return; }
  if (t.dataset.color) { ls.set("color", t.dataset.color); applyPrefs(); renderPrefs(); return; }
  if (t.dataset.pref) {
    const k = t.dataset.pref, v = t.dataset.val; ls.set(k, v);
    if (k === "resumen-defecto") sumMode = v;
    if (k === "preguntas-defecto") quizCount = +v;
    applyPrefs(); renderPrefs(); renderTop(); renderSubjTools();
    if (mode === "note" && (view === "tarjetas" || view === "quiz" || view === "resumen")) renderViewer();
    return;
  }
  if (t.id === "copysql") {
    try { const sql = await (await fetch("supabase.sql", { cache: "no-store" })).text(); await navigator.clipboard.writeText(sql); toast("Código copiado. Pégalo en el SQL Editor."); }
    catch (err) { toast("No se pudo copiar. Ábrelo aquí: " + location.origin + location.pathname + "supabase.sql"); }
    return;
  }
  if (t.id === "syncnow") { syncNow(true); return; }
  if (t.id === "syncon") { ls.set("sync-on", "1"); renderSyncStatus(); syncNow(true); return; }
  if (t.id === "syncoff") { ls.set("sync-on", "0"); renderSyncStatus(); return; }
  if (t.id === "syncforget") {
    if (!t.dataset.sure) { t.dataset.sure = "1"; t.textContent = "¿Seguro? Toca otra vez"; return; }
    ["sync", "sync-on", "sync-subido", "sync-cursor", "sync-archivos", "sync-borrados", "sync-completo", "sync-ultima", "sync-dias"].forEach(k => ls.del(k));
    renderSyncStatus(); toast("Sincronización quitada de este dispositivo"); return;
  }
  if (t.id === "voicetest") { sayOnce("Hola Erika, así sonarán tus resúmenes y tus vídeos."); return; }
  // cabecera y ajustes
  if (t.id === "reviewbtn") { startReview(notes, "Repaso de hoy"); return; }
  if (t.id === "sugbtn") { if ($("ideas").hidden) openSugs(); else $("ideas").hidden = true; return; }
  if (t.id === "ideasclose") { $("ideas").hidden = true; return; }
  if (t.dataset.sugtype) { sugType = t.dataset.sugtype; renderSugs(); return; }
  if (t.dataset.sugdone) { const x = sugs().find(s => s.id === t.dataset.sugdone); sugUpdate(t.dataset.sugdone, { done: !x?.done }); return; }
  if (t.dataset.sugreply) { sugReplying = sugReplying === t.dataset.sugreply ? null : t.dataset.sugreply; renderSugs(); $("sugreplytext")?.focus(); return; }
  if (t.dataset.sugwa) { const x = sugs().find(s => s.id === t.dataset.sugwa); if (x) sugWhatsApp(x); return; }
  if (t.dataset.sugdel) { if (!confirm("¿Borrar esta sugerencia?")) return; saveSugs(sugs().filter(s => s.id !== t.dataset.sugdel)); tomb("sug", t.dataset.sugdel); renderSugs(); renderSugBadge(); return; }
  if (t.id === "sugcopy") { const txt = sugs().sort((a, b) => a.at - b.at).map(x => `${fmtDate(x.at)} · ${sugText(x)}${x.done ? " (hecho)" : ""}`).join("\n\n"); navigator.clipboard?.writeText(txt).then(() => toast("Copiadas. Pégalas donde quieras."), () => toast("No se pudo copiar.")); return; }
  if (t.id === "settingsbtn") { if ($("settings").hidden) openSettings(); else $("settings").hidden = true; return; }
  if (t.id === "settingsclose") { $("settings").hidden = true; return; }
  if (t.id === "welcomeok") { ls.set("bienvenida-vista", "1"); renderTop(); if (!ls.get("gemini-key")) openSettings(); return; }
  if (t.id === "keyforget") { ls.del("gemini-key"); ls.del("gemini-models"); renderTop(); toast("Clave quitada"); return; }
  if (t.id === "keylink") { copyKeyLink(); return; }
  if (t.id === "pastekey" || t.id === "pastekey2") { pasteKey(); return; }
  if (t.id === "backupbtn" || t.id === "bannerbackup") { if (t.id === "bannerbackup") openSettings(); doBackup(); return; }
  if (t.id === "noticeok") { ls.set("aviso-ios-luego", "1"); renderNotice(); return; }
  if (t.id === "bannerlater") { ls.set("aviso-copia-luego", String(Date.now() + 5 * DAY)); renderTop(); return; }
  if (t.id === "restoreyes") { if (busy) { toast("Espera a que Gemini termine."); return; } applyRestore(); return; }
  if (t.id === "restoreno") { pendingRestore = null; $("restoreconfirm").innerHTML = ""; return; }
  // asignaturas
  if (t.dataset.s) { current = t.dataset.s; subjMode = null; renderTabs(); renderList(); return; }
  if (t.id === "addsubj") { $("newsubj").hidden = false; $("subjname").focus(); return; }
  if (t.id === "cancelsubj") { $("newsubj").hidden = true; return; }
  if (t.id === "subjexam") { subjMode = "exam"; renderSubjTools(); return; }
  if (t.id === "examclear") { const s = subjects.find(x => x.id === current); if (s) { delete s.exam; await put("subjects", s); } subjMode = null; renderSubjTools(); renderToday(); return; }
  if (t.id === "subjmissed") { startExam(current, true); return; }
  if (t.id === "todayreview") { startReview(notes, "Repaso de hoy"); return; }
  if (t.id === "todaymissed") { startExam("all", true); return; }
  if (t.id === "subjrename") { subjMode = "rename"; renderSubjTools(); return; }
  if (t.id === "subjdel") { subjMode = "delete"; renderSubjTools(); return; }
  if (t.id === "subjcancel") { subjMode = null; renderSubjTools(); return; }
  if (t.id === "examgo" || t.id === "examagain") { startExam(t.id === "examgo" ? current : ex.subject, t.id === "examagain" && ex.missed); return; }
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
  if (t.id === "flipcard" || t.id === "showans") { flipCard(); return; }
  if (t.id === "cardspeak" && rs) { const { c } = findCard(rs.queue[rs.i]); if (c) sayOnce(rs.flipped ? c.back : c.front); return; }
  if (t.dataset.g !== undefined && rs) { gradeCurrent(+t.dataset.g); return; }
  if (t.id === "endreview" || t.id === "endreview2") { rs = null; mode = "note"; renderViewer(); renderList(); renderTop(); return; }
  // examen
  if (t.dataset.xq !== undefined && ex) {
    const i = +t.dataset.xq, q = ex.questions[i];
    ex.answers[i] = +t.dataset.o;
    markAnswer(notes.find(x => x.id === q.noteId), q, ex.answers[i] === q.answer);
    renderExam(); renderToday(); return;
  }
  if (t.id === "endexam" || t.id === "endexam2") { ex = null; mode = "note"; renderViewer(); renderList(); return; }
  if (!n) return;
  // apunte abierto
  if (t.id === "backlist") { $("listcol").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  if (t.dataset.v) { stopSpeak(); vStop(); cardEdit = null; view = t.dataset.v; lastError = null; renderViewer(); return; }
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
  if (t.id === "speakbtn") { view = "audio"; audioSrc = "resumen"; await renderViewer(); rdPlay(); return; }
  // audio
  if (t.dataset.as) { rdStop(); audioSrc = t.dataset.as; lastError = null; renderViewer(); return; }
  if (t.id === "gopodcast") { rdStop(); runAI(n, "podcast"); return; }
  if (t.id === "rdplay") { if (rd.playing) rdStop(); else rdPlay(); return; }
  if (t.id === "rdprev" || t.id === "rdnext") { rdJump(rd.i + (t.id === "rdnext" ? 1 : -1)); return; }
  // tarjetas
  if (t.id === "listencards") { view = "audio"; audioSrc = "tarjetas"; await renderViewer(); rdPlay(); return; }
  if (t.id === "cardaddtoggle") { cardAdd = !cardAdd; renderViewer(); if (cardAdd) $("cafront").focus(); return; }
  if (t.dataset.ce) { cardEdit = t.dataset.ce; renderViewer(); $("cefront")?.focus(); return; }
  if (t.id === "cecancel") { cardEdit = null; renderViewer(); return; }
  if (t.dataset.cd) {
    if (!t.dataset.sure) { t.dataset.sure = "1"; t.textContent = "¿Seguro?"; return; }
    n.cards = (n.cards || []).filter(k => k.id !== t.dataset.cd); await saveNote(n); renderViewer(); renderTop(); renderList(); toast("Tarjeta borrada"); return;
  }
  if (t.id === "copysum") { try { await navigator.clipboard.writeText(n.summary.text); toast("Resumen copiado"); } catch (err) { toast("No se pudo copiar"); } return; }
  if (t.id === "goquiz" || t.id === "goquiz2") { runAI(n, "quiz"); return; }
  if (t.dataset.qc) { quizCount = +t.dataset.qc; renderViewer(); return; }
  if (t.dataset.q !== undefined) {
    const i = +t.dataset.q, q = n.quiz.questions[i];
    (answers[n.id] ||= [])[i] = +t.dataset.o;
    markAnswer(n, q, +t.dataset.o === q.answer);
    renderViewer(); renderToday(); return;
  }
  if (t.dataset.qk) { quizKind = t.dataset.qk; lastError = null; renderViewer(); return; }
  if (t.id === "goopen") { runAI(n, "abiertas"); return; }
  if (t.dataset.reopen !== undefined) { const q = n.open.questions[+t.dataset.reopen]; delete q.result; await saveNote(n); renderViewer(); return; }
  if (t.id === "retry" || t.id === "retry2") { answers[n.id] = []; recorded[n.id] = false; renderViewer(); return; }
  if (t.id === "gocards") { runAI(n, "tarjetas"); return; }
  if (t.dataset.cc) { cardCount = +t.dataset.cc; renderViewer(); return; }
  if (t.id === "reviewnote") { startReview([n], "Repaso: " + n.name); return; }
  if (t.id === "practicenote") { startReview([n], "Práctica: " + n.name, true); return; }
  if (t.id === "delcards") { if (t.dataset.sure) { n.cards = []; await saveNote(n); renderViewer(); renderTop(); renderList(); toast("Tarjetas borradas"); } else { t.dataset.sure = "1"; t.textContent = "Toca otra vez para confirmar"; } return; }
  if (t.id === "gomap") { runAI(n, "mapa"); return; }
  if (t.dataset.mm) { mapMode = t.dataset.mm; renderViewer(); return; }
  if (t.id === "govideo") { vStop(); runAI(n, "video"); return; }
  if (t.id === "vplay" && n.video) { vToggle(n); return; }
  if (t.id === "vfull") { vFullscreen(); return; }
  if (t.dataset.vs !== undefined && n.video) { vp.i = +t.dataset.vs; vp.ended = false; if (vp.playing) vPlayScene(n); else { vClear(); vDraw(n, false); } return; }
  if ((t.id === "vnext" || t.id === "vprev") && n.video) {
    const max = n.video.script.scenes.length - 1;
    vp.i = Math.min(max, Math.max(0, vp.i + (t.id === "vnext" ? 1 : -1))); vp.ended = false;
    if (vp.playing) vPlayScene(n); else { vClear(); vDraw(n, false); }
    return;
  }
  if (t.dataset.ask) { ask(n, t.dataset.ask); return; }
  if (t.id === "clearchat") { n.chat = []; await saveNote(n); renderViewer(); return; }
});
document.addEventListener("input", (e) => {
  const id = e.target.id, v = e.target.value;
  if (id === "cph" || id === "cps" || id === "cpl") { cpick.hsl[{ cph: 0, cps: 1, cpl: 2 }[id]] = +v; cpSet(hslToHex(...cpick.hsl), true); }
  else if (id === "cphex") { const h = (v.startsWith("#") ? v : "#" + v).toLowerCase(); if (hexOk(h)) cpSet(h); }
  else if (id === "bgopacity") setBg({ opacity: +v });
  else if (id === "bgsize") setBg({ size: +v });
  else if (id === "bgveil") setBg({ veil: +v });
  else if (id === "bgblur") setBg({ blur: +v });
  else if (id === "bgangle") setBg({ angle: +v });
});
document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("bgcustom")) ls.set("fondo-abierto", e.target.open ? "1" : "0"); }, true);
document.addEventListener("change", (e) => {
  if (e.target.id === "bgphoto" && e.target.files[0]) { setBgPhoto(e.target.files[0]); e.target.value = ""; }
  const n = notes.find(x => x.id === openId);
  if (e.target.id === "rate") { setRate(+e.target.value); if (rd.playing) rdPlay(); }
  if (e.target.id === "vmusic") { ls.set("video-musica", e.target.checked ? "1" : "0"); if (!e.target.checked) musicStop(); else if (vp.playing) musicStart(); return; }
  if (e.target.id === "vauto") { ls.set("video-auto", e.target.checked ? "1" : "0"); return; }
  if (e.target.id === "vrate") { setRate(+e.target.value); if (vp.playing && !vp.waiting && n?.video) vPlayScene(n); }
  if (e.target.id === "prefrate") setRate(+e.target.value);
  if (e.target.id === "voicesel") { ls.set("voz", e.target.value); pickVoice(); sayOnce("Así suena esta voz."); }
  if (e.target.id === "restorefile" && e.target.files[0]) { readBackup(e.target.files[0]); e.target.value = ""; }
});
document.addEventListener("submit", async (e) => {
  const id = e.target.id;
  if (id === "sugform") {
    e.preventDefault();
    const text = $("sugtext").value.trim(); if (!text) { toast("Escribe algo antes de enviar."); return; }
    const x = { id: uid(), type: sugType, area: $("sugarea").value, text, at: Date.now(), updated: Date.now(), done: false };
    saveSugs([...sugs(), x]); markSugsSeen(); syncSoon();
    sugArea = x.area; $("sugtext").value = ""; renderSugs();
    toast(syncOn() ? "¡Gracias! Le llegará a Angel." : "Guardada. Pulsa «Mandar por WhatsApp» para que le llegue.");
    return;
  }
  if (id === "sugreplyform") { e.preventDefault(); const rid = e.target.dataset.id; sugReplying = null; sugUpdate(rid, { reply: $("sugreplytext").value.trim() }); return; }
  if (["renameform", "editform", "askform", "keyform", "newsubj", "cardeditform", "cardaddform", "syncform", "examdateform"].includes(id) || e.target.classList.contains("openform")) e.preventDefault(); else return;
  const n = notes.find(x => x.id === openId);
  if (id === "keyform") {
    const raw = $("keyinput").value.trim(); if (!raw) return;
    const k = keyFromText(decodeURIComponent(raw)) || raw; // también vale pegar el enlace entero
    saveKey(k); $("keyinput").value = "";
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
  } else if (e.target.classList.contains("openform") && n) {
    gradeOpen(n, +e.target.dataset.oq, e.target.querySelector("textarea").value);
  } else if (id === "examdateform") {
    const s = subjects.find(x => x.id === current), v = $("examdate").value;
    if (s && v) { s.exam = v; await put("subjects", s); toast("Fecha guardada"); }
    subjMode = null; renderSubjTools(); renderToday();
  } else if (id === "syncform") {
    await connectSync($("syncurl").value, $("synckey").value);
  } else if (id === "cardeditform" && n) {
    const k = (n.cards || []).find(x => x.id === e.target.dataset.card);
    const f = $("cefront").value.trim(), b = $("ceback").value.trim();
    if (k && f && b) { k.front = f; k.back = b; await saveNote(n); }
    cardEdit = null; renderViewer(); toast("Tarjeta guardada");
  } else if (id === "cardaddform" && n) {
    const f = $("cafront").value.trim(), b = $("caback").value.trim();
    if (!f || !b) { toast("Escribe la pregunta y la respuesta"); return; }
    n.cards = [...(n.cards || []), newCard(f, b)]; await saveNote(n);
    renderViewer(); renderTop(); renderList(); $("cafront")?.focus(); toast("Tarjeta añadida");
  } else if (id === "askform" && n) {
    const q = $("askinput").value; $("askinput").value = ""; ask(n, q);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("cpick") && !$("cpick").hidden) { closeColorPicker(); return; }
  if (e.key === "Escape" && $("lightbox") && !$("lightbox").hidden) { closePhoto(); return; }
  if (e.key === "Escape" && $("player")?.classList.contains("theater")) { vFullscreen(); return; }
  if (e.target.id === "askinput" && e.key === "Enter" && !e.shiftKey && !isPhone()) { e.preventDefault(); $("askform").requestSubmit(); }
  if (mode === "review" && rs && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
    if (e.key === " " && !rs.flipped) { e.preventDefault(); flipCard(); }
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
document.addEventListener("visibilitychange", () => { if (!document.hidden) { renderTop(); renderList(); syncNow(); } });
window.addEventListener("online", () => syncNow());
setInterval(() => { if (!document.hidden) syncNow(); }, 120000);

// ---------- Arranque ----------
applyPrefs();
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
  syncNow();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
