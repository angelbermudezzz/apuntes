# Apuntes de Erika

App web privada para subir apuntes (PDF, Word, texto o fotos), ordenarlos por asignatura y estudiarlos con Gemini: resúmenes (también en audio), tests, tarjetas de repaso, mapas mentales y esquemas, vídeo-lecciones, un examen por asignatura y un chat para preguntar dudas.

Está hecha para una sola persona y no aparece en buscadores.

## Cómo dársela a Erika

1. En tu móvil, abre la app, entra en **Ajustes** y pega la clave de Gemini (se saca gratis en https://aistudio.google.com/apikey).
2. Pulsa **Copiar enlace para otro móvil** y mándaselo por WhatsApp. El enlace lleva la clave dentro: al abrirlo, su app queda conectada sin pegar nada. No lo compartas con nadie más.
3. Que lo abra en **Chrome** (Android) o **Safari** (iPhone) y la instale:
   - Android: menú ⋮ → «Añadir a pantalla de inicio» o «Instalar app».
   - iPhone: botón Compartir → «Añadir a pantalla de inicio».

En iPhone, la app instalada guarda sus datos aparte de Safari. Si al abrirla desde el icono pide conectar Gemini, que copie el enlace de WhatsApp y lo pegue en **Ajustes** (vale pegar el enlace entero).

Desde el icono se abre como una app normal y funciona sin internet para ver los apuntes y lo ya creado. Para crear cosas nuevas hace falta internet.

## Dónde se guardan las cosas

- Todo se guarda en el propio móvil (IndexedDB). No hay servidor ni cuentas.
- **Ajustes → Guardar copia** descarga un archivo con todos los apuntes; **Recuperar una copia** lo vuelve a cargar (en ese móvil o en otro). La app avisa si hace tiempo que no se guarda una.
- La clave de Gemini se guarda solo en el navegador y nunca va en este repositorio.

## Técnica

HTML, CSS y JavaScript sin compilar (`index.html`, `styles.css`, `app.js`), publicados con GitHub Pages desde `main`. `sw.js` guarda la app para abrirla sin conexión. pdf.js y mammoth se cargan solo al abrir un PDF o un Word.
