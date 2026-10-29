package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

// assetVer es un hash corto de los assets embebidos: cambia en cada build,
// así index.html referencia ?v=<hash> y el teléfono descarga el JS/CSS
// nuevo aunque tenga el anterior en caché — sin depender de Ctrl+F5.
var assetVer = func() string {
	h := sha256.New()
	for _, p := range []string{"web/index.html", "web/app.js", "web/conferencia-engine.js", "web/styles.css", "web/sw.js"} {
		if b, err := webFS.ReadFile(p); err == nil {
			h.Write(b)
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:8]
}()

var indexVerRe = regexp.MustCompile(`\?v=[0-9A-Za-z]+`)

var (
	appSecret  = env("APP_SECRET", "conferencia-secret-0123456789abcdef")
	publicHost = os.Getenv("PUBLIC_HOST")
	port       = env("PORT", "3000")
	dataDir    = env("DATA_DIR", "./data")
	adminUser  = env("ADMIN_USER", "admin")
	adminPass  = env("ADMIN_PASSWORD", "admin123")
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var (
	store *Store
	hub   *Hub
	media *MediaHub
)

type sesion struct {
	usuario string
	expira  time.Time
}

var sesiones sync.Map // token -> sesion

var nombreSalaRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
var instanciaServidor = func() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}()

func main() {
	var err error
	store, err = NewStore(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	hub = NewHub()
	media = NewMediaHub()

	if err := store.CrearAdmin(adminUser, adminPass); err == nil {
		log.Printf("admin por defecto creado: %s (cambiar ADMIN_PASSWORD en producción)", adminUser)
	}

	mux := http.NewServeMux()

	// --- público ---
	mux.HandleFunc("POST /api/login", hLogin)
	mux.HandleFunc("POST /api/logout", hLogout)
	mux.HandleFunc("POST /api/obtener-acceso", hObtenerAcceso)
	mux.HandleFunc("GET /api/salas/{sala}/info", hInfoSala)
	mux.HandleFunc("GET /api/salas/{sala}/espera", hEspera)
	mux.HandleFunc("GET /api/config", hConfig)
	// Versión del build embebido: el cliente la compara con la suya y se
	// auto-recarga cuando el servidor cambió — nadie debe limpiar caché
	mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		escribirJSON(w, 200, map[string]string{"v": assetVer})
	})

	// --- participante (Bearer o query token HMAC) ---
	mux.HandleFunc("GET /api/salas/{sala}/media", conParticipante(hMediaWS))
	mux.HandleFunc("GET /api/salas/{sala}/audio", conParticipante(hAudioManifiesto))
	mux.HandleFunc("POST /api/salas/{sala}/audio/subir", conParticipante(hAudioSubir))
	mux.HandleFunc("GET /api/salas/{sala}/audio/{seq}", conParticipante(hAudioSegmento))
	mux.HandleFunc("GET /api/salas/{sala}/audio/{seq}/tramos", conParticipante(hAudioTramos))
	mux.HandleFunc("GET /api/salas/{sala}/estado", conParticipante(hEstado))
	mux.HandleFunc("GET /api/salas/{sala}/eventos", conParticipante(hEventos))
	mux.HandleFunc("POST /api/salas/{sala}/accion", conParticipante(hAccion))
	mux.HandleFunc("POST /api/salas/{sala}/moderar", conParticipante(hModerar))
	mux.HandleFunc("POST /api/salas/{sala}/documento", conParticipante(hDocumento))
	mux.HandleFunc("POST /api/salas/{sala}/token", conParticipante(hTokenGrupo))
	mux.HandleFunc("GET /api/docs/{sala}/{archivo}", conParticipante(hDocArchivo))

	// --- administración (cookie de sesión) ---
	mux.HandleFunc("GET /api/admin/me", hMe)
	mux.HandleFunc("GET /api/admin/salas", conAdmin(hAdminSalas))
	mux.HandleFunc("POST /api/admin/salas", conAdmin(hAdminCrearSala))
	mux.HandleFunc("POST /api/admin/salas/{sala}", conAdmin(hAdminRenombrarSala))
	mux.HandleFunc("POST /api/admin/salas/{sala}/estado", conAdmin(hAdminEstadoSala))
	mux.HandleFunc("DELETE /api/admin/salas/{sala}", conAdmin(hAdminBorrarSala))
	mux.HandleFunc("GET /api/admin/salas/{sala}/participantes", conAdmin(hAdminParticipantes))
	mux.HandleFunc("POST /api/admin/usuarios", conAdmin(hAdminCrearUsuario))

	// --- SPA embebida ---
	sub, _ := fs.Sub(webFS, "web")
	mux.Handle("/", spaHandler(sub))

	go barrerParticipantes()
	go barrerSegmentos()

	log.Printf("conferencia escuchando en :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

func spaHandler(fsys fs.FS) http.Handler {
	fh := http.FileServer(http.FS(fsys))
	// index.html sale con ?v=<hash de los assets>: la URL de cada JS/CSS
	// cambia cuando cambia su contenido y el navegador no puede servir una
	// copia vieja — el historial del móvil se actualiza solo al recargar
	indexVerzado, errIdx := fs.ReadFile(fsys, "index.html")
	if errIdx == nil {
		indexVerzado = indexVerRe.ReplaceAll(indexVerzado, []byte("?v="+assetVer))
		// también expone al cliente su propia versión de build (para
		// compararla contra /api/version y auto-recargarse)
		indexVerzado = bytes.ReplaceAll(indexVerzado, []byte("__CONF_VER__"), []byte(assetVer))
	}
	servirIndex := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexVerzado)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" || p == "index.html" {
			// index.html siempre se revalida: es el que descubre si hay
			// una versión nueva (los ?v=<hash> de dentro ya apuntan al
			// contenido nuevo)
			w.Header().Set("Cache-Control", "no-cache")
			if errIdx == nil {
				servirIndex(w)
				return
			}
			fh.ServeHTTP(w, r)
			return
		}
		if f, err := fsys.Open(p); err == nil {
			f.Close()
			if r.URL.Query().Get("v") != "" {
				// La URL lleva huella de contenido (?v=hash): si el archivo
				// cambia, la URL cambia — el navegador puede guardarla para
				// siempre sin volver a descargar ni revalidar. Carga
				// instantánea de la PWA + actualización garantizada.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				// Sin huella (iconos, sw.js, manifest): revalidar — son
				// pequeños y deben refrescarse cuando cambian
				w.Header().Set("Cache-Control", "no-cache")
			}
			fh.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		if errIdx == nil {
			servirIndex(w)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		fh.ServeHTTP(w, r2)
	})
}

// ---------- utilidades ----------

func escribirJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func leerJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

var slugRe = regexp.MustCompile(`[^a-z0-9-]`)

func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, " ", "-")
	s = slugRe.ReplaceAllString(s, "")
	if s == "" {
		s = "user"
	}
	if len(s) > 24 {
		s = s[:24]
	}
	return s
}

func adminDe(r *http.Request) string {
	c, err := r.Cookie("sesion")
	if err != nil {
		return ""
	}
	if v, ok := sesiones.Load(c.Value); ok {
		s := v.(sesion)
		if time.Now().Before(s.expira) {
			return s.usuario
		}
		sesiones.Delete(c.Value)
	}
	return ""
}

func conAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if adminDe(r) == "" {
			escribirJSON(w, 401, map[string]string{"error": "no autorizado"})
			return
		}
		next(w, r)
	}
}

func claimsDe(r *http.Request, sala string) (*Claims, error) {
	tok := r.Header.Get("Authorization")
	tok = strings.TrimPrefix(tok, "Bearer ")
	if tok == "" {
		tok = r.URL.Query().Get("token")
	}
	if tok == "" {
		return nil, fmt.Errorf("falta token")
	}
	return verificarToken(tok, sala)
}

