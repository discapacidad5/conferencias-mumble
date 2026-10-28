/* Conferencia — SPA cliente (livekit-client v2) */
const LC = window.LivekitClient;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// iPhone/iPad: todos los navegadores iOS son WebKit y su procesamiento de
// voz baja el micro solo; por eso iOS arranca con AGC apagado y ganancia 200%
const esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// webview dentro de otra app (WhatsApp, Facebook, Instagram, Telegram...):
// es el peor contexto — historial raro, audio capado, permisos limitados
const esInApp = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Telegram|Twitter|Line\//i.test(navigator.userAgent);
// PWA instalada ("Añadir a pantalla de inicio"): sin chrome del navegador
const esStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const esAndroid = /Android/i.test(navigator.userAgent);
// evento beforeinstallprompt guardado para el botón "Instalar" (se
// declara aquí porque boot() corre antes que el listener de abajo)
let deferredInstall = null;

const S = {
  sala: null, salaNombre: '', nombre: null, token: null, identidad: null,
  esAdmin: false, adminUsuario: null,
  room: null, evt: null, estado: null, servidor: '', servidorSSE: false, estadoRecibido: 0,
  micProhibido: false, micProhibidos: [], reacciones: new Map(),
  panProhibido: false, panProhibidos: [], docProhibido: false, docProhibidos: [],
  vistaLocal: null, vistaSync: null,
  dev: { cam: null, mic: null, spk: null },
  sinCam: false,
  activo: null,              // identidad del orador dominante
  miGrupo: 0, grupoActual: 0, grupos: [], ultTiempo: 0, invitacion: '',
  icePolicy: '', iceServers: null, rec: null, grabadores: new Set(),
  wb: { strokes: [], mios: [], trazoId: '', cargado: false, dibujando: false, color: '#ffffff', grosor: 3,
        herramienta: 'lapiz', laser: {}, relleno: false },
  audio: { pub: null, ctx: null, ganancia: esIOS ? 2 : 1, ns: true, ec: true, agc: !esIOS, on: false },
  // PTT / piso exclusivo: modo 'auto' (micro libre), 'hold' (mantener
  // pisado) o 'lock' (tocar para bloquear/soltar). quiero = dedo/intención
  // pisada; tengo = el servidor confirmó el piso
  ptt: {
    modo: localStorage.getItem('lk_ptt_modo') || 'hold',
    quiero: false, tengo: false, desde: 0, _bloqueado: false, _gesto: null,
    silencio: Math.min(5, +(localStorage.getItem('lk_ptt_silencio')) || 2.2),
    sens: +(localStorage.getItem('lk_ptt_sens')) || 2.0,
    ataque: +(localStorage.getItem('lk_ptt_ataque')) || 0.12,
  },
  pisoCfg: null, pisoFaltan: 0,
  // historial local de notas de voz (IndexedDB): tope en MB y auto-salto
  segCapMB: +(localStorage.getItem('lk_seg_mb') || 100),
  autoPresente: localStorage.getItem('lk_auto_presente') === '1',
  _nvEls: new Map(),  // seq -> elemento del chat (chip de nota de voz)
  _nvSeqs: [],        // seqs en orden (encadenado al re-escuchar)
  _nvRepro: 0,        // seq que se está re-escuchando ahora
  prefAudio: localStorage.getItem('lk_audio_pref') || 'auto', // auto | telefono | voz | musica
  calidadMala: false,        // última lectura de ConnectionQuality del propio cliente
  calidadRed: 'media',       // 'mala' (~10 kbps) | 'media' (~18 kbps) | 'buena' (~28 kbps)
  previewStream: null, micCtx: null, micStream: null, micAnalyser: null,
  votos: { aFavor: 0, enContra: 0, mi: 0 }, _sentado: false, _palabra: false,
  // salida de audio: volumen general y por persona — solo amplificación
  // (100-300%): no se puede bajar ni silenciar desde la app, para eso
  // están los botones físicos del dispositivo
  volMaster: Math.max(1, +(localStorage.getItem('lk_vol_master') || 1)),
  volPor: {}, salidas: new Map(), salidaCtx: null,
  // audio compartido en vivo (pista 🎵): tarjeta en la vista documento.
  // volMusica = mi slider local (0-1.5); musicaBase = el volumen que fija
  // quien lo emite y llega por mensaje aud_vol
  musica: null, volMusica: 1, musicaBase: 1,
  ultLobby: 0,
};
// el motor (conferencia-engine.js) accede al estado como window.S
window.S = S;
const flotantes = new Map();
let flotanteOrden = 0;
const avisosPalabra = new Set(); // umbrales ya avisados (2', 1', 30")

// Cachea un elemento de vídeo por track y superficie visible: la misma
// instancia no se puede compartir entre el asiento, la rejilla y Personas.
const videoEls = new Map();
function videoDe(p, source, superficie) {
  const pub = p.getTrackPublication(source);
  const track = pub && !pub.isMuted && pub.track;
  const key = `${superficie}:${p.identity}:${source}`;
  const cur = videoEls.get(key);
  if (!track) { videoEls.delete(key); return null; }
  if (cur && cur.track === track) return cur.el;
  const el = track.attach();
  el.muted = true; el.playsInline = true;
  videoEls.set(key, { track, el });
  return el;
}
function limpiarVideoEls(track) {
  for (const [k, v] of videoEls) if (v.track === track) videoEls.delete(k);
}

/* ---------- utilidades ---------- */
function toast(msg, ms = 5000, cls = '') {
  // duración legible: piso 4s + ~55ms por carácter — los mensajes largos
  // antes desaparecían antes de poder leerlos. Tocarlo lo cierra ya.
  ms = Math.max(ms, 4000 + String(msg).length * 55);
  const t = document.createElement('div');
  t.className = ('toast ' + cls).trim(); t.textContent = msg;
  t.title = 'Toca para cerrar';
  t.onclick = () => t.remove();
  $('#toast-wrap').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function cerrarModal(id) {
  document.getElementById(id).classList.add('oculto');
  // al cerrar ajustes se libera siempre el medidor para no dejar el
  // micrófono del teléfono ocupado cuando estás silenciado o de pie
  if (id === 'modal-ajustes') detenerMedidor();
}
function abrirModal(id) {
  document.getElementById(id).classList.remove('oculto');
  if (S.room) empujarCapa('modal:' + id,
    () => !document.getElementById(id).classList.contains('oculto'));
}
window.cerrarModal = cerrarModal;

/* historial por capa: cada capa visible empuja una entrada en el historial,
   así "atrás" cierra la capa de más arriba antes de preguntar por salir */
const capasH = [];
let suprimirPop = false;
// WebKit de iOS (iPhone: Safari Y Chrome de iOS, todos son WebKit) dispara
// popstate espurio tras ciertos pushState — sin este sello el handler creía
// que era "atrás" y el "¿Salir?" parpadeaba en bucle abriéndose solo
let ultimoPushH = 0;
let pushRecientes = 0;
function empujarCapa(id, abierta) {
  capasH.push({ id, abierta });
  try {
    ultimoPushH = Date.now();
    pushRecientes = Math.min(pushRecientes + 1, 10);
    history.pushState({ capa: id }, '');
  } catch {}
}

// modal genérico interno (nada de confirm()/prompt() del navegador)
function genModal(titulo, cuerpoHtml, fn, okText) {
  $('#gen-titulo').textContent = titulo;
  $('#gen-cuerpo').innerHTML = cuerpoHtml;
  const ok = $('#gen-ok'), cancel = $('#gen-cancel');
  // okText null = sin botón de aceptar (diálogos que son solo opciones)
  ok.classList.toggle('oculto', okText === null);
  cancel.textContent = 'Cancelar';
  if (okText !== null) {
    ok.textContent = okText || 'Aceptar';
    ok.onclick = () => { cerrarModal('modal-gen'); fn(); };
  }
  cancel.onclick = () => cerrarModal('modal-gen');
  abrirModal('modal-gen');
  const inp = $('#gen-cuerpo input');
  if (inp) { inp.focus(); inp.select(); inp.onkeydown = (e) => { if (e.key === 'Enter') ok.click(); }; }
}
const confirmar = (titulo, fn) => genModal(titulo, '', fn);
const preguntarNumero = (titulo, defecto, fn) =>
  genModal(titulo, `<input id="gen-num" type="number" min="0" value="${defecto}" style="width:100%">`, () => fn(+$('#gen-num').value || 0));
const preguntarTexto = (titulo, fn) =>
  genModal(titulo, '<input id="gen-txt" type="text" style="width:100%">', () => { const v = $('#gen-txt').value.trim(); if (v) fn(v); });

// elegir duración de la palabra: presets rápidos + último usado marcado +
// campo libre. El último tiempo usado queda preseleccionado (verde).
function elegirTiempoPalabra(titulo, fn) {
  const ult = S.ultTiempo || 0;
  let html = '<div class="palabra-tiempo">';
  [[60, '1 min'], [180, '3 min'], [300, '5 min'], [0, 'Sin límite']]
    .forEach(([s, t]) => {
      html += `<button class="btn mini${s === ult ? ' prim' : ''}" data-pt="${s}">${t}${s === ult ? ' ✓' : ''}</button>`;
    });
  // otro tiempo: minutos y segundos por separado (sin ambigüedad)
  html += '</div><div class="fila" style="margin-top:.6rem;gap:.4rem;align-items:center">'
    + '<input id="pt-min" type="number" min="0" placeholder="min" style="width:70px">'
    + '<span class="muted">:</span>'
    + '<input id="pt-seg" type="number" min="0" max="59" placeholder="seg" style="width:70px">'
    + '<button class="btn mini" id="pt-manual">Dar</button></div>';
  genModal(titulo, html, () => {}, null);
  $$('#gen-cuerpo [data-pt]').forEach(b => b.onclick = () => {
    cerrarModal('modal-gen'); fn(+b.dataset.pt);
  });
  $('#pt-manual').onclick = () => {
    const total = (+$('#pt-min').value || 0) * 60 + (+$('#pt-seg').value || 0);
    cerrarModal('modal-gen'); fn(Math.max(0, total));
  };
}

async function api(path, body, opts = {}) {
  const headers = opts.headers || {};
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  const res = await fetch(path, {
    method: opts.method || (body !== undefined ? 'POST' : 'GET'),
    headers,
    body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'error ' + res.status), { status: res.status });
  return data;
}
const accion = async (tipo, asiento, extra = {}) => {
  const r = await api(`/api/salas/${S.sala}/accion`, { tipo, asiento, ...extra });
  comprobarInstancia(r.instancia);
  refrescarEstado();
  return r;
};
const moderar = async (tipo, extra = {}) => {
  const r = await api(`/api/salas/${S.sala}/moderar`, { tipo, ...extra });
  refrescarEstado();
  return r;
};
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mostrar(vistaId) {
  $$('.vista').forEach(v => v.classList.add('oculto'));
  $(vistaId).classList.remove('oculto');
}

/* ---------- arranque ---------- */
async function boot() {
  const q = new URLSearchParams(location.search);
  let sala = q.get('sala');
  if (!sala) {
    const m = location.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)/);
    if (m) sala = m[1];
  }
  S.sala = sala;
  avisoNavegador();
  try { S.adminUsuario = (await api('/api/admin/me')).usuario; } catch {}
  if (!sala) { iniciarPortada(); return; }
  // en el teléfono, antes de encender cámara/micro: pantalla para elegir
  // web o app. En escritorio o dentro de la PWA se entra directo.
  if ((esAndroid || esIOS) && !esStandalone) mostrarEntrada(sala);
  else iniciarPrejoin(sala);
}

/* Aviso según contexto del navegador:
   - webview de otra app → botón que abre el navegador del sistema
     (Android: esquema intent://; iOS 17+: esquema x-safari-https://)
   - navegador instalable (Chrome/Edge) → botón "Instalar" via
     beforeinstallprompt; si el evento no llega, instrucciones de menú
   - Safari iOS → instrucciones "Añadir a pantalla de inicio" (modo app,
     sin barra del navegador: además se acaban los popstate fantasma) */
// la ✕ del banner lo silencia 24h en este navegador (timestamp, no
// bandera: quien lo cierra hoy lo vuelve a ver mañana)
function navTipVisto() {
  const t = +localStorage.getItem('nav_tip_ok') || 0;
  return t && Date.now() - t < 864e5;
}

// PWA ya instalada = no insistir. Tres vías de saberlo: marca propia
// (appinstalled), getInstalledRelatedApps (Chrome, via related_applications
// del manifest) y el propio modo standalone si la está usando
async function pwaInstalada() {
  // la marca local manda: la API de Chrome es ciega para detectar la
  // propia WebAPK (devuelve vacío aunque esté instalada), así que solo
  // sirve como confirmación positiva, nunca para borrar la marca.
  // Las marcas falsas se limpian solas vía el fallback appcheck del
  // intent de "Abrir en la app".
  if (localStorage.getItem('pwa_instalada')) return true;
  try {
    if (navigator.getInstalledRelatedApps &&
        (await navigator.getInstalledRelatedApps()).some(a => a.platform === 'webapp')) {
      localStorage.setItem('pwa_instalada', String(Date.now()));
      return true;
    }
  } catch {}
  return false;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (esInApp || esStandalone || navTipVisto()) return;
  // la marca local puede mentir (app desinstalada): verificar antes de
  // decidir si mostrar "Instalar" u ocultar el banner
  pwaInstalada().then(inst => {
    if (inst) return;
    mostrarNavTip('Puedes instalarla como app: quedará en tu pantalla de inicio y se abrirá a pantalla completa.',
      'Instalar', async () => {
        deferredInstall.prompt();
        await deferredInstall.userChoice.catch(() => {});
        deferredInstall = null;
        $('#nav-tip').classList.add('oculto');
      });
  });
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  localStorage.setItem('pwa_instalada', String(Date.now()));
  $('#nav-tip')?.classList.add('oculto');
});

function mostrarNavTip(msg, btnTxt, onBtn, btnHref) {
  const tip = $('#nav-tip');
  if (!tip) return;
  $('#nav-tip-txt').textContent = msg;
  const btn = $('#nav-tip-btn');
  if (btnTxt) {
    btn.textContent = btnTxt;
    btn.classList.remove('oculto');
    if (btnHref) btn.href = btnHref;
    else btn.removeAttribute('href');
    // sin href el onclick manda y hay que frenar el "#" por defecto
    btn.onclick = onBtn ? (e) => { e.preventDefault(); onBtn(e); } : null;
  } else {
    btn.classList.add('oculto');
  }
  tip.classList.remove('oculto');
  $('#nav-tip-x').onclick = () => {
    tip.classList.add('oculto');
    localStorage.setItem('nav_tip_ok', String(Date.now()));
  };
}

async function avisoNavegador() {
  if (esStandalone || !$('#nav-tip')) return;
  if (esInApp) {
    // escapar del webview con un toque; cada SO tiene su esquema. En
    // Android el intent abre el navegador POR DEFECTO del usuario (si
    // usa Firefox, Firefox — respetamos su elección); en iOS, Safari
    const u = location;
    const escapeUrl = esAndroid
      ? `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(':', '')};S.browser_fallback_url=${encodeURIComponent(u.href)};end`
      : `x-safari-${u.protocol}//${u.host}${u.pathname}${u.search}`;
    mostrarNavTip('Estás en el navegador interno de otra app: el audio y la sala funcionan mejor fuera. Toca el botón para abrirla en tu navegador.',
      'Abrir en el navegador', null, escapeUrl);
    return;
  }
  if (navTipVisto()) return;
  if (await pwaInstalada()) {
    // ya instalada pero entró por el navegador: ofrecer abrir la app —
    // en Android el enlace salta a la WebAPK; si no, abre pestaña nueva
    mostrarNavTip('Ya la tienes instalada: ábrela como app — pantalla completa y más estable.',
      'Abrir en la app', () => {
        location.href = esAndroid ? urlAbrirApp(S.sala) : location.href;
      });
    return;
  }
  if (deferredInstall) return; // el listener de arriba ya mostró su banner
  if (esIOS) {
    mostrarNavTip('En iPhone puedes instalarla como app: toca Compartir → «Añadir a pantalla de inicio». Se abrirá a pantalla completa y más estable.');
  } else if (esAndroid) {
    mostrarNavTip('Puedes instalarla como app: menú ⋮ del navegador → «Instalar app» o «Añadir a pantalla de inicio».');
  }
}

// getInstalledRelatedApps (Chrome Android): devuelve qué apps propias
// están instaladas — la PWA (webapp) y la nativa (play). La nativa
// declara la relación inversa vía asset_statements en su manifest.
async function appsRelacionadas() {
  try {
    const apps = await (navigator.getInstalledRelatedApps?.() || []);
    return {
      nativa: apps.some(a => a.platform === 'play' || /conferencia/.test(a.id || '')),
      pwa: apps.some(a => a.platform === 'webapp')
    };
  } catch { return { nativa: false, pwa: false }; }
}

/* ---------- elegir entrada (móvil): web o app, sin encender nada ----------
   El link ?sala= abre esta pantalla en vez del prejoin: nada de cámara,
   nombre ni red todavía. La persona elige dónde quiere la sala. */
// intent a la nativa; si no está instalada, el fallback_url vuelve a
// esta página con appcheck=1 — Android se lo entrega a la PWA si existe
// (la abre) y si no existe ninguna app revela la marca falsa
function urlAbrirApp(sala) {
  const vuelta = location.href + (location.search ? '&' : '?') + 'appcheck=1';
  return 'intent://entrar?servidor=' + encodeURIComponent(location.origin) +
    '&sala=' + encodeURIComponent(sala || '') +
    '#Intent;scheme=conferencia;package=com.conferencia.app;' +
    'S.browser_fallback_url=' + encodeURIComponent(vuelta) + ';end';
}

async function mostrarEntrada(sala) {
  mostrar('#vista-entrada');
  try {
    const info = await api(`/api/salas/${sala}/info`);
    $('#e-titulo').textContent = 'Sala: ' + (info.nombreVisible || sala);
    $('#e-sub').textContent = info.deshabilitada && !S.adminUsuario
      ? '⛔ Sala deshabilitada por el administrador.'
      : info.privada ? 'Sala privada — te pedirá la contraseña al entrar.' : 'Sala pública.';
  } catch {
    $('#e-titulo').textContent = 'Sala: ' + sala;
    $('#e-sub').textContent = '';
  }
  $('#e-web').onclick = () => iniciarPrejoin(sala);
  const btn = $('#e-app');
  btn.classList.remove('oculto');
  if (esInApp) {
    // dentro del webview de otra app lo urgente es salir al navegador
    btn.textContent = 'Abrir en el navegador';
    const u = location;
    btn.onclick = () => {
      location.href = esAndroid
        ? `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(':', '')};S.browser_fallback_url=${encodeURIComponent(u.href)};end`
        : `x-safari-${u.protocol}//${u.host}${u.pathname}${u.search}`;
    };
    return;
  }
  // el fallback del intent aterrizó aquí con appcheck: ningún app tomó
  // el link. La marca (si no acaba de ponerse) era mentira — borrarla
  if (new URLSearchParams(location.search).get('appcheck') &&
      (+localStorage.getItem('pwa_instalada') || 0) < Date.now() - 300e3)
    localStorage.removeItem('pwa_instalada');
  const rel = await appsRelacionadas();
  const hayApp = rel.nativa || rel.pwa || !!localStorage.getItem('pwa_instalada');
  if (esAndroid && hayApp) {
    // un solo botón sirve para ambas: el intent abre la nativa si está;
    // si no, el fallback_url navega a esta misma URL y Android se la
    // entrega a la PWA instalada. Verde para distinguirlo del "Instalar"
    btn.textContent = '📱 Abrir en la app';
    btn.classList.remove('prim');
    btn.classList.add('exito');
    btn.onclick = () => { location.href = urlAbrirApp(sala); };
  } else {
    // azul (prim): acción distinta que la verde de abrir
    btn.textContent = '📲 Instalar la app';
    btn.classList.remove('exito');
    btn.classList.add('prim');
    btn.onclick = async () => {
      if (!deferredInstall) {
        mostrarNavTip(esIOS
          ? 'En iPhone: toca Compartir → «Añadir a pantalla de inicio» — se abrirá como app a pantalla completa.'
          : 'Menú ⋮ del navegador → «Instalar app» o «Añadir a pantalla de inicio».');
        return;
      }
      deferredInstall.prompt();
      const res = await deferredInstall.userChoice.catch(() => null);
      deferredInstall = null;
      // se quede o no instalada, nadie manda a la web sin que elija el
      // botón "Abrir en el navegador": la tarjeta se queda quieta
      if (res?.outcome === 'accepted') {
        localStorage.setItem('pwa_instalada', String(Date.now()));
        // Android tarda un rato en mintar la WebAPK y poner el icono —
        // mostramos una animación y esperamos el evento `appinstalled`
        // (o un tope de 60 s) antes de ofrecer "Abrir en la app"
        animarInstalacion(sala);
      } else {
        toast('Instalación cancelada — puedes seguir por el navegador');
      }
    };
  }
}

// pantalla "instalando": anillo que se llena hasta que Android confirme
// la WebAPK (appinstalled) o pasen ~60 s. Terminado, la tarjeta vuelve
// con el botón verde "Abrir en la app".
function animarInstalacion(sala) {
  const prog = $('#e-prog');
  $('#e-app').classList.add('oculto');
  $('#e-web').classList.add('oculto');
  prog.classList.remove('oculto');
  let hecho = false;
  const fin = () => {
    if (hecho) return;
    hecho = true;
    prog.classList.add('oculto');
    $('#e-app').classList.remove('oculto');
    $('#e-web').classList.remove('oculto');
    toast('App instalada — búscala en tu pantalla de inicio');
    mostrarEntrada(sala); // repinta con "Abrir en la app" (verde)
  };
  window.addEventListener('appinstalled', fin, { once: true });
  setTimeout(fin, 60e3);
}

// requisito para que Chrome ofrezca la instalación (beforeinstallprompt)
if ('serviceWorker' in navigator && !esInApp) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
boot();

/* ---------- portada ---------- */
function iniciarPortada() {
  mostrar('#vista-portada');
  const zone = $('#p-admin-zone');
  if (S.adminUsuario) {
    zone.innerHTML = `<button class="btn prim" id="p-panel">Panel de administración (${esc(S.adminUsuario)})</button>`;
    $('#p-panel').onclick = iniciarAdmin;
  } else {
    zone.innerHTML = `<button class="btn link" id="p-login">Soy administrador</button>`;
    $('#p-login').onclick = () => abrirModal('modal-login');
  }
  $('#p-ir').onclick = () => {
    const s = $('#p-sala').value.trim();
    if (s) location.href = '/?sala=' + encodeURIComponent(s);
  };
  $('#p-ir-enlace').onclick = () => {
    try {
      const u = new URL($('#p-enlace').value.trim());
      location.href = u.href;
    } catch { toast('Enlace no válido'); }
  };
}

/* ---------- login admin ---------- */
$('#lg-entrar').onclick = async () => {
  try {
    const r = await api('/api/login', { usuario: $('#lg-usuario').value, clave: $('#lg-clave').value });
    S.adminUsuario = r.usuario;
    cerrarModal('modal-login');
    if (S.sala) {
      $('#pj-admin-link').textContent = 'Sesión admin activa: ' + S.adminUsuario;
      $('#pj-admin-link').disabled = true;
      toast('Sesión admin iniciada. Pulsa "Entrar" para unirte con privilegios.');
    } else iniciarAdmin();
  } catch (e) { $('#lg-error').textContent = e.message; }
};

/* ---------- dashboard admin ---------- */
async function iniciarAdmin() {
  mostrar('#vista-admin');
  $('#a-usuario').textContent = S.adminUsuario;
  $('#a-salir').onclick = async () => { await api('/api/logout', {}); location.href = '/'; };
  // la gestión de salas va en su modal: crear/borrar/deshabilitar detrás del
  // botón, no a la vista directa en el panel
  $('#a-salas-btn').onclick = () => { abrirModal('modal-salas'); listarSalasAdmin(); };
  $('#ms-nueva').onclick = () => $('#ms-crear').classList.toggle('oculto');
  $('#ms-crear-btn').onclick = async () => {
    const nombre = $('#ms-nombre').value.trim();
    try {
      await api('/api/admin/salas', { nombre, clave: $('#ms-clave').value });
      $('#ms-nombre').value = ''; $('#ms-clave').value = '';
      $('#ms-crear').classList.add('oculto');
      toast('Sala creada'); listarSalasAdmin();
    } catch (e) { toast(e.message); }
  };
  $('#a-crear-usuario').onclick = async () => {
    try {
      await api('/api/admin/usuarios', { usuario: $('#a-nuevo-usuario').value, clave: $('#a-nuevo-pass').value });
      toast('Usuario creado');
    } catch (e) { toast(e.message); }
  };
  listarSalasAdmin();
}