func baseSala(room string) string {
	if i := strings.LastIndex(room, "-g"); i > 0 {
		if _, err := fmt.Sscanf(room[i:], "-g%d", new(int)); err == nil {
			return room[:i]
		}
	}
	return room
}

func roomLk(sala string, g int) string {
	if g <= 0 {
		return sala
	}
	return fmt.Sprintf("%s-g%d", sala, g)
}

func conParticipante(next func(http.ResponseWriter, *http.Request, *Claims)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sala := r.PathValue("sala")
		g, err := claimsDe(r, sala)
		if err != nil {
			escribirJSON(w, 401, map[string]string{"error": "token inválido"})
			return
		}
		next(w, r, g)
	}
}

func hostDe(r *http.Request) string {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return strings.Trim(host, "[]")
}

// wsURLMedia devuelve la URL WebSocket de la propia aplicación (por el mismo
// puerto 443/80 de HTTP, sin abrir puertos adicionales ni usar TURN).
func wsURLMedia(r *http.Request) string {
	proto := "ws"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		proto = "wss"
	} else if publicHost != "" && strings.EqualFold(hostDe(r), publicHost) {
		proto = "wss"
	}
	return proto + "://" + r.Host
}

// ---------- autenticación de administradores ----------

func hLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Usuario string `json:"usuario"`
		Clave   string `json:"clave"`
	}
	if leerJSON(r, &req) != nil || !store.VerificarAdmin(req.Usuario, req.Clave) {
		escribirJSON(w, 401, map[string]string{"error": "credenciales incorrectas"})
		return
	}
	tok := randHex(24)
	sesiones.Store(tok, sesion{usuario: req.Usuario, expira: time.Now().Add(24 * time.Hour)})
	http.SetCookie(w, &http.Cookie{
		Name: "sesion", Value: tok, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: 86400,
	})
	escribirJSON(w, 200, map[string]string{"usuario": req.Usuario})
}

func hLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("sesion"); err == nil {
		sesiones.Delete(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: "sesion", Value: "", Path: "/", MaxAge: -1})
	escribirJSON(w, 200, map[string]bool{"ok": true})
}

func hMe(w http.ResponseWriter, r *http.Request) {
	u := adminDe(r)
	if u == "" {
		escribirJSON(w, 401, map[string]string{"error": "sin sesión"})
		return
	}
	escribirJSON(w, 200, map[string]string{"usuario": u})
}

func hConfig(w http.ResponseWriter, r *http.Request) {
	escribirJSON(w, 200, map[string]any{
		"wsUrl":     wsURLMedia(r),
		"protocolo": "conferencia",
	})
}

// ---------- acceso a salas ----------

func hInfoSala(w http.ResponseWriter, r *http.Request) {
	sala := r.PathValue("sala")
	sl := store.BuscarSala(sala)
	if sl == nil {
		escribirJSON(w, 404, map[string]any{"existe": false})
		return
	}
	escribirJSON(w, 200, map[string]any{
		"existe": true, "privada": sl.Privada,
		"nombre": sl.Nombre, "nombreVisible": sl.Visible(), "deshabilitada": sl.Deshabilitada,
	})
}

func hEspera(w http.ResponseWriter, r *http.Request) {
	sv := hub.sala(r.PathValue("sala"))
	id := r.URL.Query().Get("identidad")
	sv.mu.Lock()
	if it, ok := sv.lobby[id]; ok {
		it.Ts = ahora()
		sv.lobby[id] = it
	}
	admitido := sv.lobbyOk[id]
	rechazado := sv.lobbyNo[id] > 0
	if sl := store.BuscarSala(r.PathValue("sala")); sl != nil && sl.Acceso == "admin" && !admitido && !rechazado && sv.staffPresente() {
		sv.lobbyOk[id] = true
		delete(sv.lobby, id)
		admitido = true
	}
	sv.mu.Unlock()
	escribirJSON(w, 200, map[string]any{"admitido": admitido, "rechazado": rechazado})
}

func hObtenerAcceso(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Sala      string `json:"sala"`
		Nombre    string `json:"nombre"`
		Clave     string `json:"clave"`
		Identidad string `json:"identidad"`
	}
	if leerJSON(r, &req) != nil || req.Nombre == "" || !nombreSalaRe.MatchString(req.Sala) {
		escribirJSON(w, 400, map[string]string{"error": "datos inválidos"})
		return
	}
	sl := store.BuscarSala(req.Sala)
	if sl == nil {
		escribirJSON(w, 404, map[string]string{"error": "la sala no existe"})
		return
	}
	admin := adminDe(r)
	if sl.Deshabilitada && admin == "" {
		escribirJSON(w, 403, map[string]string{"error": "la sala está deshabilitada por el administrador"})
		return
	}
	if !store.ClaveSalaOK(sl, req.Clave) {
		escribirJSON(w, 403, map[string]string{"error": "contraseña incorrecta"})
		return
	}

	esAdmin := admin != ""
	identidad := slug(req.Nombre) + "-" + randHex(3)

	sv := hub.sala(req.Sala)
	sv.mu.Lock()
	if hasta, ok := sv.baneados[slug(req.Nombre)]; ok && hasta > ahora() {
		sv.mu.Unlock()
		escribirJSON(w, 403, map[string]string{
			"error": "estás baneado hasta " + time.UnixMilli(hasta).Format("15:04:05"),
		})
		return
	}
	if sv.lobbyNo[req.Identidad] > 0 || sv.lobbyNo["n:"+slug(req.Nombre)] > 0 {
		sv.mu.Unlock()
		escribirJSON(w, 403, map[string]string{"error": "un moderador rechazó tu entrada a la sala"})
		return
	}

	_, esModFijo := sv.modsFijos[req.Identidad]
	if req.Identidad != "" && (sv.nombres[req.Identidad] == req.Nombre || esModFijo || sv.lobbyOk[req.Identidad]) {
		identidad = req.Identidad
	}

	roomAdmin := esAdmin || admin == sl.Creador
	esMod := roomAdmin || sv.esModerador(identidad)
	if roomAdmin && !sv.esModerador(identidad) {
		sv.moderadores = append(sv.moderadores, identidad)
	}
	if nom, ok := sv.modsFijos[identidad]; ok {
		if !sv.esModerador(identidad) {
			sv.moderadores = append(sv.moderadores, identidad)
		}
		if nom != req.Nombre {
			sv.modsFijos[identidad] = req.Nombre
			store.FijarMod(req.Sala, identidad, req.Nombre)
		}
	}
	staff := roomAdmin || sv.esModerador(identidad)
	if !staff && sv.cerradaHasta > ahora() {
		sv.mu.Unlock()
		escribirJSON(w, 403, map[string]string{"error": "la reunión terminó"})
		return
	}

	if !staff && !sv.lobbyOk[identidad] &&
		(sl.Acceso == "lobby" || (sl.Acceso == "admin" && !sv.staffPresente())) {
		if _, ok := sv.lobby[identidad]; !ok {
			sv.lobby[identidad] = ColaItem{Identidad: identidad, Nombre: req.Nombre, Ts: ahora()}
			sv.broadcast(&Evento{Tipo: "sincronizar"})
		}
		sv.mu.Unlock()
		escribirJSON(w, 200, map[string]any{"espera": true, "identidad": identidad})
		return
	}

	sv.nombres[identidad] = req.Nombre
	grupo := sv.grupoDe[identidad]
	canMic := sv.puedeMic(identidad, esMod)
	canCam := sv.puedeCam(identidad)
	canPan := sv.puedePantalla(identidad)
	sv.mu.Unlock()

	tok, err := firmarToken(Claims{
		Identity:  identidad,
		Name:      req.Nombre,
		Sala:      roomLk(req.Sala, grupo),
		Grupo:     grupo,
		RoomAdmin: roomAdmin,
		CanMic:    canMic,
		CanCam:    canCam,
		CanPan:    canPan,
	})
	if err != nil {
		escribirJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	escribirJSON(w, 200, map[string]any{
		"token":         tok,
		"url":           wsURLMedia(r),
		"identidad":     identidad,
		"admin":         roomAdmin,
		"grupo":         grupo,
		"nombreVisible": sl.Visible(),
	})
}