async function listarSalasAdmin() {
  const salas = await api('/api/admin/salas');
  $('#ms-lista').innerHTML = salas.map(s => {
    const url = location.origin + '/?sala=' + encodeURIComponent(s.nombre);
    const visible = s.nombreVisible || s.nombre;
    return `<div class="sala-fila">
      <div><strong>${esc(visible)}</strong> ${s.nombreVisible ? `<code class="muted">${esc(s.nombre)}</code>` : ''}
        ${s.privada ? '<span class="chip">privada</span>' : ''}
        ${s.deshabilitada ? '<span class="chip chip-peligro">deshabilitada</span>' : ''}
        <span class="muted"> · creada por ${esc(s.creador)}</span></div>
      <div class="fila">
        <code>${esc(url)}</code>
        <button class="btn mini" data-copy="${esc(url)}">Copiar enlace</button>
        <a class="btn mini prim" href="${url}" target="_blank">Abrir</a>
        <button class="btn mini" data-ren="${esc(s.nombre)}" data-vis="${esc(s.nombreVisible || '')}">✎ Nombre</button>
        <button class="btn mini" data-tog="${esc(s.nombre)}" data-off="${s.deshabilitada ? 0 : 1}">${s.deshabilitada ? '✅ Habilitar' : '⛔ Deshabilitar'}</button>
        <button class="btn mini peligro" data-del="${esc(s.nombre)}">Borrar</button>
      </div></div>`;
  }).join('') || '<p class="muted">No hay salas.</p>';
  $$('#ms-lista [data-copy]').forEach(b => b.onclick = () =>
    navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Enlace copiado')));
  $$('#ms-lista [data-ren]').forEach(b => b.onclick = () =>
    genModal('Nombre para mostrar — ' + b.dataset.ren,
      `<p class="muted">El enlace sigue siendo <code>${esc(b.dataset.ren)}</code>; esto solo cambia cómo se ve. Vacío = usar el enlace.</p>
       <input id="gen-txt" type="text" maxlength="80" style="width:100%" value="${esc(b.dataset.vis)}">`,
      async () => {
        await api('/api/admin/salas/' + encodeURIComponent(b.dataset.ren),
          { nombreVisible: $('#gen-txt').value.trim() });
        listarSalasAdmin();
      }, 'Guardar'));
  $$('#ms-lista [data-tog]').forEach(b => b.onclick = () =>
    api('/api/admin/salas/' + encodeURIComponent(b.dataset.tog) + '/estado',
      { deshabilitada: b.dataset.off === '1' })
      .then(listarSalasAdmin).catch(e => toast(e.message)));
  $$('#ms-lista [data-del]').forEach(b => b.onclick = () =>
    confirmar('¿Borrar la sala "' + b.dataset.del + '"?', async () => {
      await api('/api/admin/salas/' + encodeURIComponent(b.dataset.del), undefined, { method: 'DELETE' });
      listarSalasAdmin();
    }));
}
window.toast = toast;

/* ---------- pre-sala ---------- */
// Sesión por sala: recuerda nombre/clave/identidad para reingresar tras
// una recarga sin reescribir nada y volver a la misma sala de discusión.
function sesionSala() {
  try { return JSON.parse(localStorage.getItem('conf:' + S.sala) || 'null'); } catch { return null; }
}
function guardarSesion() {
  try {
    localStorage.setItem('conf:' + S.sala,
      JSON.stringify({ nombre: S.nombre, clave: S.clave || '', identidad: S.identidad }));
  } catch {}
}

async function iniciarPrejoin(sala) {
  let info;
  try { info = await api(`/api/salas/${sala}/info`); }
  catch {
    mostrar('#vista-portada');
    $('#p-admin-zone').insertAdjacentHTML('beforebegin', `<p class="error">La sala «${esc(sala)}» no existe o no está disponible.</p>`);
    return;
  }
  S.salaNombre = info.nombreVisible || sala;
  $('#pj-titulo').textContent = 'Sala: ' + S.salaNombre;
  mostrar('#vista-prejoin');
  // sala apagada por el admin: avisar ya aquí en vez de fallar al entrar
  if (info.deshabilitada && !S.adminUsuario)
    $('#pj-sub').textContent = '⛔ Sala deshabilitada por el administrador.';
  else
    $('#pj-sub').textContent = info.privada ? 'Sala privada — necesitas la contraseña.' : 'Sala pública.';
  if (info.privada) $('#pj-clave-wrap').classList.remove('oculto');
  $('#pj-admin-link').textContent = S.adminUsuario
    ? 'Sesión admin activa: ' + S.adminUsuario
    : 'Entrar como administrador';
  if (S.adminUsuario) $('#pj-admin-link').disabled = true;
  $('#pj-admin-link').onclick = () => abrirModal('modal-login');
  $('#pj-entrar').onclick = entrar;
  // en Android: ofrecer abrir la sala directamente en la app nativa
  // (dentro de la PWA standalone no tiene sentido: ya estás en "la app")
  const pjApp = $('#pj-app');
  if (pjApp && /Android/i.test(navigator.userAgent) && !esStandalone) {
    pjApp.classList.remove('oculto');
    pjApp.href = 'intent://entrar?servidor=' + encodeURIComponent(location.origin) +
      '&sala=' + encodeURIComponent(S.sala) +
      '#Intent;scheme=conferencia;package=com.conferencia.app;' +
      'S.browser_fallback_url=' + encodeURIComponent(location.href) + ';end';
    pjApp.onclick = (ev) => {
      // si la app no está instalada, el intent falla: caer a conferencia://
      setTimeout(() => { if (!document.hidden) {
        pjApp.href = 'conferencia://entrar?servidor=' + encodeURIComponent(location.origin) +
          '&sala=' + encodeURIComponent(S.sala);
      } }, 800);
    };
  }
  const ses = sesionSala();
  if (ses && ses.nombre) {
    $('#pj-nombre').value = ses.nombre;
    if (ses.clave) $('#pj-clave').value = ses.clave;
    $('#pj-entrar').textContent = 'Volver a entrar';
  }
  await prepararDispositivos();
}

async function prepararDispositivos() {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    st.getTracks().forEach(t => t.stop()); // solo para desbloquear permisos/etiquetas
  } catch (e) { avisoPermisos(e); }
  const devs = await navigator.mediaDevices.enumerateDevices();
  const llenar = (sel, tipo, etiqueta) => {
    const el = $(sel);
    el.innerHTML = '<option value="">Predeterminado del sistema</option>';
    devs.filter(d => d.kind === tipo && !(tipo === 'audiooutput' && d.deviceId === 'default'))
      .forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${etiqueta} ${i + 1}`;
      el.appendChild(o);
    });
  };
  llenar('#pj-cam', 'videoinput', 'Cámara');
  llenar('#pj-mic', 'audioinput', 'Micrófono');
  llenar('#pj-spk', 'audiooutput', 'Altavoz');
  // selección guardada en el navegador (lk_dev_*) tiene prioridad; si no hay
  // nada guardado queda "Predeterminado del sistema", salvo en teléfonos,
  // donde preferimos la salida "speaker" sobre el auricular de llamada
  const existe = (sel, v) => v && [...$(sel).options].some(o => o.value === v);
  const gCam = localStorage.getItem('lk_dev_cam');
  const gMic = localStorage.getItem('lk_dev_mic');
  const gSpk = localStorage.getItem('lk_dev_spk');
  if (existe('#pj-cam', gCam)) $('#pj-cam').value = gCam;
  if (existe('#pj-mic', gMic)) $('#pj-mic').value = gMic;
  if (existe('#pj-spk', gSpk)) $('#pj-spk').value = gSpk;
  else if (gSpk === null && /android|iphone|ipad/i.test(navigator.userAgent)) {
    const spkPref = [...$('#pj-spk').options].find(o => /speaker|altavoz|speakerphone/i.test(o.textContent));
    if (spkPref) $('#pj-spk').value = spkPref.value;
  }
  S.dev.cam = $('#pj-cam').value; S.dev.mic = $('#pj-mic').value; S.dev.spk = $('#pj-spk').value;

  $('#pj-cam').onchange = () => { S.dev.cam = $('#pj-cam').value; guardarDev(); arrancarPreview(); };
  $('#pj-mic').onchange = () => { S.dev.mic = $('#pj-mic').value; guardarDev(); arrancarMedidor(); };
  $('#pj-spk').onchange = () => { S.dev.spk = $('#pj-spk').value; guardarDev(); aplicarSink(); };
  $('#pj-mic-btn').onclick = () => {
    const off = $('#pj-mic-btn').classList.toggle('off');
    if (off) detenerMedidor(); else arrancarMedidor();
  };
  $('#pj-cam-btn').onclick = () => {
    const off = $('#pj-cam-btn').classList.toggle('off');
    if (off) {
      if (S.previewStream) { S.previewStream.getTracks().forEach(t => t.stop()); S.previewStream = null; }
      $('#pj-video').srcObject = null;
    } else arrancarPreview();
  };
  $('#pj-probar').onclick = probarAltavoz;
  arrancarPreview();
  arrancarMedidor();
}

async function arrancarPreview() {
  if (S.previewStream) S.previewStream.getTracks().forEach(t => t.stop());
  try {
    S.previewStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: S.dev.cam ? { exact: S.dev.cam } : undefined },
    });
    $('#pj-video').srcObject = S.previewStream;
    $('#pj-error').textContent = '';
  } catch (e) { avisoPermisos(e); }
}

// getUserMedia rechazado: decir dónde se concede el permiso según el
// contexto. La PWA instalada es una app Android aparte — no hereda los
// permisos de Chrome; los suyos se activan en Ajustes del teléfono.
function avisoPermisos(e) {
  const denegado = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
  const msg = denegado
    ? (esStandalone
      ? 'La app no tiene permiso de cámara y micrófono. Actívalos en Ajustes del teléfono → Aplicaciones → Conferencias → Permisos.'
      : 'El navegador bloqueó la cámara/micrófono. Toca el candado 🔒 de la barra de direcciones y permite el acceso.')
    : 'Sin acceso a cámara/micrófono' + (e?.name ? ` (${e.name})` : '');
  toast(msg);
  const err = $('#pj-error');
  if (err) err.textContent = msg;
}

// si se fue a Ajustes a dar el permiso y vuelve, reintentar sin que
// tenga que tocar nada (la página conserva su estado al volver)
document.addEventListener('visibilitychange', () => {
  if (document.hidden || $('#vista-prejoin').classList.contains('oculto')) return;
  if (!S.previewStream && !$('#pj-cam-btn').classList.contains('off')) arrancarPreview();
  if (!S.micStream && !$('#pj-mic-btn').classList.contains('off')) arrancarMedidor();
});

let medidorId = 0;
function detenerMedidor() {
  medidorId++;
  if (S.micStream) S.micStream.getTracks().forEach(t => t.stop());
  if (S.micCtx) S.micCtx.close().catch(() => {});
  S.micStream = null; S.micCtx = null; S.micAnalyser = null;
  $('#pj-nivel').style.width = '0%';
  $('#aj-nivel').style.width = '0%';
}

async function arrancarMedidor() {
  detenerMedidor();
  if (S.audio.analyser && S.audio.rawStream?.getAudioTracks()[0]?.readyState === 'live') {
    $('#aj-mensaje').textContent = '';
    return;
  }
  const id = medidorId;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: S.dev.mic ? { exact: S.dev.mic } : undefined },
    });
    if (id !== medidorId) { stream.getTracks().forEach(t => t.stop()); return; }
    S.micStream = stream;
    const ctx = new AudioContext();
    S.micCtx = ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    S.micAnalyser = an;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    $('#aj-mensaje').textContent = '';
    (function medir() {
      if (S.micCtx !== ctx || id !== medidorId) return;
      an.getByteFrequencyData(buf);
      const nivel = buf.reduce((a, b) => a + b, 0) / buf.length / 255;
      const w = Math.min(100, nivel * 300) + '%';
      $('#pj-nivel').style.width = w;
      $('#aj-nivel').style.width = w;
      requestAnimationFrame(medir);
    })();
  } catch (e) {
    if (id === medidorId) {
      detenerMedidor();
      if (!$('#modal-ajustes').classList.contains('oculto'))
        $('#aj-mensaje').textContent = 'No se pudo acceder al micrófono: ' + e.message;
    }
  }
}

// guardarDev: la elección manual de dispositivos se recuerda en el
// navegador (localStorage) — al reentrar se restaura si aún existe
function guardarDev() {
  localStorage.setItem('lk_dev_cam', S.dev.cam || '');
  localStorage.setItem('lk_dev_mic', S.dev.mic || '');
  localStorage.setItem('lk_dev_spk', S.dev.spk || '');
}

function probarAltavoz() {
  // la prueba suena por el mismo canal que usará la sala: WebAudio
  // (multimedia) cuando esa es la vía activa
  if (usarWebAudio()) {
    if (!S.salidaCtx) S.salidaCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = S.salidaCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (S.dev.spk && ctx.setSinkId) ctx.setSinkId(S.dev.spk).catch(() => {});
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.25;
    osc.frequency.value = 660;
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.7);
    return;
  }
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.frequency.value = 660;
  osc.connect(dest);
  const audio = new Audio();
  audio.srcObject = dest.stream;
  if (S.dev.spk && audio.setSinkId) audio.setSinkId(S.dev.spk);
  audio.play();
  osc.start();
  setTimeout(() => { osc.stop(); ctx.close(); }, 700);
}

function aplicarSink() {
  document.querySelectorAll('audio[data-lk]').forEach(a => {
    if (a.setSinkId && S.dev.spk) a.setSinkId(S.dev.spk).catch(() => {});
  });
  if (S.salidaCtx && S.salidaCtx.setSinkId && S.dev.spk)
    S.salidaCtx.setSinkId(S.dev.spk).catch(() => {});
  // un cambio de salida puede mover el audio entre la vía <audio> y la
  // vía WebAudio (setSinkId solo existe en una de las dos según navegador)
  ajustarSalidas();
}

/* ---------- volumen de salida (amplificador) ---------- */
// volumen efectivo de un participante: general × individual. Suelo en
// 100% (la app nunca baja el volumen, eso es cosa del dispositivo) y
// techo en 300% — solo existe la amplificación.
function volEfectivo(id) {
  return Math.min(3, Math.max(1, S.volMaster * (S.volPor[id] || 1)));
}
// La vía preferida es WebAudio (MediaStreamSource → GainNode → destino):
// suena por el canal MULTIMEDIA — en el teléfono eso significa altavoz por
// defecto, botones físicos controlando el volumen de medios y el sensor
// de proximidad fuera del juego; además permite amplificar >100%. La vía
// <audio> queda como respaldo cuando no hay WebAudio o cuando el usuario
// eligió una salida concreta que el AudioContext no puede respetar.
const ctxTieneSink = () => {
  const AC = window.AudioContext || window.webkitAudioContext;
  return !!(AC && AC.prototype.setSinkId);
};
function usarWebAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  return !S.dev.spk || ctxTieneSink();
}
function ajustarSalida(sid) {
  const s = S.salidas.get(sid);
  if (!s) return;
  // la música compartida sí se puede bajar/silenciar: cada oyente tiene su
  // slider (volMusica) y quien emite fija el nivel base (musicaBase)
  const g = s.musica
    ? Math.min(3, Math.max(0, S.volMaster * S.volMusica * S.musicaBase * (S.volPor[s.id] || 1)))
    : volEfectivo(s.id);
  // Si la pista viene del motor de voz, ya tiene su propio GainNode directo
  // en el AudioContext nativo de recepción: ajustarlo directo evita cruzar un
  // MediaStream entre dos AudioContext distintos (que causa cortes y ruido).
  if (s.track && typeof s.track.setDirectOutput === 'function') {
    if (s.src) { try { s.src.disconnect(); s.gain.disconnect(); } catch {} s.src = s.gain = null; }
    s.el.muted = true;
    s.track.setDirectOutput(g, S.dev.spk || '');
    return;
  }
  if (!usarWebAudio()) {
    if (s.src) { try { s.src.disconnect(); s.gain.disconnect(); } catch {} s.src = s.gain = null; }
    s.el.muted = false;
    s.el.volume = Math.min(1, g); // el elemento llega solo hasta 100%
    if (s.el.setSinkId && S.dev.spk) s.el.setSinkId(S.dev.spk).catch(() => {});
    return;
  }
  if (!S.salidaCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    S.salidaCtx = new AC();
  }
  // autoplay: si el contexto nació sin gesto de usuario queda suspendido.
  // Mientras no corra dejamos el elemento sonando a 100% — nunca silencio —
  // y el resume() re-entra aquí cuando el navegador lo permita.
  if (S.salidaCtx.state === 'suspended')
    S.salidaCtx.resume().then(() => {
      if (S.salidas.has(sid)) ajustarSalida(sid);
    }).catch(() => {});
  if (S.salidaCtx.state !== 'running') { s.el.muted = false; s.el.volume = 1; return; }
  s.el.muted = true; // a partir de aquí suena por WebAudio, no por el elemento
  if (S.dev.spk && S.salidaCtx.setSinkId)
    S.salidaCtx.setSinkId(S.dev.spk).catch(() => {});
  if (!s.src) {
    try {
      // la fuente es el MediaStream que el propio <audio> está sonando;
      // mediaStreamTrack es el plan A, srcObject el respaldo
      const ms = s.track && s.track.mediaStreamTrack
        ? new MediaStream([s.track.mediaStreamTrack])
        : s.el.srcObject;
      if (!(ms instanceof MediaStream) || !ms.getAudioTracks().length) {
        s.el.muted = false; s.el.volume = 1; return;
      }
      s.src = S.salidaCtx.createMediaStreamSource(ms);
      s.gain = S.salidaCtx.createGain();
      s.src.connect(s.gain); s.gain.connect(S.salidaCtx.destination);
    } catch (e) { console.warn('amplificador:', e); s.el.muted = false; s.el.volume = 1; return; }
  }
  s.gain.gain.value = g;
}
function ajustarSalidas() { S.salidas.forEach((_, sid) => ajustarSalida(sid)); }

// llenarDisp: rellena un <select> con los dispositivos de un tipo
async function llenarDisp(sel, tipo, actual) {
  let disp = [];
  try { disp = await navigator.mediaDevices.enumerateDevices(); } catch {}
  // el dispositivo 'default' es el mismo que nuestra opción Predeterminado:
  // en teléfonos es el único que expone el navegador y saldría duplicado
  sel.innerHTML = '<option value="">Predeterminado</option>' +
    disp.filter(d => d.kind === tipo && !(tipo === 'audiooutput' && d.deviceId === 'default'))
      .map(d => `<option value="${d.deviceId}" ${d.deviceId === actual ? 'selected' : ''}>${esc(d.label || 'Dispositivo')}</option>`).join('');
}

/* ---------- entrar a la sala ---------- */
async function entrar() {
  const nombre = $('#pj-nombre').value.trim();
  if (!nombre) { $('#pj-error').textContent = 'Escribe tu nombre'; return; }
  $('#pj-entrar').disabled = true;
  try {
    const ses = sesionSala();
    let r = await api('/api/obtener-acceso', {
      sala: S.sala, nombre, clave: $('#pj-clave').value,
      identidad: ses && ses.nombre === nombre ? ses.identidad : '',
    });
    // lobby: la sala pide admisión de un moderador — esperar sondeando
    while (r.espera) {
      await esperarEnLobby(r.identidad);
      r = await api('/api/obtener-acceso', {
        sala: S.sala, nombre, clave: $('#pj-clave').value, identidad: r.identidad,
      });
    }
    S.nombre = nombre; S.token = r.token; S.identidad = r.identidad; S.esAdmin = r.admin;
    S.salaNombre = r.nombreVisible || S.sala; // nombre para mostrar (el slug no cambia)
    S.clave = $('#pj-clave').value; // se guarda para reconexiones automáticas
    guardarSesion();
    S.sinCam = $('#pj-cam-btn').classList.contains('off');
    S.camQuerida = !S.sinCam; // intención del usuario: cámara encendida
    S.icePolicy = r.icePolicy || ''; S.iceServers = r.iceServers || null;
    S.grupoActual = r.grupo || 0; S.miGrupo = S.grupoActual;

    // rtcConfig va en connect(), NO en el constructor de Room (si va en
    // RoomOptions lo ignora en silencio — el PC nunca ve los TURN).
    const room = nuevaRoom();
    S.room = room;
    cablearRoom(room);
    await conectarRoom(room, r.url, r.token);

    // En modo bajo consumo, la cámara solo se enciende si ya está en
    // el Asiento 1 o tiene La Palabra; si entra de pie, S.camQuerida guarda
    // su intención y se activa sola al ocupar el Asiento 1 o recibir La Palabra.
    if (!S.sinCam && S.room._canCam) {
      try {
        await room.localParticipant.setCameraEnabled(true, { deviceId: S.dev.cam ? { exact: S.dev.cam } : undefined });
      } catch {}
    }

    // soltar siempre el medidor y la vista previa del prejoin al entrar:
    // si estás de pie o silenciado, el hardware del micrófono debe quedar
    // 100% libre para otras apps del teléfono
    detenerMedidor();
    if (S.previewStream) { S.previewStream.getTracks().forEach(t => t.stop()); S.previewStream = null; }
    S.audio.liberar = $('#pj-mic-btn').classList.contains('off');
    if (!S.audio.liberar && (estoySentado() || tengoPalabra())) {
      try { await prepararMicPtt(); } catch {} // solo abre el micro en modo auto
    }

    entrarVistaSala();
  } catch (e) {
    const nTurn = (S.iceServers || []).filter(s =>
      String(s.urls).includes('turn')).length;
    $('#pj-error').textContent = e.message +
      `  [ICE: ${S.icePolicy || 'all'} · TURN: ${nTurn} servidor(es) · v13]`;
    $('#pj-entrar').disabled = false;
  }
}

function entrarVistaSala() {
  mostrar('#vista-sala');
  $('#st-nombre-sala').textContent = (S.salaNombre || S.sala) + ' — ' + S.nombre;
  $('#st-panel-admin').classList.toggle('oculto', false); // se re-evalúa con el estado
  // botón "atrás" del teléfono: cada capa abierta (panel, modal, menú,
  // popups) empuja su propia entrada de historial. "Atrás" consume la
  // entrada y cierra la capa; solo cuando no queda ninguna capa abierta
  // se pregunta si salir — nunca te saca de la sala de golpe.
  capasH.length = 0;
  ultimoPushH = Date.now(); pushRecientes = 1;
  try { history.pushState({ capa: 'sala' }, ''); } catch {}
  let tsSalirConfirm = 0;
  window.onpopstate = () => {
    if (suprimirPop) { suprimirPop = false; return; }
    if (S.saliendo) return;
    // popstate fantasma: el navegador lo dispara como reacción a nuestro
    // propio pushState (WebKit/iOS). No es "atrás" real: la entrada que
    // quitó era la que acabamos de empujar, no reponemos nada y no
    // cerramos capa alguna.
    if (pushRecientes > 0 && Date.now() - ultimoPushH < 1500) {
      pushRecientes--;
      return;
    }
    capasH.pop(); // la entrada que el navegador acaba de quitar
    // por si quedaron huérfanas de capas cerradas desde la propia UI
    while (capasH.length && !capasH[capasH.length - 1].abierta()) capasH.pop();
    if (!cerrarCapaSuperior()) {
      // freno extra ante ráfagas de "atrás" reales
      if (Date.now() - tsSalirConfirm > 1200) {
        tsSalirConfirm = Date.now();
        confirmar('¿Salir de la sala?', salir);
      }
    }
    ultimoPushH = Date.now(); pushRecientes = 1;
    try { history.pushState({ capa: 'sala' }, ''); } catch {}
  };
  pedirWakeLock(); // la pantalla no se apaga mientras dure la reunión
  // Historial siempre consistente con el servidor: al entrar y cada 45 s
  // se compara con el manifiesto — las notas que falten aparecen y los
  // "grabando" fantasma se convierten en cerradas o se eliminan
  sincronizarNotas();
  if (!S._nvSyncT) S._nvSyncT = setInterval(sincronizarNotas, 45000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.room || S.saliendo) return;
    pedirWakeLock();
    // Android pausa la captura con la página en segundo plano: al volver,
    // si el usuario tenía el micro encendido y quedó muteado, reactivarlo
    const mp = S.room.localParticipant.getTrackPublication(LC.Track.Source.Microphone);
    if (S.audio.on && mp && mp.isMuted && puedoHablar()) mp.unmute().catch(() => {});
  });
  conectarSSE();
  precargarNotasVoz(); // notas de voz guardadas localmente vuelven al chat
  cablearControles();
  cablearPizarra();
  cablearDocs();
  $$('#st-vistas .vista-btn').forEach(b => b.onclick = () => {
    cambiarVista(b.dataset.vista);
    $('#st-vistas').classList.remove('abierto'); // en móvil el menú se cierra al elegir
  });
  $('#st-sync').onclick = () => {
    sincronizarVista();
    $('#st-vistas').classList.remove('abierto');
  };
  // el chip "👥 audiencia: X" también sincroniza al tocarlo
  if ($('#st-aud-vista')) $('#st-aud-vista').onclick = () => sincronizarVista();
  $('#st-vistas-toggle').onclick = (e) => {
    e.stopPropagation();
    $('#st-vistas').classList.toggle('abierto');
    if ($('#st-vistas').classList.contains('abierto'))
      empujarCapa('st-vistas', () => $('#st-vistas').classList.contains('abierto'));
  };
  $('#st-salir').onclick = () => confirmar('¿Salir de la sala?', salir);
  // ✎ junto al título: el moderador cambia el nombre visible sin ir a
  // Administrar salas (el enlace/slug no se toca; vacío = volver al slug)
  if ($('#st-renombrar')) $('#st-renombrar').onclick = () => genModal(
    'Nombre visible de la sala',
    `<input id="gen-txt" type="text" maxlength="80" style="width:100%" value="${esc(S.salaNombre || S.sala)}">` +
    '<p class="muted">Solo cambia cómo se ve. Vacío = volver al nombre original.</p>',
    () => moderar('renombrar', { extra: $('#gen-txt').value.trim() })
      .then(refrescarEstado).catch(e => toast(e.message)),
    'Guardar');
  cablearAjustes();
  cablearPanel();
  if (!nivelRAF) nivelRAF = requestAnimationFrame(loopNivel);
  window.addEventListener('beforeunload', beaconSalir);
  // cronómetro de la palabra + avisos a quien habla (2'/1'/30" toast;
  // últimos 10 s = número gigante con barra que se vacía)
  setInterval(() => {
    $$('#z-asientos [data-crono]').forEach(el => {
      if (!S.estado) return;
      // interrumpida: el reloj queda congelado mientras otro tiene el piso
      if (S.estado.palabraPausada) el.textContent = fmtMMSS(S.estado.palabraPausada) + ' ⏸';
      else if (S.estado.palabraFin) el.textContent = fmtMMSS(S.estado.palabraFin - Date.now());
    });
    const cr = $('#cuenta-regresiva');
    const soyYo = S.estado && S.estado.palabra && S.estado.palabra === S.identidad;
    const rest = soyYo && S.estado.palabraFin ? Math.max(0, S.estado.palabraFin - Date.now()) : 0;
    if (rest > 0) {
      // solo al cruzar el umbral: una palabra corta no debe anunciar
      // "2 minutos" ni un recién llegado a mitad de turno
      [[120000, 'quedan 2 minutos'], [60000, 'queda 1 minuto'], [30000, 'quedan 30 segundos']]
        .forEach(([ms, txt]) => {
          if (rest > ms - 2500 && rest <= ms && !avisosPalabra.has(ms)) {
            avisosPalabra.add(ms);
            toast('⏳ Te ' + txt + ' de palabra', 5000, 'aviso');
          }
        });
    } else avisosPalabra.clear();
    if (cr) {
      if (rest > 0 && rest <= 10000) {
        cr.classList.remove('oculto');
        const n = $('#cr-num');
        n.textContent = Math.ceil(rest / 1000);
        n.classList.toggle('peligro', rest <= 3000);
        $('#cr-fill').style.width = (rest / 100) + '%';
      } else cr.classList.add('oculto');
    }
    $$('#mod-grupos .item .crono-g').forEach(el => {
      const fin = +el.dataset.fin || 0;
      if (fin) el.textContent = fmtMMSS(fin - Date.now());
    });
  }, 500);
}

// esperarEnLobby: sondea cada 3 s hasta que un moderador admite (o el modo
// "admin" auto-admite cuando entra un moderador). Se cancela con el botón.
function esperarEnLobby(identidad) {
  return new Promise((resolve, reject) => {
    const box = $('#pj-espera');
    box.classList.remove('oculto');
    let vivo = true;
    $('#pj-espera-cancelar').onclick = () => {
      vivo = false;
      box.classList.add('oculto');
      reject(new Error('Cancelaste la espera'));
    };
    (async () => {
      while (vivo) {
        try {
          const w = await api(`/api/salas/${S.sala}/espera?identidad=${encodeURIComponent(identidad)}`);
          if (w.admitido) { vivo = false; box.classList.add('oculto'); resolve(); return; }
          if (w.rechazado) { vivo = false; box.classList.add('oculto'); reject(new Error('Un moderador rechazó tu entrada a la sala')); return; }
        } catch {}
        await new Promise(r2 => setTimeout(r2, 3000));
      }
    })();
  });
}

/* ---------- panel lateral: abrir/cerrar/opacidad ---------- */
function panelEstaAbierto() {
  return innerWidth <= 768
    ? $('#panel-lateral').classList.contains('abierto')
    : !$('#vista-sala').classList.contains('sin-panel');
}
function alternarPanel() {
  if (innerWidth <= 768) {
    const abrir = !$('#panel-lateral').classList.contains('abierto');
    $('#vista-sala').classList.remove('sin-panel'); // por si quedó puesta en escritorio
    $('#panel-lateral').classList.toggle('abierto', abrir);
    $('#panel-fondo').classList.toggle('activo', abrir);
    if (abrir) empujarCapa('panel', () => $('#panel-lateral').classList.contains('abierto'));
    if (!abrir) $('#panel-opaco-float').classList.add('oculto');
  } else {
    $('#vista-sala').classList.toggle('sin-panel');
  }
  $('#ctl-chat').classList.toggle('on', panelEstaAbierto());
}
function cerrarPanel() {
  $('#panel-lateral').classList.remove('abierto');
  $('#panel-fondo').classList.remove('activo');
  $('#panel-opaco-float').classList.add('oculto');
  if (innerWidth > 768) $('#vista-sala').classList.add('sin-panel');
  $('#ctl-chat').classList.remove('on');
}
function cablearPanel() {
  // en móvil el panel arranca cerrado; en escritorio, abierto como columna
  if (innerWidth <= 768) {
    $('#panel-lateral').classList.remove('abierto');
  } else {
    $('#vista-sala').classList.remove('sin-panel');
    $('#ctl-chat').classList.add('on');
  }
  $('#ctl-chat').onclick = alternarPanel;
  $('#panel-cerrar').onclick = cerrarPanel;
  $('#st-silencio').onclick = () => toast('Modo silencio: la audiencia no puede hablar. Solo el asiento 1 y la palabra.', 5000);
  $('#st-micasientos').onclick = () => toast('Micros de asientos bloqueados: los sentados deben pedir la palabra.', 5000);
  if ($('#st-grupo')) $('#st-grupo').onclick = () => volverPrincipal();
  if ($('#st-cam')) $('#st-cam').onclick = () => {
    const cuales = [];
    if (S.estado && S.estado.camAudiencia) cuales.push('la audiencia');
    if (S.estado && S.estado.camAsientos) cuales.push('los asientos');
    toast('Cámaras bloqueadas para ' + cuales.join(' y ') +
      '. Solo con la palabra o una excepción del moderador.', 5000);
  };
  $('#st-rec').onclick = () => toast('Alguien está grabando la sesión en su equipo.', 4000);
  $('#st-manos').onclick = () => abrirSolicitudes();
  if ($('#st-cola')) $('#st-cola').onclick = () => abrirSolicitudes();
  if ($('#st-lobby')) $('#st-lobby').onclick = () => abrirModal('modal-admin');
  $('#st-conexion').onclick = () => toast('Las peticiones llegan a procesos distintos: el estado no se sincroniza entre ellos. Recarga o revisa que ambos conectores apunten al mismo origen.', 8000, 'aviso');
  $('#panel-fondo').onclick = cerrarPanel;
  $('#btn-opaco').onclick = (e) => {
    e.stopPropagation();
    $('#panel-opaco-float').classList.toggle('oculto');
    if (!$('#panel-opaco-float').classList.contains('oculto'))
      empujarCapa('opaco', () => !$('#panel-opaco-float').classList.contains('oculto'));
  };
  $('#panel-opacidad').oninput = (e) => {
    document.documentElement.style.setProperty('--panel-alpha', (e.target.value / 100));
  };
}

function beaconSalir() {
  S.saliendo = true;
  if (!S.token) return;
  navigator.sendBeacon(`/api/salas/${S.sala}/accion?token=${S.token}`,
    new Blob([JSON.stringify({ tipo: 'levantarse' })], { type: 'text/plain' }));
}

async function salir() {
  S.saliendo = true; // evita que el hilo de reconexión intente volver
  if (S._nvSyncT) { clearInterval(S._nvSyncT); S._nvSyncT = null; }
  try { await accion('levantarse'); } catch {}
  window.removeEventListener('beforeunload', beaconSalir);
  cerrarPipeline();
  detenerAudioCompartido();
  detenerMedidor();
  if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; }
  if (S.evt) S.evt.close();
  if (S.room) await S.room.disconnect();
  location.href = '/';
}

/* ---------- botón atrás / wake lock ---------- */
// cerrarCapaSuperior cierra la capa visible de mayor prioridad; devuelve
// true si cerró algo (el handler de popstate vuelve a empujar el estado
// para que "atrás" nunca abandone la página mientras estás en la sala)
function cerrarCapaSuperior() {
  const modal = [...$$('.modal')].find(m => !m.classList.contains('oculto'));
  if (modal) { modal.classList.add('oculto'); return true; }
  if (!$('#menu-ctx').classList.contains('oculto')) { cerrarMenuCtx(); return true; }
  if (!$('#reacciones-panel').classList.contains('oculto')) { $('#reacciones-panel').classList.add('oculto'); return true; }
  const pop = [...$$('.popmenu')].find(p => !p.classList.contains('oculto'));
  if (pop) { pop.classList.add('oculto'); return true; }
  if ($('#st-vistas').classList.contains('abierto')) { $('#st-vistas').classList.remove('abierto'); return true; }
  if (!$('#panel-opaco-float').classList.contains('oculto')) { $('#panel-opaco-float').classList.add('oculto'); return true; }
  if (!$('#audio-share').classList.contains('oculto')) { $('#audio-share').classList.add('oculto'); return true; }
  if (!$('#inv-popup').classList.contains('oculto')) { $('#inv-popup').classList.add('oculto'); return true; }
  if ($('#panel-lateral').classList.contains('abierto')) {
    $('#panel-lateral').classList.remove('abierto');
    $('#panel-fondo').classList.remove('activo');
    return true;
  }
  return false;
}

let wakeLock = null;
async function pedirWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.onrelease = () => { wakeLock = null; };
  } catch {}
}

/* ---------- SSE ---------- */
function comprobarInstancia(id, fuente = 'http') {
  if (!id) return true;
  const primerSSE = fuente === 'sse' && !S.servidorSSE;
  if (fuente === 'sse') S.servidorSSE = true;
  if (!S.servidor) { S.servidor = id; return true; }
  if (S.servidor === id) return true;
  const aviso = $('#st-conexion');
  aviso.textContent = `Servidores distintos (${S.servidor} / ${id}): revisa tus túneles`;
  aviso.classList.remove('oculto');
  if (primerSSE) { S.servidor = id; return true; }
  return false;
}

function aplicarEstado(d, fuente = 'http') {
  if (!comprobarInstancia(d.instancia, fuente)) return;
  S.estadoRecibido = Date.now();
  const prevRejilla = S.vistaSync;
  const prevPerfil = S.estado && S.estado.audioPerfil;
  S.estado = d.estado;
  S.micProhibido = !!d.micProhibido;
  S.micProhibidos = d.micProhibidos || [];
  S.camProhibido = !!d.camProhibido;
  S.camProhibidos = d.camProhibidos || [];
  S.micPerm = !!d.micPerm;
  S.camPerm = !!d.camPerm;
  S.micPermidos = d.micPermidos || [];
  S.camPermidos = d.camPermidos || [];
  S.chatProhibido = !!d.chatProhibido;
  S.chatProhibidos = d.chatProhibidos || [];
  S.panProhibido = !!d.panProhibido;
  S.panProhibidos = d.panProhibidos || [];
  S.docProhibido = !!d.docProhibido;
  S.docProhibidos = d.docProhibidos || [];
  S.lobbyLista = d.lobby || [];
  S.accesoSala = d.acceso || 'abierto';
  if (d.pisoCfg) S.pisoCfg = d.pisoCfg;
  // nombre para mostrar: si el admin renombra con gente dentro se ve al instante
  if (d.nombreVisible !== undefined) {
    S.salaNombre = d.nombreVisible || S.sala;
    const ns = $('#st-nombre-sala');
    if (ns && S.nombre) ns.textContent = S.salaNombre + ' — ' + S.nombre;
  }
  // lobby: aviso sonoro-visual al moderador aunque no tenga el panel abierto —
  // el chip 🚪 del topbar queda fijo; el toast avisa cuando crece la cola
  if (esMod() && S.lobbyLista.length > S.ultLobby)
    toast('🔔 ' + S.lobbyLista.length + ' esperando en la sala de espera — abre Moderación para admitir', 5000);
  S.ultLobby = S.lobbyLista.length;
  S.admins = d.admins || [];
  S.votos = d.votos || { aFavor: 0, enContra: 0, mi: 0 };
  if (S.micProhibido) { S.audio.autoAsiento = false; S.audio.autoPalabra = false; }
  // transiciones: sentarse por propia decisión o ganar la palabra → micro auto
  const ahoraSentado = estoySentado(), ahoraPalabra = tengoPalabra();
  if (!S._sentado && ahoraSentado) S.audio.autoAsiento = true;
  if (S._sentado && !ahoraSentado) {
    S.audio.autoAsiento = false;
    // levantarse = soltar el micro: se silencia solo (puede reactivarlo
    // si conserva el permiso); con la palabra el micro sigue obligado
    if (!ahoraPalabra) activarMic(false);
  }
  if (!S._palabra && ahoraPalabra) S.audio.autoPalabra = true;
  if (S._palabra && !ahoraPalabra) {
    S.audio.autoPalabra = false;
    // palabra retirada/expirada/interrumpida >60 s: suelta micro y piso
    if (S.room) activarMic(false);
  }
  // La Palabra pisa el botón sola: al recibirla el micro se abre y toma el
  // piso sin esperar un toque, en cualquier modo PTT
  if (ahoraPalabra && S.room && !S.audio.retirando && !S.ptt.quiero) pttOn();
  // el estado es la red de seguridad: si el servidor me (re)concedió el
  // piso —p.ej. soy La Palabra y el interrumplente soltó— se refleja aquí
  const pisoMio = !!(S.estado && S.estado.piso === S.identidad);
  if (pisoMio && !S.ptt.quiero && !(S.room && S.room._quieroPiso)) {
    // Yo ya solté el PTT localmente: prevalece mi estado suelto
    S.estado.piso = '';
    S.estado.pisoNombre = '';
    S.ptt.tengo = false;
  } else if (pisoMio && S.ptt.quiero && !S.ptt.tengo) {
    S.ptt.tengo = true;
    if (S.audio.pub && S.audio.pub.isMuted) S.audio.pub.unmute().catch(() => {});
  } else if (!pisoMio && S.ptt.tengo) {
    S.ptt.tengo = false;
  }
  S._sentado = ahoraSentado; S._palabra = ahoraPalabra;
  // perfil de sala cambió: ajusta en caliente sin cortar el micrófono
  if (prevPerfil && d.estado.audioPerfil !== prevPerfil && S.audio.pub)
    actualizarCalidadAudioEnVivo();
  S.estado.manos = S.estado.manos || [];
  S.estado.cola = S.estado.cola || [];
  S.estado.moderadores = S.estado.moderadores || [];
  S.grupos = d.grupos || [];
  S.directorio = d.directorio || [];
  S.miGrupo = d.miGrupo || 0;
  S.ultTiempo = d.ultTiempo || 0;
  S.invitacion = d.invitacion || '';
  S.vistaSync = d.estado.rejilla;
  if (S.vistaSync !== prevRejilla) S.vistaLocal = null; // el admin forzó el cambio
  manejarEvento(d.evento);
  renderTodo();
  intentarAutoMic();
  chequearGrupo();
  renderInvitacion();
}
window.aplicarEstado = aplicarEstado;

let consultandoEstado = false;
async function refrescarEstado() {
  if (consultandoEstado || !S.room) return;
  consultandoEstado = true;
  try {
    aplicarEstado(await api(`/api/salas/${S.sala}/estado`));
  } catch { }
  finally { consultandoEstado = false; }
}

let sseTimer = null;
function abrirEventSource() {
  if (S.evt) { try { S.evt.close(); } catch {} S.evt = null; }
  // En esta versión el estado en tiempo real viaja dentro del mismo
  // WebSocket (/media -> estado_push), evitando abrir una conexión SSE extra
  // que en proxies HTTP/2 o Cloudflare produce ERR_HTTP2_PROTOCOL_ERROR.
}
function conectarSSE() {
  if (S.evt) { try { S.evt.close(); } catch {} S.evt = null; }
  if (!sseTimer) {
    sseTimer = setInterval(() => {
      if (!S.saliendo && Date.now() - (S.estadoRecibido || 0) > 25000) {
        refrescarEstado();
      }
    }, 10000);
  }
}

function manejarEvento(ev) {
  if (!ev) return;
  switch (ev.tipo) {
    case 'aprobar_mano':
      if (ev.identidad === S.identidad) {
        S.audio.autoPalabra = true;
        toast('Tienes la palabra');
      }
      break;
    case 'cortar_palabra':
      if (ev.identidad === S.identidad) {
        activarMic(false);
        toast('El moderador te ha retirado la palabra');
      }
      break;
    case 'encolado':
      if (ev.identidad === S.identidad) toast('Asientos ocupados — quedaste en la cola de espera');
      break;
    case 'expulsar_asiento':
      if (ev.identidad === S.identidad) toast('Has sido retirado del asiento');
      break;
    case 'documento':
      S.vistaLocal = 'presentacion';
      break;
    case 'palabra':
      if (ev.identidad === S.identidad) toast('Tienes la palabra: tu micrófono se activó');
      break;
    case 'invitacion_aceptada':
      if (ev.identidad === S.identidad) toast('Invitación aceptada: tienes la palabra');
      break;
    case 'expulsar_sala':
      if (ev.identidad === S.identidad) {
        S.saliendo = true;
        toast('Has sido expulsado de la sala');
        setTimeout(() => location.href = '/', 800);
      }
      break;
    case 'banear':
      if (ev.identidad === S.identidad) {
        S.saliendo = true;
        toast('Has sido baneado de la sala');
        setTimeout(() => location.href = '/', 800);
      }
      break;
    case 'invitacion':
      if (ev.destino === S.identidad) renderInvitacion();
      break;
    case 'reunion_terminada':
      S.saliendo = true;
      toast('El moderador terminó la reunión', 5000);
      setTimeout(() => location.href = '/', 1500);
      break;
  }
}

// fmtMMSS formatea milisegundos como m:ss
function fmtMMSS(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// mtab conmuta las pestañas del modal de moderación. Va como función global
// porque index.html la invoca inline: así las pestañas funcionan aunque el
// cableado de controles se interrumpa por un elemento ausente.
function mtab(t) {
  $$('.mod-tab').forEach(x => x.classList.remove('activo'));
  t.classList.add('activo');
  ['manos', 'cola', 'salas'].forEach(k =>
    $('#mtab-' + k).classList.toggle('oculto', t.dataset.mtab !== k));
  if (t.dataset.mtab === 'salas' && S.room) renderGrupos();
  // en pantallas bajas el panel puede quedar bajo el pliegue del modal:
  // lleva las pestañas a la parte visible del cuadro
  t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------- helpers de estado ---------- */
const miAsiento = () => S.estado ? S.estado.asientos.findIndex(a => a.identidad === S.identidad) : -1;
const estoySentado = () => miAsiento() >= 0;
const esMod = () => S.esAdmin || (S.admins || []).includes(S.identidad) ||
  (S.estado && S.estado.moderadores.includes(S.identidad));
const enCola = () => S.estado && S.estado.cola.some(c => c.identidad === S.identidad);
const manoLevantada = () => S.estado && S.estado.manos.some(m => m.identidad === S.identidad);
const tengoPalabra = () => S.estado && S.estado.palabra === S.identidad;
function solicitarPalabra() {
  if (tengoPalabra()) { toast('Ya tienes la palabra.'); return; }
  if (manoLevantada()) { toast('Ya levantaste la mano. Espera la aprobación del moderador.'); return; }
  confirmar('¿Quieres pedir la palabra? Se levantará tu mano para que el moderador la apruebe.',
    () => accion('levantar_mano').catch(e => toast(e.message)));
}
// micro permitido: nunca si moderación lo bloqueó; siempre con la palabra o en
// el asiento 1; el resto de sentados si micAsientos está apagado; la audiencia
// solo si el modo silencio está apagado (vale también para moderadores de pie)
const puedoHablar = () => !S.micProhibido && (tengoPalabra() || S.micPerm ||
  (estoySentado()
    ? (miAsiento() === 0 || !(S.estado && S.estado.micAsientos))
    : !(S.estado && S.estado.silencio)));

// cámara permitida en modo bajo consumo: SOLO quien ocupa el
// Asiento 1 (Anfitrión) o quien tiene La Palabra (o excepción de moderador)
const puedoCam = () => !S.camProhibido && (tengoPalabra() || miAsiento() === 0 || S.camPerm);

// compartir pantalla o documentos: moderadores siempre; el resto solo
// sentado o con la palabra — y nunca si moderación se lo prohibió
// compartir pantalla/documentos: SOLO el asiento del anfitrión (el 1) o
// quien tiene la palabra — ni admins, ni moderadores, ni otros asientos
const puedoPantalla = () => !S.panProhibido && (tengoPalabra() || miAsiento() === 0);
const puedoDoc = () => !S.docProhibido && (tengoPalabra() || miAsiento() === 0);

// activa el micro (y la cámara ligera de 240p en Asiento 1 o La Palabra)
// automáticamente cuando la propia acción lo implica
function intentarAutoMic() {
  if (!S.room) return;
  if (!S.micProhibido && !S.audio.retirando) {
    if (S.audio.autoPalabra && tengoPalabra()) {
      S.audio.autoPalabra = false;
      prepararMicPtt(); // solo abre el micro en modo auto; en manual manda el botón
    } else if (S.audio.autoAsiento && estoySentado()) {
      S.audio.autoAsiento = false;
      if (puedoHablar()) prepararMicPtt();
    }
  }
  if (S.camQuerida && puedoCam() && !S.room.localParticipant.isCameraEnabled) {
    S.room._canCam = true;
    S.room.localParticipant.setCameraEnabled(true, {
      deviceId: S.dev.cam ? { exact: S.dev.cam } : undefined,
    }).catch(() => {});
  }
}

async function sentarse(asiento) {
  if (S.sentando) return; // ya hay un intento en curso: ignorar más toques
  S.sentando = asiento || -1; // feedback inmediato en la silla ("⏳ Sentándose…")
  renderTodo();
  S.audio.autoAsiento = true;
  let ok = true;
  try {
    await accion('sentarse', asiento);
    await refrescarEstado();
    intentarAutoMic();
  } catch (e) {
    ok = false;
    S.audio.autoAsiento = false;
    toast(e.message);
  }
  // el aviso se mantiene hasta que el estado confirma (sentado en la silla
  // pedida o en cola) — con tope por si el broadcast se pierde
  const t0 = Date.now();
  while (ok && S.sentando && Date.now() - t0 < 5000) {
    const hecho = asiento
      ? (S.estado.asientos[asiento - 1] || {}).identidad === S.identidad
      : estoySentado();
    if (hecho || (S.estado.cola || []).some(c => c.identidad === S.identidad)) break;
    await new Promise(r => setTimeout(r, 150));
  }
  S.sentando = false;
  renderTodo();
}

async function aceptarInvitacion() {
  const tipo = S.invitacion;
  if (tipo === 'palabra') S.audio.autoPalabra = true;
  else if (tipo === 'sentar') S.audio.autoAsiento = true;
  try {
    await accion('aceptar_invitacion');
    await refrescarEstado();
    intentarAutoMic();
  } catch (e) {
    S.audio.autoAsiento = false; S.audio.autoPalabra = false;
    toast(e.message);
  }
}

async function dejarPalabra() {
  try {
    await accion('dejar_palabra');
    S.audio.autoPalabra = false;
    await activarMic(false);
    await refrescarEstado();
  } catch (e) { toast(e.message); }
}

/* ---------- piso exclusivo / PTT ---------- */
const modoPtt = () => S.ptt.modo !== 'auto';

// Espejo de la regla del servidor: puedes interrumpir cuando el dueño del
// piso lleva hablando el MÍNIMO de los tiempos de todos tus roles
function miTiempoPiso() {
  const c = S.pisoCfg || { admin: 0, anfitrion: 0, palabra: 10, usuario: 60 };
  let m = c.usuario;
  if (esMod()) m = Math.min(m, c.admin);
  if (miAsiento() === 0) m = Math.min(m, c.anfitrion);
  if (tengoPalabra()) m = Math.min(m, c.palabra);
  return m;
}

// Modo automático: el micro queda capturando en LOCAL (publicado sin mutear
// para que el VAD "pise el botón" al detectar voz) pero el motor solo envía
// al servidor cuando el piso ya es mío. En los modos manuales el hardware
// no se toca: se abre al pisar el botón y se libera al soltarlo, así el
// teléfono puede usar el micrófono en otra app entre frase y frase.
async function prepararMicPtt() {
  if (S.audio.pub || !puedoHablar() || S.audio.retirando || !S.room) return;
  if (S.ptt.modo !== 'auto') return;
  try {
    const track = await construirMicTrack();
    S.audio.pub = await S.room.localParticipant.publishTrack(track, opcionesAudio());
    S.audio.on = true; // intención: auto activo (reconexiones repúblican)
  } catch {}
}

async function pttOn() {
  if (!S.room || S.ptt.quiero || S.audio.retirando) return;
  if (!puedoHablar()) {
    const razon = S.micProhibido
      ? 'Un moderador te prohibió activar el micrófono.'
      : estoySentado()
      ? 'Los micrófonos de los asientos están bloqueados.'
      : 'La audiencia tiene el micrófono deshabilitado.';
    genModal('Micrófono deshabilitado',
      `<p>${razon}</p><p>Solo puedes hablar desde el puesto de la palabra. ¿Quieres levantar la mano para pedirla?</p>`,
      () => accion('levantar_mano')
        .then(() => toast('Mano levantada: espera la aprobación del moderador'))
        .catch(e => toast(e.message)),
      '✋ Levantar la mano');
    return;
  }
  S.ptt.quiero = true;
  S.ptt.desde = Date.now(); // mientras quiero y !tengo el pulsador gira "conectando"
  S.room.tomarPiso();
  try {
    if (!S.audio.pub) {
      const track = await construirMicTrack();
      S.audio.pub = await S.room.localParticipant.publishTrack(track, opcionesAudio());
    }
    await S.audio.pub.unmute();
    S.audio.on = true;
  } catch (e) {
    S.ptt.quiero = false;
    if (S.room && S.room.soltarPiso) S.room.soltarPiso();
    toast('No se pudo hablar: ' + e.message);
  }
  renderControles();
}

async function pttOff(inmediato) {
  // Teniendo La Palabra el botón no calla: su micro es obligatorio mientras
  // la tenga (si te interrumpen te muta el piso, no el botón). Para callarse
  // hay que dejar la palabra desde la esquina ✕ o el menú.
  if (tengoPalabra() && !inmediato) return;
  S.ptt.quiero = false;
  S.ptt.tengo = false;
  S.ptt._bloqueado = false;
  S.ptt.desde = 0;
  ocultarGestosPtt();
  // Soltar localmente DE INMEDIATO sin esperar al servidor:
  // 1) mutear el micrófono ya mismo para no grabar ni una trama más,
  // 2) apagar mi propio indicador de hablando y limpiar mi piso local,
  // 3) pintar el botón suelto al instante antes de cualquier await.
  if (S.ptt.modo !== 'auto' && S.audio.pub && !S.audio.pub.isMuted) {
    try { S.audio.pub.mute().catch(() => {}); } catch {}
  }
  if (S.activo === S.identidad) S.activo = null;
  if (S.estado && S.estado.piso === S.identidad) {
    S.estado.piso = '';
    S.estado.pisoNombre = '';
  }
  if (S.room) S.room.soltarPiso();
  renderControles();
  renderAsientos();
  if (S.ptt.modo === 'auto') {
    // el micro sigue abierto en local para que el VAD siga escuchando
    S.audio.on = true;
  } else {
    // manual: liberar el hardware del micrófono de inmediato
    await retirarMic();
    S.audio.liberar = true;
  }
  renderControles();
}

// Cableado PTT compartido por los tres pulsadores (botón del micro, centro
// de mi asiento y botón del chat): "hold" = mantener pisado, "lock" = un
// toque toma el piso y otro lo suelta; en "auto" también sirve de pulsador
// manual. gate() opcional decide si el gesto es PTT (p.ej. chat vacío).
function wirePttButton(el, gate) {
  if (!el || el._pttWired) return;
  el._pttWired = true;
  const libre = () => !gate || gate();
  // Android: mantener el dedo ~500 ms dispara contextmenu y el navegador
  // manda pointercancel -> soltaba el PTT solo. Se bloquea aquí de raíz.
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  el.addEventListener('pointerdown', (e) => {
    if (S.audio.retirando || S.ptt.modo === 'lock' || S.ptt.modo === 'auto' || !libre()) return;
    e.preventDefault();
    e.stopPropagation();
    // si quedó bloqueado, un toque lo desbloquea y suelta
    if (S.ptt._bloqueado) { S.ptt._bloqueado = false; pttOff(); return; }
    pttOn();
    // Capturar el puntero + el arrastre se sigue en WINDOW: en móvil la
    // captura a veces falla o el navegador manda pointerleave/cancel al
    // cruzar el borde — con el seguimiento global el gesto no se pierde.
    // Los asientos llevan sinGesto (no arrastran 🔒/A, usan esquinas fijas)
    // pero IGUAL necesitan seguimiento en window para soltar al levantar.
    try { el.setPointerCapture(e.pointerId); } catch {}
    wireGestoGlobal();
    S.ptt._gesto = { x0: e.clientX, y0: e.clientY, el, sinGesto: !!el._pttSinGesto, lock: false, auto: false };
    if (!el._pttSinGesto) mostrarGestosPtt(el);
  });
  el.addEventListener('click', (e) => {
    // click residual tras un gesto (bloquear/auto): no debe disparar nada
    if (S.ptt._tragarClick) {
      S.ptt._tragarClick = false;
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (S.ptt._bloqueado) {
      S.ptt._bloqueado = false;
      e.preventDefault(); e.stopPropagation();
      pttOff();
      return;
    }
    // el click que sigue a soltar en "hold" no debe activar menús ajenos
    if (S.ptt.modo === 'hold') { e.preventDefault(); e.stopPropagation(); return; }
    if (S.audio.retirando || !libre()) return;
    e.preventDefault();
    e.stopPropagation();
    // en automático el pulsador es un interruptor, no un PTT: un toque
    // apaga el automático (el VAD es quien pisa el botón por la voz)
    if (S.ptt.modo === 'auto') { cambiarModoPtt('hold'); return; }
    if (S.ptt.quiero) pttOff(); else pttOn();
  });
}

// Seguimiento global del gesto del pulsador: 🔒 arrastrando ARRIBA,
// A (automático) arrastrando a la DERECHA (a la izquierda del botón del
// micro no hay espacio en el celular). Se registra una sola vez.
function wireGestoGlobal() {
  if (wireGestoGlobal._ok) return;
  wireGestoGlobal._ok = true;
  window.addEventListener('pointermove', (e) => {
    const g = S.ptt._gesto;
    if (!g || g.sinGesto || !S.ptt.quiero || S.ptt._bloqueado) return;
    const dy = g.y0 - e.clientY, dx = g.x0 - e.clientX;
    g.lock = dy > 56;                           // arrastre hacia arriba
    g.auto = dx < -56 && !g.lock;               // arrastre hacia la derecha
    // el botón se arrastra un poco con el dedo, como la nota de voz de
    // WhatsApp: puro feedback visual, los gestos mandan por distancia
    const vx = Math.max(-30, Math.min(30, -dx * 0.35));
    const vy = Math.min(0, Math.max(-30, -dy * 0.35));
    const base = g.el.classList.contains('asiento-ptt') ? 'translate(-50%,-50%) ' : '';
    g.el.style.transform = `${base}translate(${vx}px, ${vy}px)`;
    marcarGestosPtt(g);
  });
  const fin = (e) => {
    const g = S.ptt._gesto;
    if (g) e.stopPropagation();
    ocultarGestosPtt();
    if (g && g.el.style.transform) g.el.style.transform = ''; // soltar el arrastre
    S.ptt._gesto = null;
    if (!g || !S.ptt.quiero) return;
    if (g.lock) {
      // candado: sigue hablando sin mantener el dedo; un toque suelta.
      // El click que el navegador dispara tras este pointerup hay que
      // tragárselo: si no, desbloquea al instante de bloquear.
      S.ptt._bloqueado = true;
      S.ptt._tragarClick = true;
      toast('🔒 Bloqueado — toca el botón de nuevo para soltar');
      renderControles();
      return;
    }
    if (g.auto) {
      // modo automático al vuelo: al entrar la frase actual la cierra
      // el VAD cuando calles; al salir se suelta como una pulsación
      S.ptt._tragarClick = true;
      const aAuto = S.ptt.modo !== 'auto';
      if (aAuto) S.ptt.quiero = false;
      cambiarModoPtt(aAuto ? 'auto' : 'hold');
      return;
    }
    if (S.ptt.modo !== 'lock' && !S.ptt._bloqueado) pttOff();
  };
  window.addEventListener('pointerup', fin);
  window.addEventListener('pointercancel', fin);
  window.addEventListener('touchend', fin, { passive: true });
  window.addEventListener('touchcancel', fin, { passive: true });
  window.addEventListener('blur', () => {
    if (S.ptt.quiero && S.ptt.modo === 'hold' && !S.ptt._bloqueado && !tengoPalabra()) pttOff();
  });
}

// Esquina 🔒 de mi asiento / puesto de la palabra: arrancar hablando ya
// bloqueado (o bloquear la frase en curso); con candado puesto, soltar
function pttEsquinaLock() {
  if (S.audio.retirando) return;
  if (S.ptt._bloqueado) {
    S.ptt._bloqueado = false;
    pttOff();
  } else {
    S.ptt._bloqueado = true;
    if (!S.ptt.quiero) pttOn();
    else renderControles();
  }
}

// Indicadores flotantes del gesto: 🔒 arriba del botón, A a la izquierda
function mostrarGestosPtt(el) {
  const g = $('#ptt-gestos');
  if (!g) return;
  const r = el.getBoundingClientRect();
  g.style.left = (r.left + r.width / 2) + 'px';
  g.style.top = (r.top + r.height / 2) + 'px';
  g.querySelector('.pg-lock').classList.remove('ready');
  g.querySelector('.pg-auto').classList.remove('ready');
  g.classList.remove('oculto');
}
function marcarGestosPtt(g) {
  const ge = $('#ptt-gestos');
  if (!ge) return;
  ge.querySelector('.pg-lock').classList.toggle('ready', g.lock);
  ge.querySelector('.pg-auto').classList.toggle('ready', g.auto);
}
function ocultarGestosPtt() {
  const g = $('#ptt-gestos');
  if (g) g.classList.add('oculto');
}

// Color compartido de todos los pulsadores PTT:
// amarillo = piso libre · verde = otra persona habla · rojo = yo hablo
// · aro girando amarillo/rojo = pisado pero aún conectando (micro + piso)
function renderPttEstados() {
  const otro = !!(S.estado && S.estado.piso && S.estado.piso !== S.identidad);
  // La Palabra no es un pulsador: con piso = hablando (rojo); sin piso por
  // interrupción = espera (violeta, el micro vuelve solo al soltar el otro)
  const st = S.ptt.tengo ? 'hablando'
    : tengoPalabra() ? 'espera'
    : S.ptt.quiero ? 'conectando'
    : !puedoHablar() ? 'sinpermiso'
    : otro ? 'ocupado' : 'libre';
  const auto = S.ptt.modo === 'auto';
  const tit = st === 'hablando'
    ? (auto ? 'Automático transmitiendo — toca para apagarlo' : 'Suelta para terminar')
    : st === 'espera' ? 'Micro en espera: te interrumpieron — vuelve solo al soltar'
    : st === 'conectando' ? 'Conectando… verificando micro y piso'
    : st === 'sinpermiso' ? 'Pide la palabra para hablar'
    : st === 'ocupado' ? `Hablando: ${S.estado.pisoNombre || S.estado.piso}`
    : S.ptt.modo === 'hold' ? 'Mantén pisado para hablar'
    : auto ? 'Automático encendido: tu voz pisa el botón — toca para apagarlo'
    : 'Toca para hablar / toca para soltar';
  $$('.ptt-sup').forEach(el => {
    el.classList.remove('ptt-libre', 'ptt-ocupado', 'ptt-hablando', 'ptt-sinpermiso', 'ptt-conectando', 'ptt-espera');
    el.classList.add('ptt-' + st);
    el.classList.toggle('ptt-bloqueado', !!S.ptt._bloqueado);
    el.classList.toggle('ptt-auto', auto);
    el.title = S.ptt._bloqueado ? 'Bloqueado: toca para soltar' : tit;
  });
  // esquinas fijas del asiento/palabra: estado visual del candado y del auto
  $$('.asiento-esq.lock').forEach(b => b.classList.toggle('on', !!S.ptt._bloqueado));
  $$('.asiento-esq.auto').forEach(b => b.classList.toggle('on', S.ptt.modo === 'auto'));
  const me = $('#mic-estado');
  if (me) me.textContent = st === 'hablando' ? (auto ? 'Auto: transmitiendo' : 'Estás hablando')
    : st === 'espera' ? 'En espera — te interrumpieron'
    : st === 'conectando' ? 'Conectando…'
    : st === 'sinpermiso' ? 'Sin permiso'
    : st === 'ocupado' ? `Habla ${S.estado.pisoNombre || S.estado.piso}`
    : auto ? 'Auto: escuchando' : 'Piso libre';
  // Círculo flotante central: SOLO mientras el dedo está físicamente
  // pisado — es un indicador del estado del piso, no un botón. Con candado
  // o en automático no se muestra: ahí el propio pulsador ya se ve activo.
  const pf = $('#ptt-float');
  if (pf) {
    const mostrar = (st === 'conectando' || st === 'hablando') &&
      S.ptt.quiero && !S.ptt._bloqueado &&
      !estoySentado() && !tengoPalabra();
    pf.classList.toggle('oculto', !mostrar);
    pf.classList.toggle('conectando', st === 'conectando');
    pf.classList.toggle('hablando', st === 'hablando');
    const t = pf.querySelector('.pf-txt');
    if (t) t.textContent = st === 'conectando' ? 'Pidiendo el piso…' : '¡Habla ya!';
  }
}

// Chirp estilo Zello: blip agudo al conseguir el piso, doble grave si te
// lo niegan (otra persona habla y aún no cumple su tiempo)
let _pttCtx = null;
function sonidoPiso(ok) {
  try {
    _pttCtx = _pttCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _pttCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    const tonos = ok ? [[880, 0, 0.09]] : [[200, 0, 0.11], [150, 0.13, 0.16]];
    for (const [f, dt, dur] of tonos) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = ok ? 'sine' : 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + dt + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0 + dt); o.stop(t0 + dt + dur + 0.02);
    }
  } catch {}
}

/* ---------- salas de discusión ---------- */
function nombreGrupo(id) {
  if (!id) return 'Sala principal';
  const g = (S.grupos || []).find(x => x.id === id);
  return g ? g.nombre : `Sala ${id}`;
}

let conectandoGrupo = false;
async function chequearGrupo() {
  if (conectandoGrupo || !S.room || S.miGrupo === S.grupoActual) return;
  const dest = S.miGrupo;
  const salia = S.grupoActual;
  conectandoGrupo = true;
  try {
    const r = await api(`/api/salas/${S.sala}/token`, { grupo: dest });
    const camOn = S.room.localParticipant.isCameraEnabled;
    const micOn = S.audio.on;
    cerrarPipeline();
    await S.room.disconnect();
    videoEls.clear();
    const room = nuevaRoom();
    S.room = room;
    cablearRoom(room);
    await conectarRoom(room, r.url, r.token);
    // marcar el grupo al que realmente conectamos: si el destino cambió
    // mientras conectábamos (p.ej. disolvieron la sala), reintentar
    S.grupoActual = dest;
    S.wb.strokes = []; S.wb.cargado = false;
    setTimeout(() => pubData({ t: 'wb_req' }), 800);
    if (camOn) {
      try { await room.localParticipant.setCameraEnabled(true, { deviceId: S.dev.cam ? { exact: S.dev.cam } : undefined }); } catch {}
    }
    if (micOn || (modoPtt() && S.ptt.quiero)) {
      // auto: el micro vuelve abierto para el VAD; manual: solo si seguía
      // pisado al cambiar de sala, retomando el piso
      try {
        await prepararMicPtt();
        if (modoPtt() && S.ptt.quiero) {
          if (!S.audio.pub) {
            const track = await construirMicTrack();
            S.audio.pub = await S.room.localParticipant.publishTrack(track, opcionesAudio());
          }
          S.room.tomarPiso();
          S.audio.on = true;
        }
      } catch {}
    }
    const disuelta = !dest && salia && !(S.grupos || []).some(g => g.id === salia);
    toast(dest ? `Te movieron a: ${nombreGrupo(dest)}`
      : disuelta ? 'La sala se disolvió — regresaste a la principal'
      : 'Regresaste a la sala principal');
    renderTodo();
    if (S.miGrupo !== S.grupoActual) setTimeout(chequearGrupo, 400);
  } catch (e) {
    toast('No se pudo cambiar de sala: ' + e.message);
  } finally {
    conectandoGrupo = false;
  }
}

// Regreso voluntario desde una sala de discusión; también sirve de rescate
// cuando el servidor ya nos marcó en la principal pero seguimos en la otra.
async function volverPrincipal() {
  try {
    await accion('volver_principal');
    await refrescarEstado();
  } catch (e) { toast(e.message); }
}

/* ---------- invitación flotante ---------- */
function renderInvitacion() {
  const pop = $('#inv-popup');
  if (!S.invitacion) { pop.classList.add('oculto'); return; }
  $('#inv-texto').textContent = S.invitacion === 'sentar'
    ? 'El moderador te invita a sentarte'
    : 'El moderador te invita a hablar';
  if (pop.classList.contains('oculto'))
    empujarCapa('invitacion', () => !pop.classList.contains('oculto'));
  pop.classList.remove('oculto');
}

/* ---------- menú contextual ---------- */
function cerrarMenuCtx() { $('#menu-ctx').classList.add('oculto'); }

function abrirMenuCtx(x, y, items, titulo) {
  const m = $('#menu-ctx');
  m.innerHTML = '';
  empujarCapa('menu-ctx', () => !m.classList.contains('oculto'));
  if (titulo) m.insertAdjacentHTML('beforeend', `<div class="mi-nombre">${esc(titulo)}</div>`);
  items.forEach(it => {
    if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); return; }
    if (it.titulo) { m.insertAdjacentHTML('beforeend', `<div class="mi-titulo">${esc(it.titulo)}</div>`); return; }
    if (it.chips) {
      const d = document.createElement('div');
      d.className = 'mi-chips';
      it.chips.forEach(c => {
        const b = document.createElement('button');
        b.className = 'chip' + (c.activo ? ' on' : '');
        b.textContent = c.label;
        b.onclick = () => { cerrarMenuCtx(); c.fn(); };
        d.appendChild(b);
      });
      m.appendChild(d); return;
    }
    if (it.slider) {
      const d = document.createElement('div');
      d.className = 'mi-slider';
      const lab = document.createElement('span');
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = it.slider.min; inp.max = it.slider.max;
      inp.step = it.slider.step || 1; inp.value = it.slider.valor;
      lab.textContent = it.slider.fmt ? it.slider.fmt(inp.value) : inp.value;
      inp.oninput = () => {
        lab.textContent = it.slider.fmt ? it.slider.fmt(inp.value) : inp.value;
        it.slider.fn(+inp.value);
      };
      d.appendChild(inp); d.appendChild(lab);
      m.appendChild(d); return;
    }
    const b = document.createElement('button');
    b.className = 'mi' + (it.peligro ? ' peligro' : '');
    b.textContent = it.label;
    b.onclick = () => { cerrarMenuCtx(); it.fn(); };
    m.appendChild(b);
  });
  // "Cerrar" explícito como en el diálogo de la app Android: en móvil se
  // ve siempre (no hay hover ni Escape); en escritorio el CSS lo oculta
  const cerrar = document.createElement('button');
  cerrar.className = 'mi mi-cerrar';
  cerrar.textContent = 'Cerrar';
  cerrar.onclick = cerrarMenuCtx;
  m.appendChild(cerrar);
  m.classList.remove('oculto');
  // ≤768px el CSS lo fija centrado como diálogo compacto; en escritorio
  // sigue siendo un popover junto al clic
  if (innerWidth > 768) {
    m.style.left = Math.min(x, innerWidth - 220) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - items.length * 34 - 12)) + 'px';
  }
}

// abrirSolicitudes: panel lateral en la pestaña de manos levantadas
const abrirSolicitudes = () => {
  if (!panelEstaAbierto()) alternarPanel();
  const t = document.querySelector('.tab[data-tab="cola-manos"]');
  if (t) t.click();
};

// menuAsientoLibre: un moderador que toca un asiento vacío puede sentarse
// o cambiar su bloqueo (antes era un candado sobre el asiento que se pisaba
// con el pin del vídeo)
function menuAsientoLibre(ev, i, a) {
  ev.stopPropagation();
  const niveles = [
    ['🔓 Libre', 0], ['👥 Solo moderadores', 1], ['⛔ Nadie (oculto)', 2],
  ];
  abrirMenuCtx(ev.clientX, ev.clientY, [
    // "nadie" es nadie: en una silla b2 solo se ofrece el desbloqueo
    ...(a.bloqueo === 2 ? [] : [{ label: '🪑 Sentarse aquí', fn: () => sentarse(i + 1) }]),
    // cada nivel en su propio botón: bloquear del todo es UN toque
    ...niveles.filter(([, n]) => n !== a.bloqueo).map(([t, n]) => ({
      label: t,
      fn: () => moderar('bloquear_asiento', { asiento: i + 1, nivel: n })
        .catch(e => toast(e.message)),
    })),
  ], 'Asiento ' + (i + 1));
}

// menuPersona: opciones sobre un participante (en asiento, audiencia o Personas)
function menuPersona(ev, id, asientoNum) {
  ev.stopPropagation();
  const mod = esMod();
  const esMio = id === S.identidad;
  const pObj = participantePorId(id);
  const tituloP = (pObj ? nombreDe(pObj) : id) + (esMio ? ' (tú)' : '');
  const items = [];
  const claveFlotante = asientoNum ? 'asiento:' + (asientoNum - 1) : id;
  if (participantePorId(id)) items.push({
    label: flotantes.has(claveFlotante) ? 'Cerrar vídeo flotante' : 'Abrir vídeo flotante',
    fn: () => alternarFlotante(claveFlotante),
  });

  if (esMio) {
    if (tengoPalabra()) items.push({ label: '🗣️ Dejar la palabra', peligro: true,
      fn: () => confirmar('¿Dejar la palabra? Tu micrófono se silenciará.', dejarPalabra) });
    if (estoySentado()) items.push({ label: '🪑 Levantarme del asiento', fn: () => accion('levantarse').catch(e => toast(e.message)) });
    if (!tengoPalabra()) items.push({ label: '✋ ' + (manoLevantada() ? 'Bajar la mano' : 'Levantar la mano'),
      fn: () => manoLevantada()
        ? confirmar('¿Bajar la mano? Perderás tu solicitud de palabra.', () => accion('bajar_mano').catch(e => toast(e.message)))
        : accion('levantar_mano').catch(e => toast(e.message)) });
    if (!items.length) return;
    abrirMenuCtx(ev.clientX, ev.clientY, items, tituloP);
    return;
  }
  // volumen individual: cuánto lo escucho YO (amplificador hasta 300%);
  // cualquiera puede ajustarlo, no es una acción de moderador
  const volAct = Math.round((S.volPor[id] || 1) * 100);
  items.push({ titulo: 'Amplificar lo que escucho' });
  items.push({ slider: {
    min: 25, max: 300, step: 5, valor: volAct,
    fmt: v => v + '%',
    fn: v => { S.volPor[id] = v / 100; ajustarSalidas(); },
  } });
  if (!mod) { abrirMenuCtx(ev.clientX, ev.clientY, items, tituloP); return; }

  items.push(...itemsModeracion(id, asientoNum));
  abrirMenuCtx(ev.clientX, ev.clientY, items, tituloP);
}

// itemsModeracion: todas las opciones de un moderador sobre una persona,
// ordenadas en secciones con título para que el menú no sea un ladrillo
function itemsModeracion(id, asientoNum) {
  const items = [];
  const modYa = S.estado.moderadores.includes(id);
  items.push({ titulo: 'Palabra y asiento' });
  if (asientoNum) items.push({ label: '🪑 Levantar del asiento', fn: () => moderar('expulsar_asiento', { asiento: asientoNum }).catch(e => toast(e.message)) });
  if (!asientoNum) items.push({ label: '🪑 Invitar a sentarse', fn: () => moderar('invitar_sentar', { objetivo: id }).catch(e => toast(e.message)) });
  if (S.estado.palabra === id) {
    items.push({ label: '⛔ Quitar la palabra', peligro: true, fn: () =>
      confirmar('¿Quitar la palabra a ' + (participantePorId(id) ? nombreDe(participantePorId(id)) : id) + '?',
        () => moderar('cortar_palabra').catch(e => toast(e.message))) });
  } else {
    items.push({ label: '🗣️ Invitar a hablar', fn: () =>
      elegirTiempoPalabra('Duración de la palabra para ' + nombreDe(participantePorId(id) || { identity: id }), (s) =>
        moderar('invitar_palabra', { objetivo: id, nivel: Math.max(0, s) }).catch(e => toast(e.message))) });
  }
  if (asientoNum) {
    const estados = ['Libre', 'Solo moderadores', 'Nadie'];
    const a = S.estado.asientos[asientoNum - 1];
    items.push({ label: `🔒 Bloqueo del asiento: ${estados[a.bloqueo]} — cambiar`,
      fn: () => moderar('bloquear_asiento', { asiento: asientoNum, nivel: (a.bloqueo + 1) % 3 }).catch(e => toast(e.message)) });
  }
  items.push({ titulo: 'Micrófono' });
  items.push({ label: '🔇 Silenciar micro', fn: () => moderar('silenciar', { objetivo: id, modo: 'suave' }).catch(e => toast(e.message)) });
  items.push({ label: '⛔ Bloquear micro', fn: () => moderar('silenciar', { objetivo: id, modo: 'bloquear' }).catch(e => toast(e.message)) });
  items.push({ label: '🎙️ Permitir micro', fn: () => moderar('habilitar_mic', { objetivo: id }).catch(e => toast(e.message)) });
  const micEx = (S.micPermidos || []).includes(id);
  items.push({ label: micEx ? '✅ Quitar excepción de micro' : '🔓 Excepción de micro',
    fn: () => moderar('mic_excepcion', { objetivo: id, valor: !micEx }).catch(e => toast(e.message)) });
  items.push({ titulo: 'Cámara' });
  items.push({ label: '📷 Apagar cámara', fn: () => moderar('silenciar_cam', { objetivo: id, modo: 'suave' }).catch(e => toast(e.message)) });
  items.push({ label: '⛔ Prohibir cámara', fn: () => moderar('silenciar_cam', { objetivo: id, modo: 'bloquear' }).catch(e => toast(e.message)) });
  items.push({ label: '📷 Permitir cámara', fn: () => moderar('habilitar_cam', { objetivo: id }).catch(e => toast(e.message)) });
  const camEx = (S.camPermidos || []).includes(id);
  items.push({ label: camEx ? '✅ Quitar excepción de cámara' : '🔓 Excepción de cámara',
    fn: () => moderar('cam_excepcion', { objetivo: id, valor: !camEx }).catch(e => toast(e.message)) });
  items.push({ titulo: 'Pantalla y documentos' });
  const panEx = (S.panProhibidos || []).includes(id);
  items.push({ label: panEx ? '🖥️ Permitir compartir pantalla' : '🖥️🚫 Prohibir compartir pantalla',
    fn: () => moderar('pantalla_bloquear', { objetivo: id, valor: !panEx }).catch(e => toast(e.message)) });
  const docEx = (S.docProhibidos || []).includes(id);
  items.push({ label: docEx ? '📄 Permitir compartir documentos' : '📄🚫 Prohibir compartir documentos',
    fn: () => moderar('doc_bloquear', { objetivo: id, valor: !docEx }).catch(e => toast(e.message)) });
  items.push({ titulo: 'Chat y rol' });
  const chatEx = (S.chatProhibidos || []).includes(id);
  items.push({ label: chatEx ? '💬 Permitir chat' : '🚫 Bloquear chat',
    fn: () => moderar('chat_bloquear', { objetivo: id, valor: !chatEx }).catch(e => toast(e.message)) });
  items.push({ label: modYa ? '⭐ Quitar moderador' : '⭐ Hacer moderador', fn: () => moderar('delegar_moderador', { objetivo: id, valor: !modYa }).catch(e => toast(e.message)) });
  if ((S.grupos || []).length) {
    items.push({ titulo: 'Salas de discusión' });
    items.push({ label: '👥 Enviar a sala principal', fn: () => moderar('grupo_asignar', { objetivo: id, nivel: 0 }).catch(e => toast(e.message)) });
    S.grupos.forEach(g => items.push({
      label: `👥 Mover a: ${g.nombre}`,
      fn: () => moderar('grupo_asignar', { objetivo: id, nivel: g.id }).catch(e => toast(e.message)),
    }));
  }
  items.push({ titulo: '⚠️ Zona de riesgo' });
  items.push({ label: '✖ Expulsar de la sala', peligro: true, fn: () =>
    confirmar('¿Expulsar a esta persona de la sala?', () =>
      moderar('expulsar_sala', { objetivo: id }).catch(e => toast(e.message))) });
  items.push({ label: '🔨 Banear por minutos…', peligro: true, fn: () =>
    preguntarNumero('¿Minutos de baneo?', 10, (s) =>
      moderar('banear', { objetivo: id, nivel: Math.max(1, s) }).catch(e => toast(e.message))) });
  return items;
}

/* ---------- livekit wiring ---------- */
function cablearRoom(room) {
  // un Room nuevo reemplaza al viejo: corta las tuberías de audio anteriores
  S.salidas.forEach(s => { if (s.src) { try { s.src.disconnect(); s.gain.disconnect(); } catch {} } });
  S.salidas.clear();
  S.musica = null; S.musicaBase = 1;
  room.on(LC.RoomEvent.TrackSubscribed, (track, pub, participant) => {
    if (track.kind === 'audio') {
      const el = track.attach();
      el.dataset.lk = '1';
      el.dataset.sid = pub.trackSid;
      el.autoplay = true;
      document.body.appendChild(el);
      S.salidas.set(pub.trackSid, { el, track, id: participant.identity });
      ajustarSalida(pub.trackSid);
      if ((pub.trackName || '').startsWith('🎵')) {
        const s = S.salidas.get(pub.trackSid);
        if (s) { s.musica = true; ajustarSalida(pub.trackSid); }
        // tarjeta en la vista documento + salto automático: todos la ven
        S.musica = { sid: pub.trackSid, nombre: pub.trackName.slice(2).trim(),
          quien: nombreDe(participant) };
        S.musicaBase = 1;
        S.vistaLocal = 'presentacion';
        toast(`${nombreDe(participant)} está compartiendo audio: ${S.musica.nombre}`, 4500);
      }
    }
    if (pub.source === LC.Track.Source.ScreenShare) {
      // pantalla compartida gana siempre: todos saltan a la vista de pantalla
      S.vistaLocal = 'pantalla';
    }
    renderTodo();
  });
  room.on(LC.RoomEvent.TrackUnsubscribed, (track, pub) => {
    if (track.kind === 'audio') {
      const s = S.salidas.get(pub.trackSid);
      if (s) {
        if (s.src) { try { s.src.disconnect(); s.gain.disconnect(); } catch {} }
        S.salidas.delete(pub.trackSid);
      }
      if (S.musica && S.musica.sid === pub.trackSid) { S.musica = null; S.musicaBase = 1; }
      document.querySelectorAll(`audio[data-sid="${pub.trackSid}"]`).forEach(e => e.remove());
    }
    limpiarVideoEls(track);
    track.detach().forEach(e => e.remove());
    renderTodo();
  });
  const rerender = () => renderTodo();
  room.on(LC.RoomEvent.TrackMuted, rerender);
  room.on(LC.RoomEvent.TrackUnmuted, rerender);
  room.on(LC.RoomEvent.LocalTrackPublished, rerender);
  room.on(LC.RoomEvent.LocalTrackUnpublished, (pub) => {
    if (pub === S.audio.pub) cerrarPipeline();
    renderTodo();
  });
  room.on(LC.RoomEvent.ParticipantPermissionsChanged, (_, p) => {
    if (p.isLocal) renderControles();
  });
  room.on(LC.RoomEvent.ParticipantConnected, rerender);
  room.on(LC.RoomEvent.ParticipantDisconnected, rerender);
  room.on(LC.RoomEvent.ConnectionStateChanged, rerender);
  // el socket de medios reconectó solo (sin reconectar la sala): resincroniza
  // el historial — los cierres de frase perdidos llegan por el manifiesto
  room.on('media_reconectada', () => {
    sincronizarNotas();
    refrescarEstado();
  });
  room.on(LC.RoomEvent.ConnectionQualityChanged, (q, p) => {
    if (!p || !p.isLocal) return;
    const mala = q === LC.ConnectionQuality.Poor || q === LC.ConnectionQuality.Lost;
    const nivel = mala ? 'mala' : (q === LC.ConnectionQuality.Excellent ? 'buena' : 'media');
    if (nivel === S.calidadRed && mala === S.calidadMala) return;
    S.calidadMala = mala;
    S.calidadRed = nivel;
    // en modo automático ajusta el bitrate en caliente acorde a la conexión real
    if (S.prefAudio === 'auto' && S.audio.pub) actualizarCalidadAudioEnVivo();
  });
  room.on(LC.RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const filtrados = speakers.filter(s => s.identity !== S.identidad || S.ptt.quiero);
    const nuevo = filtrados.length ? filtrados[0].identity : null;
    if (nuevo === S.activo) return;
    S.activo = nuevo;
    // Actualizar el borde verde en caliente SIN reconstruir el DOM de los
    // asientos: si se llamara renderTodo() al hablar, innerHTML='' destruiría
    // el <div class="asiento"> bajo el dedo y se tragaría el clic/tap.
    $$('.asiento[data-id]').forEach(el => {
      // Verde "hablando" solo en asientos ajenos: en el mío el borde es el
      // estado del PTT (rojo = yo hablando) — un verde inline lo taparía
      el.style.borderColor =
        (el.dataset.id === S.activo && el.dataset.id !== S.identidad) ? 'var(--verde)' : '';
    });
    $$('#audiencia .mini-tile').forEach(el => {
      el.classList.toggle('hablando', el.dataset.id === S.activo);
    });
    $$('.tile[data-id]').forEach(el => {
      el.classList.toggle('hablando', el.dataset.id === S.activo);
    });
    if (!$('#z-orador').classList.contains('oculto')) renderOrador();
  });
  room.on(LC.RoomEvent.DataReceived, (payload, participant) => {
    let d;
    try { d = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
    manejarData(d, participant);
  });
  // --- notas de voz en vivo (segmentos confiables) ---
  room.on('voz_propia_ini', (m) => agregarNotaPropiaPendiente(m && m.inicio));
  room.on('seg_ini', (m) => {
    if (!m) return;
    S._ultimoSeg = Math.max(S._ultimoSeg || 0, m.seq || 0);
    agregarNotaVozEnVivo(m);
  });
  room.on('seg_fin', (m) => {
    if (!m) return;
    S._ultimoSeg = Math.max(S._ultimoSeg || 0, m.seq || 0);
    agregarNotaVoz(m);
    idbGuardarSeg(m.seq);
    // todo audio cerrado queda persistido en el teléfono (incluido el mío,
    // que nunca pasa por mi cola en vivo): el servidor lo purga en ~1 h
    if ((m.durMs || 0) >= 800) bgEncolarSeg(m.seq, 4000);
  });
  room.on('seg_perdido', (seq) => marcarNotaVoz(seq, 'perdida'));
  room.on('seg_reproduciendo', (m) => { if (m) marcarNotaVoz(m.seq, 'sonando'); });
  room.on('seg_reproducido', (m) => { if (m) marcarNotaVoz(m.seq, 'oido'); });
  room.on('seg_replay_fin', (seq) => reproducirSiguienteNota(seq));
  room.on('seg_progreso', (p) => { if (p) marcarNotaVoz(p.seq, 'progreso', p); });
  room.on('voz_retraso', (ms) => renderRetraso(ms));
  // --- piso exclusivo (PTT) ---
  room.on('piso', (m) => {
    if (m && m.estado === 'mio') {
      // El servidor me dio el piso pero yo ya lo solté (dedo levantado,
      // sin candado, VAD callado): el estado LOCAL manda — suelta
      // explícito para que cierre la frase que conserve de antes
      if (!S.ptt.quiero && !(S.room && S.room._quieroPiso)) {
        S.ptt.tengo = false;
        S.room.soltarPiso();
        renderControles();
        return;
      }
      S.ptt.tengo = true;
      // si el micro quedó muteado (p.ej. soy la palabra y me interrumpieron)
      // vuelve solo: con La Palabra el micro no se apaga con el botón
      if (S.ptt.quiero && S.audio.pub && S.audio.pub.isMuted)
        S.audio.pub.unmute().catch(() => {});
      if (modoPtt() && S.ptt.quiero) sonidoPiso(true); // chirp de "ya puedes hablar"
      renderControles();
    }
  });
  room.on('piso_ocupado', (m) => {
    S.ptt.tengo = false;
    // Teniendo La Palabra no se cancela la intención: quedo en espera y
    // retomo el piso solo cuando el que me interrumpió suelte el botón
    if (tengoPalabra()) {
      if (S.audio.pub && !S.audio.pub.isMuted) S.audio.pub.mute().catch(() => {});
    } else if (modoPtt()) pttOff(); // cancela el intento y libera el micrófono
    S.pisoFaltan = (m && m.faltan) || 0;
    // rechazo audible con enfriamiento: en modo auto el VAD reintenta solo
    // y el beep no debe sonar en cada intento
    const ahoraR = Date.now();
    if (!S._pisoRechazoTs || ahoraR - S._pisoRechazoTs > 3000) {
      S._pisoRechazoTs = ahoraR;
      sonidoPiso(false);
      if (m && m.error) toast(m.error);
      else toast(`🎙️ ${(m && m.nombre) || 'Otra persona'} tiene el piso — podrás interrumpir en ${S.pisoFaltan} s`, 4500);
    }
    renderControles();
  });
  room.on('piso_perdido', (m) => {
    if (tengoPalabra()) {
      // interrumpido: sigo con La Palabra y el piso vuelve solo cuando el
      // otro suelte; mientras tanto el micro queda muteado y mi tiempo pausado
      S.ptt.tengo = false;
      if (S.audio.pub && !S.audio.pub.isMuted) S.audio.pub.mute().catch(() => {});
      toast(`⏸️ ${(m && m.por) || 'Otra persona'} te interrumpió — tu palabra se pausa`, 4500);
    } else {
      pttOff(true); // suelta piso, intención y (en manual) el micrófono
      toast(`⚠️ ${(m && m.por) || 'Otra persona'} tomó el piso`, 4500);
    }
    renderControles();
  });
  room.on('piso_estado', (m) => {
    // En cuanto alguien suelta el PTT, el servidor difunde piso_estado a
    // todos los clientes por el WebSocket de medios: los demás clientes
    // siguen escuchando el audio que les queda en cola, pero su PTT se
    // libera de inmediato (pasa a amarillo) para que puedan pisar e
    // interrumpir sin esperar a que termine de sonar la cola atrasada.
    if (!S.estado) return;
    const nuevoPiso = (m && m.piso) || '';
    if (nuevoPiso === S.identidad && !S.ptt.quiero) {
      S.estado.piso = '';
      S.estado.pisoNombre = '';
    } else {
      S.estado.piso = nuevoPiso;
      S.estado.pisoNombre = (m && m.nombre) || '';
    }
    renderPttEstados();
  });
  room.on(LC.RoomEvent.Disconnected, (razon) => {
    // no reconectar si salimos a propósito, si este Room ya fue reemplazado
    // o si la desconexión la provocó el cambio de sala de discusión
    if (S.saliendo || room !== S.room || conectandoGrupo) return;
    // si el servidor nos echó por identidad duplicada (la sala abierta en
    // otra pestaña/dispositivo con el mismo nombre), reconectar a ciegas
    // crea una guerra infinita de kicks entre ambas sesiones: avisar y
    // que el usuario decida dónde seguir
    if (razon === undefined) razon = room.disconnectReason;
    if (LC.DisconnectReason && razon === LC.DisconnectReason.DUPLICATE_IDENTITY) {
      mostrarSesionDuplicada();
      return;
    }
    reconectar();
  });
}

// La sala se abrió con la misma identidad en otro lado: ofrecer quedarse
// aquí (expulsa a la otra sesión) o salir. Sin esto, ambas partes se
// reconectan solas y se expulsan mutuamente en bucle.
function mostrarSesionDuplicada() {
  if (S.saliendo) return;
  cerrarPipeline(); // soltar el micro local mientras se decide (la intención sobrevive en S.audio.on)
  genModal('Sesión abierta en otro lugar',
    '<p>Esta sala se abrió con tu nombre en otra pestaña o dispositivo, y esta conexión se cerró.</p>',
    () => reconectar(), 'Quedarme aquí');
  const cancel = $('#gen-cancel');
  cancel.textContent = 'Salir';
  cancel.onclick = () => { cerrarModal('modal-gen'); salir(); };
}

/* ---------- conexión LiveKit con tolerancia a redes débiles ---------- */
// nuevaRoom: opciones comunes. La captura se topea a 540p para que una
// subida floja no se ahogue publicando video grande; el resto de la calidad
// la regulan dynacast/adaptiveStream capa a capa.
function nuevaRoom() {
  return new LC.Room({
    adaptiveStream: true, dynacast: true,
    videoCaptureDefaults: { resolution: LC.VideoPresets.h540.resolution },
  });
}

// conectarRoom intenta la política ICE que manda el servidor (relay/TURN en
// accesos públicos por el túnel). Si el PC no se arma, reintenta con
// política 'all' + STUN: algunas redes sí alcanzan el servidor por UDP/TCP
// directo y así se salvan cuando el TURN está caído o sus credenciales
// caducaron. También evita fallar en seco por una credencial TURN vieja.
async function conectarRoom(room, url, token) {
  // quitar urls turn:/turns: de entradas sin credenciales: Chrome rechaza
  // TODA la configuración ICE si una sola url turn: no las tiene
  const ice = (S.iceServers || []).map(s => {
    if (!s || !s.username || !s.credential)
      return { ...s, urls: (s.urls || []).filter(u => !/^turns?:/.test(u)) };
    return s;
  }).filter(s => (s.urls || []).length);
  const cfg = {};
  if (S.icePolicy) cfg.iceTransportPolicy = S.icePolicy;
  if (ice.length) cfg.iceServers = ice;
  console.log('ICE config:', JSON.stringify({
    policy: S.icePolicy || 'all',
    servers: ice.map(s => s.urls).flat(),
  }));
  try {
    await room.connect(url, token, { rtcConfig: cfg });
    return;
  } catch (e) {
    // solo reintentar si la política pedida era restrictiva; si ya era 'all'
    // el fallo es otro (token, sala, permisos) y repetir no arregla nada
    if (!S.icePolicy || S.icePolicy === 'all') throw e;
    console.warn('ICE relay falló, reintentando con politica all:', e.message);
    const alt = {
      iceTransportPolicy: 'all',
      iceServers: ice.concat([
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
      ]),
    };
    await room.connect(url, token, { rtcConfig: alt });
    toast('Conectado por ruta directa (el relé TURN falló)', 4000);
  }
}

/* ---------- reconexión automática ---------- */
// Pide un acceso nuevo (el token viejo puede haber caducado) y vuelve a
// entrar a la sala LiveKit, restaurando cámara/micro. Reintenta sin límite
// con espera creciente hasta que el usuario salga.
let reconectando = false;
async function reconectar() {
  if (reconectando || S.saliendo) return;
  reconectando = true;
  const tCaida = Date.now();
  let avisado = false;
  for (let intento = 1; !S.saliendo; intento++) {
    // Caída corta = silencio: las notas descargadas siguen sonando y la
    // sala sigue ahí. Solo pasados ~10 s se muestra un aviso discreto.
    if (!avisado && Date.now() - tCaida > 10000) {
      avisado = true;
      toast('📡 Sin conexión — reintentando en segundo plano (sigues en la sala)', 6000);
    }
    try {
      const r = await api('/api/obtener-acceso', {
        sala: S.sala, nombre: S.nombre, clave: S.clave || '',
        identidad: S.identidad, // conservar sala de discusión/asiento al reconectar
      });
      S.token = r.token; S.identidad = r.identidad; S.esAdmin = r.admin;
      guardarSesion();
      S.icePolicy = r.icePolicy || ''; S.iceServers = r.iceServers || null;
      const room = nuevaRoom();
      videoEls.clear();
      S.room = room;
      cablearRoom(room);
      await conectarRoom(room, r.url, r.token);
      // conservar el historial de voz: el Room nuevo parte del último seq
      // conocido y la bienvenida solo descarga lo que faltó durante el corte
      room._ultimoSeg = Math.max(room._ultimoSeg || 0, S._ultimoSeg || 0);
      room._vozBase = true;
      S.grupoActual = r.grupo || 0; S.miGrupo = S.grupoActual;
      if (S.camQuerida) {
        try { await room.localParticipant.setCameraEnabled(true, { deviceId: S.dev.cam ? { exact: S.dev.cam } : undefined }); } catch {}
      }
      if (S.audio.on || (modoPtt() && S.ptt.quiero)) {
        // auto: re-publica el micro para el VAD; manual: solo si seguía pisado
        try {
          S.audio.pub = null;
          await prepararMicPtt();
          if (modoPtt() && S.ptt.quiero) {
            if (!S.audio.pub) {
              const track = await construirMicTrack();
              S.audio.pub = await S.room.localParticipant.publishTrack(track, opcionesAudio());
            }
            S.room.tomarPiso();
            S.audio.on = true;
          }
        } catch {}
      }
      if (avisado) toast('📡 Conexión restablecida');
      refrescarEstado();
      sincronizarNotas(); // notas de voz del chat que se perdió el corte
      renderTodo();
      reconectando = false;
      return;
    } catch (e) {
      console.warn('reconexión falló:', e.message);
      // error permanente (sala borrada, clave inválida, baneado): no insistir
      if (e.status === 401 || e.status === 403 || e.status === 404) {
        toast('No se pudo reconectar: ' + e.message, 8000);
        setTimeout(() => location.href = '/', 4000);
        break;
      }
      await new Promise(res => setTimeout(res, Math.min(2000 * intento, 12000)));
    }
  }
  reconectando = false;
}

function pubData(obj, reliable = true) {
  S.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable });
}

function manejarData(d, participant) {
  const quien = participant ? (participant.name || participant.identity) : '';
  switch (d.t) {
    case 'chat':
      if (!puedeVerChatDe(participant)) break; // chat bloqueado por moderación
      agregarChat(quien, d.texto, participant && participant.identity === S.identidad);
      if (!chatVisible()) lanzarChatFlota(quien, d.texto);
      break;
    case 'wb': {
      const s = d.shape || (d.line && { k: 'seg', ...d.line });
      if (s) {
        if (d.shape) dibujarShape(d.shape); else dibujarLinea(d.line);
        S.wb.strokes.push(s);
        // si un trazo mío vuelve (re-emisión tras deshacer), lo recupero
        if (s.u === S.identidad && !S.wb.mios.includes(s)) S.wb.mios.push(s);
        // alguien dibuja en la pizarra → todos saltamos a esa vista (como
        // con pantalla y documento)
        if (participant && S.vistaLocal !== 'pizarra') {
          S.vistaLocal = 'pizarra';
          renderTodo();
        }
      }
      break;
    }
    case 'wb_laser':
      agregarLaser(participant ? participant.identity : '_r', d.x, d.y);
      break;
    case 'rec_start':
      if (participant) {
        S.grabadores.add(participant.identity);
        toast('🔴 ' + (d.quien || quien) + ' comenzó a grabar la sala');
        renderControles();
      }
      break;
    case 'rec_stop':
      if (participant) {
        S.grabadores.delete(participant.identity);
        renderControles();
      }
      break;
    case 'wb_clear':
      S.wb.strokes = []; S.wb.mios = []; redibujarPizarra();
      break;
    case 'wb_req':
      if (S.wb.strokes.length) pubData({ t: 'wb_state', strokes: S.wb.strokes });
      break;
    case 'wb_state':
      if (!S.wb.cargado) {
        S.wb.cargado = true;
        S.wb.strokes = d.strokes;
        if (!S.wb.mios.length) S.wb.mios = d.strokes.filter(s => s.u === S.identidad);
        redibujarPizarra();
      }
      break;
    case 'reaccion':
      if (participant) mostrarReaccion(participant.identity, d.emoji);
      break;
    case 'aud_vol':
      // quien emite el audio compartido movió su volumen: se aplica como
      // nivel base sobre el slider local de cada oyente; con "reset" (botón
      // sincronizar) además reinicia mi slider para sonar igual que allí
      S.musicaBase = d.muted ? 0 : Math.min(1, Math.max(0, +(d.v ?? 1)));
      if (d.reset) S.volMusica = 1;
      ajustarSalidas();
      break;
  }
}

/* ---------- reacciones emoji sincronizadas ---------- */
const REACCIONES = ['👏', '👍', '👎', '😄', '😐', '😢', '😠', '😴', '❤️', '🎉', '🤝', '👌'];
const REACCION_MS = 3800;

function enviarReaccion(emoji) {
  try { pubData({ t: 'reaccion', emoji }); } catch {}
  mostrarReaccion(S.identidad, emoji);
}

// mostrarReaccion: aparece sobre el vídeo/avatar de quien la envió, crece,
// se mantiene ~3s y se desvanece (la animación la hace el CSS)
function mostrarReaccion(id, emoji) {
  S.reacciones.set(id, { emoji, ts: Date.now() });
  adjuntarReacciones();
  // solo cuenta como ancla un elemento visible: si está en una pestaña o
  // vista oculta, la emoji sube desde abajo como en un directo
  const anclada = $$(`[data-id="${CSS.escape(id)}"]`).some(el =>
    el.matches('.asiento, .video-flotante') && el.offsetParent !== null);
  if (!anclada) {
    const p = participantePorId(id);
    lanzarReaccionFlota(emoji, p ? nombreDe(p) : id);
  }
}
function lanzarReaccionFlota(emoji, quien) {
  const e = document.createElement('div');
  e.className = 'reaccion-flota';
  e.innerHTML = `<span class="em">${emoji}</span>` +
    (quien ? `<span class="quien">${esc(quien)}</span>` : '');
  e.style.left = Math.round(innerWidth * 0.15 + Math.random() * innerWidth * 0.6) + 'px';
  document.body.appendChild(e);
  setTimeout(() => e.remove(), 3700);
}

function adjuntarReacciones() {
  const ahora = Date.now();
  for (const [id, r] of S.reacciones) {
    const edad = ahora - r.ts;
    if (edad > REACCION_MS) { S.reacciones.delete(id); continue; }
    $$(`[data-id="${CSS.escape(id)}"]`).forEach(el => {
      if (!el.matches('.asiento, .video-flotante') || el.offsetParent === null) return;
      // data-ts evita duplicar en cada re-render; envíos distintos sí apilan
      if (el.querySelector(`.reaccion-pop[data-ts="${r.ts}"]`)) return;
      const e = document.createElement('div');
      e.className = 'reaccion-pop';
      e.dataset.ts = r.ts;
      e.textContent = r.emoji;
      e.style.left = (30 + Math.random() * 40) + '%';
      el.appendChild(e);
      setTimeout(() => e.remove(), Math.max(300, REACCION_MS - edad));
    });
  }
}

/* ---------- render ---------- */
function todosLosParticipantes() {
  const list = [S.room.localParticipant, ...S.room.remoteParticipants.values()];
  return list;
}
function participantePorId(id) {
  if (S.room.localParticipant.identity === id) return S.room.localParticipant;
  return S.room.remoteParticipants.get(id);
}
const nombreDe = (p) => p.name || p.identity;
const esAdminDe = (id) => (S.admins || []).includes(id);
const marcaRol = (id) => esAdminDe(id) ? '👑 ' :
  (S.estado && S.estado.moderadores.includes(id)) ? '⭐ ' : '';

// una ventana flotante puede seguir a una persona ("id"), a un asiento
// ("asiento:N") o al puesto de la palabra ("palabra")
function resolverFlotante(clave) {
  if (clave === 'palabra') return (S.estado && S.estado.palabra) || '';
  // 'pantalla' sigue a quien esté compartiendo pantalla en este momento
  if (clave === 'pantalla') {
    const p = todosLosParticipantes().find(q => {
      const pub = q.getTrackPublication(LC.Track.Source.ScreenShare);
      return pub && pub.track;
    });
    return p ? p.identity : '';
  }
  if (clave.startsWith('asiento:')) {
    const a = S.estado && S.estado.asientos[+clave.slice(8)];
    return (a && a.identidad) || '';
  }
  return clave;
}
function tituloFlotante(clave) {
  if (clave === 'palabra') return 'Palabra';
  if (clave === 'pantalla') return 'Pantalla compartida';
  if (clave.startsWith('asiento:')) return 'Asiento ' + (+clave.slice(8) + 1);
  return '';
}

function alternarFlotante(clave) {
  // mientras hay pantalla compartida no se abren ventanas de cámaras: la
  // única flotante es la de la pantalla (lleva de vuelta a la vista)
  if (clave !== 'pantalla' && pantallaCompartida()) {
    toast('Mientras se comparte pantalla solo queda su ventanita flotante');
    return;
  }
  if (flotantes.has(clave)) {
    flotantes.get(clave).remove();
    flotantes.delete(clave);
    if (clave === 'pantalla') S.pantallaFlotanteOff = true; // respetar el cierre manual
    renderTodo();
    return;
  }
  const panel = document.createElement('div');
  panel.className = 'video-flotante';
  panel.style.left = Math.max(8, innerWidth - 344 - (flotantes.size % 3) * 28) + 'px';
  panel.style.top = 80 + (flotantes.size % 3) * 28 + 'px';
  panel.style.zIndex = ++flotanteOrden;
  const barra = document.createElement('div');
  barra.className = 'flotante-barra';
  const titulo = document.createElement('strong');
  barra.appendChild(titulo);
  const acc = document.createElement('span');
  acc.className = 'flotante-acc';
  const mk = (txt, tit, fn) => {
    const b = document.createElement('button');
    b.className = 'btn mini'; b.type = 'button'; b.textContent = txt;
    b.title = tit; b.setAttribute('aria-label', tit);
    b.onclick = (ev) => { ev.stopPropagation(); fn(b); };
    return b;
  };
  // encoger: deja solo la barra para ver lo que hay debajo
  const bCol = mk('–', 'Encoger (deja solo la barra)', (b) => {
    const on = panel.classList.toggle('encogida');
    b.textContent = on ? '+' : '–';
    b.title = on ? 'Expandir' : 'Encoger (deja solo la barra)';
    b.setAttribute('aria-label', b.title);
  });
  // maximizar/restaurar; se puede encoger también estando maximizada
  const bMax = mk('□', 'Maximizar', (b) => {
    const on = panel.classList.toggle('max');
    b.textContent = on ? '▣' : '□';
    b.title = on ? 'Restaurar tamaño' : 'Maximizar';
    b.setAttribute('aria-label', b.title);
  });
  const cerrar = mk('×', 'Cerrar vídeo flotante', () => alternarFlotante(clave));
  acc.append(bCol, bMax, cerrar);
  barra.appendChild(acc);
  const contenido = document.createElement('div');
  contenido.className = 'flotante-contenido';
  if (clave === 'pantalla') {
    // tocar la miniatura devuelve a la vista de pantalla completa
    contenido.style.cursor = 'zoom-in';
    contenido.title = 'Volver a la vista de pantalla';
    contenido.onclick = () => { S.vistaLocal = 'pantalla'; renderTodo(); };
  }
  const tamano = document.createElement('div');
  tamano.className = 'flotante-tamano';
  panel.append(barra, contenido, tamano);
  const mover = (handle, redimensionar) => handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    panel.style.zIndex = ++flotanteOrden;
    const rect = panel.getBoundingClientRect(), x = e.clientX, y = e.clientY;
    handle.setPointerCapture(e.pointerId);
    handle.onpointermove = (m) => {
      if (redimensionar) {
        panel.style.width = Math.max(180, Math.min(innerWidth - rect.left - 8, rect.width + m.clientX - x)) + 'px';
        panel.style.height = Math.max(140, Math.min(innerHeight - rect.top - 8, rect.height + m.clientY - y)) + 'px';
      } else {
        panel.style.left = Math.max(0, Math.min(innerWidth - rect.width, rect.left + m.clientX - x)) + 'px';
        panel.style.top = Math.max(0, Math.min(innerHeight - rect.height, rect.top + m.clientY - y)) + 'px';
      }
    };
    handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; };
  });
  mover(barra, false);
  mover(tamano, true);
  $('#flotantes').appendChild(panel);
  flotantes.set(clave, panel);
  renderTodo();
}

function actualizarFlotantes() {
  for (const [clave, panel] of flotantes) {
    const id = resolverFlotante(clave);
    // la ventanita de pantalla no espera a nadie: si nadie comparte, se va
    if (clave === 'pantalla' && !id) { panel.remove(); flotantes.delete(clave); continue; }
    const p = id && participantePorId(id);
    panel.dataset.id = id || ''; // las reacciones siguen al ocupante actual
    const tag = tituloFlotante(clave);
    const persona = p ? nombreDe(p) + (id === S.identidad ? ' (tú)' : '') : '—';
    panel.querySelector('strong').textContent = tag ? `${tag} · ${persona}` : persona;
    const contenido = panel.querySelector('.flotante-contenido');
    if (!p) {
      // persona desapareció de la sala: las ventanas de asiento/palabra
      // esperan al siguiente ocupante; las de persona se cierran
      if (tag) {
        if (panel._el !== null) {
          panel._el = null;
          const vacio = document.createElement('span');
          vacio.textContent = clave === 'palabra' ? 'Palabra libre' : 'Asiento libre';
          contenido.replaceChildren(vacio);
        }
        continue;
      }
      panel.remove(); flotantes.delete(clave); continue;
    }
    const fuente = clave === 'pantalla' ? LC.Track.Source.ScreenShare : LC.Track.Source.Camera;
    const v = videoDe(p, fuente, 'flotante:' + clave);
    if (panel._el === v) continue;
    panel._el = v;
    if (v) contenido.replaceChildren(v);
    else {
      const vacio = document.createElement('span');
      vacio.textContent = 'Cámara apagada';
      contenido.replaceChildren(vacio);
    }
  }
}

function tileVideo(p, superficie = 'rejilla') {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = p.identity;
  const v = videoDe(p, LC.Track.Source.Camera, superficie);
  if (v) {
    tile.appendChild(v);
  } else {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = (nombreDe(p)[0] || '?').toUpperCase();
    tile.appendChild(av);
  }
  const nm = document.createElement('div');
  nm.className = 'nombre';
  nm.textContent = nombreDe(p) + (p.identity === S.identidad ? ' (tú)' : '');
  tile.appendChild(nm);
  const ic = document.createElement('div');
  ic.className = 'iconos';
  const micPub = p.getTrackPublication(LC.Track.Source.Microphone);
  ic.innerHTML = `<span>${micPub && !micPub.isMuted ? '🎙️' : '🔇'}</span>`;
  if (S.estado && S.estado.manos.some(m => m.identidad === p.identity)) ic.innerHTML += '<span>✋</span>';
  const asiento = S.estado ? S.estado.asientos.findIndex(a => a.identidad === p.identity) : -1;
  if (asiento >= 0) ic.innerHTML += `<span>🪑${asiento + 1}</span>`;
  if (esAdminDe(p.identity)) ic.innerHTML += '<span title="Administrador">👑</span>';
  else if (S.estado && S.estado.moderadores.includes(p.identity)) ic.innerHTML += '<span title="Moderador">⭐</span>';
  if (esMod() && S.micProhibidos.includes(p.identity))
    ic.innerHTML += '<span class="micbloq" title="Micrófono prohibido por moderación">🔴🎙️</span>';
  if (esMod() && S.camProhibidos.includes(p.identity))
    ic.innerHTML += '<span class="micbloq" title="Cámara prohibida por moderación">🔴📷</span>';
  tile.appendChild(ic);
  const pin = document.createElement('button');
  pin.className = 'btn mini tile-pin'; pin.type = 'button';
  pin.textContent = '📌';
  pin.title = 'Abrir o cerrar vídeo flotante de ' + nombreDe(p);
  pin.setAttribute('aria-label', pin.title);
  pin.onclick = (ev) => { ev.stopPropagation(); alternarFlotante(p.identity); };
  tile.appendChild(pin);
  tile.onclick = (ev) => menuPersona(ev, p.identity, 0);
  if (S.activo === p.identity) tile.classList.add('hablando');
  return tile;
}

function renderTodo() {
  if (!S.room || !S.estado) return;
  $('#st-silencio').classList.toggle('oculto', !S.estado.silencio);
  $('#st-micasientos').classList.toggle('oculto', !S.estado.micAsientos);
  if ($('#st-cam')) $('#st-cam').classList.toggle('oculto',
    !(S.estado.camAudiencia || S.estado.camAsientos));
  $('#st-rec').classList.toggle('oculto', !(S.rec || S.grabadores.size));
  $('#st-panel-admin').classList.toggle('oculto', !esMod());
  if ($('#st-renombrar')) $('#st-renombrar').classList.toggle('oculto', !esMod());
  $('#badge-manos').textContent = S.estado.manos.length;
  $('#badge-manos').classList.toggle('oculto', !S.estado.manos.length);
  // manos levantadas visibles en la cabecera desde cualquier vista
  $('#st-manos').classList.toggle('oculto', !S.estado.manos.length);
  $('#st-manos-n').textContent = S.estado.manos.length;
  // cola para sentarse: chip 🪑 arriba junto a las manos (para el moderador)
  if ($('#st-cola')) {
    $('#st-cola').classList.toggle('oculto', !(esMod() && S.estado.cola.length));
    $('#st-cola-n').textContent = S.estado.cola.length;
  }
  // sala de espera: chip persistente para el moderador en cualquier vista
  const nLobby = (S.lobbyLista || []).length;
  if ($('#st-lobby')) {
    $('#st-lobby').classList.toggle('oculto', !(esMod() && nLobby));
    $('#st-lobby-n').textContent = nLobby;
  }

  // si la pantalla compartida terminó y la vista quedó fijada en ella,
  // volver a la vista sincronizada (antes se quedaba en la zona vacía)
  if (S.vistaLocal === 'pantalla' && !pantallaCompartida()) S.vistaLocal = null;
  // con pantalla compartida la vista NO queda bloqueada: puedes moverte a
  // otra pestaña (levantar la mano, ver quién está sentado, personas) y una
  // ventanita flotante te devuelve a la pantalla al tocarla
  // vista fijada: la audiencia solo ve la vista que el moderador sincroniza
  // (o la pantalla si hay share); los moderadores se mueven libre y ven
  // el aviso de en qué pestaña está la audiencia
  const vistaBloq = !!S.estado.vistaFija && !esMod();
  const vista = vistaBloq
    ? (pantallaCompartida() ? 'pantalla' : (S.vistaSync || 'asientos'))
    : (S.vistaLocal || S.vistaSync || 'asientos');
  ['asientos', 'rejilla', 'orador', 'pantalla', 'presentacion', 'pizarra'].forEach(v =>
    $('#z-' + v).classList.toggle('oculto', v !== vista));
  $$('#st-vistas .vista-btn').forEach(b => {
    b.classList.toggle('activo', b.dataset.vista === vista);
    b.disabled = vistaBloq; // audiencia: las pestañas no responden
    b.title = vistaBloq ? 'La vista la elige el moderador' : '';
  });
  const vistaTgl = $('#st-vistas-toggle');
  if (vistaTgl) vistaTgl.classList.toggle('oculto', vistaBloq);
  // al moderador: aviso cuando la audiencia está en otra pestaña — tocarlo
  // sincroniza (lleva a todos a la vista que él está mirando)
  const audChip = $('#st-aud-vista');
  if (audChip) {
    const audVista = S.vistaSync || 'asientos';
    const miVista = S.vistaLocal || audVista;
    const difiere = esMod() && !!S.estado.vistaFija && miVista !== audVista;
    audChip.classList.toggle('oculto', !difiere);
    if (difiere) audChip.textContent = `👥 audiencia: ${audVista}`;
  }
  $('#st-sync').classList.toggle('oculto', !esMod());

  // ventanita flotante de la pantalla compartida: aparece cuando te vas a
  // otra vista; mientras dura el share no hay flotantes de cámaras
  const compartiendo = pantallaCompartida();
  document.body.classList.toggle('compartiendo', compartiendo);
  if (!compartiendo) S.pantallaFlotanteOff = false; // nuevo share = ventanita otra vez
  for (const [c, pan] of flotantes) {
    // share activo: solo sobrevive la flotante 'pantalla' y solo si no
    // estás ya en su vista; sin share: la flotante 'pantalla' se cierra
    const cerrar = compartiendo ? (c !== 'pantalla' || vista === 'pantalla') : c === 'pantalla';
    if (cerrar) { pan.remove(); flotantes.delete(c); }
  }
  if (compartiendo && vista !== 'pantalla' && !flotantes.has('pantalla') && !S.pantallaFlotanteOff)
    alternarFlotante('pantalla');

  renderAsientos();
  renderRejilla();
  renderOrador();
  renderPantalla();
  renderPresentacion();
  renderListas();
  renderControles();
  actualizarFlotantes();
  adjuntarReacciones();
}

function renderAsientos() {
  if ($('#z-asientos').classList.contains('oculto')) return;
  const filas = [$('#fila-mod'), $('#fila-2'), $('#fila-3')];
  filas.forEach(f => f.innerHTML = '');
  S.estado.asientos.forEach((a, i) => {
    // bloqueado "para nadie" = el asiento no existe para el público (como
    // eliminarlo); solo el moderador lo ve, para poder desbloquearlo
    if (a.bloqueo === 2 && !a.identidad && !esMod()) return;
    const div = document.createElement('div');
    div.className = 'asiento';
    div.innerHTML = `<span class="num">${i + 1}</span>`;
    const mod = esMod();

    if (a.bloqueo === 2 && !a.identidad) {
      div.classList.add('b2');
      div.insertAdjacentHTML('beforeend', '<span class="tag">Bloqueado</span>');
      // el moderador sí lo ve para poder desbloquearlo / pasarlo a "solo mods"
      if (mod) {
        div.insertAdjacentHTML('beforeend', '<span class="sentar">⚙️ Opciones</span>');
        div.onclick = (ev) => menuAsientoLibre(ev, i, a);
      }
    } else if (a.bloqueo === 1 && !a.identidad && !mod) {
      div.classList.add('b1');
      div.insertAdjacentHTML('beforeend', '<span class="tag">Solo moderadores</span>');
    } else if (a.bloqueo === 1 && !a.identidad && mod) {
      div.classList.add('b1', 'libre');
      div.insertAdjacentHTML('beforeend', '<span class="sentar">Sentarse</span>');
      div.onclick = (ev) => menuAsientoLibre(ev, i, a);
    } else if (a.identidad) {
      div.classList.add('ocupado');
      div.dataset.id = a.identidad;
      const p = participantePorId(a.identidad);
      if (p) {
        const v = videoDe(p, LC.Track.Source.Camera, 'asiento:' + i);
        if (v) div.appendChild(v);
        else div.insertAdjacentHTML('beforeend', `<div class="avatar">${esc((a.nombre[0] || '?').toUpperCase())}</div>`);
      }
      div.insertAdjacentHTML('beforeend', `<span class="tag">${marcaRol(a.identidad)}${esc(a.nombre)}</span>`);
      if (p) {
        // microfonito como en Android: 🎙️ encendido / 🔇 apagado en la esquina
        const micPub = p.getTrackPublication(LC.Track.Source.Microphone);
        div.insertAdjacentHTML('beforeend',
          `<span class="mic-ind">${micPub && !micPub.isMuted ? '🎙️' : '🔇'}</span>`);
        const pin = document.createElement('button');
        pin.className = 'btn mini asiento-pin'; pin.type = 'button'; pin.textContent = '📌';
        pin.title = 'Vídeo flotante del asiento ' + (i + 1) + ' (sigue a quien se siente)';
        pin.onclick = (ev) => { ev.stopPropagation(); alternarFlotante('asiento:' + i); };
        pin.addEventListener('pointerdown', ev => ev.stopPropagation());
        div.appendChild(pin);
      }
      // Verde "hablando" solo en asientos ajenos: en el mío manda el color
      // del pulsador PTT (rojo = yo hablando); sin esto tapaba el rojo
      if (S.activo === a.identidad && a.identidad !== S.identidad)
        div.style.borderColor = 'var(--verde)';
      // MI asiento entero ES el pulsador PTT: mi nombre queda dentro del
      // botón y las esquinas guardan las acciones (⋮ opciones · ✕ salir)
      if (a.identidad === S.identidad && S.room) {
        div.classList.add('asiento-mio', 'ptt-sup');
        wirePttButton(div);
        div._pttSinGesto = true; // un asiento entero no se arrastra: esquinas fijas
        div.insertAdjacentHTML('beforeend',
          '<button class="asiento-esq menu" type="button" title="Opciones del asiento">⋮</button>' +
          '<button class="asiento-esq salir" type="button" title="Levantarme del asiento">✕</button>' +
          '<button class="asiento-esq lock" type="button" title="Hablar con el micrófono bloqueado (sin mantener)">🔒</button>' +
          '<button class="asiento-esq auto" type="button" title="Modo automático: la voz pisa el botón por ti">A</button>');
        div.querySelector('.asiento-esq.menu').onclick =
          (ev) => { ev.stopPropagation(); menuPersona(ev, a.identidad, i + 1); };
        div.querySelector('.asiento-esq.salir').onclick =
          (ev) => { ev.stopPropagation(); accion('levantarse').catch(e => toast(e.message)); };
        div.querySelector('.asiento-esq.lock').onclick =
          (ev) => { ev.stopPropagation(); pttEsquinaLock(); };
        div.querySelector('.asiento-esq.auto').onclick =
          (ev) => { ev.stopPropagation(); cambiarModoPtt(S.ptt.modo === 'auto' ? 'hold' : 'auto'); };
        // las esquinas no deben disparar el PTT del asiento completo
        div.querySelectorAll('.asiento-esq').forEach(b =>
          b.addEventListener('pointerdown', ev => ev.stopPropagation()));
      } else {
        div.onclick = (ev) => menuPersona(ev, a.identidad, i + 1);
      }
    } else {
      div.classList.add('libre');
      if (S.sentando) {
        // toque registrado: la silla muestra que el servidor está sentándote
        // (y las demás también, para no repetir el tap en otro lado)
        div.classList.add('sentando');
        div.insertAdjacentHTML('beforeend', '<span class="sentar">⏳ Sentándose…</span>');
      } else if (mod) {
        div.insertAdjacentHTML('beforeend', '<span class="sentar">Sentarse</span>');
        div.onclick = (ev) => menuAsientoLibre(ev, i, a);
      } else if (i !== 0) {
        div.insertAdjacentHTML('beforeend', '<span class="sentar">Sentarse</span>');
        div.onclick = () => sentarse(i + 1);
      } else {
        div.insertAdjacentHTML('beforeend', '<span class="tag muted">Solo moderadores</span>');
      }
    }
    if (a.bloqueo === 1 && a.identidad) div.classList.add('b1');
    if (a.bloqueo === 2 && a.identidad) div.classList.add('b2');
    filas[i === 0 ? 0 : i < 5 ? 1 : 2].appendChild(div);
  });

  // cuadro de "la palabra" junto al asiento 1: quien recibió el micro por mano aprobada
  const pb = document.createElement('div');
  pb.className = 'asiento palabra';
  pb.innerHTML = '<span class="num">Palabra</span>';
  const palabraId = S.estado.palabra;
  const soyYo = palabraId === S.identidad;
  if (palabraId) {
    pb.dataset.id = palabraId;
    const p = participantePorId(palabraId);
    pb.classList.add('ocupado');
    if (p) {
      const v = videoDe(p, LC.Track.Source.Camera, 'palabra');
      if (v) pb.appendChild(v);
      else pb.insertAdjacentHTML('beforeend', `<div class="avatar">${esc((nombreDe(p)[0] || '?').toUpperCase())}</div>`);
      pb.insertAdjacentHTML('beforeend', `<span class="tag">${marcaRol(palabraId)}${esc(nombreDe(p))}</span>`);
      const micPb = p.getTrackPublication(LC.Track.Source.Microphone);
      pb.insertAdjacentHTML('beforeend',
        `<span class="mic-ind">${micPb && !micPb.isMuted ? '🎙️' : '🔇'}</span>`);
      const pin = document.createElement('button');
      pin.className = 'btn mini asiento-pin'; pin.type = 'button'; pin.textContent = '📌';
      pin.title = 'Vídeo flotante del puesto de la palabra (sigue a quien hable)';
      pin.onclick = (ev) => { ev.stopPropagation(); alternarFlotante('palabra'); };
      pb.appendChild(pin);
    } else {
      pb.insertAdjacentHTML('beforeend', `<span class="tag">${esc(palabraId)}</span>`);
    }
    // verde solo si habla otro: si la palabra es mía manda el rojo del PTT
    if (S.activo === palabraId && !soyYo) pb.style.borderColor = 'var(--verde)';
    // La Palabra NO es un pulsador: el micro es obligatorio mientras la
    // tengas — no hay candado, ni automático, ni gesto. Se ve siempre
    // "pisada" (rojo hablando / violeta en espera tras interrupción) y
    // tocarla solo ofrece dejarla — no se puede callar sin soltarla
    if (soyYo && S.room) {
      pb.classList.add('asiento-mio', 'ptt-sup');
      pb.insertAdjacentHTML('beforeend',
        '<button class="asiento-esq menu" type="button" title="Opciones de la palabra">⋮</button>' +
        '<button class="asiento-esq salir" type="button" title="Dejar la palabra">✕</button>');
      pb.querySelectorAll('.asiento-esq').forEach(b =>
        b.addEventListener('pointerdown', ev => ev.stopPropagation()));
      pb.querySelector('.asiento-esq.menu').onclick =
        (ev) => { ev.stopPropagation(); if (pb._menuPalabra) pb._menuPalabra(ev); };
      pb.querySelector('.asiento-esq.salir').onclick =
        (ev) => { ev.stopPropagation(); confirmar('¿Dejar la palabra? Tu micrófono se silenciará.', dejarPalabra); };
      pb.onclick = (ev) => {
        if (ev.target.closest('.asiento-esq') || ev.target.closest('.asiento-pin')) return;
        confirmar('¿Dejar la palabra? Tu micrófono se silenciará.', dejarPalabra);
      };
    }
    if (S.estado.palabraFin || S.estado.palabraPausada) {
      const msRest = S.estado.palabraPausada || Math.max(0, S.estado.palabraFin - Date.now());
      pb.insertAdjacentHTML('beforeend',
        `<span class="crono" data-crono>${fmtMMSS(msRest)}${S.estado.palabraPausada ? ' ⏸' : ''}</span>`);
    }
    // marcador de votación sobre el orador actual
    pb.insertAdjacentHTML('beforeend',
      `<span class="votos${S.votos.mi > 0 ? ' mio-si' : S.votos.mi < 0 ? ' mio-no' : ''}">👍 ${S.votos.aFavor} · 👎 ${S.votos.enContra}</span>`);
  } else if (S.estado.manos.length) {
    // palabra libre pero hay manos: aviso visible
    pb.classList.add('manospend');
    pb.insertAdjacentHTML('beforeend',
      `<span class="tag">✋ ${S.estado.manos.length} mano${S.estado.manos.length > 1 ? 's' : ''} levantada${S.estado.manos.length > 1 ? 's' : ''}</span>`);
  } else {
    pb.insertAdjacentHTML('beforeend', '<span class="tag muted">Palabra libre · pedir la palabra</span>');
  }
  if (!palabraId) {
    // botones físicos directos: ✋ levantar/bajar la mano para todos, y el
    // moderador además ve el contador de solicitudes (abre la lista)
    const acc = document.createElement('div');
    acc.className = 'palabra-acc';
    const bm = document.createElement('button');
    bm.className = 'btn mini'; bm.type = 'button';
    bm.textContent = manoLevantada() ? '🤚' : '✋';
    bm.title = manoLevantada() ? 'Bajar la mano' : 'Levantar la mano (pedir la palabra)';
    bm.onclick = (ev) => {
      ev.stopPropagation();
      if (manoLevantada()) confirmar('¿Bajar la mano? Perderás tu solicitud de palabra.',
        () => accion('bajar_mano').catch(e => toast(e.message)));
      else solicitarPalabra();
    };
    acc.appendChild(bm);
    if (esMod() && S.estado.manos.length) {
      const bs = document.createElement('button');
      bs.className = 'btn mini prim'; bs.type = 'button';
      bs.textContent = '📋 ' + S.estado.manos.length;
      bs.title = 'Solicitudes de palabra pendientes — abrir la lista';
      bs.onclick = (ev) => { ev.stopPropagation(); abrirSolicitudes(); };
      acc.appendChild(bs);
    }
    pb.appendChild(acc);
  }
  // clic: menú con las opciones que correspondan al rol y al estado
  pb.classList.add('solicitable');
  pb.title = 'Opciones de la palabra';
  pb.onclick = (ev) => {
    ev.stopPropagation(); // si no, el oyente del documento cierra el menú al instante
    const p = palabraId ? participantePorId(palabraId) : null;
    const nombre = p ? nombreDe(p) : palabraId;
    const items = [];
    const verSolicitudes = { label: `📋 Ver solicitudes (${S.estado.manos.length})`, fn: abrirSolicitudes };
    const votarItems = [
      { label: '👍 Votar a favor' + (S.votos.mi > 0 ? ' ✓' : ''),
        fn: () => accion('votar', 0, { nivel: 1 }).catch(e => toast(e.message)) },
      { label: '👎 Votar en contra' + (S.votos.mi < 0 ? ' ✓' : ''),
        fn: () => accion('votar', 0, { nivel: -1 }).catch(e => toast(e.message)) },
    ];
    if (palabraId) {
      if (soyYo) items.push({ label: '🗣️ Dejar la palabra', peligro: true,
        fn: () => confirmar('¿Dejar la palabra? Tu micrófono se silenciará.', dejarPalabra) });
      else if (esMod()) items.push({ label: '⛔ Quitar la palabra a ' + nombre, peligro: true,
        fn: () => confirmar('¿Quitar la palabra a ' + nombre + '?',
          () => moderar('cortar_palabra').catch(e => toast(e.message))) });
      else items.push({ label: '✋ Pedir la palabra', fn: solicitarPalabra });
      items.push({ sep: true });
      items.push(...votarItems);
      if (soyYo || esMod())
        items.push({ label: '🔄 Reiniciar votación',
          fn: () => accion('reset_votos').catch(e => toast(e.message)) });
      if (esMod() && !soyYo) {
        items.push({ sep: true });
        items.push(...itemsModeracion(palabraId, 0));
      }
      if (esMod() && S.estado.manos.length) items.push(verSolicitudes);
    } else {
      items.push({ label: '✋ Pedir la palabra (levantar la mano)', fn: solicitarPalabra });
      if (esMod()) {
        items.push({ label: '🗣️ Hablar ahora (sin límite)',
          fn: () => moderar('palabra', { objetivo: S.identidad, nivel: 0 }).catch(e => toast(e.message)) });
        items.push({ label: '⏱️ Hablar con tiempo…',
          fn: () => elegirTiempoPalabra('Duración de tu palabra', (s) =>
            moderar('palabra', { objetivo: S.identidad, nivel: Math.max(0, s) }).catch(e => toast(e.message))) });
        if (S.estado.manos.length) items.push(verSolicitudes);
      }
    }
    if (items.length) abrirMenuCtx(ev.clientX, ev.clientY, items, palabraId ? nombre : 'Palabra');
  };
  // con La Palabra mi puesto es pulsador PTT: el click no abre el menú
  // (soltar el botón dispararía el menú) — el menú va por la esquina ⋮
  if (soyYo && S.room) {
    pb._menuPalabra = pb.onclick;
    pb.onclick = null;
    pb.title = 'Tienes la palabra: tu micrófono está abierto';
  }
  filas[0].appendChild(pb);

  // audiencia
  const sentados = new Set(S.estado.asientos.filter(a => a.identidad).map(a => a.identidad));
  const audiencia = todosLosParticipantes().filter(p => !sentados.has(p.identity));
  $('#audiencia').innerHTML = '';
  audiencia.forEach(p => {
    const el = document.createElement('div');
    el.className = 'mini-tile' + (S.activo === p.identity ? ' hablando' : '');
    el.dataset.id = p.identity;
    const bloq = esMod()
      ? (S.micProhibidos.includes(p.identity) ? ' 🔴🎙️' : '') +
        (S.camProhibidos.includes(p.identity) ? ' 🔴📷' : '')
      : '';
    const mano = S.estado.manos.some(m => m.identidad === p.identity) ? ' ✋' : '';
    el.textContent = marcaRol(p.identity) + nombreDe(p) + mano + bloq;
    el.onclick = (ev) => menuPersona(ev, p.identity, 0);
    $('#audiencia').appendChild(el);
  });

  // botones de acción propios
  const acc = $('#audiencia-acciones');
  acc.innerHTML = '';
  if (estoySentado()) {
    acc.innerHTML = '<button class="btn" id="ac-levantar">Levantarme del asiento</button>';
    $('#ac-levantar').onclick = () => accion('levantarse').catch(e => toast(e.message));
  } else if (enCola()) {
    const pos = S.estado.cola.findIndex(c => c.identidad === S.identidad) + 1;
    acc.innerHTML = `<span class="chip">En cola (pos. ${pos})</span> <button class="btn" id="ac-descolar">Salir de la cola</button>`;
    $('#ac-descolar').onclick = () => accion('desencolar').catch(e => toast(e.message));
  } else {
    acc.innerHTML = `<button class="btn prim" id="ac-sentarse"${S.sentando ? ' disabled' : ''}>${S.sentando ? '⏳ Sentándose…' : 'Sentarse'}</button>`;
    $('#ac-sentarse').onclick = () => sentarse(0);
  }

  // cola visible
  $('#cola-wrap').classList.toggle('oculto', !S.estado.cola.length);
  $('#cola').innerHTML = S.estado.cola.map(c =>
    `<li>${esc(c.nombre)}${c.identidad === S.identidad ? ' (tú)' : ''}</li>`).join('');

  renderPttEstados(); // los pulsadores de los asientos se recrean en cada render
}

function renderRejilla() {
  if ($('#z-rejilla').classList.contains('oculto')) return;
  const g = $('#rejilla');
  g.innerHTML = '';
  // con muchas personas se pagina: nadie se pierde en la posicion 40
  const todos = todosLosParticipantes();
  const porPag = innerWidth <= 768 ? 4 : 9;
  const paginas = Math.max(1, Math.ceil(todos.length / porPag));
  S.rejPag = Math.min(S.rejPag || 0, paginas - 1);
  todos.slice(S.rejPag * porPag, S.rejPag * porPag + porPag)
    .forEach(p => g.appendChild(tileVideo(p, 'rejilla')));
  $('#rej-nav').classList.toggle('oculto', paginas < 2);
  $('#rej-pag').textContent = `${S.rejPag + 1} / ${paginas} · ${todos.length}`;
  $('#rej-prev').onclick = () => { S.rejPag = Math.max(0, (S.rejPag || 0) - 1); renderRejilla(); };
  $('#rej-next').onclick = () => { S.rejPag = Math.min(paginas - 1, (S.rejPag || 0) + 1); renderRejilla(); };
}

function renderOrador() {
  if ($('#z-orador').classList.contains('oculto')) return;
  const principal = $('#orador-principal'), tira = $('#orador-tira');
  principal.innerHTML = ''; tira.innerHTML = '';
  const todos = todosLosParticipantes();
  const dom = todos.find(p => p.identity === S.activo) || todos[0];
  if (dom) principal.appendChild(tileVideo(dom, 'orador-principal'));
  todos.filter(p => p !== dom).forEach(p => tira.appendChild(tileVideo(p, 'orador-tira')));
}

// Un solo <video> estable por contenedor para la pantalla compartida:
// re-adjuntar en cada render destruía y recreaba el elemento y la imagen
// parpadeaba para quien la veía.
const scrEls = new WeakMap();
function pintarPantalla(cont, track) {
  const cur = scrEls.get(cont);
  if (cur && cur.track === track && cur.el.parentNode === cont) return;
  cont.querySelectorAll('video').forEach(v => v.remove());
  if (!track) { scrEls.delete(cont); return; }
  const el = track.attach();
  // un <video> que quedó pausado al adjuntarse oculto pinta negro: forzar
  // autoplay mudo + play() para que arranque al mostrarse la zona
  el.muted = true; el.playsInline = true; el.autoplay = true;
  scrEls.set(cont, { track, el });
  cont.appendChild(el);
  try { const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch {}
}

function pantallaCompartida() {
  return todosLosParticipantes().some(p => {
    const pub = p.getTrackPublication(LC.Track.Source.ScreenShare);
    // basta con que exista el track: si llega muteado, el <video> pinta solo
    // al llegar el primer frame; exigir !isMuted dejaba la vista en negro
    // hasta el siguiente re-render
    return pub && pub.track;
  });
}

// zoom del documento compartido: los botones sirven para todos los tipos;
// la rueda, la pinza y el arrastre funcionan donde el iframe no capture
// los gestos (imagen, vídeo y los márgenes del contenido)
const docZoom = { z: 1, x: 0, y: 0 };
function docZoomAplicar() {
  const el = $('#doc-zoom');
  if (el) el.style.transform = `translate(${docZoom.x}px, ${docZoom.y}px) scale(${docZoom.z})`;
  const pc = $('#doc-zoom-pct');
  if (pc) pc.textContent = Math.round(docZoom.z * 100) + '%';
}
function docZoomPoner(z) {
  docZoom.z = Math.min(6, Math.max(0.5, z));
  if (docZoom.z === 1) { docZoom.x = 0; docZoom.y = 0; }
  docZoomAplicar();
}
function docZoomReset() { docZoomPoner(1); }
function cablearDocZoom() {
  $('#doc-zoom-mas').onclick = () => docZoomPoner(docZoom.z * 1.25);
  $('#doc-zoom-menos').onclick = () => docZoomPoner(docZoom.z / 1.25);
  $('#doc-zoom-reset').onclick = docZoomReset;
  const capa = $('#doc-zoom');
  capa.addEventListener('wheel', e => {
    e.preventDefault();
    docZoomPoner(docZoom.z * (e.deltaY < 0 ? 1.12 : 0.89));
  }, { passive: false });
  const pts = new Map();
  let dist0 = 0, z0 = 1, cx0 = 0, cy0 = 0, x0 = 0, y0 = 0;
  capa.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, e);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      dist0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      z0 = docZoom.z;
    } else { cx0 = e.clientX; cy0 = e.clientY; x0 = docZoom.x; y0 = docZoom.y; }
    try { capa.setPointerCapture(e.pointerId); } catch {}
  });
  capa.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (dist0 > 0) docZoomPoner(z0 * d / dist0);
    } else if (docZoom.z > 1) {
      docZoom.x = x0 + e.clientX - cx0;
      docZoom.y = y0 + e.clientY - cy0;
      docZoomAplicar();
    }
  });
  const soltar = e => { pts.delete(e.pointerId); dist0 = 0; };
  capa.addEventListener('pointerup', soltar);
  capa.addEventListener('pointercancel', soltar);
}

function renderPresentacion() {
  const zona = $('#z-presentacion');
  if (zona.classList.contains('oculto')) return;
  // tarjeta del audio compartido en vivo: visible haya o no documento
  const mus = $('#doc-musica');
  if (mus) {
    mus.classList.toggle('oculto', !S.musica);
    if (S.musica) {
      $('#doc-musica-nombre').textContent = S.musica.nombre || 'audio';
      $('#doc-musica-quien').textContent = ' — ' + S.musica.quien;
      const mv = $('#doc-musica-vol');
      if (mv && +mv.value !== Math.round(S.volMusica * 100)) mv.value = Math.round(S.volMusica * 100);
    }
  }
  $('#doc-controles').classList.toggle('oculto', !puedoDoc());
  const dt = $('#doc-tools-toggle');
  if (dt) dt.classList.toggle('oculto', !puedoDoc());
  const quitar = $('#doc-quitar');
  if (quitar) quitar.classList.toggle('oculto', !puedoDoc());
  const doc = S.estado.doc;
  const frame = $('#doc-frame'), img = $('#doc-img'), vw = $('#doc-video-wrap'),
    vacio = $('#doc-vacio'), audioEl = $('#doc-audio-el');

  // pantalla compartida tiene prioridad visual
  let screenTrack = null;
  todosLosParticipantes().forEach(p => {
    const pub = p.getTrackPublication(LC.Track.Source.ScreenShare);
    if (pub && pub.track) screenTrack = pub.track;
  });
  const zctl = $('#doc-zoom-ctl');
  if (screenTrack) {
    pintarPantalla(vw, screenTrack);
    vw.classList.remove('oculto');
    frame.classList.add('oculto'); img.classList.add('oculto'); audioEl.classList.add('oculto'); vacio.classList.add('oculto');
    if (zctl) zctl.classList.remove('oculto');
    return;
  }
  vw.classList.add('oculto'); pintarPantalla(vw, null);

  if (!doc) {
    S.docPintado = '';
    frame.classList.add('oculto'); img.classList.add('oculto'); audioEl.classList.add('oculto'); vacio.classList.remove('oculto');
    if (zctl) zctl.classList.add('oculto');
    docZoomReset();
    return;
  }
  vacio.classList.add('oculto');
  if (zctl) zctl.classList.remove('oculto');
  const key = doc.tipo + '|' + doc.url;
  if (S.docPintado !== key) { // asignar src solo si el documento cambió, si no el iframe se recarga en cada render
    S.docPintado = key;
    docZoomReset(); // un documento nuevo arranca sin zoom
    if (doc.tipo === 'imagen') img.src = doc.url + '?token=' + S.token;
    // el audio va en un <audio controls> real: cada oyente pausa/adelanta
    // su propia reproducción; pdf/vídeo van por iframe con ?token=
    else if (doc.tipo === 'audio') audioEl.src = doc.url + '?token=' + S.token;
    else frame.src = doc.tipo === 'web' ? doc.url : doc.url + '?token=' + S.token;
  }
  const esImg = doc.tipo === 'imagen', esAudio = doc.tipo === 'audio';
  img.classList.toggle('oculto', !esImg);
  audioEl.classList.toggle('oculto', !esAudio);
  frame.classList.toggle('oculto', esImg || esAudio);
}

function renderPantalla() {
  const zona = $('#z-pantalla');
  if (zona.classList.contains('oculto')) return;
  const cont = $('#pantalla-zona');
  let screenTrack = null;
  todosLosParticipantes().forEach(p => {
    const pub = p.getTrackPublication(LC.Track.Source.ScreenShare);
    if (pub && pub.track) screenTrack = pub.track;
  });
  pintarPantalla(cont, screenTrack);
  $('#pantalla-vacia').classList.toggle('oculto', !!screenTrack);
}

function renderListas() {
  // manos (panel lateral + modal)
  const htmlManos = S.estado.manos.map(m => `
    <div class="item"><span>${esc(m.nombre)} ${m.aprobada ? '· <span class="muted">aprobada</span>' : ''}</span>
      ${esMod() ? `<span class="acciones">
        ${!m.aprobada ? `<button class="btn mini prim" data-ap="${esc(m.identidad)}">Dar palabra</button>` : ''}
        <button class="btn mini peligro" data-re="${esc(m.identidad)}">✕</button></span>` : ''}
    </div>`).join('') || '<p class="muted">Nadie.</p>';
  $('#lista-manos').innerHTML = htmlManos;
  $('#mod-manos').innerHTML = htmlManos;
  $$('[data-ap]').forEach(b => b.onclick = () =>
    elegirTiempoPalabra('Duración de la palabra', (s) =>
      moderar('aprobar_mano', { objetivo: b.dataset.ap, nivel: Math.max(0, s) }).catch(e => toast(e.message))));
  $$('[data-re]').forEach(b => b.onclick = () => moderar('rechazar_mano', { objetivo: b.dataset.re }).catch(e => toast(e.message)));

  const htmlCola = S.estado.cola.map((c, i) => `<div class="item"><span>${i + 1}. ${esc(c.nombre)}</span></div>`).join('') || '<p class="muted">Vacía.</p>';
  $('#lista-cola').innerHTML = htmlCola;
  if ($('#mod-cola')) $('#mod-cola').innerHTML = htmlCola;
  const bm = $('#mod-badge-manos');
  if (bm) { bm.textContent = S.estado.manos.length; bm.classList.toggle('oculto', !S.estado.manos.length); }

  if (esMod()) {
    // interruptores on/off (ON = activo/permitido, salvo "Silenciar audiencia")
    if ($('#mod-silencio')) $('#mod-silencio').classList.toggle('on', !!S.estado.silencio);
    if ($('#mod-mic-asientos')) $('#mod-mic-asientos').classList.toggle('on', !S.estado.micAsientos);
    if ($('#mod-cam-audiencia')) $('#mod-cam-audiencia').classList.toggle('on', !S.estado.camAudiencia);
    if ($('#mod-cam-asientos')) $('#mod-cam-asientos').classList.toggle('on', !S.estado.camAsientos);
    if ($('#mod-chat-off')) $('#mod-chat-off').classList.toggle('on', !S.estado.chatOff);
    // ON (por defecto) = la audiencia solo ve la vista sincronizada
    if ($('#mod-vista-fija')) $('#mod-vista-fija').classList.toggle('on', !!S.estado.vistaFija);
    if ($('#mod-audio')) $('#mod-audio').value = S.estado.audioPerfil || 'auto';
    if ($('#mod-acceso')) $('#mod-acceso').value = S.accesoSala || 'abierto';
    // tiempos de interrupción del piso por rol — solo se sobrescriben si el
    // moderador no los está editando ahora mismo
    if (S.pisoCfg && $('#piso-admin') && document.activeElement?.id !== 'piso-admin'
      && document.activeElement?.id !== 'piso-anfitrion'
      && document.activeElement?.id !== 'piso-palabra'
      && document.activeElement?.id !== 'piso-usuario'
      && document.activeElement?.id !== 'piso-tol') {
      $('#piso-admin').value = S.pisoCfg.admin;
      $('#piso-anfitrion').value = S.pisoCfg.anfitrion;
      $('#piso-palabra').value = S.pisoCfg.palabra;
      $('#piso-usuario').value = S.pisoCfg.usuario;
      if ($('#piso-tol')) $('#piso-tol').value = S.pisoCfg.palabraTol ?? 60;
    }
    // sala de espera: quién espera admisión + botón por persona
    const lw = $('#mod-lobby-wrap');
    if (lw) {
      lw.classList.toggle('oculto', !(S.lobbyLista || []).length);
      $('#mod-lobby').innerHTML = (S.lobbyLista || []).map(p =>
        `<div class="item"><span>${esc(p.nombre || p.identidad)}</span>
          <span class="acciones"><button class="btn mini prim" data-adm="${esc(p.identidad)}">Admitir</button>
          <button class="btn mini peligro" data-rej="${esc(p.identidad)}">Rechazar</button></span></div>`).join('');
      $$('#mod-lobby [data-adm]').forEach(b => b.onclick = () =>
        moderar('lobby_admitir', { objetivo: b.dataset.adm }).catch(e => toast(e.message)));
      $$('#mod-lobby [data-rej]').forEach(b => b.onclick = () =>
        moderar('lobby_rechazar', { objetivo: b.dataset.rej }).catch(e => toast(e.message)));
    }
    renderGrupos();
  }
  renderPersonas();
}

// renderGrupos: salas de discusión — planificar miembros, comenzar, moverse
function renderGrupos() {
  const lg = $('#mod-grupos');
  if (!lg) return;
  lg.innerHTML = '';
  const todos = todosLosParticipantes();
  // para los selects: participantes de la sala del moderador + miembros
  // de todas las salas de discusión (así se puede añadir a cualquiera)
  const mapa = new Map(todos.map(p => [p.identity, p]));
  (S.grupos || []).forEach(gg => (gg.miembros || []).forEach(m => {
    if (!mapa.has(m.identidad)) mapa.set(m.identidad, { identity: m.identidad, name: m.nombre });
  }));
  // el directorio global (solo moderadores) incluye también la sala
  // principal y a quien regresó por su cuenta, esté donde esté el mod
  (S.directorio || []).forEach(dd => {
    if (!mapa.has(dd.identidad)) mapa.set(dd.identidad, { identity: dd.identidad, name: dd.nombre });
  });
  const todosSel = [...mapa.values()];
  // sala actual de cada identidad, para mostrarla en las opciones
  const salaDe = new Map();
  if (S.directorio && S.directorio.length) {
    S.directorio.forEach(dd => salaDe.set(dd.identidad, dd.grupo ? nombreGrupo(dd.grupo) : 'principal'));
  } else {
    (S.grupos || []).forEach(gg => (gg.miembros || []).forEach(m => salaDe.set(m.identidad, gg.nombre)));
  }
  const opciones = (lista, fuera) => '<option value="">+ añadir…</option>' + lista
    .filter(p => !fuera.has(p.identity))
    .map(p => `<option value="${esc(p.identity)}">${esc(nombreDe(p))} · ${esc(salaDe.get(p.identity) || 'principal')}</option>`).join('');

  // sala principal
  const enGrupos = (S.grupos || []).reduce((n, g) => n + g.miembros.length, 0);
  const totalPers = (S.directorio && S.directorio.length) ? S.directorio.length : todos.length;
  const filaP = document.createElement('div');
  filaP.className = 'item';
  filaP.innerHTML = `<span><strong>Sala principal</strong> · ${Math.max(0, totalPers - enGrupos)} pers.${S.miGrupo === 0 ? ' · <span class="muted">estás aquí</span>' : ''}</span>`;
  if (S.miGrupo !== 0) {
    const ir = document.createElement('button');
    ir.className = 'btn mini prim'; ir.textContent = 'Volver';
    ir.onclick = () => moderar('grupo_ir', { nivel: 0 }).catch(e => toast(e.message));
    filaP.appendChild(ir);
  }
  lg.appendChild(filaP);

  (S.grupos || []).forEach(g => {
    const div = document.createElement('div');
    div.className = 'item';
    div.style.flexDirection = 'column'; div.style.alignItems = 'stretch';
    const resto = g.fin ? ` · ⏱️ <span class="crono-g" data-fin="${g.fin}">${fmtMMSS(g.fin - Date.now())}</span>` : '';
    const est = g.iniciado ? resto : ` · <span class="muted">sin iniciar${g.durMin ? ' · ' + g.durMin + ' min' : ''}</span>`;
    div.innerHTML = `<span><strong>${esc(g.nombre)}</strong> · ${g.miembros.length} pers.${est}${g.id === S.miGrupo ? ' · <span class="muted">estás aquí</span>' : ''}</span>`;

    // personas planificadas (se moverán al iniciar)
    if (!g.iniciado) {
      const enPlan = new Set((g.plan || []).map(m => m.identidad));
      const chips = document.createElement('div');
      chips.className = 'plan-chips';
      (g.plan || []).forEach(m => {
        const c = document.createElement('span');
        c.className = 'plan-chip';
        c.textContent = (m.nombre || m.identidad) + ' ✕';
        c.title = 'Quitar del plan';
        c.onclick = () => moderar('grupo_plan', { objetivo: m.identidad, nivel: g.id, valor: false }).catch(e => toast(e.message));
        chips.appendChild(c);
      });
      const addSel = document.createElement('select');
      addSel.className = 'mini';
      addSel.innerHTML = opciones(todosSel, enPlan);
      addSel.onchange = () => {
        if (addSel.value) moderar('grupo_plan', { objetivo: addSel.value, nivel: g.id, valor: true }).catch(e => toast(e.message));
      };
      chips.appendChild(addSel);
      div.appendChild(chips);
    } else {
      // sala iniciada: miembros con ✕ para devolverlos y select para
      // añadir gente directamente (grupo_asignar los mueve al instante)
      const dentro = new Set((g.miembros || []).map(m => m.identidad));
      const chips = document.createElement('div');
      chips.className = 'plan-chips';
      (g.miembros || []).forEach(m => {
        const c = document.createElement('span');
        c.className = 'plan-chip';
        c.textContent = (m.nombre || m.identidad) + ' ✕';
        c.title = 'Devolver a la sala principal';
        c.onclick = () => moderar('grupo_asignar', { objetivo: m.identidad, nivel: 0 }).catch(e => toast(e.message));
        chips.appendChild(c);
      });
      const addSel = document.createElement('select');
      addSel.className = 'mini';
      addSel.innerHTML = opciones(todosSel, dentro);
      addSel.onchange = () => {
        if (addSel.value) moderar('grupo_asignar', { objetivo: addSel.value, nivel: g.id }).catch(e => toast(e.message));
      };
      chips.appendChild(addSel);
      div.appendChild(chips);
    }

    const acc = document.createElement('div');
    acc.className = 'fila'; acc.style.marginTop = '.3rem';
    if (!g.iniciado) {
      const play = document.createElement('button');
      play.className = 'btn mini prim'; play.textContent = '▶ Iniciar';
      play.title = 'Mueve a las personas planificadas y arranca el tiempo';
      play.onclick = () => moderar('grupo_comenzar', { nivel: g.id }).catch(e => toast(e.message));
      acc.appendChild(play);
    } else {
      const cerrar = document.createElement('button');
      cerrar.className = 'btn mini'; cerrar.textContent = '⏹ Cerrar';
      cerrar.title = 'Devuelve a todos a la sala principal sin borrar la sala (se puede reabrir)';
      cerrar.onclick = () => moderar('grupo_cerrar', { nivel: g.id }).catch(e => toast(e.message));
      acc.appendChild(cerrar);
    }
    if (g.id !== S.miGrupo) {
      const ir = document.createElement('button');
      ir.className = 'btn mini'; ir.textContent = 'Ir';
      ir.onclick = () => moderar('grupo_ir', { nivel: g.id }).catch(e => toast(e.message));
      acc.appendChild(ir);
    }
    const borrar = document.createElement('button');
    borrar.className = 'btn mini peligro'; borrar.textContent = '✕';
    borrar.title = 'Disolver esta sala (sus miembros vuelven a la principal)';
    borrar.onclick = () => confirmar('¿Disolver la sala «' + g.nombre + '»? Sus miembros vuelven a la principal.',
      () => moderar('grupo_borrar', { nivel: g.id }).catch(e => toast(e.message)));
    acc.appendChild(borrar);
    div.appendChild(acc);
    lg.appendChild(div);
  });
}

function renderPersonas() {
  const lp = $('#lista-personas');
  if (!lp) return;
  lp.innerHTML = '';
  todosLosParticipantes().forEach(p => {
    const tile = tileVideo(p, 'personas');
    const extras = [];
    if (S.estado.palabra === p.identity) extras.push('🎙️ palabra');
    if (S.estado.manos.some(m => m.identidad === p.identity)) extras.push('✋');
    if (S.estado.cola.some(c => c.identidad === p.identity)) extras.push('🕒');
    if (esAdminDe(p.identity)) extras.push('👑 admin');
    else if (S.estado.moderadores.includes(p.identity)) extras.push('⭐');
    if (esMod() && S.micProhibidos.includes(p.identity)) extras.push('🔴 micro prohibido');
    if (esMod() && S.camProhibidos.includes(p.identity)) extras.push('🔴 cámara prohibida');
    if (esMod() && (S.micPermidos || []).includes(p.identity)) extras.push('🔓 micro exento');
    if (esMod() && (S.camPermidos || []).includes(p.identity)) extras.push('🔓 cámara exenta');
    if (extras.length) {
      const el = document.createElement('div');
      el.className = 'tag';
      el.textContent = extras.join(' · ');
      tile.appendChild(el);
    }
    tile.onclick = (ev) => menuPersona(ev, p.identity, 0);
    lp.appendChild(tile);
  });
}

function renderControles() {
  const micPub = S.room.localParticipant.getTrackPublication(LC.Track.Source.Microphone);
  const micOn = micPub && !micPub.isMuted;
  const camPub = S.room.localParticipant.getTrackPublication(LC.Track.Source.Camera);
  const camOn = camPub && !camPub.isMuted;
  const scrOn = S.room.localParticipant.isScreenShareEnabled;

  // enforcement: si perdí el permiso (me levanté, me cortaron la palabra…) apago el micro
  if (!puedoHablar() && micPub) retirarMic();
  // igual con la cámara: sin permiso se desactiva y libera el hardware
  if (!puedoCam() && camPub)
    S.room.localParticipant.setCameraEnabled(false).catch(() => {});
  // con la palabra el micro es obligatorio en cualquier modo: si quedó
  // muteado (interrupción, reingreso) se reactiva — ahí no hay botón que
  // lo calle, para callarse hay que dejar la palabra
  if (tengoPalabra() && micPub && micPub.isMuted && !S.audio.retirando)
    micPub.unmute().catch(() => {});

  // El botón del micro ES el pulsador PTT: ya no existe "encender/apagar".
  // amarillo = piso libre · verde = otra persona habla · rojo = yo hablo
  const bm = $('#ctl-mic');
  bm.className = 'btn ctl ptt-sup' + (S.audio.retirando ? ' cargando' : '');
  bm.disabled = !!S.audio.retirando;
  renderPttEstados();

  // chip del piso: quién está hablando ahora y cuánto falta para poder
  // interrumpirlo según el menor de mis tiempos por rol
  const chipPiso = $('#st-piso');
  if (chipPiso) {
    if (S.estado && S.estado.piso) {
      chipPiso.classList.remove('oculto');
      const soyYo = S.estado.piso === S.identidad;
      let t = soyYo ? 'TÚ' : (S.estado.pisoNombre || S.estado.piso);
      if (!soyYo && S.estado.pisoDesde) {
        const falta = Math.max(0, miTiempoPiso() - Math.floor((Date.now() - S.estado.pisoDesde) / 1000));
        if (falta > 0) t += ' · ⏳' + falta + 's';
      }
      $('#st-piso-n').textContent = t;
      chipPiso.classList.toggle('rec', soyYo);
    } else {
      chipPiso.classList.add('oculto');
    }
  }

  $('#ctl-cam').className = 'btn ctl ' + (camOn ? 'on' : '');
  $('#ctl-pantalla').className = 'btn ctl ' + (scrOn ? 'on' : '');
  $('#ctl-emoji').className = 'btn ctl ' + (manoLevantada() ? 'levantada' : '');
  $('#rp-mano').textContent = tengoPalabra() ? '🗣️ Dejar la palabra'
    : manoLevantada() ? '🤚 Bajar la mano' : '✋ Levantar la mano';
  $('#ctl-rec').className = 'btn ctl ' + (S.rec ? 'on' : '');
  const bv = $('#ctl-vol');
  bv.className = 'btn ctl ' + (S.volMaster > 1 ? 'on' : '');
  bv.title = 'Salida y amplificación del audio';
  $('#st-rec').classList.toggle('oculto', !(S.rec || S.grabadores.size));

  // chat deshabilitado: bloqueo individual o "solo moderadores" de la sala
  const chatOff = S.chatProhibido || (S.estado?.chatOff && !esMod());
  const ci = $('#chat-input'), ce = $('#chat-enviar');
  ci.disabled = chatOff;
  ce.disabled = false; // con el campo vacío el botón es PTT, no "enviar"
  ci.placeholder = chatOff ? 'Chat bloqueado por el moderador' : 'Escribe un mensaje…';
  actualizarChatBtn();

  const enGrupo = S.miGrupo ? `[${nombreGrupo(S.miGrupo)}] ` : '';
  $('#ctl-aviso').textContent = enGrupo + (tengoPalabra()
    ? 'Tienes la palabra'
    : estoySentado()
    ? `Asiento ${miAsiento() + 1}`
    : enCola() ? `En cola (posición ${S.estado.cola.findIndex(c => c.identidad === S.identidad) + 1})`
    : 'Audiencia');

  // indicador de sala de discusión: muestra dónde estás y permite volver;
  // si el servidor ya nos sacó pero seguimos conectados a la otra sala,
  // queda en rojo pulsante como salvavidas para regresar
  const gChip = $('#st-grupo');
  if (S.grupoActual !== 0) {
    const varado = S.miGrupo === 0;
    gChip.classList.remove('oculto');
    gChip.classList.toggle('rec', varado);
    gChip.textContent = varado
      ? '⚠️ Sala cerrada — volver ↩'
      : '🏠 ' + nombreGrupo(S.grupoActual) + ' · volver ↩';
    gChip.title = varado
      ? 'La sala de discusión se disolvió — toca para regresar a la principal'
      : 'Estás en esta sala de discusión — toca para volver a la principal';
  } else {
    gChip.classList.add('oculto');
  }
}

// Cambio del modo de hablar, compartido entre el menú del micro y los
// ajustes personales: hold = mantener pisado · lock = tocar/soltar ·
// auto = la voz pisa el botón. Al pasar a manual el hardware se libera;
// al pasar a auto se abre solo para que el VAD escuche en local.
function cambiarModoPtt(modo) {
  if (!['hold', 'lock', 'auto'].includes(modo)) return;
  S.ptt.modo = modo;
  S.ptt._bloqueado = false;
  localStorage.setItem('lk_ptt_modo', modo);
  const sm = $('#mic-modo'), sp = $('#aj-ptt');
  if (sm) sm.value = modo;
  if (sp) sp.value = modo;
  const silWrap = $('#mic-silencio-wrap'), silAj = $('#aj-auto-cfg');
  if (silWrap) silWrap.classList.toggle('oculto', modo !== 'auto');
  if (silAj) silAj.classList.toggle('oculto', modo !== 'auto');
  if (modo === 'auto') {
    if (puedoHablar()) prepararMicPtt(); // abre el micro solo para el VAD
  } else {
    // al apagar el automático con el VAD transmitiendo (piso tomado sin
    // dedo), soltarlo explícitamente antes de cerrar el micrófono
    if (!S.ptt.quiero && S.ptt.tengo && S.room) {
      S.room.soltarPiso();
      S.ptt.tengo = false;
    }
    if (S.ptt.quiero) pttOff();
    else if (S.audio.pub) retirarMic(); // manual: nada de micro abierto
  }
  toast(modo === 'auto' ? 'Voz automática: al hablar piso el botón por ti' :
    modo === 'hold' ? 'PTT: mantén pisado el botón para hablar' :
    'PTT: toca el botón para hablar y tócalo otra vez para soltar');
  renderControles();
}

function cablearControles() {
  // El botón del micro ES el PTT — ya no hay "encender/apagar micrófono".
  // hold = mantener pisado · lock = tocar/soltar · auto = la voz lo pisa
  wirePttButton($('#ctl-mic'));
  // cambio de modo de habla desde el menú del micro
  const selModo = $('#mic-modo');
  if (selModo) {
    selModo.value = S.ptt.modo;
    const silWrap = $('#mic-silencio-wrap'), silIn = $('#mic-silencio');
    if (silWrap && silIn) {
      silWrap.classList.toggle('oculto', S.ptt.modo !== 'auto');
      silIn.value = S.ptt.silencio;
      silIn.onchange = () => {
        S.ptt.silencio = Math.max(0.5, Math.min(5, +silIn.value || 2.2));
        silIn.value = S.ptt.silencio;
        localStorage.setItem('lk_ptt_silencio', String(S.ptt.silencio));
        const sa = $('#aj-ptt-sil'); if (sa) sa.value = S.ptt.silencio;
      };
    }
    selModo.onchange = () => {
      cambiarModoPtt(selModo.value);
      $('#mic-pop').classList.add('oculto');
    };
  }
  // chips de piso y de retraso de audio
  const chipRetraso = $('#st-retraso');
  if (chipRetraso) chipRetraso.onclick = () => {
    if (S.room && S.room.saltarAlPresente) S.room.saltarAlPresente();
    toast('Te pusiste al día con el audio en vivo');
  };
  const chipPiso = $('#st-piso');
  if (chipPiso) chipPiso.onclick = () => {
    const e = S.estado;
    if (!e || !e.piso) return;
    const yo = e.piso === S.identidad;
    toast(yo ? 'Tienes el piso: estás hablando' :
      `Habla ${e.pisoNombre || e.piso} — puedes interrumpir cuando cumpla ${miTiempoPiso()} s`, 4500);
  };
  // panel de moderación: tiempos de interrupción del piso por rol
  const pisoGuardar = $('#piso-guardar');
  if (pisoGuardar) pisoGuardar.onclick = () => {
    const v = (id, def) => Math.max(0, Math.min(3600, (+$(id).value || def)));
    moderar('piso_cfg', {
      extra: [v('#piso-admin', 0), v('#piso-anfitrion', 0),
              v('#piso-palabra', 10), v('#piso-usuario', 60),
              v('#piso-tol', 60)].join(','),
    }).then(() => toast('Tiempos de interrupción guardados'))
      .catch(e => toast(e.message));
  };
  $('#ctl-cam').onclick = async () => {
    const p = S.room.localParticipant.getTrackPublication(LC.Track.Source.Camera);
    const on = p && !p.isMuted;
    if (!on && !puedoCam()) {
      const razon = S.camProhibido
        ? 'Un moderador te prohibió la cámara.'
        : 'Para ahorrar ancho de banda en conexiones móviles lentas, la cámara está reservada al Asiento 1 (Anfitrión) y a quien tiene La Palabra.';
      genModal('Cámara solo en Asiento 1 o con La Palabra',
        `<p>${razon}</p><p>¿Quieres levantar la mano para pedir la palabra?</p>`,
        () => accion('levantar_mano')
          .then(() => toast('Mano levantada: espera la aprobación del moderador'))
          .catch(e => toast(e.message)),
        '✋ Levantar la mano');
      return;
    }
    S.camQuerida = !on;
    const bc = $('#ctl-cam');
    bc.classList.add('cargando');
    try {
      await S.room.localParticipant.setCameraEnabled(!on, { deviceId: S.dev.cam ? { exact: S.dev.cam } : undefined });
    } catch (e) { S.camQuerida = on; toast('No se pudo cambiar la cámara: ' + e.message); }
    finally { bc.classList.remove('cargando'); }
  };
  $('#ctl-pantalla').onclick = async () => {
    const lp = S.room.localParticipant;
    if (lp.isScreenShareEnabled) { await lp.setScreenShareEnabled(false); return; }
    // Firefox móvil, Safari iOS y los webview de apps no exponen
    // getDisplayMedia: hay que decirlo claro en vez de un error genérico
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      const u = location;
      const cuerpo = '<p>Este navegador no permite compartir pantalla. ' +
        'Funciona en Google Chrome o desde una computadora.</p>';
      if (esAndroid && !esInApp) {
        genModal('Compartir pantalla no disponible',
          cuerpo + '<p>¿Quieres abrir la sala en Chrome?</p>',
          () => {
            location.href = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=` +
              `${u.protocol.replace(':', '')};package=com.android.chrome;` +
              `S.browser_fallback_url=${encodeURIComponent(u.href)};end`;
          }, 'Abrir en Chrome');
      } else if (esInApp) {
        genModal('Compartir pantalla no disponible',
          cuerpo + '<p>Si estás dentro de otra app, usa «Abrir en el navegador» del aviso de abajo.</p>', null, null);
      } else {
        genModal('Compartir pantalla no disponible', cuerpo, null, null);
      }
      return;
    }
    if (!puedoPantalla()) {
      const razon = S.panProhibido
        ? 'Un moderador te prohibió compartir la pantalla.'
        : 'Solo puedes compartir pantalla desde el asiento del anfitrión o con la palabra.';
      genModal('Pantalla deshabilitada',
        `<p>${razon}</p><p>¿Quieres levantar la mano para pedir la palabra?</p>`,
        () => accion('levantar_mano')
          .then(() => toast('Mano levantada: espera la aprobación del moderador'))
          .catch(e => toast(e.message)),
        '✋ Levantar la mano');
      return;
    }
    const bp = $('#ctl-pantalla');
    bp.classList.add('cargando');
    try {
      // audio:true → el navegador ofrece compartir el audio de la pestaña/sistema
      await lp.setScreenShareEnabled(true, { audio: true });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'AbortError') return; // canceló el selector
      try { await lp.setScreenShareEnabled(true); } // navegador sin audio compartido
      catch (e2) {
        if (e2.name !== 'NotAllowedError' && e2.name !== 'AbortError')
          toast('No se pudo compartir pantalla: ' + e2.message);
      }
    } finally { bp.classList.remove('cargando'); }
  };
  // un boton abre el panel: la mano arriba y las reacciones debajo
  const accionMano = () => {
    if (tengoPalabra()) {
      confirmar('¿Dejar la palabra? Tu micrófono se silenciará.', dejarPalabra); return;
    }
    if (manoLevantada()) confirmar('¿Bajar la mano? Perderás tu lugar en las solicitudes.',
      () => accion('bajar_mano').catch(e => toast(e.message)));
    else confirmar('¿Levantar la mano para pedir la palabra?',
      () => accion('levantar_mano').catch(e => toast(e.message)));
  };
  const rp = $('#reacciones-panel'), rpGrid = $('#rp-grid');
  rpGrid.innerHTML = REACCIONES.map(em => `<button class="reaccion-btn" type="button">${em}</button>`).join('');
  rpGrid.querySelectorAll('.reaccion-btn').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); enviarReaccion(b.textContent); rp.classList.add('oculto');
  });
  $('#rp-mano').onclick = () => { rp.classList.add('oculto'); accionMano(); };
  $('#ctl-emoji').onclick = (ev) => {
    ev.stopPropagation();
    rp.classList.toggle('oculto');
    if (!rp.classList.contains('oculto'))
      empujarCapa('reacciones', () => !rp.classList.contains('oculto'));
  };
  // altavoz: el botón (y su flechita) abre el panel de salida +
  // amplificación. Sin silencio ni volumen <100%: bajar el volumen es
  // cosa de los botones físicos del dispositivo, no de la sala
  const pops = [$('#vol-pop'), $('#mic-pop'), $('#cam-pop')];
  const cerrarPops = () => pops.forEach(p => p.classList.add('oculto'));
  const alternarPop = async (pop, preparar) => {
    const abrir = pop.classList.contains('oculto');
    cerrarPops();
    if (abrir) {
      await preparar();
      pop.classList.remove('oculto');
      empujarCapa('popmenu:' + pop.id, () => !pop.classList.contains('oculto'));
    }
  };
  const abrirVolPop = (ev) => {
    ev.stopPropagation();
    alternarPop($('#vol-pop'), async () => {
      await llenarDisp($('#vol-spk'), 'audiooutput', S.dev.spk);
      $('#vol-master').value = S.volMaster;
      $('#vol-val').textContent = Math.round(S.volMaster * 100) + '%';
    });
  };
  $('#ctl-vol').onclick = abrirVolPop;
  $('#ctl-vol-cfg').onclick = abrirVolPop;
  $('#vol-spk').onchange = (e) => { S.dev.spk = e.target.value; guardarDev(); aplicarSink(); };
  $('#vol-master').oninput = (e) => {
    S.volMaster = Math.max(1, +e.target.value);
    $('#vol-val').textContent = Math.round(S.volMaster * 100) + '%';
    localStorage.setItem('lk_vol_master', S.volMaster);
    ajustarSalidas();
  };
  $('#vol-probar').onclick = probarAltavoz;
  // el AudioContext del amplificador puede nacer suspendido (autoplay):
  // el primer toque/tecla lo reanuda y re-aplica las ganancias
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => {
    if (S.salidaCtx && S.salidaCtx.state === 'suspended')
      S.salidaCtx.resume().then(() => ajustarSalidas()).catch(() => {});
  }, { passive: true }));
  // flechitas de micro y cámara: elegir el dispositivo sin abrir Ajustes
  $('#ctl-mic-cfg').onclick = (ev) => {
    ev.stopPropagation();
    alternarPop($('#mic-pop'), () => llenarDisp($('#mic-sel'), 'audioinput', S.dev.mic));
  };
  $('#mic-sel').onchange = async (e) => {
    S.dev.mic = e.target.value; guardarDev();
    try { await reconstruirMic(); } catch (x) { toast(x.message); }
  };
  $('#mic-mas').onclick = () => {
    $('#mic-pop').classList.add('oculto');
    poblarSelectsAjustes().then(() => abrirModal('modal-ajustes'));
  };
  $('#ctl-cam-cfg').onclick = (ev) => {
    ev.stopPropagation();
    alternarPop($('#cam-pop'), () => llenarDisp($('#cam-sel'), 'videoinput', S.dev.cam));
  };
  $('#cam-sel').onchange = async (e) => {
    S.dev.cam = e.target.value; guardarDev();
    try { await cambiarCamara(); } catch (x) { toast(x.message); }
  };
  $('#ctl-rec').onclick = toggleGrabacion;
  $('#ctl-mas').onclick = () => {
    const footer = $('#barra-controles');
    const abierto = footer.classList.toggle('extra-abierto');
    $('#ctl-mas').setAttribute('aria-expanded', String(abierto));
    $('#ctl-mas .ctl-ico').innerHTML = abierto
      ? '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14l-6-6z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
  };
  const cp = $('#ctl-plegar');
  if (cp) cp.onclick = () => {
    const plegada = $('#barra-controles').classList.toggle('plegada');
    cp.textContent = plegada ? '⌃' : '⌄';
  };

  // invitación flotante
  $('#inv-si').onclick = aceptarInvitacion;
  $('#inv-no').onclick = () => accion('rechazar_invitacion').catch(e => toast(e.message));

  // menú contextual se cierra al clicar fuera
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu-ctx')) cerrarMenuCtx();
    if (!e.target.closest('#reacciones-panel') && !e.target.closest('#ctl-emoji'))
      $('#reacciones-panel').classList.add('oculto');
    if (!e.target.closest('.popmenu') && !e.target.closest('.ctl-cfg'))
      cerrarPops();
    if (!e.target.closest('#st-vistas') && !e.target.closest('#st-vistas-toggle'))
      $('#st-vistas').classList.remove('abierto');
  });

  $('#st-panel-admin').onclick = () => abrirModal('modal-admin');
  $('#mod-silencio').onclick = () =>
    moderar('silencio', { valor: !(S.estado && S.estado.silencio) }).catch(x => toast(x.message));
  $('#mod-mic-asientos').onclick = () =>
    moderar('mic_asientos', { valor: !(S.estado && S.estado.micAsientos) }).catch(x => toast(x.message));
  // null-safe: si el HTML desplegado es más viejo que este JS (caché mixta),
  // un elemento ausente no debe romper el resto del cableado
  if ($('#mod-cam-audiencia')) $('#mod-cam-audiencia').onclick = () =>
    moderar('cam_audiencia', { valor: !(S.estado && S.estado.camAudiencia) }).catch(x => toast(x.message));
  if ($('#mod-cam-asientos')) $('#mod-cam-asientos').onclick = () =>
    moderar('cam_asientos', { valor: !(S.estado && S.estado.camAsientos) }).catch(x => toast(x.message));
  $('#mod-audio').onchange = (e) =>
    moderar('audio_perfil', { extra: e.target.value })
      .then(() => toast('Perfil de audio: ' + e.target.selectedOptions[0].text))
      .catch(x => toast(x.message));
  if ($('#mod-chat-off')) $('#mod-chat-off').onclick = () =>
    moderar('chat_todos', { valor: !(S.estado && S.estado.chatOff) }).catch(x => toast(x.message));
  if ($('#mod-vista-fija')) $('#mod-vista-fija').onclick = () => {
    // capturar el valor nuevo AHORA: el broadcast puede actualizar
    // S.estado antes de que corra el then()
    const nuevo = !(S.estado && S.estado.vistaFija);
    moderar('vista_fija', { valor: nuevo })
      .then(() => toast(nuevo ? 'Vista fijada: la audiencia sigue tu pestaña' : 'Vista libre: cada quien elige su pestaña'))
      .catch(x => toast(x.message));
  };
  // asientos masivos: un toque para todos (el anfitrión no se toca)
  const bloqTodos = (nivel, texto) =>
    moderar('bloquear_todos', { nivel }).then(() => toast(texto)).catch(x => toast(x.message));
  if ($('#mod-seat-libres')) $('#mod-seat-libres').onclick = () =>
    bloqTodos(0, 'Todos los asientos quedaron libres');
  if ($('#mod-seat-mods')) $('#mod-seat-mods').onclick = () =>
    bloqTodos(1, 'Todos los asientos: solo moderadores');
  if ($('#mod-seat-nadie')) $('#mod-seat-nadie').onclick = () =>
    confirmar('¿Bloquear TODOS los asientos? Los sentados que no sean moderadores quedarán de pie y la gente dejará de ver las sillas.',
      () => bloqTodos(2, 'Todos los asientos bloqueados'));
  if ($('#mod-acceso')) $('#mod-acceso').onchange = (e) =>
    moderar('acceso', { extra: e.target.value })
      .then(() => toast('Acceso a la sala: ' + e.target.selectedOptions[0].text))
      .catch(x => toast(x.message));
  if ($('#mod-lobby-todos')) $('#mod-lobby-todos').onclick = () =>
    moderar('lobby_admitir').then(() => toast('Se admitió a toda la sala de espera'))
      .catch(e => toast(e.message));
  if ($('#mod-lobby-ninguno')) $('#mod-lobby-ninguno').onclick = () =>
    moderar('lobby_rechazar').then(() => toast('Se rechazó a toda la sala de espera'))
      .catch(e => toast(e.message));
  if ($('#mod-terminar')) $('#mod-terminar').onclick = () =>
    genModal('Terminar la reunión',
      '<p>Se desconectará a <strong>todos</strong> los participantes de todas las salas de discusión y de la principal. ¿Seguro?</p>',
      () => moderar('terminar_reunion').catch(e => toast(e.message)),
      '🔴 Terminar para todos');

  // salas de discusión — crear 1 o N numeradas con el mismo tiempo
  $('#grupo-crear').onclick = () => {
    const nombre = $('#grupo-nombre').value.trim() || 'Sala';
    const cant = Math.max(1, Math.min(20, +$('#grupo-cant').value || 1));
    const minutos = Math.max(0, +$('#grupo-minutos').value || 0);
    (async () => {
      for (let i = 1; i <= cant; i++) {
        await moderar('grupo_crear', { extra: cant > 1 ? nombre + ' ' + i : nombre, nivel: minutos });
      }
    })().then(() => {
      $('#grupo-nombre').value = ''; $('#grupo-minutos').value = ''; $('#grupo-cant').value = '';
    }).catch(x => toast(x.message));
  };
  // comenzar todas las salas pendientes: mueve a la gente del plan y arranca
  if ($('#grupo-todas')) $('#grupo-todas').onclick = () => {
    const pend = (S.grupos || []).filter(g => !g.iniciado);
    if (!pend.length) { toast('No hay salas pendientes de comenzar'); return; }
    confirmar(`¿Comenzar ${pend.length} sala(s)? Se moverá a toda la gente planificada.`, () =>
      pend.forEach(g => moderar('grupo_comenzar', { nivel: g.id }).catch(x => toast(x.message))));
  };
  if ($('#grupo-cerrart')) $('#grupo-cerrart').onclick = () => {
    const abiertas = (S.grupos || []).filter(g => g.iniciado);
    if (!abiertas.length) { toast('No hay salas en marcha'); return; }
    confirmar(`¿Cerrar ${abiertas.length} sala(s)? La gente vuelve a la principal y las salas se pueden reabrir.`,
      () => abiertas.forEach(g => moderar('grupo_cerrar', { nivel: g.id }).catch(x => toast(x.message))));
  };
  $('#grupo-disolver').onclick = () =>
    confirmar('¿Disolver todas las salas de discusión? Todos vuelven a la principal.',
      () => moderar('grupo_disolver').catch(x => toast(x.message)));

  // pestañas dentro del modal de moderación (el onclick inline de
  // index.html llama a mtab; esto solo reafirma el mismo handler)
  $$('.mod-tab').forEach(t => t.onclick = () => mtab(t));

  // chat: el botón de enviar es PTT mientras el campo esté vacío y vuelve
  // a ser "enviar" en cuanto hay texto escrito
  const inp = $('#chat-input'), ce = $('#chat-enviar');
  const enviarChat = () => {
    const texto = inp.value.trim();
    if (!texto) return;
    pubData({ t: 'chat', texto });
    agregarChat(S.nombre, texto, true);
    inp.value = '';
    actualizarChatBtn();
  };
  wirePttButton(ce, () => !inp.value.trim());
  ce.addEventListener('click', () => { if (inp.value.trim()) enviarChat(); });
  inp.addEventListener('input', actualizarChatBtn);
  inp.onkeydown = (e) => { if (e.key === 'Enter') enviarChat(); };
  actualizarChatBtn();

  $('#ctl-ajustes').onclick = () => {
    poblarSelectsAjustes();
    abrirModal('modal-ajustes');
    arrancarMedidor();
  };

  // tabs del panel lateral — SOLO los que tienen data-tab: las pestañas del
  // modal de moderación usan data-mtab y llevan su propio handler (mtab)
  $$('.tab[data-tab]').forEach(t => t.onclick = () => {
    $$('.tab[data-tab]').forEach(x => x.classList.remove('activo'));
    t.classList.add('activo');
    $('#tab-chat').classList.toggle('oculto', t.dataset.tab !== 'chat');
    $('#tab-colamanos').classList.toggle('oculto', t.dataset.tab !== 'cola-manos');
    $('#tab-personas').classList.toggle('oculto', t.dataset.tab !== 'personas');
    if (t.dataset.tab === 'personas') renderPersonas();
  });

  // selección de mensajes del chat: ☑️ entra al modo, la barra ofrece
  // borrar marcados/todo y unir las notas elegidas en un solo audio
  $('#chat-sel').onclick = () => toggleChatSel();
  $('#cs-salir').onclick = () => toggleChatSel(false);
  $('#cs-todo').onclick = () => {
    const msgs = $$('#chat-lista .msg').filter(m => !m.classList.contains('grabando'));
    const todos = msgs.length > 0 && msgs.every(m => m.classList.contains('sel'));
    msgs.forEach(m => m.classList.toggle('sel', !todos));
  };
  $('#cs-borrar').onclick = () => {
    const sel = $$('#chat-lista .msg.sel');
    if (!sel.length) { toast('Marca mensajes primero'); return; }
    confirmar(`¿Borrar ${sel.length} mensaje(s) del historial? Las notas de voz no volverán a aparecer.`,
      () => { borrarMensajes(sel); toggleChatSel(false); });
  };
  $('#cs-audios').onclick = () => {
    const seqs = $$('#chat-lista .msg.sel .nv-play')
      .map(b => +b.dataset.seq).filter(s => s > 0);
    if (!seqs.length) { toast('Marca notas de voz para exportar'); return; }
    exportarNotas(seqs);
  };
  // en modo selección el toque marca/desmarca; fuera de él, un toque largo
  // (o clic derecho) entra al modo marcando ese mensaje
  $('#chat-lista').addEventListener('click', (ev) => {
    if (!chatSel || ev.target.closest('.msg-opc')) return;
    const m = ev.target.closest('.msg');
    if (!m || m.classList.contains('grabando')) return; // nota en vivo: no se marca
    ev.preventDefault(); ev.stopPropagation();
    m.classList.toggle('sel');
  }, true);
  $('#chat-lista').addEventListener('contextmenu', (ev) => {
    const m = ev.target.closest('.msg');
    if (!m || m.classList.contains('grabando')) return;
    ev.preventDefault();
    if (!chatSel) toggleChatSel(true);
    m.classList.add('sel');
  });
}