// ---------- estado y SSE ----------

func marshalEstadoPara(sv *salaViva, ev *Evento, id string) ([]byte, error) {
	e := sv.estadoDe(id)
	copia := *e
	if copia.Cola == nil {
		copia.Cola = []ColaItem{}
	}
	if copia.Manos == nil {
		copia.Manos = []Mano{}
	}
	copia.Moderadores = append([]string{}, sv.moderadores...)
	for mid := range sv.modsFijos {
		ya := false
		for _, m := range sv.moderadores {
			if m == mid {
				ya = true
				break
			}
		}
		if !ya {
			copia.Moderadores = append(copia.Moderadores, mid)
		}
	}
	prohibidos := []string{}
	camProhibidos := []string{}
	panProhibidos := []string{}
	docProhibidos := []string{}
	micPermidos := []string{}
	camPermidos := []string{}
	admins := []string{}
	for identidad := range sv.admins {
		admins = append(admins, identidad)
	}
	if sv.esModerador(id) {
		for identidad, bloqueado := range sv.micBloq {
			if bloqueado {
				prohibidos = append(prohibidos, identidad)
			}
		}
		for identidad, bloqueado := range sv.camBloq {
			if bloqueado {
				camProhibidos = append(camProhibidos, identidad)
			}
		}
		for identidad, bloqueado := range sv.pantallaBloq {
			if bloqueado {
				panProhibidos = append(panProhibidos, identidad)
			}
		}
		for identidad, bloqueado := range sv.docBloq {
			if bloqueado {
				docProhibidos = append(docProhibidos, identidad)
			}
		}
		for identidad, ok := range sv.micOk {
			if ok {
				micPermidos = append(micPermidos, identidad)
			}
		}
		for identidad, ok := range sv.camOk {
			if ok {
				camPermidos = append(camPermidos, identidad)
			}
		}
	}
	directorio := []any{}
	chatProhibidos := []string{}
	for identidad, ok := range sv.chatBloq {
		if ok {
			chatProhibidos = append(chatProhibidos, identidad)
		}
	}
	lobbyLista := []any{}
	if sv.esModerador(id) {
		for lid, it := range sv.lobby {
			lobbyLista = append(lobbyLista, map[string]any{"identidad": lid, "nombre": it.Nombre})
		}
		visto := map[string]bool{}
		for i2 := range sv.presentes {
			visto[i2] = true
		}
		for i2 := range sv.grupoDe {
			visto[i2] = true
		}
		for i2 := range visto {
			directorio = append(directorio, map[string]any{
				"identidad": i2, "nombre": sv.nombres[i2], "grupo": sv.grupoDe[i2],
			})
		}
	}
	acceso := ""
	nombreVisible := sv.nombre
	if sl := store.BuscarSala(sv.nombre); sl != nil {
		acceso = sl.Acceso
		nombreVisible = sl.Visible()
	}
	aFavor, enContra := 0, 0
	miVoto := int8(0)
	for quien, v := range e.votantes {
		if v > 0 {
			aFavor++
		} else if v < 0 {
			enContra++
		}
		if quien == id {
			miVoto = v
		}
	}
	pcfg := pisoCfgDe(store.BuscarSala(sv.nombre))
	return json.Marshal(map[string]any{
		"estado":         &copia,
		"pisoCfg":        map[string]int{"admin": pcfg.admin, "anfitrion": pcfg.anfitrion, "palabra": pcfg.palabra, "usuario": pcfg.usuario, "palabraTol": pcfg.tol},
		"votos":          map[string]any{"aFavor": aFavor, "enContra": enContra, "mi": miVoto},
		"instancia":      instanciaServidor,
		"micProhibido":   sv.micBloq[id],
		"micProhibidos":  prohibidos,
		"camProhibido":   sv.camBloq[id],
		"camProhibidos":  camProhibidos,
		"micPerm":        sv.micOk[id],
		"camPerm":        sv.camOk[id],
		"micPermidos":    micPermidos,
		"camPermidos":    camPermidos,
		"admins":         admins,
		"evento":         ev,
		"miGrupo":        sv.grupoDe[id],
		"grupos":         sv.gruposJSON(),
		"directorio":     directorio,
		"ultTiempo":      sv.ultTiempoPalabra,
		"invitacion":     sv.invitaciones[id],
		"chatProhibido":  sv.chatBloq[id],
		"chatProhibidos": chatProhibidos,
		"panProhibido":   sv.pantallaBloq[id],
		"panProhibidos":  panProhibidos,
		"docProhibido":   sv.docBloq[id],
		"docProhibidos":  docProhibidos,
		"lobby":          lobbyLista,
		"acceso":         acceso,
		"nombreVisible":  nombreVisible,
	})
}