/* ---------- ajustes de audio ---------- */
function cablearAjustes() {
  $('#aj-ganancia').oninput = (e) => {
    S.audio.ganancia = +e.target.value;
    $('#aj-gan-val').textContent = Math.round(S.audio.ganancia * 100) + '%';
    if (S.audio.gain) S.audio.gain.gain.value = S.audio.ganancia;
  };
  $('#aj-mic').onchange = async (e) => {
    S.dev.mic = e.target.value; guardarDev();
    arrancarMedidor();
    try { await reconstruirMic(); } catch (x) { toast(x.message); }
  };
  $('#aj-spk').onchange = (e) => { S.dev.spk = e.target.value; guardarDev(); aplicarSink(); };
  $('#aj-cam').onchange = async (e) => {
    S.dev.cam = e.target.value; guardarDev();
    try { await cambiarCamara(); } catch (x) { toast(x.message); }
  };
  const filtros = async () => {
    S.audio.ns = $('#aj-ns').checked;
    S.audio.ec = $('#aj-ec').checked;
    S.audio.agc = $('#aj-agc').checked;
    try { await reconstruirMic(); } catch (x) { toast(x.message); }
  };
  $('#aj-ns').onchange = filtros;
  $('#aj-ec').onchange = filtros;
  $('#aj-agc').onchange = filtros;
  $('#aj-calidad').onchange = async (e) => {
    S.prefAudio = e.target.value;
    localStorage.setItem('lk_audio_pref', S.prefAudio);
    try { actualizarCalidadAudioEnVivo(); } catch (x) { toast(x.message); }
  };
  // modo de hablar (mismo selector que el menú "Micro ▾")
  if ($('#aj-ptt')) $('#aj-ptt').onchange = (e) => cambiarModoPtt(e.target.value);
  if ($('#aj-ptt-sil')) $('#aj-ptt-sil').onchange = (e) => {
    S.ptt.silencio = Math.max(0.5, Math.min(5, +e.target.value || 2.2));
    e.target.value = S.ptt.silencio;
    localStorage.setItem('lk_ptt_silencio', String(S.ptt.silencio));
    const sil = $('#mic-silencio'); if (sil) sil.value = S.ptt.silencio;
  };
  // automático: sensibilidad de voz (cuánto por encima del ruido ambiente
  // hay que hablar para que el VAD "pise el botón") y debounce de ataque
  if ($('#aj-sens')) $('#aj-sens').oninput = (e) => {
    S.ptt.sens = +e.target.value;
    $('#aj-sens-val').textContent = '×' + S.ptt.sens.toFixed(1);
    localStorage.setItem('lk_ptt_sens', String(S.ptt.sens));
  };
  if ($('#aj-ataque')) $('#aj-ataque').oninput = (e) => {
    S.ptt.ataque = +e.target.value;
    $('#aj-ataque-val').textContent = Math.round(S.ptt.ataque * 1000) + ' ms';
    localStorage.setItem('lk_ptt_ataque', String(S.ptt.ataque));
  };
  // historial de voz: auto-salto al presente, tope de almacenamiento, vaciar
  if ($('#aj-presente')) $('#aj-presente').onchange = (e) => {
    S.autoPresente = e.target.checked;
    localStorage.setItem('lk_auto_presente', S.autoPresente ? '1' : '0');
    if (S.room && S.room.setAutoPresente) S.room.setAutoPresente(S.autoPresente);
  };
  if ($('#aj-hist-mb')) $('#aj-hist-mb').onchange = (e) => {
    S.segCapMB = Math.max(10, Math.min(2000, +e.target.value || 100));
    e.target.value = S.segCapMB;
    localStorage.setItem('lk_seg_mb', String(S.segCapMB));
    idbEvict().catch(() => {});
  };
  if ($('#aj-hist-vaciar')) $('#aj-hist-vaciar').onclick = () =>
    confirmar('¿Vaciar el historial de notas de voz guardado en este equipo?', async () => {
      await idbVaciar();
      S._nvEls.forEach(el => el.remove());
      S._nvEls.clear(); S._nvSeqs = []; S._nvRepro = 0;
      toast('Historial de voz vaciado');
    });
}

// Cambiar de cámara en caliente: setCameraEnabled(true) sobre un track ya
// publicado solo lo desmutea e ignora el deviceId nuevo — hay que reiniciar
// el track para que el cambio de dispositivo se aplique de verdad.
async function cambiarCamara() {
  const lp = S.room && S.room.localParticipant;
  if (!lp || !lp.isCameraEnabled) return;
  const cons = { deviceId: S.dev.cam ? { exact: S.dev.cam } : undefined };
  const pub = lp.getTrackPublication(LC.Track.Source.Camera);
  if (!pub || !pub.track) { await lp.setCameraEnabled(true, cons); return; }
  try {
    await pub.track.restartTrack(cons);
  } catch (e) {
    // algunos Android rechazan 'exact' al cambiar de cámara: reintentar laxo
    if (S.dev.cam && e && e.name === 'OverconstrainedError')
      await pub.track.restartTrack({ deviceId: { ideal: S.dev.cam } });
    else throw e;
  }
}

async function poblarSelectsAjustes() {
  $('#aj-ganancia').value = S.audio.ganancia;
  $('#aj-gan-val').textContent = Math.round(S.audio.ganancia * 100) + '%';
  $('#aj-ns').checked = S.audio.ns;
  $('#aj-ec').checked = S.audio.ec;
  $('#aj-agc').checked = S.audio.agc;
  $('#aj-calidad').value = S.prefAudio || 'auto';
  if ($('#aj-presente')) $('#aj-presente').checked = S.autoPresente;
  if ($('#aj-hist-mb')) $('#aj-hist-mb').value = S.segCapMB;
  if ($('#aj-ptt')) $('#aj-ptt').value = S.ptt.modo;
  if ($('#aj-ptt-sil')) $('#aj-ptt-sil').value = S.ptt.silencio;
  if ($('#aj-auto-cfg')) $('#aj-auto-cfg').classList.toggle('oculto', S.ptt.modo !== 'auto');
  if ($('#aj-sens')) {
    $('#aj-sens').value = S.ptt.sens;
    $('#aj-sens-val').textContent = '×' + (+S.ptt.sens).toFixed(1);
  }
  if ($('#aj-ataque')) {
    $('#aj-ataque').value = S.ptt.ataque;
    $('#aj-ataque-val').textContent = Math.round(S.ptt.ataque * 1000) + ' ms';
  }
  await llenarDisp($('#aj-cam'), 'videoinput', S.dev.cam);
  await llenarDisp($('#aj-mic'), 'audioinput', S.dev.mic);
  await llenarDisp($('#aj-spk'), 'audiooutput', S.dev.spk);
}