func hEstado(w http.ResponseWriter, r *http.Request, g *Claims) {
	sv := hub.sala(r.PathValue("sala"))
	sv.mu.Lock()
	defer sv.mu.Unlock()
	b, _ := marshalEstadoPara(sv, nil, g.Identity)
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func hEventos(w http.ResponseWriter, r *http.Request, g *Claims) {
	sala := r.PathValue("sala")
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl, ok := w.(http.Flusher)
	if !ok {
		return
	}
	ch := hub.suscribir(sala, g.Identity)
	defer hub.desuscribir(sala, ch)

	sv := hub.sala(sala)
	sv.mu.Lock()
	if g.RoomAdmin {
		sv.admins[g.Identity] = true
	} else {
		delete(sv.admins, g.Identity)
	}
	b, _ := marshalEstadoPara(sv, nil, g.Identity)
	sv.mu.Unlock()
	fmt.Fprintf(w, "data: %s\n\n", b)
	fl.Flush()

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case m := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", m)
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// ---------- acciones de participante ----------

type reqAccion struct {
	Tipo    string `json:"tipo"`
	Asiento int    `json:"asiento"`
	Nivel   int    `json:"nivel"`
}

func hAccion(w http.ResponseWriter, r *http.Request, g *Claims) {
	sala := r.PathValue("sala")
	var req reqAccion
	if leerJSON(r, &req) != nil {
		escribirJSON(w, 400, map[string]string{"error": "json inválido"})
		return
	}
	id, nombre := g.Identity, g.Name
	esAdmin := g.RoomAdmin
	sv := hub.sala(sala)

	revisar := map[string]bool{}
	var mutarMicID string
	var mutarMicGrupo int
	var pisoRobadoDe string
	var cerrarSegDe string
	sv.mu.Lock()
	sv.nombres[id] = nombre
	e := sv.estadoDe(id)
	soyMod := esAdmin || sv.esModerador(id)
	ev := &Evento{Tipo: req.Tipo, Identidad: id}
	errStr := ""
	encolar := func() {
		if asientoEn(e, id) < 0 && !enColaEn(e, id) {
			e.Cola = append(e.Cola, ColaItem{Identidad: id, Nombre: nombre, Ts: ahora()})
		}
		ev.Tipo = "encolado"
	}
	sentarEn := func(idx int) {
		if prev := asientoEn(e, id); prev >= 0 && prev != idx {
			liberarAsientoEn(e, prev)
			if nuevo := sv.rellenarColaSiPuede(e, prev); nuevo != "" {
				revisar[nuevo] = true
			}
		}
		e.Cola = filtrarCola(e.Cola, id)
		a := &e.Asientos[idx]
		a.Identidad, a.Nombre = id, nombre
		ev.Asiento = idx + 1
		revisar[id] = true
	}

	switch req.Tipo {
	case "sentarse":
		idx := -1
		if req.Asiento == 0 {
			idx = sv.asientoLibreEn(e, id, soyMod)
			if idx == -1 {
				encolar()
				break
			}
		} else {
			i := req.Asiento - 1
			if i < 0 || i > 8 {
				errStr = "asiento inválido"
				break
			}
			if i == 0 && !soyMod {
				errStr = "el asiento 1 es exclusivo de moderadores"
				break
			}
			a := &e.Asientos[i]
			if !sv.puedeSentarse(e, id, i, esAdmin) {
				errStr = "asiento bloqueado"
				break
			}
			if a.Identidad != "" && a.Identidad != id {
				if sv.asientoLibreEn(e, id, soyMod) == -1 {
					encolar()
					break
				}
				errStr = "asiento ocupado"
				break
			}
			idx = i
		}
		sentarEn(idx)

	case "piso_tomar":
		// PTT: tomar el piso exclusivo de voz. Si está ocupado, se tumba solo
		// cuando ya pasó el tiempo mínimo de los roles del solicitante.
		if !sv.puedeMic(id, soyMod) {
			errStr = "sin permiso de micrófono"
			break
		}
		res, faltan, anterior := sv.tomarPisoEn(e, id, nombre, soyMod)
		holderNombre := e.PisoNombre
		if res == pisoOcupadoR {
			sv.mu.Unlock()
			escribirJSON(w, 409, map[string]any{
				"error": "piso_ocupado", "faltan": faltan, "holder": holderNombre,
			})
			return
		}
		pisoRobadoDe = anterior
		cerrarSegDe = id // cerrar su frase abierta al tomar/soltar el piso
		ev.Tipo = "piso"

	case "piso_soltar":
		sv.soltarPisoEn(e, id)
		cerrarSegDe = id
		ev.Tipo = "piso"

	case "levantarse":
		if idx := asientoEn(e, id); idx >= 0 {
			liberarAsientoEn(e, idx)
			ev.Asiento = idx + 1
			revisar[id] = true
			if nuevo := sv.rellenarColaSiPuede(e, idx); nuevo != "" {
				revisar[nuevo] = true
			}
		}

	case "encolar":
		encolar()

	case "desencolar":
		e.Cola = filtrarCola(e.Cola, id)

	case "levantar_mano":
		existe := false
		for _, m := range e.Manos {
			if m.Identidad == id {
				existe = true
			}
		}
		if !existe {
			e.Manos = append(e.Manos, Mano{Identidad: id, Nombre: nombre, Ts: ahora()})
		}

	case "bajar_mano":
		e.Manos = filtrarManos(e.Manos, id)

	case "aceptar_invitacion":
		tipo := sv.invitaciones[id]
		segundos := sv.tiempoInvitacion[id]
		delete(sv.invitaciones, id)
		delete(sv.tiempoInvitacion, id)
		switch tipo {
		case "sentar":
			if idx := sv.asientoLibreEn(e, id, soyMod); idx >= 0 {
				sentarEn(idx)
			} else {
				encolar()
			}
		case "palabra":
			if e.Palabra != "" && e.Palabra != id {
				revisar[e.Palabra] = true
			}
			e.Palabra = id
			e.PalabraPausada, e.PausadaDesde = 0, 0
			e.PalabraFin = 0
			limpiarVotos(e)
			if segundos > 0 {
				e.PalabraFin = ahora() + int64(segundos)*1000
			}
			e.Manos = filtrarManos(e.Manos, id)
			delete(sv.micBloq, id)
			delete(sv.camBloq, id)
			revisar[id] = true
		}
		ev.Tipo = "invitacion_aceptada"

	case "rechazar_invitacion":
		delete(sv.invitaciones, id)
		delete(sv.tiempoInvitacion, id)

	case "dejar_palabra":
		if e.Palabra == id {
			e.Palabra = ""
			e.PalabraPausada, e.PausadaDesde = 0, 0
			e.PalabraFin = 0
			limpiarVotos(e)
			revisar[id] = true
			mutarMicID, mutarMicGrupo = id, sv.grupoDe[id]
		}

	case "votar":
		if e.Palabra == "" {
			errStr = "nadie tiene la palabra"
			break
		}
		v := int8(0)
		if req.Nivel > 0 {
			v = 1
		} else if req.Nivel < 0 {
			v = -1
		}
		if v == 0 {
			errStr = "voto inválido"
			break
		}
		if e.votantes[id] == v {
			delete(e.votantes, id)
		} else {
			e.votantes[id] = v
		}

	case "reset_votos":
		if e.Palabra != id && !soyMod {
			errStr = "solo el orador o un moderador"
			break
		}
		limpiarVotos(e)

	case "volver_principal":
		sv.moverAGrupo(id, 0)
		ev.Identidad = id
		revisar[id] = true

	case "quitar_documento":
		if !soyMod && !sv.puedeDoc(id) {
			errStr = "solo el anfitrión, la palabra o un moderador"
			break
		}
		e.Doc = nil

	default:
		errStr = "acción desconocida"
	}

	if errStr != "" {
		sv.mu.Unlock()
		escribirJSON(w, 409, map[string]string{"error": errStr})
		return
	}
	sv.broadcast(ev)
	sv.mu.Unlock()
	for pid := range revisar {
		reaplicarPermiso(sala, pid)
	}
	if mutarMicID != "" {
		mutearPistas(sala, mutarMicGrupo, mutarMicID, true, false)
	}
	if cerrarSegDe != "" || pisoRobadoDe != "" {
		mr := media.room(sala)
		if cerrarSegDe != "" {
			if sg := mr.seg.cerrarHablante(cerrarSegDe, false); sg != nil {
				mr.notificarSegFin(sg)
			}
		}
		if pisoRobadoDe != "" {
			// Al que le tumbamos el piso: su frase se cierra como interrumpida
			// y se le avisa para que suelte el PTT.
			if sg := mr.seg.cerrarHablante(pisoRobadoDe, true); sg != nil {
				mr.notificarSegFin(sg)
			}
			if oc := mr.clienteDe(pisoRobadoDe); oc != nil {
				msg, _ := json.Marshal(map[string]any{"t": "piso_perdido", "por": nombre})
				oc.enviarCtrl(append([]byte{1}, msg...))
			}
		}
	}
	escribirJSON(w, 200, map[string]any{"ok": true, "instancia": instanciaServidor})
}

// ---------- moderación ----------

type reqModerar struct {
	Tipo     string `json:"tipo"`
	Objetivo string `json:"objetivo"`
	Asiento  int    `json:"asiento"`
	Valor    bool   `json:"valor"`
	Nivel    int    `json:"nivel"`
	Modo     string `json:"modo"`
	Extra    string `json:"extra"`
}

func hModerar(w http.ResponseWriter, r *http.Request, g *Claims) {
	sala := r.PathValue("sala")
	sv := hub.sala(sala)

	sv.mu.Lock()
	if !g.RoomAdmin && !sv.esModerador(g.Identity) {
		sv.mu.Unlock()
		escribirJSON(w, 403, map[string]string{"error": "solo moderadores"})
		return
	}
	sv.mu.Unlock()

	var req reqModerar
	if leerJSON(r, &req) != nil {
		escribirJSON(w, 400, map[string]string{"error": "json inválido"})
		return
	}

	revisar := map[string]bool{}
	type muteOp struct {
		grupo    int
		id       string
		mic, cam bool
	}
	var muteSolo []muteOp
	var sacarTodos []string
	var expulsarID string
	reaplicarGrupo := -1
	resp := map[string]any{"ok": true}

	sv.mu.Lock()
	e := sv.estadoDe(g.Identity)
	ev := &Evento{Tipo: req.Tipo, Identidad: req.Objetivo, Extra: req.Extra}
	errStr := ""
	objGrupo := func() int { return sv.grupoDe[req.Objetivo] }

	darLaPalabra := func(obj string) {
		if e.Palabra != "" && e.Palabra != obj {
			revisar[e.Palabra] = true
		}
		e.Manos = filtrarManos(e.Manos, obj)
		delete(sv.micBloq, obj)
		delete(sv.camBloq, obj)
		e.Palabra = obj
		limpiarVotos(e)
		if req.Nivel > 0 {
			e.PalabraFin = ahora() + int64(req.Nivel)*1000
		} else {
			e.PalabraFin = 0
		}
		sv.ultTiempoPalabra = req.Nivel
		revisar[obj] = true
	}

	expulsar := func(obj string) {
		eg := sv.estadoDe(obj)
		if idx := sacarDeEstado(eg, obj); idx >= 0 {
			if nuevo := sv.rellenarColaSiPuede(eg, idx); nuevo != "" {
				revisar[nuevo] = true
			}
		}
		sv.quitarModerador(obj)
		delete(sv.invitaciones, obj)
		delete(sv.tiempoInvitacion, obj)
		delete(sv.micBloq, obj)
		delete(sv.camBloq, obj)
		delete(sv.pantallaBloq, obj)
		delete(sv.docBloq, obj)
		expulsarID = obj
		delete(sv.grupoDe, obj)
		delete(sv.nombres, obj)
	}

	switch req.Tipo {
	case "bloquear_asiento":
		idx := req.Asiento - 1
		if idx < 0 || idx > 8 {
			errStr = "asiento inválido"
			break
		}
		nivel := req.Nivel
		if nivel < 0 || nivel > 2 {
			nivel = 0
		}
		a := &e.Asientos[idx]
		a.Bloqueo = nivel
		if a.Identidad != "" && !sv.puedeSentarse(e, a.Identidad, idx, false) {
			exp := a.Identidad
			a.Identidad, a.Nombre = "", ""
			revisar[exp] = true
		}
		if a.Identidad == "" {
			if nid := sv.rellenarColaSiPuede(e, idx); nid != "" {
				revisar[nid] = true
			}
		}
		ev.Asiento = req.Asiento

	case "bloquear_todos":
		nivel := req.Nivel
		if nivel < 0 || nivel > 2 {
			nivel = 0
		}
		for idx := 1; idx <= 8; idx++ {
			a := &e.Asientos[idx]
			a.Bloqueo = nivel
			if a.Identidad != "" && !sv.puedeSentarse(e, a.Identidad, idx, false) {
				exp := a.Identidad
				a.Identidad, a.Nombre = "", ""
				revisar[exp] = true
			}
			if a.Identidad == "" {
				if nid := sv.rellenarColaSiPuede(e, idx); nid != "" {
					revisar[nid] = true
				}
			}
		}
		ev.Asiento = nivel

	case "expulsar_asiento":
		idx := req.Asiento - 1
		if idx < 0 || idx > 8 {
			errStr = "asiento inválido"
			break
		}
		exp := liberarAsientoEn(e, idx)
		ev.Identidad = exp
		ev.Asiento = req.Asiento
		if exp != "" {
			revisar[exp] = true
		}
		if nuevo := sv.rellenarColaSiPuede(e, idx); nuevo != "" {
			revisar[nuevo] = true
		}

	case "aprobar_mano":
		darLaPalabra(req.Objetivo)

	case "palabra":
		darLaPalabra(req.Objetivo)

	case "palabra_tiempo":
		if e.Palabra != "" && req.Nivel > 0 {
			e.PalabraFin = ahora() + int64(req.Nivel)*1000
		}

	case "rechazar_mano":
		e.Manos = filtrarManos(e.Manos, req.Objetivo)

	case "cortar_palabra":
		obj := req.Objetivo
		if obj == "" {
			obj = e.Palabra
		}
		if e.Palabra == obj {
			e.Palabra = ""
			e.PalabraPausada, e.PausadaDesde = 0, 0
			e.PalabraFin = 0
			limpiarVotos(e)
			muteSolo = append(muteSolo, muteOp{sv.grupoDe[obj], obj, true, true})
		}
		ev.Identidad = obj
		if obj != "" {
			revisar[obj] = true
		}

	case "silenciar":
		if e.Palabra == req.Objetivo {
			e.Palabra = ""
			e.PalabraPausada, e.PausadaDesde = 0, 0
			e.PalabraFin = 0
			limpiarVotos(e)
			revisar[req.Objetivo] = true
		}
		if req.Modo == "bloquear" {
			sv.micBloq[req.Objetivo] = true
			revisar[req.Objetivo] = true
		}
		muteSolo = append(muteSolo, muteOp{objGrupo(), req.Objetivo, true, false})

	case "habilitar_mic":
		delete(sv.micBloq, req.Objetivo)
		revisar[req.Objetivo] = true

	case "silenciar_cam":
		if req.Modo == "bloquear" {
			sv.camBloq[req.Objetivo] = true
			revisar[req.Objetivo] = true
		}
		muteSolo = append(muteSolo, muteOp{objGrupo(), req.Objetivo, false, true})

	case "habilitar_cam":
		delete(sv.camBloq, req.Objetivo)
		revisar[req.Objetivo] = true

	case "pantalla_bloquear":
		if req.Valor {
			sv.pantallaBloq[req.Objetivo] = true
		} else {
			delete(sv.pantallaBloq, req.Objetivo)
		}
		revisar[req.Objetivo] = true

	case "doc_bloquear":
		if req.Valor {
			sv.docBloq[req.Objetivo] = true
		} else {
			delete(sv.docBloq, req.Objetivo)
		}

	case "mic_excepcion":
		if req.Valor {
			sv.micOk[req.Objetivo] = true
		} else {
			delete(sv.micOk, req.Objetivo)
		}
		revisar[req.Objetivo] = true

	case "cam_excepcion":
		if req.Valor {
			sv.camOk[req.Objetivo] = true
		} else {
			delete(sv.camOk, req.Objetivo)
		}
		revisar[req.Objetivo] = true

	case "expulsar_sala":
		expulsar(req.Objetivo)

	case "banear":
		min := req.Nivel
		if min <= 0 {
			min = 10
		}
		clave := slug(sv.nombres[req.Objetivo])
		if clave == "" || clave == "user" {
			base := req.Objetivo
			if i := strings.LastIndex(base, "-"); i > 0 {
				base = base[:i]
			}
			clave = slug(base)
			if clave == "" || clave == "user" {
				clave = req.Objetivo
			}
		}
		sv.baneados[clave] = ahora() + int64(min)*60000
		sv.baneados[req.Objetivo] = ahora() + int64(min)*60000
		expulsar(req.Objetivo)

	case "delegar_moderador":
		if req.Valor && !sv.esModerador(req.Objetivo) {
			sv.moderadores = append(sv.moderadores, req.Objetivo)
			nomMod := sv.nombres[req.Objetivo]
			if nomMod == "" {
				nomMod = sv.lobby[req.Objetivo].Nombre
			}
			sv.modsFijos[req.Objetivo] = nomMod
			store.FijarMod(sala, req.Objetivo, nomMod)
			revisar[req.Objetivo] = true
		} else if !req.Valor {
			sv.quitarModerador(req.Objetivo)
			revisar[req.Objetivo] = true
		}

	case "silencio":
		e.Silencio = req.Valor
		reaplicarGrupo = sv.grupoDe[g.Identity]

	case "mic_asientos":
		e.MicAsientos = req.Valor
		reaplicarGrupo = sv.grupoDe[g.Identity]

	case "cam_audiencia":
		e.CamAudiencia = req.Valor
		reaplicarGrupo = sv.grupoDe[g.Identity]

	case "cam_asientos":
		e.CamAsientos = req.Valor
		reaplicarGrupo = sv.grupoDe[g.Identity]

	case "rejilla":
		e.Rejilla = req.Extra
		reaplicarGrupo = sv.grupoDe[g.Identity]

	case "vista_fija":
		e.VistaFija = req.Valor
		reaplicarGrupo = sv.grupoDe[g.Identity]

	case "renombrar":
		nom := strings.TrimSpace(req.Extra)
		if len(nom) > 80 {
			errStr = "nombre demasiado largo (máx. 80)"
			break
		}
		store.FijarNombreVisible(sala, nom)

	case "quitar_documento":
		e.Doc = nil

	case "invitar_sentar":
		sv.invitaciones[req.Objetivo] = "sentar"
		ev.Tipo, ev.Destino, ev.Extra = "invitacion", req.Objetivo, "sentar"

	case "invitar_palabra":
		sv.invitaciones[req.Objetivo] = "palabra"
		sv.tiempoInvitacion[req.Objetivo] = max(0, req.Nivel)
		sv.ultTiempoPalabra = max(0, req.Nivel)
		ev.Tipo, ev.Destino, ev.Extra = "invitacion", req.Objetivo, "palabra"

	case "grupo_crear":
		gid := sv.crearGrupo(req.Extra, req.Nivel)
		resp["grupo"] = gid
		ev.Extra = fmt.Sprintf("%d", gid)

	case "grupo_asignar":
		if req.Nivel > 0 {
			if _, ok := sv.grupos[req.Nivel]; !ok {
				errStr = "el grupo no existe"
				break
			}
		}
		sv.moverAGrupo(req.Objetivo, req.Nivel)
		ev.Identidad = req.Objetivo

	case "audio_perfil":
		switch req.Extra {
		case "auto", "telefono", "voz", "musica":
			e.AudioPerfil = req.Extra
		default:
			errStr = "perfil de audio desconocido"
		}

	case "grupo_plan":
		if _, ok := sv.grupos[req.Nivel]; !ok {
			errStr = "el grupo no existe"
			break
		}
		if sv.plan[req.Nivel] == nil {
			sv.plan[req.Nivel] = map[string]bool{}
		}
		if req.Valor {
			sv.plan[req.Nivel][req.Objetivo] = true
		} else {
			delete(sv.plan[req.Nivel], req.Objetivo)
		}

	case "grupo_comenzar":
		if _, ok := sv.grupos[req.Nivel]; !ok {
			errStr = "el grupo no existe"
			break
		}
		sv.comenzarGrupo(req.Nivel)

	case "grupo_cerrar":
		if _, ok := sv.grupos[req.Nivel]; !ok {
			errStr = "el grupo no existe"
			break
		}
		sv.cerrarGrupo(req.Nivel)

	case "grupo_borrar":
		if _, ok := sv.grupos[req.Nivel]; !ok {
			errStr = "el grupo no existe"
			break
		}
		sv.borrarGrupo(req.Nivel)

	case "grupo_ir":
		if req.Nivel > 0 {
			if _, ok := sv.grupos[req.Nivel]; !ok {
				errStr = "el grupo no existe"
				break
			}
		}
		sv.moverAGrupo(g.Identity, req.Nivel)
		ev.Identidad = g.Identity

	case "grupo_disolver":
		sv.disolverGrupos()

	case "chat_todos":
		e.ChatOff = req.Valor

	case "chat_bloquear":
		if req.Valor {
			sv.chatBloq[req.Objetivo] = true
		} else {
			delete(sv.chatBloq, req.Objetivo)
		}

	case "acceso":
		switch req.Extra {
		case "", "abierto":
			store.FijarAcceso(sala, "")
		case "admin", "lobby":
			store.FijarAcceso(sala, req.Extra)
		default:
			errStr = "modo de acceso desconocido"
		}

	case "piso_cfg":
		// Tiempos de interrupción del piso, en segundos, separados por comas:
		// extra = "admin,anfitrion,palabra,usuario[,tolPalabra]"
		// (0 = interrumpir al instante; tolPalabra = segundos que La Palabra
		// aguanta interrumpida antes de retirarse — 0 = 60 por defecto)
		var vs [5]int
		partes := strings.Split(req.Extra, ",")
		if len(partes) != 4 && len(partes) != 5 {
			errStr = "formato: admin,anfitrion,palabra,usuario[,tolPalabra] (segundos)"
			break
		}
		ok4 := true
		for i, p := range partes {
			n, err := strconv.Atoi(strings.TrimSpace(p))
			if err != nil || n < 0 {
				ok4 = false
				break
			}
			vs[i] = n
		}
		if !ok4 {
			errStr = "formato: admin,anfitrion,palabra,usuario[,tolPalabra] (segundos)"
			break
		}
		store.FijarPisoCfg(sala, vs[0], vs[1], vs[2], vs[3], vs[4])

	case "lobby_admitir":
		if req.Objetivo != "" {
			sv.lobbyOk[req.Objetivo] = true
			delete(sv.lobby, req.Objetivo)
		} else {
			for lid := range sv.lobby {
				sv.lobbyOk[lid] = true
				delete(sv.lobby, lid)
			}
		}

	case "lobby_rechazar":
		rechazar := func(lid string) {
			sv.lobbyNo[lid] = ahora()
			if it, ok := sv.lobby[lid]; ok {
				sv.lobbyNo["n:"+slug(it.Nombre)] = ahora()
			}
			delete(sv.lobby, lid)
		}
		if req.Objetivo != "" {
			rechazar(req.Objetivo)
		} else {
			for lid := range sv.lobby {
				rechazar(lid)
			}
		}

	case "terminar_reunion":
		ev.Tipo = "reunion_terminada"
		sv.cerradaHasta = ahora() + 60_000
		visto := map[string]bool{}
		for id := range sv.presentes {
			visto[id] = true
			sacarTodos = append(sacarTodos, id)
		}
		for id := range sv.grupoDe {
			if !visto[id] {
				sacarTodos = append(sacarTodos, id)
			}
		}

	default:
		errStr = "acción desconocida"
	}

	if errStr != "" {
		sv.mu.Unlock()
		escribirJSON(w, 409, map[string]string{"error": errStr})
		return
	}
	sv.broadcast(ev)
	sv.mu.Unlock()

	for pid := range revisar {
		reaplicarPermiso(sala, pid)
	}
	for _, m := range muteSolo {
		mutearPistas(sala, m.grupo, m.id, m.mic, m.cam)
	}
	if expulsarID != "" {
		expulsarClienteWS(sala, expulsarID)
	}
	for _, id := range sacarTodos {
		expulsarClienteWS(sala, id)
	}
	if reaplicarGrupo >= 0 {
		aplicarPermisosGrupo(sala, reaplicarGrupo)
	}
	escribirJSON(w, 200, resp)
}

func reaplicarPermiso(sala, id string) {
	sv := hub.sala(sala)
	sv.mu.Lock()
	mic := sv.puedeMic(id, false)
	cam := sv.puedeCam(id)
	pan := sv.puedePantalla(id)
	sv.mu.Unlock()
	actualizarPermiso(sala, id, mic, cam, pan)
}

func aplicarPermisosGrupo(sala string, g int) {
	for _, c := range media.listarPorGrupo(sala, g) {
		reaplicarPermiso(sala, c.identidad)
	}
}

func hTokenGrupo(w http.ResponseWriter, r *http.Request, g *Claims) {
	sala := r.PathValue("sala")
	var req struct {
		Grupo int `json:"grupo"`
	}
	if leerJSON(r, &req) != nil || req.Grupo < 0 {
		escribirJSON(w, 400, map[string]string{"error": "json inválido"})
		return
	}
	sv := hub.sala(sala)
	sv.mu.Lock()
	soyMod := g.RoomAdmin || sv.esModerador(g.Identity)
	if req.Grupo > 0 {
		if _, ok := sv.grupos[req.Grupo]; !ok {
			sv.mu.Unlock()
			escribirJSON(w, 404, map[string]string{"error": "el grupo no existe"})
			return
		}
	}
	if sv.grupoDe[g.Identity] != req.Grupo && !soyMod {
		sv.mu.Unlock()
		escribirJSON(w, 403, map[string]string{"error": "no estás asignado a ese grupo"})
		return
	}
	if soyMod {
		sv.moverAGrupo(g.Identity, req.Grupo)
	}
	canMic := sv.puedeMic(g.Identity, soyMod)
	canCam := sv.puedeCam(g.Identity)
	canPan := sv.puedePantalla(g.Identity)
	sv.mu.Unlock()

	tok, err := firmarToken(Claims{
		Identity:  g.Identity,
		Name:      g.Name,
		Sala:      roomLk(sala, req.Grupo),
		Grupo:     req.Grupo,
		RoomAdmin: g.RoomAdmin,
		CanMic:    canMic,
		CanCam:    canCam,
		CanPan:    canPan,
	})
	if err != nil {
		escribirJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	escribirJSON(w, 200, map[string]any{"token": tok, "url": wsURLMedia(r)})
}

// ---------- documentos ----------

func hDocumento(w http.ResponseWriter, r *http.Request, g *Claims) {
	sala := r.PathValue("sala")
	sv := hub.sala(sala)
	sv.mu.Lock()
	ok := sv.puedeDoc(g.Identity)
	bloq := sv.docBloq[g.Identity]
	sv.mu.Unlock()
	if !ok {
		msg := "necesitas el asiento del anfitrión o la palabra para compartir documentos"
		if bloq {
			msg = "un moderador te prohibió compartir documentos"
		}
		escribirJSON(w, 403, map[string]string{"error": msg})
		return
	}

	var doc *Documento
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(25 << 20); err != nil {
			escribirJSON(w, 400, map[string]string{"error": "archivo inválido"})
			return
		}
		f, hdr, err := r.FormFile("archivo")
		if err != nil {
			escribirJSON(w, 400, map[string]string{"error": "falta archivo"})
			return
		}
		defer f.Close()
		nombre := filepath.Base(hdr.Filename)
		ext := strings.ToLower(filepath.Ext(nombre))
		tipo := ""
		switch ext {
		case ".pdf":
			tipo = "pdf"
		case ".png", ".jpg", ".jpeg", ".gif", ".webp":
			tipo = "imagen"
		case ".mp4", ".webm", ".mkv", ".mov", ".m4v":
			tipo = "video"
		case ".mp3", ".ogg", ".wav", ".m4a", ".aac", ".flac", ".opus":
			tipo = "audio"
		default:
			escribirJSON(w, 400, map[string]string{"error": "tipo no soportado (pdf, imagen, vídeo o audio)"})
			return
		}
		dir := filepath.Join(dataDir, "docs", sala)
		os.MkdirAll(dir, 0o755)
		archivo := randHex(6) + "-" + nombre
		dst, err := os.Create(filepath.Join(dir, archivo))
		if err != nil {
			escribirJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		io.Copy(dst, f)
		dst.Close()
		doc = &Documento{Tipo: tipo, URL: "/api/docs/" + sala + "/" + archivo, Titulo: nombre}
	} else {
		var req struct {
			URL    string `json:"url"`
			Titulo string `json:"titulo"`
		}
		if leerJSON(r, &req) != nil || req.URL == "" {
			escribirJSON(w, 400, map[string]string{"error": "falta url"})
			return
		}
		t := req.Titulo
		if t == "" {
			t = req.URL
		}
		doc = &Documento{Tipo: "web", URL: req.URL, Titulo: t}
	}

	sv.mu.Lock()
	sv.estadoDe(g.Identity).Doc = doc
	sv.broadcast(&Evento{Tipo: "documento"})
	sv.mu.Unlock()
	escribirJSON(w, 200, doc)
}

func hDocArchivo(w http.ResponseWriter, r *http.Request, g *Claims) {
	sala := r.PathValue("sala")
	archivo := filepath.Base(r.PathValue("archivo"))
	p := filepath.Join(dataDir, "docs", sala, archivo)
	ext := strings.ToLower(filepath.Ext(p))
	switch ext {
	case ".pdf":
		w.Header().Set("Content-Type", "application/pdf")
	case ".png":
		w.Header().Set("Content-Type", "image/png")
	case ".jpg", ".jpeg":
		w.Header().Set("Content-Type", "image/jpeg")
	case ".gif":
		w.Header().Set("Content-Type", "image/gif")
	case ".webp":
		w.Header().Set("Content-Type", "image/webp")
	}
	http.ServeFile(w, r, p)
}

// ---------- administración ----------

func hAdminSalas(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	for _, s := range store.ListarSalas() {
		out = append(out, map[string]any{
			"nombre": s.Nombre, "nombreVisible": s.NombreVisible, "privada": s.Privada,
			"creador": s.Creador, "creadaEn": s.CreadaEn, "deshabilitada": s.Deshabilitada,
		})
	}
	escribirJSON(w, 200, out)
}

func hAdminCrearSala(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nombre string `json:"nombre"`
		Clave  string `json:"clave"`
	}
	if leerJSON(r, &req) != nil || !nombreSalaRe.MatchString(req.Nombre) {
		escribirJSON(w, 400, map[string]string{"error": "nombre inválido (a-z 0-9 - _)"})
		return
	}
	sl, err := store.CrearSala(req.Nombre, req.Clave, adminDe(r), ahora())
	if err != nil {
		escribirJSON(w, 409, map[string]string{"error": err.Error()})
		return
	}
	escribirJSON(w, 200, map[string]any{"nombre": sl.Nombre, "privada": sl.Privada})
}

func hAdminRenombrarSala(w http.ResponseWriter, r *http.Request) {
	var req struct {
		NombreVisible string `json:"nombreVisible"`
	}
	if leerJSON(r, &req) != nil {
		escribirJSON(w, 400, map[string]string{"error": "datos inválidos"})
		return
	}
	sala := r.PathValue("sala")
	if store.BuscarSala(sala) == nil {
		escribirJSON(w, 404, map[string]string{"error": "la sala no existe"})
		return
	}
	req.NombreVisible = strings.TrimSpace(req.NombreVisible)
	if len(req.NombreVisible) > 80 {
		escribirJSON(w, 400, map[string]string{"error": "nombre demasiado largo (máx. 80)"})
		return
	}
	store.FijarNombreVisible(sala, req.NombreVisible)
	sv := hub.sala(sala)
	sv.mu.Lock()
	sv.broadcast(&Evento{Tipo: "sincronizar"})
	sv.mu.Unlock()
	escribirJSON(w, 200, map[string]bool{"ok": true})
}

func hAdminEstadoSala(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Deshabilitada bool `json:"deshabilitada"`
	}
	if leerJSON(r, &req) != nil {
		escribirJSON(w, 400, map[string]string{"error": "datos inválidos"})
		return
	}
	sala := r.PathValue("sala")
	if store.BuscarSala(sala) == nil {
		escribirJSON(w, 404, map[string]string{"error": "la sala no existe"})
		return
	}
	store.FijarDeshabilitada(sala, req.Deshabilitada)
	escribirJSON(w, 200, map[string]bool{"ok": true})
}

func hAdminBorrarSala(w http.ResponseWriter, r *http.Request) {
	sala := r.PathValue("sala")
	store.BorrarSala(sala)
	media.borrarRoom(sala)
	escribirJSON(w, 200, map[string]bool{"ok": true})
}

func hAdminParticipantes(w http.ResponseWriter, r *http.Request) {
	sala := r.PathValue("sala")
	out := []map[string]any{}
	for _, c := range media.listarTodos(sala) {
		out = append(out, map[string]any{
			"identidad": c.identidad, "nombre": c.nombre, "estado": "CONNECTED",
		})
	}
	escribirJSON(w, 200, out)
}

func hAdminCrearUsuario(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Usuario string `json:"usuario"`
		Clave   string `json:"clave"`
	}
	if leerJSON(r, &req) != nil || req.Usuario == "" || len(req.Clave) < 4 {
		escribirJSON(w, 400, map[string]string{"error": "usuario/clave inválidos"})
		return
	}
	if err := store.CrearAdmin(req.Usuario, req.Clave); err != nil {
		escribirJSON(w, 409, map[string]string{"error": err.Error()})
		return
	}
	escribirJSON(w, 200, map[string]bool{"ok": true})
}

// barrerParticipantes limpia estados por grupo, expira la palabra y disuelve
// grupos cuyo tiempo se acabó. Corre cada 5 segundos.
func barrerParticipantes() {
	for {
		time.Sleep(5 * time.Second)
		hub.mu.Lock()
		nombres := make([]string, 0, len(hub.salas))
		for n := range hub.salas {
			nombres = append(nombres, n)
		}
		hub.mu.Unlock()

		for _, nombre := range nombres {
			sv := hub.sala(nombre)
			sv.mu.Lock()

			revisar := map[string]bool{}
			expiraron := map[string]int{}
			for gidE, e := range sv.estados {
				if e.Palabra != "" && e.PalabraFin > 0 && e.PalabraFin <= ahora() {
					revisar[e.Palabra] = true
					expiraron[e.Palabra] = gidE
					e.Palabra = ""
					e.PalabraPausada, e.PausadaDesde = 0, 0
					e.PalabraFin = 0
					limpiarVotos(e)
				}
			}
			for gid, info := range sv.grupos {
				if info.Fin > 0 && info.Fin <= ahora() {
					for id, gg := range sv.grupoDe {
						if gg == gid {
							sv.moverAGrupo(id, 0)
						}
					}
					delete(sv.grupos, gid)
					delete(sv.estados, gid)
				}
			}

			for k, hasta := range sv.baneados {
				if hasta <= ahora() {
					delete(sv.baneados, k)
				}
			}

			grupos := []int{0}
			for gid := range sv.grupos {
				grupos = append(grupos, gid)
			}
			sv.mu.Unlock()

			cambio := false
			presentesGlobal := map[string]bool{}
			dondeEsta := map[string]int{}
			for _, gid := range grupos {
				lista := media.listarPorGrupo(nombre, gid)
				presentes := map[string]bool{}
				for _, p := range lista {
					presentes[p.identidad] = true
					presentesGlobal[p.identidad] = true
					dondeEsta[p.identidad] = gid
				}
				sv.mu.Lock()
				e, ok := sv.estados[gid]
				if !ok {
					sv.mu.Unlock()
					continue
				}
				for i := range e.Asientos {
					idAsiento := e.Asientos[i].Identidad
					if idAsiento != "" && !presentes[idAsiento] {
						// Dar margen de 20s a desconexiones breves antes de quitar el asiento
						if sv.ausente[idAsiento] > 0 && ahora()-sv.ausente[idAsiento] >= 20_000 {
							liberarAsientoEn(e, i)
							sv.rellenarColaSiPuede(e, i)
							cambio = true
						}
					}
				}
				nc := e.Cola[:0]
				for _, c := range e.Cola {
					if presentes[c.Identidad] || (sv.ausente[c.Identidad] == 0 || ahora()-sv.ausente[c.Identidad] < 20_000) {
						nc = append(nc, c)
					} else {
						cambio = true
					}
				}
				e.Cola = nc
				nm := e.Manos[:0]
				for _, m := range e.Manos {
					if presentes[m.Identidad] || (sv.ausente[m.Identidad] == 0 || ahora()-sv.ausente[m.Identidad] < 20_000) {
						nm = append(nm, m)
					} else {
						cambio = true
					}
				}
				e.Manos = nm
				if e.Palabra != "" && !presentes[e.Palabra] && sv.ausente[e.Palabra] > 0 && ahora()-sv.ausente[e.Palabra] >= 20_000 {
					e.Palabra = ""
					e.PalabraPausada, e.PausadaDesde = 0, 0
					e.PalabraFin = 0
					limpiarVotos(e)
					cambio = true
				}
				// Watchdog del piso: si el dueño lleva >45 s sin mandar tramas
				// ni latidos de PTT (pestaña muerta), se libera; baches móviles
				// de 5-30 s conservan su piso y entregan la ráfaga completa.
				if e.Piso != "" {
					vivo := false
					for _, p := range lista {
						if p.identidad == e.Piso && ahora()-p.ultimoHabl < 45_000 {
							vivo = true
							break
						}
					}
					if !vivo {
						// soltarPisoEn re-concede el piso a La Palabra si existe
						if solto, reasig := sv.soltarPisoEn(e, e.Piso); solto {
							if reasig != "" {
								if pc := media.room(nombre).clienteDe(reasig); pc != nil {
									pc.ultimoHabl = ahora()
									msg, _ := json.Marshal(map[string]any{"t": "piso_ok"})
									pc.enviarCtrl(append([]byte{1}, msg...))
								}
							}
							cambio = true
						}
					}
				}
				// La Palabra lleva más de la tolerancia configurada
				// interrumpida por otro hablante: se retira sola (quien la
				// tenía puede volver a levantar la mano)
				tolMs := int64(pisoCfgDe(store.BuscarSala(sv.nombre)).tol) * 1000
				if e.Palabra != "" && e.PausadaDesde > 0 && ahora()-e.PausadaDesde > tolMs {
					exPalabra := e.Palabra
					e.Palabra = ""
					e.PalabraPausada, e.PausadaDesde = 0, 0
					e.PalabraFin = 0
					limpiarVotos(e)
					revisar[exPalabra] = true
					expiraron[exPalabra] = gid
					cambio = true
				}
				sv.mu.Unlock()
			}

			sv.mu.Lock()
			sv.presentes = dondeEsta
			expirada := func(id string) bool {
				if presentesGlobal[id] {
					delete(sv.ausente, id)
					return false
				}
				if sv.ausente[id] == 0 {
					sv.ausente[id] = ahora()
					return false
				}
				return ahora()-sv.ausente[id] >= 90_000
			}
			for lid, it := range sv.lobby {
				if ahora()-it.Ts > 180_000 {
					delete(sv.lobby, lid)
					cambio = true
				}
			}
			for rid, ts := range sv.lobbyNo {
				if ahora()-ts > 600_000 {
					delete(sv.lobbyNo, rid)
				}
			}
			for id := range sv.nombres {
				if expirada(id) {
					delete(sv.ausente, id)
					delete(sv.grupoDe, id)
					delete(sv.nombres, id)
					delete(sv.invitaciones, id)
					delete(sv.tiempoInvitacion, id)
					delete(sv.micOk, id)
					delete(sv.camOk, id)
					delete(sv.lobbyOk, id)
					cambio = true
				}
			}
			out := sv.moderadores[:0]
			for _, m := range sv.moderadores {
				if presentesGlobal[m] || sv.ausente[m] != 0 {
					out = append(out, m)
				} else {
					cambio = true
				}
			}
			sv.moderadores = out
			if cambio || len(revisar) > 0 {
				sv.broadcast(&Evento{Tipo: "sincronizar"})
			}
			sv.mu.Unlock()

			for pid := range revisar {
				reaplicarPermiso(nombre, pid)
			}
			for pid, gidE := range expiraron {
				mutearPistas(nombre, gidE, pid, true, true)
			}
		}
	}
}