/* ---------- grabación local en el cliente ---------- */
async function toggleGrabacion() {
  if (S.rec) { S.rec.mr.stop(); return; }
  confirmar('¿Grabar la sesión en este equipo? Se avisará a toda la sala.', async () => {
    try { await iniciarGrabacion(); } catch (e) { toast('No se pudo grabar: ' + e.message); }
  });
}

async function iniciarGrabacion() {
  {
    const cv = document.createElement('canvas');
    cv.width = 1280; cv.height = 720;
    const cx = cv.getContext('2d');

    // videos: cámaras de todos + pantallas compartidas
    const videos = [];
    todosLosParticipantes().forEach(p => {
      [['📷', LC.Track.Source.Camera], ['🖥️', LC.Track.Source.ScreenShare]].forEach(([ico, src]) => {
        const pub = p.getTrackPublication(src);
        if (pub && pub.track && !pub.isMuted) {
          const el = pub.track.attach();
          el.play().catch(() => {});
          videos.push({ el, nombre: `${nombreDe(p)} ${src === LC.Track.Source.ScreenShare ? '🖥️' : ''}` });
        }
      });
    });

    // audio: mezcla de los micros remotos (el propio no, evita eco raro)
    const actx = new AudioContext();
    const dest = actx.createMediaStreamDestination();
    S.room.remoteParticipants.forEach(p => {
      [LC.Track.Source.Microphone, LC.Track.Source.ScreenShareAudio].forEach(src => {
        const pub = p.getTrackPublication(src);
        if (pub && pub.track) {
          try {
            const ms = new MediaStream([pub.track.mediaStreamTrack]);
            actx.createMediaStreamSource(ms).connect(dest);
          } catch {}
        }
      });
    });

    const timer = setInterval(() => {
      cx.fillStyle = '#0e1318';
      cx.fillRect(0, 0, cv.width, cv.height);
      const vivos = videos.filter(v => v.el.videoWidth > 0);
      if (!vivos.length) {
        cx.fillStyle = '#8fa0b3';
        cx.font = '28px system-ui';
        cx.fillText('Sin video — grabando audio', 60, 360);
        return;
      }
      const cols = Math.ceil(Math.sqrt(vivos.length));
      const rows = Math.ceil(vivos.length / cols);
      const w = cv.width / cols, h = cv.height / rows;
      vivos.forEach((v, i) => {
        const x = (i % cols) * w, y = Math.floor(i / cols) * h;
        // encaje "contain" dentro de la celda
        const s = Math.min(w / v.el.videoWidth, h / v.el.videoHeight);
        const vw = v.el.videoWidth * s, vh = v.el.videoHeight * s;
        cx.drawImage(v.el, x + (w - vw) / 2, y + (h - vh) / 2, vw, vh);
        cx.fillStyle = '#fff';
        cx.font = '16px system-ui';
        cx.fillText(v.nombre, x + 10, y + h - 10);
      });
    }, 100);

    const stream = cv.captureStream(15);
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      clearInterval(timer);
      actx.close().catch(() => {});
      try { pubData({ t: 'rec_stop' }); } catch {}
      const blob = new Blob(chunks, { type: 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${S.sala}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
      a.click();
      URL.revokeObjectURL(a.href);
      S.rec = null;
      S.grabadores.delete(S.identidad);
      renderControles();
      toast('Grabación guardada en tu equipo');
    };
    mr.start(1000);
    S.rec = { mr };
    S.grabadores.add(S.identidad);
    try { pubData({ t: 'rec_start', quien: S.nombre || S.identidad }); } catch {}
    renderControles();
    toast('Grabando en tu equipo — pulsa ⏺️ de nuevo para parar');
  }
}

/* ---------- pipeline de audio: micro → ganancia → analyser → publicación ---------- */
async function construirMicTrack() {
  // Asegurar que cualquier stream anterior quede cerrado antes de abrir otro
  if (S.audio.rawStream) {
    S.audio.rawStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    S.audio.rawStream = null;
  }
  if (S.audio.ctx) {
    S.audio.ctx.close().catch(() => {});
    S.audio.ctx = null;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: S.dev.mic ? { exact: S.dev.mic } : undefined,
      echoCancellation: S.audio.ec,
      noiseSuppression: S.audio.ns,
      autoGainControl: S.audio.agc,
      channelCount: 1,
    },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = S.audio.ganancia;
  const an = ctx.createAnalyser();
  an.fftSize = 256;
  const dest = ctx.createMediaStreamDestination();
  src.connect(gain); gain.connect(an); an.connect(dest);
  S.audio.ctx = ctx;
  S.audio.analyser = an;
  S.audio.gain = gain;
  S.audio.rawStream = stream;
  const outTrack = dest.stream.getAudioTracks()[0];
  if (outTrack) {
    outTrack._rawStream = stream;
    outTrack._sharedCtx = ctx;
    outTrack._sharedNode = an;
  }
  return outTrack;
}

function cerrarPipeline() {
  if (S.audio.rawStream) S.audio.rawStream.getTracks().forEach(t => t.stop());
  if (S.audio.ctx) S.audio.ctx.close().catch(() => {});
  S.audio.ctx = null; S.audio.analyser = null; S.audio.rawStream = null;
  // OJO: no tocar S.audio.on — es la intención del usuario y debe
  // sobrevivir a una desconexión para que reconectar() republique
  // el micro. Quien quiere el micro apagado lo apaga en retirarMic().
  S.audio.pub = null;
  detenerMedidor(); // el medidor del prejoin también captura: hay que soltarlo
}

// preset Opus/ADPCM según el perfil de sala y la velocidad de conexión detectada
const AUDIO_PRESETS = { telefono: 'telephone', voz: 'speech', musica: 'musicStereo' };
function perfilAudioEfectivo() {
  const pref = S.prefAudio || 'auto';
  const salaPerfil = (S.estado && S.estado.audioPerfil) || 'auto';
  if (pref !== 'auto') {
    if (salaPerfil === 'telefono') return 'telefono';
    return pref;
  }
  // automático: adapta dinámicamente según la conexión medida del propio usuario
  // ('mala' -> ~10 kbps, 'media' -> ~18 kbps, 'buena' -> ~28 kbps)
  const segRed = S.calidadRed === 'mala' ? 'telefono' : (S.calidadRed === 'buena' ? 'musica' : 'voz');
  if (salaPerfil === 'telefono') return 'telefono';
  if (salaPerfil === 'voz' && segRed === 'musica') return 'voz';
  return segRed;
}
function opcionesAudio() {
  return {
    source: LC.Track.Source.Microphone, name: 'microfono',
    audioPreset: LC.AudioPresets[AUDIO_PRESETS[perfilAudioEfectivo()] || 'speech'],
    dtx: true, red: false,
  };
}
function actualizarCalidadAudioEnVivo() {
  if (!S.audio.pub || !S.room || !S.room.localParticipant) return;
  if (typeof S.room.localParticipant.actualizarPresetAudio === 'function') {
    if (S.room.localParticipant.actualizarPresetAudio(opcionesAudio())) return;
  }
  reconstruirMic().catch(() => {});
}

async function retirarMic() {
  if (S.audio.retirando) return;
  S.audio.retirando = true;
  const room = S.room;
  let fallo = false;
  try {
    const pub = room.localParticipant.getTrackPublication(LC.Track.Source.Microphone);
    if (pub && pub.track) {
      // cada paso por separado: aunque el servidor ya haya revocado el permiso
      // y unpublish falle, el track local se detiene y el micro se libera
      await pub.mute().catch(() => {});
      await room.localParticipant.unpublishTrack(pub.track).catch(() => {});
      try { pub.track.stop(); } catch {}
    }
  } catch (e) { fallo = true; toast('No se pudo retirar el micro: ' + e.message); }
  finally {
    S.audio.retirando = false;
    if (S.room === room) {
      S.audio.on = false; // retirar = intención de apagado (usuario o permiso perdido)
      cerrarPipeline();
      if (!fallo) renderControles();
    }
  }
}

async function activarMic(on) {
  if (on && S.audio.activando) return;
  if (on) S.audio.activando = true;
  // anillo "encendiendo" en el botón: puede tardar segundos en teléfonos
  const bm = $('#ctl-mic');
  bm.classList.add('cargando');
  try {
    if (S.audio.pub && S.audio.pub !== S.room.localParticipant.getTrackPublication(LC.Track.Source.Microphone))
      cerrarPipeline();
    if (on) {
      if (!puedoHablar() || S.audio.retirando) return;
      if (!S.audio.pub) {
        S.audio.liberar = false; // el usuario lo activo: vuelve a capturar
        // adopta una publicación ya existente (p.ej. la del setMicrophoneEnabled
        // del inicio) en vez de publicar una segunda pista de micro
        const existente = S.room.localParticipant.getTrackPublication(LC.Track.Source.Microphone);
        if (existente && existente.track) {
          S.audio.pub = existente;
          await existente.unmute();
        } else {
          const track = await construirMicTrack();
          S.audio.pub = await S.room.localParticipant.publishTrack(track, opcionesAudio());
        }
        // el pipeline ya mide la entrada; el monitor deja de ser necesario
        if (S.micStream) detenerMedidor();
      } else {
        await S.audio.pub.unmute();
      }
      S.audio.on = true;
    } else {
      // silenciar = liberar el hardware: unpublish + cerrar pipeline + medidor,
      // así el teléfono puede usar el micro en otra app (en escritorio igual).
      // Sin condición sobre S.audio.pub: el micro pudo publicarse fuera del
      // pipeline (al entrar con setMicrophoneEnabled) y también hay que soltarlo.
      await retirarMic();
      S.audio.liberar = true;
      // apagar el micro también suelta el piso y la intención PTT
      S.ptt.quiero = false;
      S.ptt.tengo = false;
      if (S.room && S.room.soltarPiso) S.room.soltarPiso();
    }
    renderControles();
  } catch (e) {
    if (!S.room.localParticipant.getTrackPublication(LC.Track.Source.Microphone)) cerrarPipeline();
    toast('No se pudo activar el micro: ' + e.message);
  } finally {
    if (on) S.audio.activando = false;
    bm.classList.remove('cargando'); // renderControles ya lo limpió si salió bien
  }
}

async function reconstruirMic() {
  if (!S.audio.pub) return;          // sin micro activo no hay nada que reconstruir
  const estabaOn = S.audio.on;
  const viejo = S.audio.pub.track;
  await S.room.localParticipant.unpublishTrack(viejo);
  cerrarPipeline();
  if (!puedoHablar()) return;
  const track = await construirMicTrack();
  const pub = await S.room.localParticipant.publishTrack(track, opcionesAudio());
  S.audio.pub = pub;
  if (!estabaOn) await pub.mute();
  S.audio.on = estabaOn;
}

/* medidor de nivel: verde cuando el micro sale a la sala; gris cuando la
   entrada local se oye pero estás silenciado o sin permiso. #aj-nivel mide
   la entrada local en los ajustes. */
let nivelRAF = null;
function loopNivel() {
  if (!S.room) { nivelRAF = null; return; }
  const pub = S.room.localParticipant.getTrackPublication(LC.Track.Source.Microphone);
  // "enviando" = la pista real transmite; no puede depender del permiso,
  // porque si el estado llega desfasado la etiqueta miente (dice Silenciado
  // estando el micro activo)
  const enviando = !!(pub && !pub.isMuted);
  // los teléfonos recambian la salida solos (sensor de proximidad): se
  // reafirma el altavoz elegido cada pocos segundos
  if (S.dev.spk && Date.now() - (S._sinkTs || 0) > 3000) { S._sinkTs = Date.now(); aplicarSink(); }
  // fuente de nivel: el pipeline publicado si existe; si no, el monitor local
  const an = S.audio.analyser || S.micAnalyser;
  let nivel = 0;
  if (an) {
    const buf = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(buf);
    nivel = buf.reduce((a, b) => a + b, 0) / buf.length / 255;
  }
  const m1 = document.querySelector('#mic-nivel i');
  if (m1) {
    m1.style.width = Math.min(100, nivel * 320) + '%';
    m1.classList.toggle('gris', !enviando);
  }
  const ajustes = !$('#modal-ajustes').classList.contains('oculto') && !S.micCtx;
  if (ajustes) $('#aj-nivel').style.width = Math.min(100, nivel * 320) + '%';
  const est = $('#mic-estado');
  const hablas = !enviando && nivel > 0.12 && puedoHablar();
  const txt = enviando && modoPtt() && !S.ptt.tengo ? 'Esperando piso…'
    : enviando ? 'Enviando'
    : !puedoHablar() ? 'Sin permiso'
    : hablas ? 'Hablas con el micro silenciado'
    : S.ptt.modo === 'hold' ? 'Mantén pisado para hablar'
    : S.ptt.modo === 'lock' ? 'Toca para hablar'
    : 'Silenciado';
  if (est.textContent !== txt) est.textContent = txt;
  est.classList.toggle('avisa', hablas);
  // aviso grande centrado: solo cuando el micro está permitido en tu
  // posición actual; sin permiso no tiene sentido avisar
  if (!enviando && nivel > 0.12 && puedoHablar()) S._hablasTs = Date.now();
  const verAviso = puedoHablar() && Date.now() - (S._hablasTs || 0) < 3000;
  $('#hablas-aviso').classList.toggle('oculto', !verAviso);
  if (verAviso) $('#hablas-txt').textContent = '🎙️ Estás hablando con el micrófono silenciado';
  nivelRAF = requestAnimationFrame(loopNivel);
}

/* ---------- vista ---------- */
function cambiarVista(v) {
  // con la vista fijada la audiencia no se mueve: solo los moderadores
  if (S.estado && S.estado.vistaFija && !esMod()) return;
  S.vistaLocal = v;                    // cambio solo local
  renderTodo();
}

function sincronizarVista() {
  const vista = S.vistaLocal || S.vistaSync || 'asientos';
  moderar('rejilla', { extra: vista }).catch(e => toast(e.message));
  toast('Vista sincronizada a todos: ' + vista);
}

/* ---------- chat ---------- */
// ⋮ en la esquina de cada mensaje: abre un desplegable con acciones
// directas — seleccionar (entra al modo selección con éste marcado),
// descargar el audio (solo notas cerradas) o eliminar ese mensaje
function ponerOpcionesMsg(el) {
  const b = document.createElement('button');
  b.className = 'msg-opc';
  b.textContent = '⋮';
  b.title = 'Opciones';
  b.onclick = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const r = b.getBoundingClientRect();
    menuMensaje(el, r.right, r.bottom + 4);
  };
  el.appendChild(b);
}

function menuMensaje(el, x, y) {
  const seq = +(el.querySelector('.nv-play')?.dataset.seq || 0);
  const grabando = el.classList.contains('grabando');
  const items = [
    { label: '☑️ Seleccionar', fn: () => {
      if (!chatSel) toggleChatSel(true);
      el.classList.add('sel');
    } },
  ];
  if (seq && !grabando)
    items.push({ label: '⬇️ Descargar audio', fn: () => exportarNotas([seq]) });
  items.push({ label: '🗑️ Eliminar', peligro: true, fn: () =>
    confirmar(seq
      ? '¿Eliminar esta nota de voz? No volverá a aparecer al sincronizar.'
      : '¿Eliminar este mensaje?',
      () => borrarMensajes([el])) });
  abrirMenuCtx(x, y, items);
}

function agregarChat(quien, texto, propio) {
  const el = document.createElement('div');
  el.className = 'msg' + (propio ? ' propio' : '');
  el.innerHTML = `<div class="quien">${esc(quien)}</div>${esc(texto)}`;
  ponerOpcionesMsg(el);
  const lista = $('#chat-lista');
  lista.appendChild(el);
  while (lista.children.length > 200) lista.firstChild.remove();
  lista.scrollTop = lista.scrollHeight;
}

/* ---------- notas de voz (historial de audio en el chat) ---------- */
// Lápidas: seqs de notas que el usuario borró. Persisten en localStorage
// por sala para que la sincronización tras un corte no las resucite.
function nvBorrados() {
  if (!S._nvBorrados) {
    S._nvBorrados = new Set();
    try { JSON.parse(localStorage.getItem('nv_bor_' + S.sala) || '[]').forEach(s => S._nvBorrados.add(s)); } catch {}
  }
  return S._nvBorrados;
}
function nvBorrarSeq(seq) {
  nvBorrados().add(seq);
  try { localStorage.setItem('nv_bor_' + S.sala, JSON.stringify([...S._nvBorrados].slice(-500))); } catch {}
}

const fmtDurSeg = (ms) => {
  const s = Math.max(1, Math.round((ms || 0) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// Inserta una nota de voz en #chat-lista respetando el orden numérico de seq
// (para que una nota recuperada tras un corte no quede abajo de notas más nuevas)
function insertarNotaOrdenada(lista, el, seq) {
  el.dataset.seq = seq;
  for (const ch of lista.children) {
    const cSeq = +(ch.dataset?.seq || ch.querySelector('.nv-play')?.dataset.seq || 0);
    if (cSeq > seq) {
      lista.insertBefore(el, ch);
      return;
    }
  }
  lista.appendChild(el);
}

// Cada frase cerrada queda como nota de voz en el historial del chat:
// reproducible, con indicador de sonando/escuchada
// La frase que se está grabando AHORA aparece al instante en el chat con
// ● grabando + tiempo corriendo. No se puede rebobinar (aún no termina),
// pero tocarla te adelanta hasta el audio en tiempo real — igual que el
// chip "Ir al presente" cuando vas atrasado.
// Mi nota "grabando" se crea en el instante en que el cliente empieza a
// transmitir — no espera el eco del servidor. Lleva un seq provisional
// alto (ordena al final); cuando llega el seg_ini/seg_fin real con mi
// identidad, el provisional ADOPTA ese seq y sigue siendo la misma nota.
let _nvMiaPend = 0, _nvMiaN = 0;
function agregarNotaPropiaPendiente(inicio) {
  if (_nvMiaPend && !S._nvEls.has(_nvMiaPend)) _nvMiaPend = 0;
  if (_nvMiaPend) return; // ya hay una nota mía grabando
  _nvMiaPend = 2e9 + (++_nvMiaN);
  agregarNotaVozEnVivo({ seq: _nvMiaPend, de: S.identidad, nombre: S.nombre || 'Yo', inicio });
}
// El provisional de mi nota "grabando" adopta el seq real del servidor.
// Devuelve true si adoptó (la nota ya existe bajo la nueva llave).
function adoptarSeqPropia(meta) {
  if (!meta || meta.de !== S.identidad || meta.seq <= 0) return false;
  const prov = _nvMiaPend;
  if (!prov || prov === meta.seq) return false;
  const el = S._nvEls.get(prov);
  _nvMiaPend = 0;
  if (!el || !el.classList.contains('grabando')) return false;
  if (S._nvEls.has(meta.seq)) return false; // ya existía con seq real
  S._nvEls.delete(prov);
  S._nvEls.set(meta.seq, el);
  const i = S._nvSeqs.indexOf(prov);
  if (i >= 0) { S._nvSeqs[i] = meta.seq; S._nvSeqs.sort((a, b) => a - b); }
  el.querySelectorAll('[data-seq]').forEach(b => { b.dataset.seq = meta.seq; });
  const lista = $('#chat-lista');
  el.remove();
  insertarNotaOrdenada(lista, el, meta.seq);
  return true;
}

function agregarNotaVozEnVivo(meta) {
  // Mi provisional adopta el seq real: la nota "grabando" ya existe
  if (adoptarSeqPropia(meta)) return;
  if (!meta || meta.seq <= 0 || S._nvEls.has(meta.seq) || nvBorrados().has(meta.seq)) return;
  const lista = $('#chat-lista');
  const el = document.createElement('div');
  el.className = 'msg nota-voz grabando';
  const inicio = meta.inicio || Date.now();
  el.dataset.durMs = 0;
  el.innerHTML = `<div class="quien">🎙️ ${esc(meta.nombre || meta.de)} · <span class="muted">ahora</span></div>` +
    `<div class="nv-player"><button class="nv-play btn mini" data-seq="${meta.seq}" title="Ir al audio en tiempo real">⏭️</button>` +
    `<button class="nv-stop btn mini oculto" data-seq="${meta.seq}" title="Detener">⏹️</button>` +
    `<div class="nv-pista"><div class="nv-relleno rec"></div></div>` +
    `<span class="nv-tiempo">● 0:00</span></div>`;
  // sin ⋮ mientras graba: no hay nada que seleccionar/descargar/borrar
  insertarNotaOrdenada(lista, el, meta.seq);
  lista.scrollTop = lista.scrollHeight;
  S._nvEls.set(meta.seq, el);
  S._nvSeqs.push(meta.seq);
  S._nvSeqs.sort((a, b) => a - b);
  const t = el.querySelector('.nv-tiempo');
  el._recTimer = setInterval(() => {
    const trans = Date.now() - inicio;
    // el servidor cierra toda frase a los 90 s: si sigue "grabando" mucho
    // más allá, su seg_fin se perdió — red de seguridad local
    if (trans > 95000) {
      marcarNotaVoz(meta.seq, 'perdida');
      return;
    }
    t.textContent = '● ' + fmtDurSeg(trans);
  }, 500);
  // tocarla: saltar todo el retraso acumulado y escuchar desde el vivo
  el.querySelector('.nv-play').onclick = () => {
    if (S.room && S.room.saltarAlPresente) S.room.saltarAlPresente();
    marcarNotaVoz(meta.seq, 'sonando');
    toast('Te adelantaste al audio en tiempo real');
  };
}

// Tras reconectar (o al entrar) rellena el historial del chat: pide al
// manifiesto los segmentos recientes del grupo y crea notas para las que
// el corte se llevó. Las ya mostradas se saltan por seq.
async function sincronizarNotas() {
  if (!S.room || !S.sala) return;
  try {
    const ultimo = Math.max(S._ultimoSeg || 0, ...(S._nvSeqs.length ? [S._nvSeqs[S._nvSeqs.length - 1]] : [0]));
    // solo metadatos (seq, nombre, duración, estado) — el audio NO baja aquí,
    // se descarga recién al darle ▶ a una nota. Al entrar se piden las
    // últimas 40; después solo el rango desde lo último conocido.
    const q = ultimo > 0 ? `desde=${Math.max(0, ultimo - 40)}` : 'ultimos=40';
    const r = await fetch(
      `/api/salas/${encodeURIComponent(S.sala)}/audio?${q}&g=${S.miGrupo || 0}`,
      { headers: { Authorization: 'Bearer ' + S.token } });
    if (!r.ok) return;
    const man = await r.json();
    // al entrar (desde=0) solo se siembran las ~40 últimas notas: el chat
    // no se inunda con el historial completo pero sí queda recuperable
    for (const meta of (man.segmentos || []).slice(-40)) {
      const viejo = S._nvEls.get(meta.seq);
      // las seq ya mostradas se saltan SALVO si quedaron como fantasma
      // "grabando": el manifiesto las convierte en nota cerrada
      if (meta.seq && !nvBorrados().has(meta.seq) &&
          (!viejo || viejo.classList.contains('grabando')))
        agregarNotaVoz({ seq: meta.seq, de: meta.de, nombre: meta.nombre, durMs: meta.durMs, inicio: meta.inicio, interrumpida: meta.interrumpida });
    }
    // comparar el manifiesto del servidor contra IndexedDB: se encolan para
    // descarga de fondo SOLO los audios cerrados que aún no están en local
    try {
      const guardados = new Set((await idbListarSala()).map(r => r.seq));
      for (const meta of (man.segmentos || [])) {
        if (meta.seq && (meta.durMs || 0) >= 800 &&
            !guardados.has(meta.seq) && !nvBorrados().has(meta.seq))
          bgEncolarSeg(meta.seq, 2500);
      }
    } catch {}
    if (man.abierto && man.abierto.seq && !S._nvEls.has(man.abierto.seq) && !nvBorrados().has(man.abierto.seq))
      agregarNotaVozEnVivo({ seq: man.abierto.seq, de: man.abierto.de, nombre: man.abierto.nombre, inicio: man.abierto.inicio });
    // Fantasmas: notas "grabando" que el servidor ya no tiene ni abiertas
    // ni archivadas (su seg_fin se perdió en un corte). Se eliminan.
    const vivos = new Set((man.segmentos || []).map(m => m.seq));
    if (man.abierto && man.abierto.seq) vivos.add(man.abierto.seq);
    S._nvEls.forEach((el, seq) => {
      // las provisionales (mi frase en curso, seq aún sin asignar por el
      // servidor) no son fantasmas: adoptan su seq al llegar seg_ini/fin
      if (seq >= 2e9) return;
      if (el.classList.contains('grabando') && !vivos.has(seq))
        marcarNotaVoz(seq, 'perdida');
    });
    if (man.ultimo) S._ultimoSeg = Math.max(S._ultimoSeg || 0, man.ultimo);
  } catch {}
}

function agregarNotaVoz(meta) {
  if (!meta || meta.seq <= 0) return;
  // si el seg_ini se perdió, mi provisional adopta el seq del seg_fin
  // y cae en el flujo normal que la convierte en nota cerrada
  adoptarSeqPropia(meta);
  if (nvBorrados().has(meta.seq)) {
    // nota borrada por el usuario: si quedó una copia "grabando", fuera
    const v = S._nvEls.get(meta.seq);
    if (v) { clearInterval(v._recTimer); S._nvEls.delete(meta.seq); v.remove(); }
    return;
  }
  const viejo = S._nvEls.get(meta.seq);
  if (viejo) {
    // nota de tap accidental (<0,8 s): no queda en el historial, se borra
    if ((meta.durMs || 0) < 800) {
      clearInterval(viejo._recTimer);
      S._nvEls.delete(meta.seq);
      const i = S._nvSeqs.indexOf(meta.seq); if (i >= 0) S._nvSeqs.splice(i, 1);
      viejo.remove();
      return;
    }
    // la nota en vivo se cerró: pasa de "grabando" a nota reproducible
    // (y ahora sí gana su ⋮ de opciones)
    viejo.classList.remove('grabando');
    ponerOpcionesMsg(viejo);
    clearInterval(viejo._recTimer);
    viejo.dataset.durMs = meta.durMs || viejo.dataset.durMs || 0;
    const t = viejo.querySelector('.nv-tiempo');
    if (t) t.textContent = fmtDurSeg(meta.durMs);
    const r = viejo.querySelector('.nv-relleno');
    if (r) { r.classList.remove('rec'); r.style.width = '0%'; }
    const b = viejo.querySelector('.nv-play');
    if (b) {
      if (!b.classList.contains('sonando')) b.textContent = '▶';
      b.onclick = () => reproducirNota(meta.seq);
    }
    const bs = viejo.querySelector('.nv-stop');
    if (bs) {
      bs.classList.remove('oculto');
      bs.onclick = (ev) => { ev.stopPropagation(); detenerNota(meta.seq); };
    }
    return;
  }
  const lista = $('#chat-lista');
  const el = document.createElement('div');
  el.className = 'msg nota-voz';
  const hora = meta.inicio ? new Date(meta.inicio).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  el.dataset.durMs = meta.durMs || 0;
  el.innerHTML = `<div class="quien">🎙️ ${esc(meta.nombre || meta.de)}${hora ? ` · <span class="muted">${hora}</span>` : ''}${meta.interrumpida ? ' <span class="muted">(interrumpida)</span>' : ''}</div>` +
    `<div class="nv-player"><button class="nv-play btn mini" data-seq="${meta.seq}">▶</button>` +
    `<button class="nv-stop btn mini" data-seq="${meta.seq}" title="Detener">⏹️</button>` +
    `<div class="nv-pista"><div class="nv-relleno"></div></div>` +
    `<span class="nv-tiempo">${fmtDurSeg(meta.durMs)}</span></div>`;
  ponerOpcionesMsg(el);
  insertarNotaOrdenada(lista, el, meta.seq);
  while (lista.children.length > 200) {
    const viejo = lista.firstChild;
    if (viejo && viejo.classList.contains('nota-voz')) {
      const seq = +(viejo.querySelector('.nv-play')?.dataset.seq || 0);
      if (seq) { S._nvEls.delete(seq); const i = S._nvSeqs.indexOf(seq); if (i >= 0) S._nvSeqs.splice(i, 1); }
    }
    viejo.remove();
  }
  lista.scrollTop = lista.scrollHeight;
  S._nvEls.set(meta.seq, el);
  S._nvSeqs.push(meta.seq);
  S._nvSeqs.sort((a, b) => a - b);
  el.querySelector('.nv-play').onclick = () => reproducirNota(meta.seq);
  el.querySelector('.nv-stop').onclick = (ev) => { ev.stopPropagation(); detenerNota(meta.seq); };
}

function marcarNotaVoz(seq, est, prog) {
  const el = S._nvEls.get(seq);
  if (!el) return;
  const b = el.querySelector('.nv-play');
  const t = el.querySelector('.nv-tiempo');
  const r = el.querySelector('.nv-relleno');
  if (!b) return;
  if (est === 'cargando') {
    b.classList.add('cargando'); b.classList.remove('sonando', 'oido');
    b.textContent = '⏳';
  }
  if (est === 'sonando') {
    b.classList.add('sonando'); b.classList.remove('oido', 'cargando', 'pausa');
    b.textContent = '🔊';
  }
  if (est === 'pausa') {
    b.classList.add('pausa'); b.classList.remove('sonando', 'oido', 'cargando');
    b.textContent = '⏸️';
    b.title = 'En pausa — toca para seguir escuchando';
  }
  if (est === 'oido') {
    b.classList.add('oido'); b.classList.remove('sonando', 'cargando', 'pausa');
    b.textContent = '▶';
    b.title = '';
    if (r) r.style.width = '0%';
    if (t) t.textContent = fmtDurSeg(+el.dataset.durMs || 0);
  }
  if (est === 'progreso' && prog) {
    if (!b.classList.contains('sonando')) {
      b.classList.add('sonando'); b.classList.remove('oido', 'cargando');
      b.textContent = '🔊';
    }
    const tot = prog.durMs || 1;
    if (r) r.style.width = Math.min(100, (prog.posMs / tot) * 100) + '%';
    if (t) t.textContent = fmtDurSeg(prog.posMs) + ' / ' + fmtDurSeg(tot);
  }
  if (est === 'perdida') {
    // segmento descartado: se quita del chat (si seguía "grabando", su
    // cronómetro también muere con él)
    clearInterval(el._recTimer);
    S._nvEls.delete(seq);
    const i = S._nvSeqs.indexOf(seq); if (i >= 0) S._nvSeqs.splice(i, 1);
    el.remove();
  }
}

// Re-escuchar una nota: primero en la RAM del motor; si ya se limpió, en el
// historial local (IndexedDB); por último en el servidor (retención 1 h)
// --- selección de mensajes del chat: borrar o exportar audios ---
let chatSel = false;
function toggleChatSel(on) {
  chatSel = on === undefined ? !chatSel : !!on;
  $('#chat-lista').classList.toggle('seleccion', chatSel);
  $('#chat-selbar').classList.toggle('oculto', !chatSel);
  $('#chat-sel').classList.toggle('on', chatSel);
  if (!chatSel) $$('#chat-lista .msg.sel').forEach(el => el.classList.remove('sel'));
}

// Borra mensajes del historial propio. Las notas de voz quedan con lápida
// (nv_bor_<sala>) para que la sincronización no las vuelva a traer; los
// mensajes de texto no se re-sincronizan y solo se quitan de la vista.
function borrarMensajes(els) {
  for (const el of els) {
    if (el.classList.contains('grabando')) continue; // nota aún grabándose: intocable
    const seq = +(el.querySelector('.nv-play')?.dataset.seq || 0);
    if (seq) {
      nvBorrarSeq(seq);
      if (S._nvPausas) S._nvPausas.delete(seq);
      clearInterval(el._recTimer);
      S._nvEls.delete(seq);
      const i = S._nvSeqs.indexOf(seq); if (i >= 0) S._nvSeqs.splice(i, 1);
    }
    el.remove();
  }
}

// Une las notas seleccionadas en un solo WAV y lo descarga — el audio ya
// está en el equipo (RAM/IndexedDB) o se trae del servidor (retención 1 h)
async function exportarNotas(seqs) {
  if (!S.room) return;
  toast('Preparando el audio…');
  const rate = (S.room._asegurarRxAudioCtx && S.room._asegurarRxAudioCtx().sampleRate) || 48000;
  const partes = []; let total = 0;
  for (const seq of seqs) {
    let bl = await S.room.bloquesDeSeg(seq).catch(() => null);
    if (!bl) {
      try {
        const rec = await idbCargarSeg(seq);
        if (rec && rec.raw && rec.raw.length) bl = await S.room.bloquesDeRaw(rec.raw);
      } catch {}
    }
    if (!bl) {
      try {
        const r = await fetch(`/api/salas/${encodeURIComponent(S.sala)}/audio/${seq}`,
          { headers: { Authorization: 'Bearer ' + S.token } });
        if (r.ok) bl = await S.room.bloquesDeArchivo(await r.arrayBuffer());
      } catch {}
    }
    if (!bl) continue;
    for (const b of bl) { partes.push(b); total += b.length; }
  }
  if (!total) { toast('No se pudo armar el audio de las notas elegidas'); return; }
  const pcm = new Float32Array(total);
  let o = 0;
  for (const b of partes) { pcm.set(b, o); o += b.length; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(pcmAWav(pcm, rate));
  a.download = `conferencia-${S.sala}-${seqs.length}-notas.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  toast(`⬇️ ${seqs.length} nota(s) unidas en un solo audio`);
}

// WAV PCM de 16 bits mono: cabecera RIFF estándar + muestras
function pcmAWav(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function reproducirNota(seq) {
  if (!S.room) return;
  if (!S._nvPausas) S._nvPausas = new Set();
  // La nota que está sonando se PAUSA al pisarla de nuevo; si quedó en
  // pausa, otro toque la reanuda desde donde iba — aunque hayas
  // escuchado otras notas entremedio, la marca no se pierde
  if (S._nvPausas.has(seq) && S.room.reanudarReplay && S.room.reanudarReplay(seq)) {
    S._nvPausas.delete(seq);
    S._nvRepro = seq;
    marcarNotaVoz(seq, 'sonando');
    return;
  }
  if (S.room.pausarReplay && S.room.pausarReplay(seq)) {
    S._nvPausas.add(seq);
    marcarNotaVoz(seq, 'pausa');
    return;
  }
  S._nvRepro = seq;
  marcarNotaVoz(seq, 'cargando'); // feedback inmediato mientras decodifica/descarga
  if (S.room.reproducirSeg && S.room.reproducirSeg(seq)) return;
  try {
    const rec = await idbCargarSeg(seq);
    if (rec && rec.raw && rec.raw.length) {
      await S.room.reproducirRaw(rec.raw, seq);
      return;
    }
  } catch {}
  try {
    const r = await fetch(`/api/salas/${S.sala}/audio/${seq}`,
      { headers: { Authorization: 'Bearer ' + S.token } });
    if (r.ok) {
      const buf = await r.arrayBuffer();
      await S.room.reproducirArchivo(buf, seq);
      // la descarga queda en el caché local: la próxima vez suena sin conexión
      const p = S.room.analizarArchivoSeg && S.room.analizarArchivoSeg(buf);
      if (p) idbGuardarArchivo(p);
      return;
    }
  } catch {}
  marcarNotaVoz(seq, 'perdida');
  toast('Esa nota de voz ya no está disponible (el servidor la guarda 1 hora)');
}

// ⏹ junto al play: detiene la nota (si suena o está pausada) y olvida su
// posición — el siguiente ▶ la empieza desde el inicio
function detenerNota(seq) {
  if (!S.room) return;
  if (S._nvPausas) S._nvPausas.delete(seq);
  if (S._nvRepro === seq) S._nvRepro = 0; // no encadenar con la siguiente nota
  if (S.room.detenerReplay) S.room.detenerReplay(seq);
  else marcarNotaVoz(seq, 'oido');
}

// Al terminar de re-escuchar una nota, sigue con la siguiente cerrada del historial
function reproducirSiguienteNota(seq) {
  marcarNotaVoz(seq, 'oido');
  if (S._nvPausas) S._nvPausas.delete(seq);
  if (S._nvRepro !== seq) return;
  for (const s of S._nvSeqs) {
    if (s <= seq) continue;
    const el = S._nvEls.get(s);
    if (el && !el.classList.contains('grabando')) {
      reproducirNota(s);
      return;
    }
  }
  S._nvRepro = 0;
}

// El botón del chat es PTT cuando el campo está vacío (mismos permisos y
// colores que los demás pulsadores) y "enviar" cuando hay texto
function actualizarChatBtn() {
  const ci = $('#chat-input'), ce = $('#chat-enviar');
  if (!ci || !ce) return;
  const vacio = !ci.value.trim();
  ce.classList.toggle('ptt-sup', vacio);
  ce.textContent = vacio ? '🎙️' : '➤';
  if (vacio) {
    ce.classList.remove('enviando');
    renderPttEstados();
  } else {
    ce.classList.remove('ptt-libre', 'ptt-ocupado', 'ptt-hablando', 'ptt-sinpermiso');
    ce.title = 'Enviar mensaje';
  }
}

// Chip "vas con retraso": indica cuánto audio falta por escuchar respecto
// al presente y permite saltar directo al audio en vivo
function renderRetraso(ms) {
  const chip = $('#st-retraso');
  if (!chip) return;
  if (ms > 1500) {
    chip.classList.remove('oculto');
    $('#st-retraso-n').textContent = '+' + Math.round(ms / 1000) + ' s';
  } else {
    chip.classList.add('oculto');
  }
}

/* ---------- historial local de voz (IndexedDB) ---------- */
let _idbP = null;
function idbAbrir() {
  if (_idbP) return _idbP;
  _idbP = new Promise((res, rej) => {
    const r = indexedDB.open('conferencia-notas-voz', 1);
    r.onupgradeneeded = () => {
      const os = r.result.createObjectStore('segs', { keyPath: 'k' });
      os.createIndex('sala', 'sala');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  _idbP.then(db => idbMigrarLegado(db)).catch(() => {});
  return _idbP;
}

// Migra el historial que haya quedado guardado bajo el nombre antiguo de la
// base de datos, si existe, y luego la elimina.
async function idbMigrarLegado(db) {
  try {
    const viejo = 'mumble-notas-voz';
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      if (!dbs.some(d => d.name === viejo)) return;
    }
    const dbV = await new Promise((res, rej) => {
      const r = indexedDB.open(viejo, 1);
      r.onsuccess = () => res(r.result);
      r.onerror = r.onupgradeneeded = () => rej(r.error);
    });
    const recs = await new Promise((res, rej) => {
      const rq = dbV.transaction('segs', 'readonly').objectStore('segs').getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
    dbV.close();
    if (recs.length) {
      await new Promise((res, rej) => {
        const tx = db.transaction('segs', 'readwrite');
        const os = tx.objectStore('segs');
        recs.forEach(rec => os.put(rec));
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    }
    indexedDB.deleteDatabase(viejo);
  } catch {}
}

async function idbGuardarSeg(seq) {
  if (!S.room || typeof S.room.datosSeg !== 'function') return;
  const d = S.room.datosSeg(seq);
  // Solo cachear en IndexedDB cuando el segmento esté COMPLETO (sin huecos
  // o ya descargado del servidor); si en vivo faltaron tramas, no guardar
  // la copia rota — al darle ▶ se bajará el archivo entero del servidor.
  if (!d || (d.huecos && !d.descargado) || !d.raw || !d.raw.length) return;
  try {
    const raw = d.raw.map(u => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
    const rec = {
      k: S.sala + '|' + seq, sala: S.sala, seq,
      de: d.de, nombre: d.nombre, durMs: d.durMs,
      inicio: d.inicio || Date.now(), interrumpida: !!d.interrumpida,
      bytes: d.raw.reduce((a, u) => a + u.length, 0), raw,
    };
    const db = await idbAbrir();
    await new Promise((res, rej) => {
      const tx = db.transaction('segs', 'readwrite');
      tx.objectStore('segs').put(rec);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    idbEvict().catch(() => {});
  } catch {}
}

// Persiste una nota descargada bajo demanda (espejo de idbGuardarSeg pero
// a partir del archivo .seg del servidor): al darle ▶ una vez queda en el
// teléfono y se puede escuchar después sin conexión
async function idbGuardarArchivo(p) {
  if (!p || !p.sg || !p.sg.seq || !p.frames || !p.frames.length) return;
  try {
    const raw = p.frames.map(u => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
    const rec = {
      k: S.sala + '|' + p.sg.seq, sala: S.sala, seq: p.sg.seq,
      de: p.sg.de, nombre: p.sg.nombre, durMs: p.sg.durMs,
      inicio: p.sg.inicio || Date.now(), interrumpida: !!p.sg.cortado,
      bytes: raw.reduce((a, u) => a + u.byteLength, 0), raw,
    };
    const db = await idbAbrir();
    await new Promise((res, rej) => {
      const tx = db.transaction('segs', 'readwrite');
      tx.objectStore('segs').put(rec);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    idbEvict().catch(() => {});
  } catch {}
}

async function idbCargarSeg(seq) {
  const db = await idbAbrir();
  return new Promise((res, rej) => {
    const rq = db.transaction('segs').objectStore('segs').get(S.sala + '|' + seq);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}

async function idbListarSala() {
  try {
    const db = await idbAbrir();
    const recs = await new Promise((res, rej) => {
      const rq = db.transaction('segs').objectStore('segs').index('sala').getAll(S.sala);
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
    return recs.sort((a, b) => a.seq - b.seq);
  } catch { return []; }
}

// Evicción FIFO: borra las notas más viejas hasta caber bajo el tope
async function idbEvict() {
  const recs = await idbListarSala();
  const cap = Math.max(10, S.segCapMB) * 1048576;
  let total = recs.reduce((a, r) => a + (r.bytes || 0), 0);
  if (total <= cap) return;
  const db = await idbAbrir();
  const tx = db.transaction('segs', 'readwrite');
  const os = tx.objectStore('segs');
  for (const r of recs) {
    if (total <= cap) break;
    os.delete(r.k);
    total -= r.bytes || 0;
  }
}

async function idbVaciar() {
  const recs = await idbListarSala();
  const db = await idbAbrir();
  await new Promise((res, rej) => {
    const tx = db.transaction('segs', 'readwrite');
    const os = tx.objectStore('segs');
    for (const r of recs) os.delete(r.k);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

// Al entrar a la sala: el historial de notas vuelve a verse en el chat
async function precargarNotasVoz() {
  const recs = await idbListarSala();
  for (const r of recs.slice(-80)) agregarNotaVoz(r);
}

// ---------- descarga de fondo: todo audio cerrado queda en el teléfono ----------
// El servidor retiene cada .seg solo ~1 h. Esta cola baja al IndexedDB local
// los audios que falten, de a UNO por vez y espaciados, con prioridad menor
// que el audio en vivo: si ya está guardado en local o completo en RAM, no
// gasta datos. Así al darle ▶ siempre suena, aunque el servidor lo haya
// purgado.
const _bgSeg = { cola: [], enCola: new Set(), muertos: new Set(), timer: 0, activo: false };

function bgEncolarSeg(seq, demoraMs) {
  seq = +seq || 0;
  if (seq <= 0 || _bgSeg.muertos.has(seq) || nvBorrados().has(seq)) return;
  if (!_bgSeg.enCola.has(seq)) {
    _bgSeg.enCola.add(seq);
    _bgSeg.cola.push(seq);
  }
  _bgProgramar(demoraMs || 0);
}

function _bgProgramar(demoraMs) {
  if (_bgSeg.timer || !_bgSeg.cola.length) return;
  _bgSeg.timer = setTimeout(() => {
    _bgSeg.timer = 0;
    _bgProcesarSeg();
  }, Math.max(400, demoraMs || 400));
}

async function _bgProcesarSeg() {
  if (_bgSeg.activo || !S.sala || !S.token || !S.room) return;
  _bgSeg.cola.sort((a, b) => a - b);
  const seq = _bgSeg.cola.shift();
  if (!seq) return;
  _bgSeg.enCola.delete(seq);
  _bgSeg.activo = true;
  try {
    // 1) ya está guardada en el teléfono → nada que bajar
    let rec = null;
    try { rec = await idbCargarSeg(seq); } catch {}
    if (rec && rec.raw && rec.raw.length) return;
    // 2) está completa en RAM (llegó en vivo sin huecos o ya reparada):
    //    se persiste sin gastar datos
    try {
      const d = S.room.datosSeg && S.room.datosSeg(seq);
      if (d && d.raw && d.raw.length && (!d.huecos || d.descargado)) {
        await idbGuardarSeg(seq);
        return;
      }
    } catch {}
    // 3) descargar el .seg completo del servidor (incluye mi propia voz,
    //    que nunca pasa por mi cola en vivo)
    const r = await fetch(
      `/api/salas/${encodeURIComponent(S.sala)}/audio/${seq}`,
      { headers: { Authorization: 'Bearer ' + S.token } });
    if (!r.ok) {
      if (r.status === 404 || r.status === 410) {
        _bgSeg.muertos.add(seq); // el servidor ya la purgó
        marcarNotaVoz(seq, 'perdida');
      } else bgEncolarSeg(seq, 8000); // error transitorio: reintentar
      return;
    }
    const buf = await r.arrayBuffer();
    const p = S.room.analizarArchivoSeg && S.room.analizarArchivoSeg(buf);
    if (p && p.sg && !p.sg.abierto && p.frames && p.frames.length) {
      await idbGuardarArchivo(p);
    } else if (p && p.sg && p.sg.abierto) {
      bgEncolarSeg(seq, 10000); // aún abierta en el servidor: reintentar luego
    }
  } catch {
    bgEncolarSeg(seq, 8000); // sin señal/datos: reintenta en unos segundos
  } finally {
    _bgSeg.activo = false;
    _bgProgramar(1200);
  }
}

// chat: "leído" = panel abierto en la pestaña Chat. Si está cerrado, los
// mensajes llegan como burbuja flotante que sube por la pantalla
function chatVisible() {
  if (!panelEstaAbierto()) return false;
  const t = document.querySelector('.tab[data-tab="chat"]');
  return t && t.classList.contains('activo');
}
// filtro de recepción: mensajes de quien tiene el chat prohibido no se ven,
// y con chatOff solo escriben moderadores/admins
function puedeVerChatDe(p) {
  if (!p) return true;
  if (S.chatProhibidos && S.chatProhibidos.includes(p.identity)) return false;
  if (S.estado && S.estado.chatOff &&
      !(S.estado.moderadores.includes(p.identity) || (S.admins || []).includes(p.identity)))
    return false;
  return true;
}
function lanzarChatFlota(quien, texto) {
  const e = document.createElement('div');
  e.className = 'reaccion-flota chat-flota';
  e.innerHTML = `<div class="burbuja"><div class="quien">💬 ${esc(quien)}</div><div class="txt">${esc(texto)}</div></div>`;
  e.style.left = Math.round(innerWidth * 0.08 + Math.random() * innerWidth * 0.45) + 'px';
  document.body.appendChild(e);
  setTimeout(() => e.remove(), 5000);
}

/* ---------- documentos ---------- */
function cablearDocs() {
  const sinDoc = () => {
    const razon = S.docProhibido
      ? 'Un moderador te prohibió compartir documentos.'
      : 'Solo puedes compartir documentos desde el asiento del anfitrión o con la palabra.';
    genModal('Documentos deshabilitados',
      `<p>${razon}</p><p>¿Quieres levantar la mano para pedir la palabra?</p>`,
      () => accion('levantar_mano')
        .then(() => toast('Mano levantada: espera la aprobación del moderador'))
        .catch(e => toast(e.message)),
      '✋ Levantar la mano');
  };
  $('#doc-subir').onclick = () => { if (!puedoDoc()) return sinDoc(); $('#doc-archivo').click(); };
  $('#doc-archivo').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('archivo', f);
    try {
      await api(`/api/salas/${S.sala}/documento`, fd);
      moderar('rejilla', { extra: 'presentacion' }).catch(() => {});
    } catch (x) { toast(x.message); }
    e.target.value = '';
  };
  $('#doc-web').onclick = async () => {
    if (!puedoDoc()) return sinDoc();
    const url = $('#doc-url').value.trim();
    if (!url) return;
    try {
      await api(`/api/salas/${S.sala}/documento`, { url });
      moderar('rejilla', { extra: 'presentacion' }).catch(() => {});
    } catch (e) { toast(e.message); }
  };
  $('#doc-quitar').onclick = () => accion('quitar_documento').catch(e => toast(e.message));
  $('#doc-audio').onclick = () => {
    if (S.audioCompartido) { detenerAudioCompartido(); return; }
    if (!puedoDoc()) return sinDoc();
    $('#doc-audio-archivo').click();
  };
  // volumen local del audio compartido en vivo (cada oyente elige el suyo)
  const mv = $('#doc-musica-vol');
  if (mv) mv.oninput = () => {
    S.volMusica = (+mv.value || 0) / 100;
    if (S.musica) ajustarSalida(S.musica.sid);
  };
  $('#doc-audio-archivo').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) compartirAudio(f).catch(x => toast('No se pudo compartir el audio: ' + x.message));
  };
  $('#as-stop').onclick = detenerAudioCompartido;
  // 📢 "sincronizar": fija mi volumen como nivel de todos y les reinicia su
  // slider local (reset) — para cuando cada oyente lo ajustó distinto
  $('#as-sync').onclick = () => {
    const el = $('#as-player');
    try { pubData({ t: 'aud_vol', v: el.volume, muted: el.muted, reset: true }); } catch {}
    toast('📢 Volumen sincronizado en toda la sala');
  };
  const dt = $('#doc-tools-toggle');
  cablearDocZoom();
  if (dt) dt.onclick = () => {
    const plegado = $('#doc-controles').classList.toggle('plegado');
    dt.textContent = plegado ? '🛠' : '✕';
  };
}

/* ---------- compartir un archivo de audio ---------- */
// compartirAudio reproduce un archivo local y lo publica como pista de
// audio: los demás lo oyen en streaming por el canal normal de LiveKit.
// El elemento es el propio reproductor visible (#as-player): la ventanita
// flotante da play/pausa y permite adelantar/retroceder sobre la marcha.
async function compartirAudio(f) {
  const el = $('#as-player');
  const cap = el.captureStream || el.mozCaptureStream;
  if (!cap) throw new Error('este navegador no permite retransmitir audio (prueba en Chrome/Edge)');
  el.src = URL.createObjectURL(f);
  if (S.dev.spk && el.setSinkId) el.setSinkId(S.dev.spk).catch(() => {});
  // esperar a que el archivo cargue para que captureStream dé la pista
  await new Promise((res, rej) => {
    el.onloadeddata = res;
    el.onerror = () => rej(new Error('no se pudo cargar el archivo'));
  });
  const st = cap.call(el);
  const track = st.getAudioTracks()[0];
  if (!track) throw new Error('no se pudo capturar el audio del archivo');
  track.contentHint = 'music';
  // el reproductor se abre PAUSADO: aunque la pista quede publicada no se
  // oye nada en la sala hasta que el usuario le dé play a su reproductor —
  // antes el el.play() previo dejaba el audio sonando sin controles si la
  // publicación fallaba
  $('#as-nombre').textContent = f.name;
  if ($('#audio-share').classList.contains('oculto'))
    empujarCapa('audio-share', () => !$('#audio-share').classList.contains('oculto'));
  $('#audio-share').classList.remove('oculto');
  $('#doc-audio').textContent = '⏹ Parar audio';
  el.onended = detenerAudioCompartido;
  // el volumen del reproductor se replica como nivel base en la sala: si
  // quien emite lo baja, baja para todos (encima cada oyente tiene su slider)
  el.onvolumechange = () => {
    try { pubData({ t: 'aud_vol', v: el.volume, muted: el.muted }); } catch {}
  };
  S.audioCompartido = { el, pub: null };
  try {
    // fuente SCREEN_SHARE_AUDIO: es la que el grant concede a quien tiene
    // asiento/palabra/moderación — con UNKNOWN la sala lo rechazaba
    S.audioCompartido.pub = await S.room.localParticipant.publishTrack(track,
      { source: LC.Track.Source.ScreenShareAudio, name: '🎵 ' + f.name });
    toast('Audio listo: dale ▶ en el reproductor para que suene en la sala');
  } catch (x) {
    // sin permiso para transmitir: el reproductor queda igualmente para
    // escucharlo en local, pero nada sale a la sala
    toast('Sin permiso para transmitir a la sala — suena solo aquí: ' + x.message);
  }
}
function detenerAudioCompartido() {
  const ac = S.audioCompartido;
  if (!ac) return;
  S.audioCompartido = null;
  try { ac.el.pause(); ac.el.onvolumechange = null; URL.revokeObjectURL(ac.el.src); ac.el.removeAttribute('src'); ac.el.load(); } catch {}
  $('#audio-share').classList.add('oculto');
  if (ac.pub && ac.pub.track)
    S.room.localParticipant.unpublishTrack(ac.pub.track).catch(() => {});
  if ($('#doc-audio')) $('#doc-audio').textContent = '🎵 Audio';
}

/* ---------- pizarra ---------- */
function cablearPizarra() {
  const cv = $('#pizarra');
  $('#pz-color').oninput = (e) => S.wb.color = e.target.value;
  $('#pz-grosor').oninput = (e) => S.wb.grosor = +e.target.value;
  $('#pz-relleno').onchange = (e) => S.wb.relleno = e.target.checked;
  $('#pz-limpiar').onclick = () => { S.wb.strokes = []; S.wb.mios = []; redibujarPizarra(); pubData({ t: 'wb_clear' }); };
  // deshacer MI último trazo: un trazo a mano alzada son muchos segmentos del
  // mismo grupo "g" — se quitan todos y se re-emite la pizarra completa
  $('#pz-deshacer').onclick = () => {
    const mio = S.wb.mios.pop();
    if (!mio) return;
    const g = mio.g;
    if (g) S.wb.mios = S.wb.mios.filter(s => s.g !== g);
    S.wb.strokes = S.wb.strokes.filter(s => (g ? s.g !== g : s !== mio));
    redibujarPizarra();
    pubData({ t: 'wb_clear' });
    S.wb.strokes.forEach(s => pubData({ t: 'wb', shape: s }));
  };
  $$('.wb-tool').forEach(b => b.onclick = () => {
    S.wb.herramienta = b.dataset.tool;
    $$('.wb-tool').forEach(x => x.classList.toggle('activo', x === b));
  });
  const pt = $('#pz-tools-toggle');
  if (pt) pt.onclick = () => {
    const plegado = $('.pizarra-tools').classList.toggle('plegado');
    pt.textContent = plegado ? '🛠' : '✕';
  };

  const norm = (e) => {
    const r = cv.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  // cada trazo emitido lleva "u" (autor) y "g" (grupo): deshacer quita el
  // grupo entero y, si la pizarra se re-emite, recupero lo que era mío
  const emitirWB = (s) => {
    s.g = s.g || S.wb.trazoId; s.u = S.identidad;
    S.wb.strokes.push(s); S.wb.mios.push(s);
    pubData({ t: 'wb', shape: s });
  };
  let prev = null, inicio = null, previa = null;
  cv.onpointerdown = (e) => {
    const p = norm(e);
    // id de grupo nuevo para este trazo (los segmentos se deshacen de una vez)
    S.wb.trazoId = Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    if (S.wb.herramienta === 'texto') {
      preguntarTexto('Texto a insertar:', (texto) => {
        emitirWB({ k: 'texto', x: p[0], y: p[1], texto, c: S.wb.color, w: S.wb.grosor });
        redibujarPizarra();
      });
      return;
    }
    S.wb.dibujando = true; prev = p; inicio = p;
    cv.setPointerCapture(e.pointerId);
  };
  cv.onpointerup = (e) => {
    if (!S.wb.dibujando) return;
    S.wb.dibujando = false;
    const p = norm(e);
    const s = formaEntre(inicio, p);
    if (s) emitirWB(s);
    previa = null; prev = null; inicio = null;
    redibujarPizarra();
  };
  cv.onpointermove = (e) => {
    const p = norm(e);
    if (S.wb.herramienta === 'laser') {
      pubData({ t: 'wb_laser', x: p[0], y: p[1] }, false);
      agregarLaser('_yo', p[0], p[1]);
      return;
    }
    if (!S.wb.dibujando || !prev) return;
    if (S.wb.herramienta === 'lapiz' || S.wb.herramienta === 'marcador' || S.wb.herramienta === 'borrador') {
      const s = {
        k: S.wb.herramienta === 'borrador' ? 'borrador' : S.wb.herramienta === 'marcador' ? 'marcador' : 'seg',
        x0: prev[0], y0: prev[1], x1: p[0], y1: p[1], c: S.wb.color,
        w: S.wb.herramienta === 'borrador' ? S.wb.grosor * 4 : S.wb.grosor,
      };
      emitirWB(s); dibujarShape(s);
      prev = p;
    } else {
      previa = formaEntre(inicio, p);
      redibujarPizarra();
      if (previa) dibujarShape(previa);
    }
  };
  new ResizeObserver(() => { ajustarPizarra(); redibujarPizarra(); }).observe(cv);
  ajustarPizarra();
  setTimeout(() => { if (!S.wb.cargado) pubData({ t: 'wb_req' }); }, 800);
  requestAnimationFrame(loopLaser);
}

function formaEntre(a, b) {
  if (!a || !b) return null;
  // ojo: 'w' es el grosor del trazo; el tamaño va en ancho/alto/rx/ry
  const base = { c: S.wb.color, w: S.wb.grosor, f: S.wb.relleno };
  if (S.wb.herramienta === 'linea') return { k: 'linea', x0: a[0], y0: a[1], x1: b[0], y1: b[1], ...base };
  if (S.wb.herramienta === 'rect') return { k: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), ancho: Math.abs(b[0] - a[0]), alto: Math.abs(b[1] - a[1]), ...base };
  if (S.wb.herramienta === 'circulo') return { k: 'circulo', cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2, ...base };
  return null;
}

function ajustarPizarra() {
  const cv = $('#pizarra');
  const fx = $('#pizarra-fx');
  const r = cv.getBoundingClientRect();
  if (r.width && (cv.width !== r.width * devicePixelRatio || cv.height !== r.height * devicePixelRatio)) {
    cv.width = r.width * devicePixelRatio;
    cv.height = r.height * devicePixelRatio;
    if (fx) { fx.width = cv.width; fx.height = cv.height; }
  }
}

function dibujarShape(s) {
  const cv = $('#pizarra');
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.c || '#fff';
  ctx.fillStyle = s.c || '#fff';
  ctx.lineWidth = (s.w || 3) * devicePixelRatio;
  const W = cv.width, H = cv.height;
  switch (s.k) {
    case 'borrador':
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = (s.w || 10) * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(s.x0 * W, s.y0 * H); ctx.lineTo(s.x1 * W, s.y1 * H); ctx.stroke();
      break;
    case 'seg':
    case 'linea':
      ctx.beginPath(); ctx.moveTo(s.x0 * W, s.y0 * H); ctx.lineTo(s.x1 * W, s.y1 * H); ctx.stroke();
      break;
    case 'marcador':
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = (s.w || 3) * devicePixelRatio * 3;
      ctx.beginPath(); ctx.moveTo(s.x0 * W, s.y0 * H); ctx.lineTo(s.x1 * W, s.y1 * H); ctx.stroke();
      break;
    case 'rect':
      if (s.f) { ctx.globalAlpha = 0.3; ctx.fillRect(s.x * W, s.y * H, s.ancho * W, s.alto * H); ctx.globalAlpha = 1; }
      ctx.strokeRect(s.x * W, s.y * H, s.ancho * W, s.alto * H);
      break;
    case 'circulo':
      ctx.beginPath();
      ctx.ellipse(s.cx * W, s.cy * H, s.rx * W, s.ry * H, 0, 0, 2 * Math.PI);
      if (s.f) { ctx.globalAlpha = 0.3; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.stroke();
      break;
    case 'texto':
      ctx.font = `${(s.w || 3) * 8 * devicePixelRatio}px system-ui`;
      ctx.fillText(s.texto, s.x * W, s.y * H);
      break;
  }
  ctx.restore();
}

function dibujarLinea(l) { dibujarShape({ k: 'seg', ...l }); }

function redibujarPizarra() {
  const cv = $('#pizarra');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  S.wb.strokes.forEach(dibujarShape);
}

/* puntero láser: un solo punto rojo por persona, efímero (canvas fx) */
function agregarLaser(quien, x, y) {
  S.wb.laser[quien] = { x, y, t: performance.now() };
}
let laserRAF = null;
function loopLaser() {
  laserRAF = requestAnimationFrame(loopLaser);
  const fx = $('#pizarra-fx');
  if (!fx) return;
  const ctx = fx.getContext('2d');
  ctx.clearRect(0, 0, fx.width, fx.height);
  const ahora = performance.now();
  for (const [q, d] of Object.entries(S.wb.laser)) {
    const edad = ahora - d.t;
    if (edad > 600) { delete S.wb.laser[q]; continue; }
    ctx.globalAlpha = Math.max(0, 1 - edad / 600);
    ctx.fillStyle = '#ff3b30';
    ctx.beginPath();
    ctx.arc(d.x * fx.width, d.y * fx.height, 7 * devicePixelRatio, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
